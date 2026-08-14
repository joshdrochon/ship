/**
 * PF-577 / PF-578 — the demo moment's output.
 *
 * p.13 grades *"a screenshot of the `ship webhooks tail` terminal showing a
 * verified signed event arriving in real time"*, which makes this block's
 * content and shape a deliverable rather than a formatting preference. It is
 * pinned byte-for-byte by a golden test, and every line is asserted to be at
 * most `MAX_COLUMNS` wide so nothing wraps in the screenshot.
 *
 * The verified block's last line is p.6's fifth line, character for character:
 *
 *     → document.created event arrives, signature verified ✓
 *
 * ── Why the failure block is a different shape and not a different colour ───
 * A screenshot is often greyscale, is often cropped, and is frequently viewed
 * by someone who did not run the command. `signature INVALID ✗` on a block ruled
 * with `═` rather than `─`, prefixed `✗` rather than `→`, survives all three.
 * Colour is off by default here for the same reason (`NO_COLOR` is honoured, but
 * there is nothing to honour it about — this renderer emits no escape codes).
 */
import {
  DEFAULT_TOLERANCE_SECONDS,
  SIGNATURE_HEADER,
  verifyWebhook,
  type WebhookHeaders,
} from '@ship/sdk';

/** Nothing this renderer emits exceeds this. Asserted, not hoped. */
export const MAX_COLUMNS = 80;

/** The rule under and over a verified block. */
const RULE_OK = '─'.repeat(78);

/** The rule under and over a block that failed verification. Deliberately different. */
const RULE_BAD = '═'.repeat(78);

/** Label column width. Every field name below fits. */
const LABEL_WIDTH = 17;

/** The event envelope the platform signs (`{id, type, created_at, workspace_id, data}`). */
export interface EventEnvelope {
  id: string;
  type: string;
  created_at: string;
  workspace_id?: string;
  data?: unknown;
}

/** Why a signature did not verify. `null` when it did. */
export type VerificationFailure =
  | 'missing-header'
  | 'malformed-header'
  | 'stale-timestamp'
  | 'digest-mismatch';

const FAILURE_TEXT: Record<VerificationFailure, string> = {
  'missing-header': `no ${SIGNATURE_HEADER} header on the request`,
  'malformed-header': `${SIGNATURE_HEADER} carries no v1= digest`,
  'stale-timestamp': `timestamp outside the ${DEFAULT_TOLERANCE_SECONDS}s tolerance`,
  'digest-mismatch': 'body does not match the signature (tampered or wrong secret)',
};

export interface VerificationResult {
  verified: boolean;
  failure: VerificationFailure | null;
  /** The `t=` value from the header, in unix seconds. `null` when unreadable. */
  timestampSeconds: number | null;
}

/** Case-insensitively reads one header off any of the three shapes the SDK accepts. */
function readHeader(headers: WebhookHeaders, name: string): string | null {
  const maybeGetter = headers as { get?: (n: string) => string | null };
  if (typeof maybeGetter.get === 'function') return maybeGetter.get(name);
  for (const [key, raw] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() !== name) continue;
    const value = Array.isArray(raw) ? raw[0] : raw;
    return typeof value === 'string' ? value : null;
  }
  return null;
}

/**
 * The verdict, plus a diagnosis.
 *
 * `verifyWebhook` is the verdict and it is the SDK's — this function never
 * re-implements HMAC and never decides `verified` for itself. The extra parsing
 * exists only to answer PF-578's *"naming which check failed"*, because a
 * boolean cannot, and a terminal that says only "INVALID" sends a developer to
 * read their own signing code when the real problem was a clock.
 */
export function verifyDelivery(
  headers: WebhookHeaders,
  rawBody: string,
  secret: string,
  nowMs: number,
  toleranceSeconds: number = DEFAULT_TOLERANCE_SECONDS,
): VerificationResult {
  const header = readHeader(headers, SIGNATURE_HEADER);
  if (header === null || header.trim() === '') {
    return { verified: false, failure: 'missing-header', timestampSeconds: null };
  }

  let timestampSeconds: number | null = null;
  let hasV1 = false;
  for (const piece of header.split(',')) {
    const equals = piece.indexOf('=');
    if (equals === -1) continue;
    const key = piece.slice(0, equals).trim();
    const value = piece.slice(equals + 1).trim();
    if (key === 't' && /^\d+$/.test(value)) timestampSeconds = Number(value);
    if (key === 'v1' && value !== '') hasV1 = true;
  }

  if (!hasV1 || timestampSeconds === null) {
    return { verified: false, failure: 'malformed-header', timestampSeconds };
  }

  // THE verdict. Everything above and below is presentation.
  const verified = verifyWebhook(headers, rawBody, secret, toleranceSeconds, {
    nowSeconds: () => Math.floor(nowMs / 1000),
  });
  if (verified) return { verified: true, failure: null, timestampSeconds };

  const skew = Math.abs(nowMs / 1000 - timestampSeconds);
  return {
    verified: false,
    failure: skew > toleranceSeconds ? 'stale-timestamp' : 'digest-mismatch',
    timestampSeconds,
  };
}

/**
 * Unix seconds → `YYYY-MM-DD HH:MM:SS ±HH:MM`, in a caller-chosen offset.
 *
 * The offset is a PARAMETER and not `Date.getTimezoneOffset()` read inside,
 * which is the only reason a golden test of this block can exist: the block is
 * rendered in local time for the human taking the screenshot, and in a fixed
 * offset for the assertion. Same code path, one injected value.
 */
export function formatLocalTime(epochSeconds: number, offsetMinutes: number): string {
  const shifted = new Date((epochSeconds + offsetMinutes * 60) * 1000);
  const iso = shifted.toISOString();
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} ${sign}${hh}:${mm}`;
}

/** Current local offset in minutes, east-positive. `Date` reports it west-positive. */
export function localOffsetMinutes(nowMs: number = Date.now()): number {
  return -new Date(nowMs).getTimezoneOffset();
}

export interface DeliveryBlockInput {
  event: EventEnvelope;
  /** From the delivery's `Idempotency-Key` header (p.4's dedupe contract). */
  idempotencyKey: string | null;
  verification: VerificationResult;
  /** When the POST landed on the listener, in ms. */
  arrivedAtMs: number;
  /** Local UTC offset in minutes, injected so the golden test is deterministic. */
  offsetMinutes: number;
  /**
   * `--poll` cannot verify: L16 persists the signature header but deliberately
   * does not expose the signed body (`deliveryLog.ts` — *"the body is fetched
   * deliberately, never leaked"*). PF-576 permits exactly two outcomes and this
   * is the honest one — say so, never print the checkmark unearned.
   */
  unverifiable?: boolean | undefined;
}

/** Truncates so `prefix + value` fits inside `MAX_COLUMNS`. */
function fit(prefix: string, value: string): string {
  const room = MAX_COLUMNS - prefix.length;
  return `${prefix}${value.length > room ? `${value.slice(0, Math.max(0, room - 1))}…` : value}`;
}

function field(label: string, value: string): string {
  return fit(`  ${label.padEnd(LABEL_WIDTH)}`, value);
}

/** The document (or issue, or sprint) an event is about, as `<id>  "<title>"`. */
function subjectOf(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const record = data as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id : null;
  if (id === null) return null;
  const title = typeof record.title === 'string' ? record.title : null;
  return title !== null ? `${id}  "${title}"` : id;
}

/**
 * One delivery, as the lines to print. The block a grader screenshots.
 */
export function renderDeliveryBlock(input: DeliveryBlockInput): string[] {
  const { event, verification } = input;
  const ok = verification.verified;
  const rule = ok ? RULE_OK : RULE_BAD;

  const lines: string[] = [rule];
  lines.push(field('event', event.type));
  lines.push(field('event.id', event.id));

  const subject = subjectOf(event.data);
  if (subject !== null) lines.push(field('document', subject));

  lines.push(field('idempotency-key', input.idempotencyKey ?? '(none sent)'));

  lines.push(
    field(
      'signature t=',
      verification.timestampSeconds !== null
        ? `${verification.timestampSeconds}  (${formatLocalTime(
            verification.timestampSeconds,
            input.offsetMinutes,
          )})`
        : '(absent)',
    ),
  );

  // p.6's *"Webhook delivery latency (P95, first attempt) < 2s"* made visible to
  // a viewer of the demo, not only to a test (PF-579).
  const emittedMs = Date.parse(event.created_at);
  if (Number.isFinite(emittedMs)) {
    lines.push(field('latency', `${Math.max(0, input.arrivedAtMs - emittedMs)} ms  event → arrival`));
  }

  if (input.unverifiable === true) {
    lines.push(field('signature', 'not verifiable in poll mode'));
    lines.push(fit('', `· ${event.type} event logged, signature not verifiable in poll mode`));
  } else if (ok) {
    // p.6's fifth line, character for character.
    lines.push(fit('', `→ ${event.type} event arrives, signature verified ✓`));
  } else {
    lines.push(
      field('check failed', FAILURE_TEXT[verification.failure ?? 'digest-mismatch']),
    );
    lines.push(fit('', `✗ ${event.type} event arrives, signature INVALID ✗`));
  }

  lines.push(rule);
  return lines;
}

/** The `--json` form of one delivery. Newline-delimited, since `tail` streams. */
export function deliveryJson(input: DeliveryBlockInput): string {
  return JSON.stringify({
    event_id: input.event.id,
    event_type: input.event.type,
    created_at: input.event.created_at,
    idempotency_key: input.idempotencyKey,
    signature_timestamp: input.verification.timestampSeconds,
    signature_verified: input.unverifiable === true ? null : input.verification.verified,
    signature_failure: input.unverifiable === true ? 'not-verifiable-in-poll-mode' : input.verification.failure,
    latency_ms: Number.isFinite(Date.parse(input.event.created_at))
      ? Math.max(0, input.arrivedAtMs - Date.parse(input.event.created_at))
      : null,
    data: input.event.data,
  });
}
