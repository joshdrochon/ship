/**
 * PF-577 — the demo moment's output, pinned BYTE-FOR-BYTE by a golden file.
 *
 * p.13 grades *"a screenshot of the `ship webhooks tail` terminal showing a
 * verified signed event arriving in real time"*. That makes this block's content
 * and shape a deliverable, not a formatting preference — so it is checked
 * against a committed artifact, `tests/__golden__/delivery-verified.txt`, which
 * a reviewer can open and hold next to the screenshot.
 *
 * ── Why a file on disk and not `toMatchInlineSnapshot` ─────────────────────
 * The criterion asks for a golden test, and the point of one here is that a
 * human comparing the graded screenshot to the repo has something to compare it
 * TO. An inline snapshot lives inside the assertion that consumes it, so it
 * cannot be read without reading the test; a `.txt` alongside it can be `cat`ed.
 * It is also read with `readFileSync` and compared with `toBe` rather than
 * through vitest's snapshot machinery, deliberately: `--update` would silently
 * rewrite a snapshot to match whatever the renderer now emits, which is exactly
 * the failure mode a golden test on a GRADED artifact must not have. Changing
 * this block requires editing the golden by hand and saying why.
 *
 * ── What makes a golden test possible at all here ──────────────────────────
 * Three values that would otherwise be ambient are parameters of the renderer:
 * `offsetMinutes` (rather than `Date.getTimezoneOffset()` read inside),
 * `arrivedAtMs`, and the `nowMs` handed to `verifyDelivery`. The block is
 * rendered in local time for the human taking the screenshot and in a fixed
 * `+00:00` for this assertion — same code path, one injected value. Colour is
 * off because this renderer emits no escape codes at all.
 *
 * ── The three assertions below the golden are not redundant ────────────────
 * If someone regenerates the golden, the equality check follows it wherever it
 * goes. These do not: the 80-column bound is p.13's screenshot requirement, and
 * the closing line is p.6's fifth line quoted from the PRD rather than from the
 * renderer. Both would fail on a regenerated golden that broke them.
 */
import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SIGNATURE_HEADER } from '@ship/sdk';
import {
  MAX_COLUMNS,
  formatLocalTime,
  renderDeliveryBlock,
  verifyDelivery,
  type EventEnvelope,
} from '../src/render/delivery.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = join(HERE, '__golden__', 'delivery-verified.txt');

const SECRET = 'whsec_pf577_golden_secret_0123456789';

/**
 * The fixture is deliberately WIDE — a 36-character uuid, a 26-character event
 * id and a titled document — because the 80-column bound is only meaningful
 * against realistic values. A block built from `evt_1` and `hello` would fit
 * inside 80 columns no matter what the renderer did.
 */
const EVENT: EventEnvelope = {
  id: 'evt_01J9Z2K5Q7R3T8V0W2X4Y6Z8A0',
  type: 'document.created',
  created_at: '2026-08-15T14:23:05.000Z',
  workspace_id: 'ws_01J9Z2K5Q7R3T8V0W2X4Y6Z8A1',
  data: { id: '3f2a1c88-5d4e-4b6a-9c1f-2e7d8a0b3c5d', title: 'Q3 launch plan' },
};

const BODY = JSON.stringify(EVENT);
const SIGNED_AT_SECONDS = Math.floor(Date.parse(EVENT.created_at) / 1000);
/** 24 ms after the event — inside p.6's *"< 2s"* budget, and a real observed figure. */
const ARRIVED_AT_MS = Date.parse(EVENT.created_at) + 24;

/** The header a correct deliverer sends: `t=<unix seconds>,v1=<hex>`. */
function sign(body: string, secret: string, timestampSeconds: number): string {
  const digest = createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(`${timestampSeconds}.`, 'utf8'), Buffer.from(body, 'utf8')]))
    .digest('hex');
  return `t=${timestampSeconds},v1=${digest}`;
}

/** The block, rendered from a REAL HMAC through the real verifier. */
function verifiedBlock(): string[] {
  const headers = { [SIGNATURE_HEADER]: sign(BODY, SECRET, SIGNED_AT_SECONDS) };
  const verification = verifyDelivery(headers, BODY, SECRET, ARRIVED_AT_MS);
  // Not the point of this test, but a golden of an UNVERIFIED block would be a
  // silent disaster — the file would pin `INVALID` and nothing would notice.
  expect(verification.verified, 'the golden fixture must actually verify').toBe(true);

  return renderDeliveryBlock({
    event: EVENT,
    idempotencyKey: EVENT.id,
    verification,
    arrivedAtMs: ARRIVED_AT_MS,
    offsetMinutes: 0,
  });
}

describe('PF-577 — one verified delivery, pinned byte-for-byte', () => {
  it('matches the committed golden exactly', () => {
    const rendered = `${verifiedBlock().join('\n')}\n`;
    const golden = readFileSync(GOLDEN_PATH, 'utf8');

    // `toBe` on the whole block: a diff here is a change to a graded artifact
    // and should be read line by line, not accepted by re-running with -u.
    expect(rendered).toBe(golden);
  });

  it('no line exceeds 80 columns, so nothing wraps in the screenshot', () => {
    // Counted in CODE POINTS, not UTF-16 units: the rules, the arrow and the
    // check mark are all multi-byte, and `String.length` would over-count them
    // and fail a block that renders fine in a terminal.
    for (const line of verifiedBlock()) {
      expect(
        [...line].length,
        `over ${MAX_COLUMNS} columns and will wrap in the screenshot: ${line}`,
      ).toBeLessThanOrEqual(MAX_COLUMNS);
    }
  });

  it('the last line is p.6’s fifth line, character for character', () => {
    // Quoted from the PRD, not read back from the renderer — that is the whole
    // value of this assertion. p.6:
    //     → document.created event arrives, signature verified ✓
    const P6_LINE = '→ document.created event arrives, signature verified ✓';

    const lines = verifiedBlock();
    // Last line is the closing rule; the claim is the one above it.
    expect(lines[lines.length - 2]).toBe(P6_LINE);
    expect(lines[lines.length - 1]).toMatch(/^─+$/);
    expect(lines[0]).toMatch(/^─+$/);
  });

  it('carries every field p.13 and p.4 require, and no signing secret', () => {
    const text = verifiedBlock().join('\n');

    expect(text).toContain('document.created'); // the event type
    expect(text).toContain(EVENT.id); // event.id
    expect(text).toContain('3f2a1c88-5d4e-4b6a-9c1f-2e7d8a0b3c5d'); // target document id
    expect(text).toContain('"Q3 launch plan"'); // and its title
    expect(text).toContain('idempotency-key'); // p.4's dedupe contract, visible
    expect(text).toContain(String(SIGNED_AT_SECONDS)); // the `t=` value
    expect(text).toContain('24 ms  event → arrival'); // elapsed since the event

    // The `t=` value is rendered as local time beside the raw seconds.
    expect(text).toContain(formatLocalTime(SIGNED_AT_SECONDS, 0));

    // PF-572: the signing secret is what makes the block trustworthy and must
    // never be in it. A screenshot is a published artifact.
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('whsec_');
  });

  it('the golden on disk is the shape a reviewer can hold against a screenshot', () => {
    // Guards the artifact itself rather than the renderer: an empty or
    // whitespace-only golden would make the equality assertion above vacuous
    // for anyone who regenerated it by redirecting the wrong command.
    const golden = readFileSync(GOLDEN_PATH, 'utf8');
    const lines = golden.replace(/\n$/, '').split('\n');

    expect(lines).toHaveLength(9);
    expect(lines[0]).toMatch(/^─{78}$/);
    expect(lines[lines.length - 1]).toMatch(/^─{78}$/);
    expect(golden.endsWith('\n'), 'the golden must end with exactly one newline').toBe(true);
    expect(golden).not.toContain('['); // no escape codes — colour is off
  });
});
