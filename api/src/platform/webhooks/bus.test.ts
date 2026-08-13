/**
 * The bus's tests — PF-395, PF-398, PF-399, PF-400, PF-401, PF-402.
 *
 * PF-400's behaviour and PF-394's id semantics are asserted inside the shared
 * contract suite, because they are properties any substitute must also have.
 * What is here is what is specific to THIS implementation, plus the two
 * substitutability runs.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  InProcessEventBus,
  NoopEventBus,
  RecordingEventBus,
  type EventBusOptions,
} from './bus.js';
import { EventRegistry } from './events.js';
import {
  EVENT_BUS_CONTRACT_ASSERTIONS,
  contractRegistry,
  describeEventBusContract,
} from './busContract.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const API_SRC = join(HERE, '..', '..');
const BUS_SOURCE = readFileSync(join(HERE, 'bus.ts'), 'utf8');
const WORKSPACE = '00000000-0000-4000-8000-000000000001';

/**
 * Source with comments removed.
 *
 * The structural assertions below are about what the module DOES, and a doc
 * comment that names `setTimeout` in order to say the module does not use one
 * is not a violation. Asserting over raw text made the first version of this
 * file fail on its own explanation, which is a fitness test that punishes
 * writing things down.
 */
const BUS_CODE = BUS_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// PF-401 — the SAME suite, twice, with the factory as the only difference.
// ───────────────────────────────────────────────────────────────────────────

describeEventBusContract(
  'InProcessEventBus',
  (options?: EventBusOptions) => new InProcessEventBus(options),
);

describeEventBusContract(
  'RecordingEventBus',
  (options?: EventBusOptions) => new RecordingEventBus(options),
);

describe('PF-401 — the contract suite is non-empty', () => {
  it('makes the number of assertions it claims to', () => {
    // A vacuous contract suite passes for every implementation, which is
    // precisely how "Liskov-substitutable" would rot into a green tick over
    // nothing. Counting the `it(` calls in the shared file is crude and it is
    // also exactly the failure being guarded against.
    const source = readFileSync(join(HERE, 'busContract.ts'), 'utf8');
    const assertions = (source.match(/^\s{4}it\(/gm) ?? []).length;
    expect(
      assertions,
      'The IEventBus contract changed size. If that was deliberate, update ' +
        'EVENT_BUS_CONTRACT_ASSERTIONS in busContract.ts — the count exists so ' +
        'shrinking the contract cannot be silent.',
    ).toBe(EVENT_BUS_CONTRACT_ASSERTIONS);
    expect(assertions).toBeGreaterThan(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────

describe('PF-398 — IEventBus has no transport knowledge', () => {
  it('imports nothing from express, pg or node:http', () => {
    for (const forbidden of ['express', "'pg'", 'node:http', 'node:https', '../../routes/']) {
      expect(BUS_CODE.includes(`from '${forbidden}`), `bus.ts imports ${forbidden}`).toBe(false);
    }
  });

  it('constructs and publishes in a bare Node context with no HTTP stack', async () => {
    // The DIP exhibit p.12 asks the architecture doc to name with a file path:
    // nothing here needed a request, a response, a pool or a socket.
    const bus = new InProcessEventBus({ registry: contractRegistry() });
    let seen = 0;
    bus.subscribe('*', () => void seen++);
    await bus.publish({ type: 'test.happened', workspace_id: WORKSPACE, data: { n: 1 } });
    expect(seen).toBe(1);
  });
});

describe('PF-399 — dispatch is synchronous and timer-free', () => {
  it('the module contains no setTimeout, setInterval or setImmediate', () => {
    // A bus that deferred dispatch to a timer would make every downstream
    // webhook test a race, and p.11 forbids sleeps in these tests outright.
    for (const timer of ['setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask']) {
      expect(BUS_CODE.includes(timer), `bus.ts uses ${timer}`).toBe(false);
    }
  });

  it('the handler has already run when publish() resolves — asserted with no await gap', async () => {
    const bus = new InProcessEventBus({ registry: contractRegistry() });
    const seen: number[] = [];
    bus.subscribe('test.happened', (e) => void seen.push((e.data as { n: number }).n));

    await bus.publish({ type: 'test.happened', workspace_id: WORKSPACE, data: { n: 42 } });
    expect(seen).toEqual([42]);
  });

  it('publishes sequentially — handlers of the second event never interleave with the first', async () => {
    const bus = new InProcessEventBus({ registry: contractRegistry() });
    const trace: string[] = [];
    bus.subscribe('test.happened', async (e) => {
      const n = (e.data as { n: number }).n;
      trace.push(`enter-${n}`);
      await Promise.resolve();
      trace.push(`exit-${n}`);
    });

    await bus.publish({ type: 'test.happened', workspace_id: WORKSPACE, data: { n: 1 } });
    await bus.publish({ type: 'test.happened', workspace_id: WORKSPACE, data: { n: 2 } });

    expect(trace).toEqual(['enter-1', 'exit-1', 'enter-2', 'exit-2']);
  });
});

describe('B2 — the publish-timing contract L15 and L16 build to', () => {
  it('warns when a handler exceeds the budget, naming the event', async () => {
    // The contract is "handlers accept and enqueue; they never do network I/O".
    // This makes it observable rather than merely documented — MVP-9's +10% P95
    // budget is ours to hold, and a handler that awaits a third party moves it
    // outside our control.
    const warnings: string[] = [];
    let now = 0;
    const bus = new InProcessEventBus({
      registry: contractRegistry(),
      clock: { nowMs: () => now },
      slowHandlerMs: 10,
      logger: { error: () => {}, warn: (m: unknown) => void warnings.push(String(m)) },
    });
    bus.subscribe('test.happened', () => {
      now += 500; // a handler that went to the network
    });

    await bus.publish({ type: 'test.happened', workspace_id: WORKSPACE, data: { n: 1 } });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('test.happened');
    expect(warnings[0]).toContain('500ms');
  });

  it('a well-behaved handler produces no warning', async () => {
    const warnings: string[] = [];
    const bus = new InProcessEventBus({
      registry: contractRegistry(),
      clock: { nowMs: () => 0 },
      logger: { error: () => {}, warn: (m: unknown) => void warnings.push(String(m)) },
    });
    bus.subscribe('test.happened', () => {});
    await bus.publish({ type: 'test.happened', workspace_id: WORKSPACE, data: { n: 1 } });
    expect(warnings).toEqual([]);
  });

  it('a slow handler still does not fail the publish', async () => {
    let now = 0;
    const bus = new InProcessEventBus({
      registry: contractRegistry(),
      clock: { nowMs: () => now },
      slowHandlerMs: 1,
      logger: { error: () => {}, warn: () => {} },
    });
    bus.subscribe('test.happened', () => void (now += 5000));
    await expect(
      bus.publish({ type: 'test.happened', workspace_id: WORKSPACE, data: { n: 1 } }),
    ).resolves.toBeUndefined();
  });
});

describe('PF-395 — a ninth event type is a registration, not a code edit', () => {
  it('registers plugin.installed on a fresh registry and a subscriber receives it', async () => {
    // The OCP claim `docs/architecture.md` makes for events, as a property.
    // Note what this test does NOT do: it does not import anything new into
    // bus.ts, does not add a case to a switch and does not touch a matcher.
    // The bus never learns that a ninth type exists.
    const registry = new EventRegistry({
      'plugin.installed': z.object({ app_id: z.string(), installed_by: z.string() }).strict(),
    });
    const bus = new InProcessEventBus({ registry });

    const received: unknown[] = [];
    bus.subscribe('plugin.installed', (e) => void received.push(e.data));

    await bus.publish({
      type: 'plugin.installed',
      workspace_id: WORKSPACE,
      data: { app_id: 'app_123', installed_by: 'user_1' },
    });

    expect(received).toEqual([{ app_id: 'app_123', installed_by: 'user_1' }]);
  });

  it('the ninth type is validated by its own schema, like any other', async () => {
    const registry = new EventRegistry({
      'plugin.installed': z.object({ app_id: z.string() }).strict(),
    });
    const bus = new InProcessEventBus({ registry });
    await expect(
      bus.publish({ type: 'plugin.installed', workspace_id: WORKSPACE, data: { wrong: 1 } }),
    ).rejects.toThrow();
  });

  it('bus.ts names no specific event type at all', () => {
    // The mechanical form of the claim. If the bus mentioned an event type, a
    // ninth one would eventually need it to mention that too.
    expect(BUS_CODE).not.toMatch(/'(document|issue|sprint)\.[a-z_]+'/);
  });
});

describe('RecordingEventBus — a real substitute, not a stub', () => {
  it('records every envelope in order', async () => {
    const bus = new RecordingEventBus({ registry: contractRegistry() });
    await bus.publish({ type: 'test.happened', workspace_id: WORKSPACE, data: { n: 1 } });
    await bus.publish({ type: 'test.other', workspace_id: WORKSPACE, data: { n: 2 } });

    expect(bus.events.map((e) => e.type)).toEqual(['test.happened', 'test.other']);
    expect(bus.ofType('test.other')).toHaveLength(1);
  });

  it('DISPATCHES as well as records', async () => {
    // The property that makes running the contract against it meaningful. A
    // double that only recorded would pass a suite that only published, and
    // every test subscribing through testDeps() would silently observe nothing.
    const bus = new RecordingEventBus({ registry: contractRegistry() });
    let seen = 0;
    bus.subscribe('test.happened', () => void seen++);
    await bus.publish({ type: 'test.happened', workspace_id: WORKSPACE, data: { n: 1 } });
    expect(seen).toBe(1);
    expect(bus.events).toHaveLength(1);
  });

  it('records the same envelope object a subscriber saw', async () => {
    const bus = new RecordingEventBus({ registry: contractRegistry() });
    let subscriberId = '';
    bus.subscribe('test.happened', (e) => {
      subscriberId = e.id;
    });
    await bus.publish({ type: 'test.happened', workspace_id: WORKSPACE, data: { n: 1 } });
    expect(bus.events[0]!.id).toBe(subscriberId);
  });
});

describe('PF-402 — seeds and migrations get a bus that publishes nothing', () => {
  it('NoopEventBus swallows a publish and never rejects', async () => {
    const bus = new NoopEventBus();
    await expect(bus.publish({ type: 'anything', workspace_id: WORKSPACE, data: {} })).resolves
      .toBeUndefined();
  });

  it('a seed run publishes zero events', async () => {
    // `api/src/db/seed.ts` inserts 14 documents. A seed that fanned those out
    // to live subscriptions is a self-inflicted incident, so the seeding path
    // is handed this bus rather than the real one.
    const bus = new NoopEventBus();
    let delivered = 0;
    bus.subscribe('*', () => void delivered++);
    for (let i = 0; i < 14; i++) {
      await bus.publish({ type: 'document.created', workspace_id: WORKSPACE, data: {} });
    }
    expect(delivered, 'the no-op bus delivered an event to a subscriber').toBe(0);
  });
});

describe('PF-402 — the bus is constructed at the composition root only', () => {
  const CONSTRUCTION = /new\s+(InProcess|Recording|Noop)EventBus\s*\(/;

  it('no module under platform/ constructs a bus', () => {
    // If you find yourself writing `new InProcessEventBus()` under platform/,
    // that is the bug: take the dependency as a constructor argument and let
    // `deps.ts` decide. This is the same rule PF-037 and PF-154 enforce for the
    // Postgres repositories.
    const offenders: string[] = [];
    for (const file of walk(join(API_SRC, 'platform'))) {
      if (file.endsWith('.test.ts')) continue;
      if (file.endsWith(join('webhooks', 'bus.ts'))) continue; // the definitions themselves
      if (file.endsWith(join('webhooks', 'busContract.ts'))) continue;
      if (CONSTRUCTION.test(readFileSync(file, 'utf8'))) {
        offenders.push(file.slice(API_SRC.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no module-level singleton bus is exported anywhere', () => {
    // A `export const bus = new InProcessEventBus()` would satisfy "one
    // construction site" while defeating the entire point — every importer
    // would share it and no test could substitute one.
    const offenders: string[] = [];
    for (const file of walk(API_SRC)) {
      if (file.endsWith('.test.ts')) continue;
      const source = readFileSync(file, 'utf8');
      if (/export\s+const\s+\w*[bB]us\w*\s*[:=][^\n]*new\s+\w*EventBus/.test(source)) {
        offenders.push(file.slice(API_SRC.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('production and test wiring each construct exactly one bus, in deps.ts', () => {
    const deps = readFileSync(join(API_SRC, 'deps.ts'), 'utf8');
    const constructions = deps.match(/new\s+\w*EventBus\s*\(/g) ?? [];
    expect(
      constructions,
      'deps.ts should construct exactly two buses: the production one in ' +
        'productionDeps() and the recording double in testDeps().',
    ).toHaveLength(2);
    expect(deps).toContain('new InProcessEventBus(');
    expect(deps).toContain('new RecordingEventBus(');
  });

  it('outside deps.ts, only tests construct a bus', () => {
    const offenders: string[] = [];
    for (const file of walk(API_SRC)) {
      if (file.endsWith('.test.ts')) continue;
      if (file.endsWith(join('api', 'src', 'deps.ts')) || file.endsWith('/deps.ts')) continue;
      if (file.endsWith(join('webhooks', 'bus.ts'))) continue;
      if (file.endsWith(join('webhooks', 'busContract.ts'))) continue;
      // Seeds and migrations construct the Noop bus deliberately — that IS the
      // ticket. They are allowed exactly that one.
      const source = readFileSync(file, 'utf8');
      const hits = (source.match(CONSTRUCTION) ?? []).length;
      if (hits > 0 && !/new\s+NoopEventBus\s*\(/.test(source)) {
        offenders.push(file.slice(API_SRC.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });
});
