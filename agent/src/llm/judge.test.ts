/**
 * Judgement, with the provider replaced by a counting fake.
 *
 * The counter is the point. "Degrades gracefully when the LLM is down" is easy
 * to claim and easy to fake — a test that mocks the judge module and asserts it
 * returned nothing proves only that the mock returned nothing. These tests hold
 * a fake that increments on every call, so the assertions are about what the
 * real code path did: whether the provider was reached at all, and how many
 * times for how many signals.
 *
 * No network, no database, no LangChain object. Engineering requirement 3 wants
 * a stable fake for every external service; for the model, the fake is a plain
 * object with one method.
 */
import { describe, it, expect, beforeEach } from 'vitest';

import { judgeSignals, makeJudge, JudgementUnavailableError, clearJudgmentCache } from './judge.js';
import { CircuitBreaker, type PromptedModel } from './client.js';
import type { JudgeInput } from './judge.js';
import type { Signal } from '../detectors/types.js';

const ASSIGNEE = '11111111-1111-1111-1111-111111111111';
const SPRINT_OWNER = '22222222-2222-2222-2222-222222222222';

function signal(overrides: Partial<Signal> = {}): Signal {
  return {
    type: 'stalled_work',
    targetId: '33333333-3333-3333-3333-333333333333',
    targetType: 'issue',
    targetTitle: 'Wire up the export endpoint',
    measurement: 7,
    threshold: 5,
    bucket: '5-9d',
    fingerprint: 'stalled_work:33333333:5-9d',
    context: { status: 'in_progress', business_days_idle: 7 },
    accountableUserId: ASSIGNEE,
    ...overrides,
  };
}

function input(signals: Signal[]): JudgeInput {
  return {
    signals,
    participants: [
      { userId: ASSIGNEE, roles: ['assignee'] },
      { userId: SPRINT_OWNER, roles: ['sprint_owner'] },
    ],
    scope: { workspaceId: '44444444-4444-4444-4444-444444444444' },
  };
}

/** A model that records every call and replies with whatever it was handed. */
function fakeModel(reply: unknown) {
  let calls = 0;
  const model: PromptedModel = {
    async invoke() {
      calls += 1;
      return reply;
    },
  };
  return { model, calls: () => calls };
}

beforeEach(() => {
  clearJudgmentCache();
});

describe('judgeSignals', () => {
  it('parses a batch into findings, one per signal, in input order', async () => {
    const a = signal();
    const b = signal({
      type: 'review_bottleneck',
      targetId: '55555555-5555-5555-5555-555555555555',
      targetTitle: 'Refactor the week rollup',
      fingerprint: 'review_bottleneck:55555555:2-4d',
      measurement: 3,
      threshold: 2,
      bucket: '2-4d',
    });

    const { model, calls } = fakeModel({
      judgments: [
        // Returned out of order on purpose: the assembler is driven by the
        // signals, so order comes from the input rather than from the model.
        {
          fingerprint: b.fingerprint,
          worth_surfacing: false,
          severity: 'low',
          recipient: null,
          phrasing: '',
        },
        {
          fingerprint: a.fingerprint,
          worth_surfacing: true,
          severity: 'high',
          recipient: ASSIGNEE,
          phrasing: '  This has not moved in 7 working days.  ',
        },
      ],
    });

    const result = await judgeSignals(input([a, b]), { model });

    expect(result.status).toBe('judged');
    expect(calls()).toBe(1);
    expect(result.findings).toHaveLength(2);

    expect(result.findings[0]).toEqual({
      fingerprint: a.fingerprint,
      severity: 'high',
      recipientUserId: ASSIGNEE,
      worthSurfacing: true,
      phrasing: 'This has not moved in 7 working days.',
    });

    // Kept, not dropped: "the model rejected it" has to stay distinguishable
    // from "the model never saw it".
    expect(result.findings[1]?.fingerprint).toBe(b.fingerprint);
    expect(result.findings[1]?.worthSurfacing).toBe(false);
  });

  it('makes ONE call for a whole batch, not one per signal', async () => {
    const signals = Array.from({ length: 5 }, (_, i) =>
      signal({ fingerprint: `stalled_work:target-${i}:5-9d` })
    );
    const { model, calls } = fakeModel({
      judgments: signals.map((s) => ({
        fingerprint: s.fingerprint,
        worth_surfacing: true,
        severity: 'medium',
        recipient: ASSIGNEE,
        phrasing: 'Idle for 7 working days.',
      })),
    });

    const result = await judgeSignals(input(signals), { model });

    // PRESEARCH.md Q32: judging every signal individually is a named cost
    // cliff. Five signals, one call.
    expect(calls()).toBe(1);
    expect(result.findings).toHaveLength(5);
  });

  it('spends nothing when there are no signals', async () => {
    const { model, calls } = fakeModel({ judgments: [] });

    const result = await judgeSignals(input([]), { model });

    expect(result).toEqual({ status: 'judged', findings: [], fromCache: false });
    expect(calls()).toBe(0);
  });

  it('marks a signal the model skipped as not worth surfacing', async () => {
    const s = signal();
    const { model } = fakeModel({ judgments: [] });

    const result = await judgeSignals(input([s]), { model });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.worthSurfacing).toBe(false);
    expect(result.findings[0]?.recipientUserId).toBe(ASSIGNEE);
  });

  it('discards a judgement whose fingerprint was never sent', async () => {
    const s = signal();
    const { model } = fakeModel({
      judgments: [
        {
          fingerprint: 'invented:by-the-model:0d',
          worth_surfacing: true,
          severity: 'high',
          recipient: ASSIGNEE,
          phrasing: 'Something the measurement layer never named.',
        },
      ],
    });

    const result = await judgeSignals(input([s]), { model });

    // The invented fingerprint has nowhere to land, so it cannot reach the
    // action layer; the real signal still produces a finding.
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.fingerprint).toBe(s.fingerprint);
    expect(result.findings[0]?.worthSurfacing).toBe(false);
  });

  it('refuses a recipient the deterministic layer never named', async () => {
    const s = signal();
    const { model } = fakeModel({
      judgments: [
        {
          fingerprint: s.fingerprint,
          worth_surfacing: true,
          severity: 'medium',
          recipient: '99999999-9999-9999-9999-999999999999',
          phrasing: 'Idle for 7 working days.',
        },
      ],
    });

    const result = await judgeSignals(input([s]), { model });

    // Q6: routing is structural. Null hands it back to the graph's fallback
    // rather than letting the model invent a destination.
    expect(result.findings[0]?.recipientUserId).toBeNull();
  });

  it('returns ai_unavailable when the output fails validation', async () => {
    const { model } = fakeModel({ judgments: [{ fingerprint: 1234, severity: 'urgent' }] });

    const result = await judgeSignals(input([signal()]), { model });

    expect(result.status).toBe('ai_unavailable');
    expect(result).toMatchObject({ reason: 'invalid_output', findings: [] });
  });

  it('returns ai_unavailable when the provider throws', async () => {
    const model: PromptedModel = {
      async invoke() {
        throw new Error('TimeoutError: socket hang up');
      },
    };

    const result = await judgeSignals(input([signal()]), { model });

    expect(result).toMatchObject({ status: 'ai_unavailable', reason: 'provider_error' });
  });
});

describe('circuit breaker', () => {
  it('returns ai_unavailable WITHOUT calling the provider when the circuit is open', async () => {
    const breaker = new CircuitBreaker({
      name: 'test',
      failureThreshold: 1,
      cooldownMs: 60_000,
    });

    // Drive it open through the breaker's own failure path rather than by
    // poking at internals — the test should exercise the same transition
    // production does.
    await expect(breaker.run(async () => { throw new Error('bedrock down'); })).rejects.toThrow();
    expect(breaker.state).toBe('open');

    const { model, calls } = fakeModel({ judgments: [] });
    const result = await judgeSignals(input([signal()]), { model, breaker });

    expect(result).toMatchObject({ status: 'ai_unavailable', reason: 'circuit_open', findings: [] });
    // The assertion that matters: a fast failure, not a slow one. Nothing was
    // dialled, so an outage costs a run nothing instead of 20 s per attempt.
    expect(calls()).toBe(0);
  });
});

describe('content-hash cache', () => {
  it('reuses a judgement for identical input and re-judges when it changes', async () => {
    const s = signal();
    const { model, calls } = fakeModel({
      judgments: [
        {
          fingerprint: s.fingerprint,
          worth_surfacing: true,
          severity: 'medium',
          recipient: ASSIGNEE,
          phrasing: 'Idle for 7 working days.',
        },
      ],
    });

    const first = await judgeSignals(input([s]), { model });
    const second = await judgeSignals(input([s]), { model });

    expect(first).toMatchObject({ status: 'judged', fromCache: false });
    expect(second).toMatchObject({ status: 'judged', fromCache: true });
    expect(second.findings).toEqual(first.findings);
    // Q32's biggest cliff is re-judging unchanged state every three minutes.
    expect(calls()).toBe(1);

    // A moved measurement is a different judgement, so it must miss.
    await judgeSignals(input([signal({ measurement: 12, bucket: '10-19d' })]), { model });
    expect(calls()).toBe(2);
  });

  it('does not cache an unavailable provider', async () => {
    let attempts = 0;
    const model: PromptedModel = {
      async invoke() {
        attempts += 1;
        throw new Error('bedrock down');
      },
    };

    await judgeSignals(input([signal()]), { model });
    await judgeSignals(input([signal()]), { model });

    // Caching a failure would suppress judgement for that state until the
    // process restarted — the outage would outlive itself.
    expect(attempts).toBe(2);
  });
});

describe('makeJudge', () => {
  it('flattens to findings for the graph seam', async () => {
    const s = signal();
    const { model } = fakeModel({
      judgments: [
        {
          fingerprint: s.fingerprint,
          worth_surfacing: true,
          severity: 'low',
          recipient: ASSIGNEE,
          phrasing: 'Idle for 7 working days.',
        },
      ],
    });

    const judge = makeJudge({ model });
    const findings = await judge(input([s]));

    expect(findings).toHaveLength(1);
    expect(findings[0]?.fingerprint).toBe(s.fingerprint);
  });

  it('THROWS on an unavailable provider rather than returning no findings', async () => {
    // This test previously asserted the opposite, and the assertion was the
    // bug. Flattening `ai_unavailable` to `[]` handed the graph an empty
    // findings array, which it correctly reads as "the model judged nothing
    // worth surfacing" — so it routed to close_quiet and advanced the
    // watermark, closing a scan window whose signals were never judged.
    //
    // `closeQuiet` already refused to advance on `ai_unavailable`; it never
    // saw that outcome because the status died here.
    //
    // An empty result and an unreachable provider must not be the same value.
    // A calm project and a broken one are different events, and every layer
    // that erases the difference has to be found and fixed.
    const model: PromptedModel = {
      async invoke() {
        throw new Error('bedrock down');
      },
    };

    await expect(makeJudge({ model })(input([signal()]))).rejects.toThrow(
      JudgementUnavailableError
    );
  });

  it('still returns findings normally when the provider works', async () => {
    // The throw must be reachable only on failure — a judge that threw on the
    // happy path would take the whole run down.
    const model: PromptedModel = {
      async invoke() {
        return {
          judgments: [
            {
              fingerprint: signal().fingerprint,
              worth_surfacing: true,
              severity: 'medium' as const,
              recipient: null,
              phrasing: 'ok',
            },
          ],
        };
      },
    };

    const findings = await makeJudge({ model })(input([signal()]));
    expect(findings).toHaveLength(1);
  });
});
