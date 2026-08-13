/**
 * PF-401 — the `IEventBus` contract, as a suite any implementation must pass.
 *
 * PRD p.3 requires a queue-backed bus to be a *"Liskov-substitutable drop-in"*
 * for the in-process one. A claim like that is only checkable if there is a
 * single set of assertions that neither implementation gets to edit — so this
 * file is written against `IEventBus` and nothing else, and `bus.test.ts`
 * executes it twice, passing a different factory each time. **Swapping the
 * factory is the only difference between the two runs.** The day a BullMQ or
 * SQS bus lands, it adds a third `describeEventBusContract(...)` line and either
 * passes or is not a substitute.
 *
 * The suite deliberately asserts BEHAVIOUR a substitute must preserve, not
 * implementation detail:
 *
 *   - every handler has run before `publish()` resolves
 *   - targeted handlers before wildcard, registration order within each
 *   - a throwing handler does not stop later handlers and does not reject
 *   - the envelope is minted with a fresh id and validated before dispatch
 *
 * A queue-backed bus satisfies all four; what it changes is where the work
 * happens, which is exactly what Liskov says must not be observable here.
 *
 * It uses its OWN registry rather than the eight shipped types, so that a change
 * to a payload schema (decision D7) cannot make the substitutability proof fail
 * for an unrelated reason.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { EventRegistry } from './events.js';
import type { EventBusOptions, IEventBus } from './bus.js';

/** A registry with one trivial type, independent of the shipped eight. */
export function contractRegistry(): EventRegistry {
  return new EventRegistry({
    'test.happened': z.object({ n: z.number() }).strict(),
    'test.other': z.object({ n: z.number() }).strict(),
  });
}

const WORKSPACE = '00000000-0000-4000-8000-000000000001';

function input(type = 'test.happened', n = 1) {
  return { type, workspace_id: WORKSPACE, data: { n } };
}

/** Silences the deliberate handler-failure logging in the isolation test. */
const quiet = { error: () => {}, warn: () => {} };

export type EventBusFactory = (options?: EventBusOptions) => IEventBus;

/**
 * Run the contract against one implementation.
 *
 * `makeBus` must apply the options it is given — the suite injects a registry
 * and a logger. An implementation that ignored them would fail here, which is
 * correct: the composition root configures the bus, and a bus that cannot be
 * configured is not a drop-in.
 */
export function describeEventBusContract(name: string, makeBus: EventBusFactory): void {
  describe(`IEventBus contract — ${name}`, () => {
    it('runs every subscribed handler before publish() resolves', async () => {
      // PF-399's headline: the mutation is visible on the NEXT LINE, with no
      // await gap and no timer. This is what makes every downstream webhook
      // test sleep-free, and it is what p.11's "resolves synchronously" buys.
      const bus = makeBus({ registry: contractRegistry() });
      let seen: unknown = null;
      bus.subscribe('test.happened', (event) => {
        seen = event.data;
      });

      await bus.publish(input());

      expect(seen).toEqual({ n: 1 });
    });

    it('awaits an ASYNC handler too', async () => {
      const bus = makeBus({ registry: contractRegistry() });
      let done = false;
      bus.subscribe('test.happened', async () => {
        await Promise.resolve();
        await Promise.resolve();
        done = true;
      });

      await bus.publish(input());

      expect(done, 'publish() resolved before an async handler finished').toBe(true);
    });

    it('delivers to wildcard subscribers', async () => {
      const bus = makeBus({ registry: contractRegistry() });
      const seen: string[] = [];
      bus.subscribe('*', (event) => {
        seen.push(event.type);
      });

      await bus.publish(input('test.happened'));
      await bus.publish(input('test.other'));

      expect(seen).toEqual(['test.happened', 'test.other']);
    });

    it('does not deliver an event to a handler subscribed to a different type', async () => {
      const bus = makeBus({ registry: contractRegistry() });
      const seen: string[] = [];
      bus.subscribe('test.other', (e) => void seen.push(e.type));

      await bus.publish(input('test.happened'));

      expect(seen).toEqual([]);
    });

    it('runs targeted handlers before wildcard, in registration order', async () => {
      const bus = makeBus({ registry: contractRegistry() });
      const order: string[] = [];
      bus.subscribe('*', () => void order.push('wildcard-1'));
      bus.subscribe('test.happened', () => void order.push('targeted-1'));
      bus.subscribe('*', () => void order.push('wildcard-2'));
      bus.subscribe('test.happened', () => void order.push('targeted-2'));

      await bus.publish(input());

      expect(order).toEqual(['targeted-1', 'targeted-2', 'wildcard-1', 'wildcard-2']);
    });

    it('PF-400 — a throwing handler isolates: later handlers run, publish resolves', async () => {
      const bus = makeBus({ registry: contractRegistry(), logger: quiet });
      const reached: string[] = [];
      bus.subscribe('test.happened', () => {
        reached.push('a');
        throw new Error('subscriber exploded');
      });
      bus.subscribe('test.happened', () => void reached.push('b'));

      await expect(bus.publish(input())).resolves.toBeUndefined();

      expect(reached, 'handler B did not run after handler A threw').toEqual(['a', 'b']);
    });

    it('PF-400 — a REJECTING async handler isolates the same way', async () => {
      const bus = makeBus({ registry: contractRegistry(), logger: quiet });
      const reached: string[] = [];
      bus.subscribe('test.happened', async () => {
        reached.push('a');
        return Promise.reject(new Error('async subscriber exploded'));
      });
      bus.subscribe('test.happened', () => void reached.push('b'));

      await expect(bus.publish(input())).resolves.toBeUndefined();
      expect(reached).toEqual(['a', 'b']);
    });

    it('PF-400 — the failure is logged with the event id and type', async () => {
      const logged: string[] = [];
      const bus = makeBus({
        registry: contractRegistry(),
        logger: { error: (m: unknown) => void logged.push(String(m)), warn: () => {} },
      });
      let publishedId = '';
      bus.subscribe('*', (e) => {
        publishedId = e.id;
      });
      bus.subscribe('test.happened', () => {
        throw new Error('boom');
      });

      await bus.publish(input());

      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain('test.happened');
      expect(logged[0]).toContain(publishedId);
    });

    it('PF-394 — mints a fresh id per publish; 1000 publishes give 1000 distinct ids', async () => {
      const bus = makeBus({ registry: contractRegistry() });
      const ids = new Set<string>();
      bus.subscribe('*', (e) => void ids.add(e.id));

      for (let i = 0; i < 1000; i++) await bus.publish(input('test.happened', i));

      expect(ids.size).toBe(1000);
    });

    it('PF-394 — the envelope handed to every subscriber carries the SAME id', async () => {
      // What makes a re-delivered envelope byte-identical downstream, and so
      // what makes TS-8's "original idempotency key intact" checkable at all.
      const bus = makeBus({ registry: contractRegistry() });
      const ids: string[] = [];
      bus.subscribe('test.happened', (e) => void ids.push(e.id));
      bus.subscribe('*', (e) => void ids.push(e.id));

      await bus.publish(input());

      expect(ids).toHaveLength(2);
      expect(ids[0]).toBe(ids[1]);
    });

    it('stamps created_at from the injected clock, never the wall clock', async () => {
      const at = 1_760_000_000_000;
      const bus = makeBus({ registry: contractRegistry(), clock: { nowMs: () => at } });
      let created = '';
      bus.subscribe('*', (e) => {
        created = e.created_at;
      });

      await bus.publish(input());

      expect(created).toBe(new Date(at).toISOString());
    });

    it('PF-393 — rejects a payload that does not match the type\'s schema', async () => {
      const bus = makeBus({ registry: contractRegistry() });
      let delivered = 0;
      bus.subscribe('*', () => void delivered++);

      await expect(
        bus.publish({ type: 'test.happened', workspace_id: WORKSPACE, data: { n: 'not a number' } }),
      ).rejects.toThrow();

      expect(delivered, 'an invalid payload reached a subscriber').toBe(0);
    });

    it('PF-397 — rejects an unregistered event type', async () => {
      const bus = makeBus({ registry: contractRegistry() });
      await expect(
        bus.publish({ type: 'test.exploded', workspace_id: WORKSPACE, data: { n: 1 } }),
      ).rejects.toThrow(/not a registered event type/);
    });

    it('publishing with no subscribers is a no-op, not an error', async () => {
      const bus = makeBus({ registry: contractRegistry() });
      await expect(bus.publish(input())).resolves.toBeUndefined();
    });
  });
}

/**
 * The number of assertions the contract makes.
 *
 * PF-401 asks that the suite be proved non-empty: a `describeEventBusContract`
 * whose body was accidentally deleted would pass for BOTH implementations and
 * "Liskov-substitutable" would be a green tick over nothing. `bus.test.ts`
 * asserts the real count matches this, so shrinking the contract is a
 * deliberate edit in two places rather than a silent one.
 */
export const EVENT_BUS_CONTRACT_ASSERTIONS = 14;
