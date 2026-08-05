/**
 * The action client's four load-bearing claims, asserted rather than described.
 *
 *   FG-122  every call carries the bearer `api_token` and names one document
 *   FG-123  every call has a deadline and a bounded, backed-off retry
 *   FG-124  a SEPARATE breaker instance guards the Ship API
 *   FG-125  no code path can reach `POST /api/issues/bulk`
 *
 * No network and no container. `fetch` is injected (engineering requirement 3),
 * which is what lets these assertions be about the client rather than about an
 * interceptor — "three attempts were made" is a count on a fake, not an
 * inference from a mock's call log.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  createShipClient,
  assertSingleDocumentPath,
  getShipApiBreakerStats,
  resetShipApiBreaker,
  CircuitBreaker,
  AUTOMATED_BY,
  MAX_ATTEMPTS,
  MAX_TOTAL_MS,
  REQUEST_TIMEOUT_MS,
  type FetchLike,
} from './client.js';
import { getLlmBreakerStats, resetLlmBreaker } from '../llm/client.js';

const DOC = '11111111-2222-4333-8444-555555555555';
const BASE = 'http://ship.test';
const TOKEN = 'ship_tok_secret';

interface Call {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * A stable fake Ship API.
 *
 * Takes a queue of responses; records every request. A plain function rather
 * than a network interceptor, so the suite is reproducible in CI regardless of
 * local state (requirement 3).
 */
function fakeShip(responses: Array<{ status: number; body?: unknown } | 'network_error'>) {
  const calls: Call[] = [];
  let i = 0;

  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({
      url,
      headers: init.headers,
      body: init.body ? JSON.parse(init.body) : null,
    });
    const next = responses[Math.min(i, responses.length - 1)];
    i++;
    if (next === 'network_error') throw new Error('ECONNREFUSED 10.0.0.1:3000');
    return {
      status: next!.status,
      ok: next!.status >= 200 && next!.status < 300,
      text: async () => JSON.stringify(next!.body ?? { ok: true }),
    };
  };

  return { calls, fetchImpl };
}

/** A client with every seam pinned: instant sleeps, no jitter, own breaker. */
function clientWith(fetchImpl: FetchLike, breaker = freshBreaker()) {
  const slept: number[] = [];
  const client = createShipClient({
    baseUrl: BASE,
    token: TOKEN,
    fetchImpl,
    sleep: async (ms) => {
      slept.push(ms);
    },
    // Full jitter draws in [0, ceiling). Pinned at its top so the backoff
    // SHAPE is assertable; the randomness itself is asserted separately.
    random: () => 0.999999,
    breaker,
  });
  return { client, slept, breaker };
}

function freshBreaker() {
  return new CircuitBreaker({
    name: 'test-ship-api',
    failureThreshold: 5,
    cooldownMs: 60_000,
  });
}

beforeEach(() => {
  resetShipApiBreaker();
  resetLlmBreaker();
});

describe('FG-122 — the Ship HTTP client', () => {
  it('sends the bearer token and the comment body to the document comments route', async () => {
    const { calls, fetchImpl } = fakeShip([{ status: 201 }]);
    const { client } = clientWith(fetchImpl);

    const result = await client.postComment(DOC, 'four issues have not moved in two weeks');

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}/api/documents/${DOC}/comments`);
    // Q29: authMiddleware reads Bearer before falling through to session cookies.
    expect(calls[0]!.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]!.headers['Content-Type']).toBe('application/json');

    const body = calls[0]!.body as { comment_id: string; content: string };
    expect(body.content).toContain('four issues have not moved');
    // Ship's zod schema requires a uuid here; a malformed one is a 400 that no
    // retry can fix.
    expect(body.comment_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  it('derives comment_id deterministically, so a retried POST is not a new comment', async () => {
    // The endpoint has no idempotency key and does not dedupe. Deriving the id
    // from the content is the most the API allows: it does not prevent a
    // double-post after a timeout, it makes one findable with a query.
    const a = fakeShip([{ status: 201 }]);
    const b = fakeShip([{ status: 201 }]);
    const c = fakeShip([{ status: 201 }]);

    await clientWith(a.fetchImpl).client.postComment(DOC, 'same text');
    await clientWith(b.fetchImpl).client.postComment(DOC, 'same text');
    await clientWith(c.fetchImpl).client.postComment(DOC, 'different text');

    const id = (x: typeof a) => (x.calls[0]!.body as { comment_id: string }).comment_id;
    expect(id(a)).toBe(id(b));
    expect(id(a)).not.toBe(id(c));
  });

  it('FG-127 — a history note is attributed to fleetgraph and nothing else can be spelled', async () => {
    const { calls, fetchImpl } = fakeShip([{ status: 201 }]);
    const { client } = clientWith(fetchImpl);

    const result = await client.logHistoryNote(DOC, {
      field: 'fleetgraph_comment',
      newValue: 'stalled_work: measured 14, threshold 5',
    });

    expect(result.ok).toBe(true);
    expect(calls[0]!.url).toBe(`${BASE}/api/issues/${DOC}/history`);

    const body = calls[0]!.body as Record<string, unknown>;
    // The column migration 016 added, through the parameter logDocumentChange
    // already takes. Not a parallel agent-only log.
    expect(body.automated_by).toBe(AUTOMATED_BY);
    expect(body.automated_by).toBe('fleetgraph');
    expect(body.field).toBe('fleetgraph_comment');
    expect(body.old_value).toBeNull();

    // There is no parameter on logHistoryNote that could change it — the marker
    // is baked into the request body, so an unattributable row is unwritable.
    expect(Object.keys(body).sort()).toEqual(
      ['automated_by', 'field', 'new_value', 'old_value'].sort()
    );
  });

  it('never leaks the bearer token into an error detail', async () => {
    // Error details land in GraphState.errors, which is checkpointed to
    // Postgres and rendered in traces.
    const fetchImpl: FetchLike = async () => {
      throw new Error(`connect failed for request with Authorization: Bearer ${TOKEN}`);
    };
    const { client } = clientWith(fetchImpl);

    const result = await client.postComment(DOC, 'x');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).not.toContain(TOKEN);
    expect(result.detail).toContain('Bearer ***');
  });
});

describe('FG-125 — the bulk endpoint is unreachable, not merely unused', () => {
  it('rejects the real bulk path outright', () => {
    // POST /api/issues/bulk writes no document_history rows (Q4). The widest
    // blast radius in the product with no audit trail is the one combination
    // that cannot be reviewed after the fact.
    expect(() => assertSingleDocumentPath('/api/issues/bulk')).toThrow(/one document per request/);
    expect(() => assertSingleDocumentPath('/api/issues/bulk')).toThrow(/document_history/);
  });

  it('rejects anything that is not one of the two single-document verbs', () => {
    // An allowlist, not a blacklist of "bulk": endpoints nobody has written yet
    // fail closed too.
    for (const path of [
      '/api/issues',
      '/api/documents',
      `/api/issues/${DOC}`,
      `/api/documents/${DOC}`,
      `/api/documents/${DOC}/comments/extra`,
      '/api/issues/all/history',
    ]) {
      expect(() => assertSingleDocumentPath(path), path).toThrow();
    }
  });

  it('accepts exactly the two paths the client can build', () => {
    expect(() => assertSingleDocumentPath(`/api/documents/${DOC}/comments`)).not.toThrow();
    expect(() => assertSingleDocumentPath(`/api/issues/${DOC}/history`)).not.toThrow();
  });

  it('cannot be walked out of its path by a hostile targetId', async () => {
    // Every id goes through encodeURIComponent, so `/` does not survive. The
    // request then fails the allowlist rather than reaching a different route.
    const { calls, fetchImpl } = fakeShip([{ status: 201 }]);
    const { client } = clientWith(fetchImpl);

    await expect(client.postComment('../../issues/bulk', 'x')).rejects.toThrow(
      /one document per request/
    );
    expect(calls, 'nothing may reach the network').toHaveLength(0);
  });
});

describe('FG-123 — timeout and bounded retry with exponential backoff', () => {
  it('retries a 503 and succeeds, backing off between attempts', async () => {
    const { calls, fetchImpl } = fakeShip([
      { status: 503 },
      { status: 503 },
      { status: 201, body: { id: 'c1' } },
    ]);
    const { client, slept } = clientWith(fetchImpl);

    const result = await client.postComment(DOC, 'hello');

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(3);
    // Exponential: the second wait is twice the first.
    expect(slept).toHaveLength(2);
    expect(slept[1]!).toBeGreaterThan(slept[0]!);
    expect(slept[1]!).toBeCloseTo(slept[0]! * 2, -1);
  });

  it('stops at MAX_ATTEMPTS rather than looping', async () => {
    // "Never loop" is an explicit requirement, not an aspiration.
    const { calls, fetchImpl } = fakeShip([{ status: 500 }]);
    const { client } = clientWith(fetchImpl);

    const result = await client.postComment(DOC, 'hello');

    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(MAX_ATTEMPTS);
    expect(MAX_ATTEMPTS).toBe(3);
  });

  it('retries a transport failure, which is what a restarting API looks like', async () => {
    const { calls, fetchImpl } = fakeShip(['network_error', 'network_error', { status: 201 }]);
    const { client } = clientWith(fetchImpl);

    expect((await client.postComment(DOC, 'hello')).ok).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it('does NOT retry a 400 or a 404 — our bug, not Ship being unwell', async () => {
    for (const status of [400, 404, 403]) {
      const { calls, fetchImpl } = fakeShip([{ status, body: { error: 'nope' } }]);
      const { client } = clientWith(fetchImpl);

      const result = await client.postComment(DOC, 'hello');
      expect(result.ok, `${status}`).toBe(false);
      expect(calls, `${status} must not be retried`).toHaveLength(1);
    }
  });

  it('retries 408 and 429, which a retry can actually fix', async () => {
    for (const status of [408, 429]) {
      const { calls, fetchImpl } = fakeShip([{ status }, { status: 201 }]);
      const { client } = clientWith(fetchImpl);

      expect((await client.postComment(DOC, 'hello')).ok, `${status}`).toBe(true);
      expect(calls).toHaveLength(2);
    }
  });

  it('jitters the backoff instead of retrying in lockstep', async () => {
    // Every workspace in a cron run that hits a throttled API would otherwise
    // back off together and retry together, reproducing the burst.
    const draws: number[] = [];
    const client = createShipClient({
      baseUrl: BASE,
      token: TOKEN,
      fetchImpl: fakeShip([{ status: 503 }]).fetchImpl,
      sleep: async (ms) => {
        draws.push(ms);
      },
      random: (() => {
        const seq = [0.1, 0.9];
        let n = 0;
        return () => seq[n++ % seq.length]!;
      })(),
      breaker: freshBreaker(),
    });

    await client.postComment(DOC, 'hello');
    expect(draws).toHaveLength(2);
    // 0.1 * 200 = 20; 0.9 * 400 = 360. Different draws, not a fixed ladder.
    expect(draws[0]).toBe(20);
    expect(draws[1]).toBe(360);
  });

  it('aborts an attempt at the deadline rather than hanging forever', async () => {
    // The failure mode: an endpoint that accepts the connection and never
    // answers. Without the abort, a cron run hangs holding a DB connection and
    // the "never hang" requirement is met only by luck.
    vi.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      const fetchImpl: FetchLike = (_url, init) =>
        new Promise((_resolve, reject) => {
          signals.push(init.signal!);
          init.signal!.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });

      const { client } = clientWith(fetchImpl);
      const pending = client.postComment(DOC, 'hello');

      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS * MAX_ATTEMPTS + 100);
      const result = await pending;

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('timeout');
      expect(result.detail).toContain(`${REQUEST_TIMEOUT_MS}ms`);
      expect(signals, 'each attempt gets its own deadline').toHaveLength(MAX_ATTEMPTS);
      expect(signals.every((s) => s.aborted)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds the worst case inside the Q30 latency headroom', async () => {
    // The Q30 budget leaves 83 s of headroom against the 300 s SLA. This is the
    // guard on that number: a well-meant bump of REQUEST_TIMEOUT_MS or
    // MAX_ATTEMPTS would eat it with nothing else failing.
    expect(MAX_TOTAL_MS).toBe(MAX_ATTEMPTS * REQUEST_TIMEOUT_MS + 200 + 400);
    expect(MAX_TOTAL_MS).toBe(15_600);
    expect(MAX_TOTAL_MS).toBeLessThan(83_000);
  });
});

describe('FG-124 — a second breaker instance for the Ship API', () => {
  it('opens after five consecutive failed CALLS, not five failed attempts', async () => {
    // The ordering claim. The breaker wraps the whole retry sequence, so three
    // attempts count once. Wrapping each attempt would open the circuit after
    // two genuine failures and silence delivery for a minute on one bad deploy.
    const { calls, fetchImpl } = fakeShip([{ status: 503 }]);
    const { client } = clientWith(fetchImpl);

    for (let n = 0; n < 5; n++) {
      const r = await client.postComment(DOC, `attempt ${n}`);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('http_error');
    }

    expect(calls, '5 calls x 3 attempts').toHaveLength(15);

    const sixth = await client.postComment(DOC, 'sixth');
    expect(sixth.ok).toBe(false);
    if (sixth.ok) return;
    expect(sixth.reason).toBe('circuit_open');
    expect(sixth.detail).toContain('retries next run');
    expect(calls, 'an open circuit must not touch the network').toHaveLength(15);
  });

  it('does not count a 404 against the circuit', async () => {
    // Our bug must not be able to open a circuit that then blocks correct calls
    // to every other document in the workspace.
    const { fetchImpl } = fakeShip([{ status: 404 }]);
    const { client, breaker } = clientWith(fetchImpl);

    for (let n = 0; n < 8; n++) await client.postComment(DOC, `attempt ${n}`);

    expect(breaker.stats.state).toBe('closed');
    expect(breaker.stats.consecutiveFailures).toBe(0);
  });

  it('is a DIFFERENT instance from the LLM breaker', async () => {
    // Q25's ladder treats them as separate rungs: judgement can fail while
    // delivery works, and vice versa. Sharing one instance would make a Bedrock
    // outage silently stop comments from posting.
    const { fetchImpl } = fakeShip([{ status: 503 }]);
    // No injected breaker — this exercises the module-level one the graph uses.
    const client = createShipClient({
      baseUrl: BASE,
      token: TOKEN,
      fetchImpl,
      sleep: async () => {},
      random: () => 0,
    });

    for (let n = 0; n < 5; n++) await client.postComment(DOC, `attempt ${n}`);

    expect(getShipApiBreakerStats().state).toBe('open');
    expect(getLlmBreakerStats().state, 'a Ship outage must not gate the model').toBe('closed');
    expect(getLlmBreakerStats().consecutiveFailures).toBe(0);
  });

  it('recovers: after the cooldown one probe is let through', async () => {
    // Degrade, then come back. A breaker that never closes is an outage that
    // outlives the outage.
    let clock = 0;
    const breaker = new CircuitBreaker({
      name: 'test-recovery',
      failureThreshold: 2,
      cooldownMs: 1_000,
      now: () => clock,
    });

    let status = 503;
    const fetchImpl: FetchLike = async () => ({
      status,
      ok: status < 300,
      text: async () => '{}',
    });
    const { client } = clientWith(fetchImpl, breaker);

    await client.postComment(DOC, 'a');
    await client.postComment(DOC, 'b');
    expect(breaker.stats.state).toBe('open');

    clock += 1_001;
    status = 201;
    const probe = await client.postComment(DOC, 'c');
    expect(probe.ok).toBe(true);
    expect(breaker.stats.state).toBe('closed');
  });
});
