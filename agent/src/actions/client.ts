/**
 * Everything FleetGraph is allowed to write back to Ship, and nothing else.
 *
 * ── Why this file is so small, and deliberately so ─────────────────────────
 * PRESEARCH.md Q3 draws the autonomy line at "additive and reversible": a
 * comment, a `document_history` note, a notification. Q4 draws the other half —
 * anything that mutates project state is proposed, never executed by the agent
 * on its own. `api_tokens` has no scope column, so a FleetGraph token inherits
 * the full permissions of the user who created it and the platform cannot
 * enforce either line for us. The boundary therefore has to be enforced where a
 * reviewer can see it, and this file is one of the two places it lives (the
 * other is `graph/nodes/routeAction.ts`, which decides WHETHER; this decides
 * HOW).
 *
 * So the client exposes two verbs. Not a generic `request(path, body)` with two
 * convenience wrappers — two verbs, and no way to name a third.
 *
 * ── FG-125: the bulk endpoint is unreachable, not merely unused ────────────
 * `POST /api/issues/bulk` takes up to 100 ids and writes NO `document_history`
 * rows (Q4). An agent-driven bulk update would therefore combine the widest
 * blast radius in the product with no audit trail at all — the one combination
 * that cannot be reviewed after the fact, which is the whole basis on which Q3
 * grants the agent any autonomy.
 *
 * "We just don't call it" is not a guarantee; it is a habit. Three things make
 * it structural here:
 *
 *   1. Requests are a closed discriminated union (`ShipRequest`), not strings.
 *      There is no `op` for bulk, so a bulk call is not expressible — it is a
 *      type error, not a code review finding.
 *   2. `pathOf` is the only place a URL is built, it is total over that union,
 *      and every document id goes through `encodeURIComponent`. A caller cannot
 *      smuggle `../bulk` through a targetId, because `/` does not survive.
 *   3. Every path `pathOf` can produce is checked against an ALLOWLIST that
 *      requires exactly one document id in it. An allowlist, rather than a
 *      blacklist of "bulk", because the property worth holding is "one document
 *      per request" — which is also what makes a future bulk-shaped endpoint
 *      fail closed instead of sliding through.
 *
 * ── Requirement 4: never hang, never loop, never crash ─────────────────────
 * Three separate mechanisms, because they fail differently:
 *
 *   timeout    an endpoint that accepts the connection and then stalls. Every
 *              attempt is aborted at REQUEST_TIMEOUT_MS. Without this, a cron
 *              run hangs holding a database connection and the SLA is met only
 *              by luck.
 *   retry      a single 429/503/reset. Bounded at MAX_ATTEMPTS with exponential
 *              backoff and full jitter, so a bad second does not become a
 *              thundering herd on the next run.
 *   breaker    the API is actually down. Retrying then multiplies both load and
 *              the latency every caller waits through — see the header of
 *              `api/src/services/circuitBreaker.ts`, which is where this
 *              reasoning is written down and why we import that class rather
 *              than write a second one.
 *
 * The three compose in one order and it matters: the breaker wraps the WHOLE
 * retry sequence, so three attempts count as one failure against the threshold.
 * The other order would open the circuit after fewer than two real failures.
 *
 * The worst case is bounded and computable rather than estimated:
 * `MAX_TOTAL_MS` below is 3 attempts of 5 s plus the two backoffs — 15.6 s,
 * which fits inside the 83 s of headroom the Q30 latency budget leaves.
 *
 * ── FG-124: a second breaker instance, not a second breaker ────────────────
 * `llm/client.ts` already holds one for Bedrock. This is another INSTANCE of
 * the same class, because the LLM being down and the Ship API being down are
 * independent events and Q25's degradation ladder treats them as separate rungs
 * — judgement can fail while delivery works, and vice versa. Sharing one
 * instance would make a Bedrock outage silently stop comments from posting.
 *
 * ── The import path is `api/dist`, and that is deliberate ──────────────────
 * Same trick as `llm/client.ts`: this package compiles with `rootDir: ./src`,
 * so importing a `.ts` outside it is a hard `tsc` error while importing the
 * built `.d.ts` is not. It costs nothing operationally because the agent ships
 * in the same image as the API (Q27), where `api/dist` exists by construction.
 *
 * ── Auth: a bearer `api_token`, per Q29 ────────────────────────────────────
 * `authMiddleware` checks for a Bearer token before falling through to session
 * cookies, and `api_tokens` rows are revocable, expiring, and record
 * `last_used_at`. The token arrives as an environment variable and is never
 * logged — `redact()` below exists so that an error string carrying a header
 * dump cannot leak it into `graph_state.errors`, which is persisted.
 */
import { createHash } from 'node:crypto';

import { CircuitBreaker, CircuitOpenError } from '../../../api/dist/services/circuitBreaker.js';

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/**
 * One attempt's ceiling.
 *
 * Deliberately tighter than the 20 s the model gets. A model call is the
 * expensive, variable term in the Q30 budget; a comment POST is two inserts
 * behind an indexed lookup. Anything past 5 s is a stalled connection, not a
 * slow query, and waiting longer only burns the headroom judgement needs.
 */
export const REQUEST_TIMEOUT_MS = 5_000;

/**
 * Bounded at 3, matching the Bedrock client. A retry buys recovery from one bad
 * response; a fourth attempt is how a bad minute becomes a queue of runs.
 */
export const MAX_ATTEMPTS = 3;

/** Backoff base. Doubles per attempt, with full jitter, capped. */
const BACKOFF_BASE_MS = 200;
const BACKOFF_CAP_MS = 2_000;

/**
 * The worst case, computed rather than guessed: every attempt times out and
 * every backoff draws its maximum. Exported so a test can assert the bound
 * still holds after someone edits the constants above — a silent change here
 * would eat the Q30 headroom with nothing failing.
 */
export const MAX_TOTAL_MS =
  MAX_ATTEMPTS * REQUEST_TIMEOUT_MS +
  Array.from({ length: MAX_ATTEMPTS - 1 }, (_, i) =>
    Math.min(BACKOFF_BASE_MS * 2 ** i, BACKOFF_CAP_MS)
  ).reduce((a, b) => a + b, 0);

/** Inherited from the Bedrock breaker rather than chosen again (Q25). */
const BREAKER_FAILURE_THRESHOLD = 5;
const BREAKER_COOLDOWN_MS = 60_000;

/**
 * The marker every automated write carries.
 *
 * A constant, not a parameter. `document_history.automated_by` is how "what did
 * the agent do last week" becomes a query anyone can run without agent-specific
 * tooling (Q3), and a caller able to pass a different string is a caller able to
 * write an unattributable row.
 */
export const AUTOMATED_BY = 'fleetgraph';

// ---------------------------------------------------------------------------
// The closed set of things this client can ask Ship to do
// ---------------------------------------------------------------------------

/**
 * Every request the agent can issue. Adding a member is the only way to widen
 * what FleetGraph can write, which makes widening it a diff a reviewer will see.
 */
type ShipRequest =
  | { op: 'post_comment'; documentId: string; body: CommentBody }
  | { op: 'log_history'; issueId: string; body: HistoryBody };

interface CommentBody {
  comment_id: string;
  content: string;
}

interface HistoryBody {
  field: string;
  old_value: string | null;
  new_value: string | null;
  automated_by: typeof AUTOMATED_BY;
}

/**
 * The one place a URL is built.
 *
 * Total over `ShipRequest`, so there is no default branch a new op could fall
 * through into, and every id is percent-encoded — `/` does not survive, so a
 * hostile or merely wrong `targetId` cannot walk the path anywhere else.
 */
function pathOf(req: ShipRequest): string {
  switch (req.op) {
    case 'post_comment':
      return `/api/documents/${encodeURIComponent(req.documentId)}/comments`;
    case 'log_history':
      return `/api/issues/${encodeURIComponent(req.issueId)}/history`;
  }
}

/**
 * Single-document allowlist (FG-125).
 *
 * Not `!path.includes('/bulk')`. A blacklist has to anticipate the next
 * dangerous endpoint by name; this says what the client is FOR — one document
 * id, one of two additive verbs — so anything else fails closed, including
 * endpoints nobody has written yet.
 */
const SINGLE_DOCUMENT_PATH =
  /^\/api\/(?:documents\/[0-9a-fA-F-]{36}\/comments|issues\/[0-9a-fA-F-]{36}\/history)$/;

/** Exported for the test that asserts a bulk-shaped path can never be produced. */
export function assertSingleDocumentPath(path: string): void {
  if (!SINGLE_DOCUMENT_PATH.test(path)) {
    throw new Error(
      `[fleetgraph] refusing "${path}": the action client may only address one document ` +
        'per request. POST /api/issues/bulk writes no document_history rows, so a bulk ' +
        'agent write would leave no audit trail (PRESEARCH.md Q4).'
    );
  }
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/**
 * A discriminated result rather than an exception, for the same reason
 * `callModel` returns one: every failure here is ordinary control flow. Q24
 * says a Ship API outage means findings queue and delivery retries next run —
 * never that the run dies.
 */
export type ShipResult<T = unknown> =
  | { ok: true; status: number; data: T }
  | {
      ok: false;
      reason: 'circuit_open' | 'timeout' | 'network_error' | 'http_error';
      status?: number;
      detail: string;
    };

// ---------------------------------------------------------------------------
// Injectable seams (engineering requirement 3)
// ---------------------------------------------------------------------------

/**
 * The shape of `fetch` this client uses, declared structurally.
 *
 * Structural rather than `typeof globalThis.fetch` so a test passes a plain
 * function — no network interceptor, no undici internals, and no dependency on
 * the DOM lib, which this package does not enable.
 */
export interface HttpResponse {
  status: number;
  ok: boolean;
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  }
) => Promise<HttpResponse>;

export interface ShipClientOptions {
  /** Defaults to `SHIP_API_URL`. */
  baseUrl?: string;
  /** Defaults to `SHIP_API_TOKEN`. The `api_tokens` bearer from Q29. */
  token?: string;
  fetchImpl?: FetchLike;
  /** Injected so retry tests do not sleep for real. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected so a suite can start from an open circuit. */
  breaker?: CircuitBreaker;
  /** Injected so jitter is reproducible under test. */
  random?: () => number;
}

/**
 * The process-wide breaker for the Ship API.
 *
 * Module-level and shared by every client built without an explicit one, because
 * the breaker guards the DEPENDENCY, not the caller. Two clients each with their
 * own breaker would each independently discover the API is down, at twice the
 * cost of finding out once.
 */
const shipApiBreaker = new CircuitBreaker({
  name: 'fleetgraph-ship-api',
  failureThreshold: BREAKER_FAILURE_THRESHOLD,
  cooldownMs: BREAKER_COOLDOWN_MS,
});

/** For the health endpoint (Q28) and for tests. */
export function getShipApiBreakerStats() {
  return shipApiBreaker.stats;
}

/** Test seam: start from a known circuit state. */
export function resetShipApiBreaker(): void {
  shipApiBreaker.reset();
}

export { CircuitBreaker, CircuitOpenError };

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export interface ShipClient {
  /**
   * FG-126 — post a comment on a document.
   *
   * Additive and reversible: a human can delete it, and nothing about the
   * project changed (Q3). This is the only thing the agent says out loud
   * without being asked.
   */
  postComment(documentId: string, content: string): Promise<ShipResult>;

  /**
   * FG-127 — write one `document_history` row attributed to the agent.
   *
   * Uses `POST /api/issues/:id/history`, which calls Ship's own
   * `logDocumentChange` with the `automated_by` parameter the schema already
   * has (migration 016). Building a parallel `fleetgraph_actions` log instead
   * would mean "what did the agent change" needed agent-specific tooling to
   * answer, and would drift from the history the UI already renders.
   *
   * CONSTRAINT WORTH KNOWING: that route verifies `document_type = 'issue'`
   * before writing, so it 404s for a sprint or project target. Callers check
   * the target type rather than discovering it as an error — see `act.ts`.
   */
  logHistoryNote(
    issueId: string,
    entry: { field: string; oldValue?: string | null; newValue: string | null }
  ): Promise<ShipResult>;
}

export function createShipClient(options: ShipClientOptions = {}): ShipClient {
  const baseUrl = (options.baseUrl ?? process.env.SHIP_API_URL ?? '').replace(/\/+$/, '');
  const token = options.token ?? process.env.SHIP_API_TOKEN ?? '';
  const doFetch = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const breaker = options.breaker ?? shipApiBreaker;
  const random = options.random ?? Math.random;

  /**
   * One attempt. Aborted at the deadline whatever the server is doing.
   *
   * `AbortController` rather than `Promise.race`: a race leaves the request in
   * flight holding a socket, which is how a process that "timed out" still runs
   * out of file descriptors.
   */
  async function attempt(path: string, body: unknown): Promise<ShipResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await doFetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Q29. Ship's authMiddleware reads this before session cookies.
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await res.text();

      if (!res.ok) {
        return {
          ok: false,
          reason: 'http_error',
          status: res.status,
          detail: `${path} -> ${res.status} ${redact(text).slice(0, 300)}`,
        };
      }

      return { ok: true, status: res.status, data: parseJson(text) };
    } catch (err) {
      const message = redact(err instanceof Error ? err.message : String(err));
      // An abort is our own deadline firing, not the network failing. Kept
      // distinct because they mean different things to whoever reads the error:
      // one says Ship is slow, the other says Ship is unreachable.
      const aborted =
        controller.signal.aborted || (err instanceof Error && err.name === 'AbortError');
      return {
        ok: false,
        reason: aborted ? 'timeout' : 'network_error',
        detail: `${path} -> ${aborted ? `aborted after ${REQUEST_TIMEOUT_MS}ms` : message}`,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * FG-123 — the retry sequence.
   *
   * Retries only what a retry can fix. A 400 or a 404 will fail identically
   * three times; retrying it wastes the budget and delays the honest error.
   * 408/429/5xx and transport failures are the retryable set.
   *
   * Full jitter rather than plain exponential: every workspace in a cron run
   * that hits a throttled API would otherwise back off in lockstep and retry in
   * lockstep, which reproduces the burst that caused the throttle.
   */
  async function send(path: string, req: ShipRequest): Promise<ShipResult> {
    let last: ShipResult = {
      ok: false,
      reason: 'network_error',
      detail: 'no attempt was made',
    };

    for (let n = 1; n <= MAX_ATTEMPTS; n++) {
      last = await attempt(path, req.body);
      if (last.ok) return last;
      if (!indicatesDependencyFailure(last)) return last;
      if (n === MAX_ATTEMPTS) break;

      const ceiling = Math.min(BACKOFF_BASE_MS * 2 ** (n - 1), BACKOFF_CAP_MS);
      await sleep(Math.floor(random() * ceiling));
    }

    return last;
  }

  /**
   * The breaker wraps the whole sequence, so `MAX_ATTEMPTS` failed attempts are
   * ONE failure against the threshold. Wrapping each attempt instead would open
   * the circuit after two genuine failures rather than five, and a single
   * unlucky deploy would silence delivery for a minute.
   *
   * Only failures that say something about the DEPENDENCY'S health count. A 404
   * on a document someone deleted, or a 400 from a body we built wrong, is our
   * bug — and five of them in a row would otherwise open the circuit and stop
   * comments posting to every healthy document in the workspace. The breaker
   * exists to stop us hammering something that is down, not to punish us for
   * asking the wrong question.
   */
  async function guarded(req: ShipRequest): Promise<ShipResult> {
    // Outside the breaker and outside the catch, deliberately. A path the
    // allowlist rejects is a programming error, not a Ship outage: it must not
    // count toward opening the circuit, and it must be loud rather than
    // degrading into an ordinary failed delivery that someone reads past.
    const path = pathOf(req);
    assertSingleDocumentPath(path);

    try {
      return await breaker.run(async () => {
        const result = await send(path, req);
        // The breaker counts thrown errors, and `send` does not throw. Throwing
        // here is what makes a failed call visible to it; the catch below turns
        // it straight back into the result the caller expects.
        if (!result.ok && indicatesDependencyFailure(result)) throw new ShipCallFailed(result);
        return result;
      });
    } catch (err) {
      if (err instanceof ShipCallFailed) return err.result;
      if (err instanceof CircuitOpenError) {
        return {
          ok: false,
          reason: 'circuit_open',
          // Not an error the caller should act on: Q24 says findings queue and
          // delivery retries next run. The watermark has not advanced.
          detail: `Ship API circuit is open (${err.message}) — delivery retries next run`,
        };
      }
      return {
        ok: false,
        reason: 'network_error',
        detail: redact(err instanceof Error ? err.message : String(err)),
      };
    }
  }

  return {
    async postComment(documentId, content) {
      return guarded({
        op: 'post_comment',
        documentId,
        body: {
          // The API requires a client-supplied `comment_id` (it is the TipTap
          // mark id). Derived deterministically from the target and the text
          // rather than random, so a retry after a timeout re-sends the SAME
          // id. Ship does not dedupe on it, so this does not make the POST
          // idempotent — it makes a double-post detectable with a query
          // instead of invisible, which is the most the endpoint allows.
          comment_id: deterministicUuid(`${documentId} ${content}`),
          content,
        },
      });
    },

    async logHistoryNote(issueId, entry) {
      return guarded({
        op: 'log_history',
        issueId,
        body: {
          field: entry.field,
          old_value: entry.oldValue ?? null,
          new_value: entry.newValue,
          automated_by: AUTOMATED_BY,
        },
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Carries a failed `ShipResult` through the breaker, which counts throws. */
class ShipCallFailed extends Error {
  constructor(readonly result: Extract<ShipResult, { ok: false }>) {
    super(result.detail);
    this.name = 'ShipCallFailed';
  }
}

/**
 * Does this failure say the dependency is unwell?
 *
 * One predicate for two decisions — whether to retry, and whether the breaker
 * should count it — because the answer is the same in both cases and for the
 * same reason. A timeout, a reset, a 503 or a 429 mean Ship is struggling: a
 * retry might land, and five in a row mean stop trying. A 400 or a 404 mean we
 * asked the wrong question: a retry will fail identically, and counting it
 * would let our own bug open a circuit that then blocks correct calls.
 */
function indicatesDependencyFailure(result: Extract<ShipResult, { ok: false }>): boolean {
  if (result.reason === 'timeout' || result.reason === 'network_error') return true;
  if (result.reason !== 'http_error' || result.status === undefined) return false;
  return result.status === 408 || result.status === 429 || result.status >= 500;
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Strip anything that looks like the bearer token out of a string.
 *
 * Error details end up in `GraphState.errors`, which is checkpointed to
 * Postgres and rendered in traces. A fetch implementation that echoes request
 * headers into its error message would otherwise persist the credential.
 */
function redact(s: string): string {
  return s.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer ***');
}

/**
 * A stable UUID from a seed. Shaped as v4 because that is what Ship's zod
 * schema validates; the value is a hash, not randomness, which is the point.
 */
function deterministicUuid(seed: string): string {
  const b = Buffer.from(createHash('sha256').update(seed).digest().subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
