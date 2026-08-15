/**
 * `ship webhooks tail`, both modes, against a booted Ship — PF-573, PF-576,
 * PF-579.
 *
 * PF-573 chose two answers to "how does a signed delivery reach a laptop" and
 * requires that *"each mode has its own test"*. `--listen` has had one since S6
 * (`story.test.ts`). This file adds `--poll`'s, and the streaming claim that
 * p.13's *"arriving in real time"* rests on.
 *
 * ── What `--poll` can and cannot claim (PF-576) ────────────────────────────
 * The delivery log persists the `Ship-Signature` header actually sent (L16's
 * PF-475 / B9) but deliberately does not expose the signed `raw_body`. Without
 * the body there is nothing to verify a digest against. PF-576 permits exactly
 * two outcomes and forbids a third: verify a stored signature, or say plainly
 * that it cannot — never silently omit the line. This asserts the second, on a
 * real delivery, in a real log.
 *
 * ── No timers here either ──────────────────────────────────────────────────
 * Every wait is on the child's own output (`ShipProcess.waitFor` wakes on a
 * `data` event). `--poll`'s priming pass announces itself precisely so this
 * file does not have to sleep past it: an event published into that window
 * would land in "history" and be skipped, and a test that raced a two-second
 * period would be the flake p.11 forbids.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, runShip, ShipProcess } from './support/harness.js';
import { makeHome } from './support/harness.js';
import { MAX_COLUMNS } from '../../src/render/delivery.js';
import { EXIT_CODES } from '../../src/exitCodes.js';

let home: string;
let dispose: () => void;

beforeAll(async () => {
  const scratch = makeHome();
  home = scratch.home;
  dispose = scratch.dispose;
  await login(home);
}, 120_000);

afterAll(async () => {
  // Nothing this file created may outlive it: `--listen` deletes its own
  // subscription on SIGINT, and this is the belt to that pair of braces.
  await runShip(['webhooks', 'tail', '--cleanup'], home);
  dispose?.();
});

describe('PF-576 — --poll tails the delivery log, and is honest about signatures', () => {
  it('prints each new delivery once, and never claims a signature it cannot check', async () => {
    // An active subscription, so deliveries actually happen. `--listen` owns it
    // and removes it on interrupt; `--poll` is a reader of the log it fills.
    const listen = new ShipProcess(['webhooks', 'tail'], home);
    const poll = new ShipProcess(['webhooks', 'tail', '--poll'], home);

    try {
      await listen.waitFor(
        (all) => all.includes('waiting for a signed delivery'),
        'binding the loopback listener',
      );
      await poll.waitFor(
        (all) => all.includes('tailing from now on'),
        'the priming pass to finish',
      );

      expect(poll.stderr).toContain('signatures cannot be verified here');

      const first = await runShip(['docs', 'create', '--title', 'poll-one'], home);
      expect(first.code, first.all).toBe(EXIT_CODES.success);
      await poll.waitFor(
        (all) => all.includes('not verifiable in poll mode'),
        'the first polled delivery',
      );

      const firstEventId = eventIdsIn(poll.stdout)[0];
      expect(firstEventId, poll.all).toBeDefined();

      // A SECOND delivery forces at least one more poll pass — and page 1 still
      // carries the first one. So if the dedupe were broken, this is the pass
      // that would print it twice.
      const second = await runShip(['docs', 'create', '--title', 'poll-two'], home);
      expect(second.code, second.all).toBe(EXIT_CODES.success);
      await poll.waitFor((all) => eventIdsIn(all).length >= 2, 'the second polled delivery');

      const ids = eventIdsIn(poll.stdout);
      expect(new Set(ids).size, `deliveries were printed twice: ${ids.join(', ')}`).toBe(
        ids.length,
      );

      // PF-576's honesty clause, both halves.
      expect(poll.stdout).toMatch(/^ {2}signature\s+not verifiable in poll mode$/m);
      expect(poll.stdout).toContain('event logged, signature not verifiable in poll mode');
      expect(poll.stdout).not.toContain('signature verified ✓');
      // A THIRD block shape. "not checked" and "failed the check" are different
      // facts, and a poll block ruled like a failure would read as a terminal
      // full of forgeries in the greyscale screenshot p.13 grades.
      expect(poll.stdout).toMatch(/^┈+$/m);
      expect(poll.stdout).not.toMatch(/^═+$/m);
      expect(poll.stdout).not.toContain('INVALID');

      // The `t=` from the persisted header is real, so the block is not empty
      // where a signature would be.
      expect(poll.stdout).toMatch(/signature t=\s+\d+ {2}\(\d{4}-\d{2}-\d{2} /);

      // p.13's screenshot bound holds in this mode too.
      for (const line of poll.stdout.split('\n')) {
        expect([...line].length, `over ${MAX_COLUMNS} columns: ${line}`).toBeLessThanOrEqual(
          MAX_COLUMNS,
        );
      }
    } finally {
      poll.interrupt();
      listen.interrupt();
      await poll.exited();
      await listen.exited();
    }
  }, 120_000);
});

describe('PF-579 — tail STREAMS: the first block is readable before the second event exists', () => {
  it('publishes one event, reads its whole block, and only then publishes the next', async () => {
    const tail = new ShipProcess(['webhooks', 'tail'], home);
    try {
      await tail.waitFor(
        (all) => all.includes('waiting for a signed delivery'),
        'binding the loopback listener',
      );

      const first = await runShip(['docs', 'create', '--title', 'stream-one'], home);
      expect(first.code, first.all).toBe(EXIT_CODES.success);
      const firstId = first.stdout.trim();

      // "Fully readable" is not "some bytes arrived": the block's closing rule
      // has to be on the child's stdout, on a pipe, with the process still
      // running. That is the line-flush claim `ship webhooks tail | head -20`
      // depends on — a buffered stdout would hold all of this until exit.
      await tail.waitFor((all) => blockIsComplete(all, firstId), 'the first block, in full');

      const beforeSecond = tail.stdout;
      expect(blockIsComplete(beforeSecond, firstId)).toBe(true);

      const second = await runShip(['docs', 'create', '--title', 'stream-two'], home);
      expect(second.code, second.all).toBe(EXIT_CODES.success);
      const secondId = second.stdout.trim();

      // The ordering claim, stated as PF-579 states it: the second event did
      // not exist when the first block was already readable.
      expect(beforeSecond).not.toContain(secondId);

      await tail.waitFor((all) => blockIsComplete(all, secondId), 'the second block, in full');

      // p.6's *"Webhook delivery latency (P95, first attempt) < 2s"*, made
      // visible to a viewer of the demo rather than only to a test.
      const latencies = [...tail.stdout.matchAll(/latency\s+(\d+) ms {2}event → arrival/g)].map(
        (match) => Number(match[1]),
      );
      expect(latencies.length).toBeGreaterThanOrEqual(2);
      for (const latency of latencies) expect(latency).toBeLessThan(2_000);
    } finally {
      tail.interrupt();
      await tail.exited();
    }
  }, 120_000);
});

/** Every `event.id` printed by a human-mode block, in order. */
function eventIdsIn(stdout: string): string[] {
  return [...stdout.matchAll(/^ {2}event\.id\s+(\S+)/gm)].map((match) => match[1] as string);
}

/**
 * Is the block for `documentId` complete — down to its closing rule?
 *
 * A partial write is the failure this is looking for, so "contains the id" is
 * not enough: the verified line and the rule after it are what a reader (or a
 * screenshot) actually needs.
 */
function blockIsComplete(stdout: string, documentId: string): boolean {
  const lines = stdout.split('\n');
  const at = lines.findIndex((line) => line.includes(documentId));
  if (at === -1) return false;
  const verified = lines.findIndex(
    (line, index) => index > at && line.includes('signature verified ✓'),
  );
  if (verified === -1) return false;
  return lines.slice(verified + 1).some((line) => /^─+$/.test(line));
}
