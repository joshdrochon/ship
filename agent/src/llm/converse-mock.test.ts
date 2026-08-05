/**
 * The real Bedrock client against the stable fake, over the real endpoint.
 *
 * Engineering requirement 3 asks for a stable fake for every external service.
 * The other tests in this directory satisfy the letter of that with an injected
 * fake model, which is the right tool for asserting judgement logic — but it
 * never constructs `ChatBedrockConverse` and therefore never proves the client
 * can talk to anything.
 *
 * That distinction was not academic. The E2E mock answered only the InvokeModel
 * operation, and `ChatBedrockConverse` calls Converse instead, so every judged
 * run in CI 404'd, degraded to `ai_unavailable`, and passed — because the
 * assertions accepted a degraded result. CI could not exercise judgement at all
 * and nothing said so (FG-271).
 *
 * This test uses the actual client, pointed at the actual mock via
 * `BEDROCK_ENDPOINT`, which is the exact path CI takes.
 *
 * ── The assertion that matters ─────────────────────────────────────────────
 * Fingerprints must survive the round trip. `routeAction` drops any finding
 * whose fingerprint does not match a measured signal, so a mock returning
 * canned fingerprints would have its findings silently discarded and the run
 * would look quiet — indistinguishable from a healthy project.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { startMockBedrock, type MockBedrock } from '../../../e2e/fixtures/mock-bedrock.js';
import { resetChatModel, resetLlmBreaker } from './client.js';
import { makeJudge, clearJudgmentCache } from './judge.js';
import type { Signal } from '../detectors/types.js';

let mock: MockBedrock;

const SIGNALS: Signal[] = [
  {
    type: 'stalled_work',
    targetId: '11111111-1111-1111-1111-111111111111',
    targetType: 'issue',
    targetTitle: 'Wire the export job',
    measurement: 19,
    threshold: 5,
    bucket: '15+',
    fingerprint: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    context: { idle_business_days: 19 },
    accountableUserId: '22222222-2222-2222-2222-222222222222',
  },
  {
    type: 'sprint_miss_risk',
    targetId: '33333333-3333-3333-3333-333333333333',
    targetType: 'sprint',
    targetTitle: 'Week 31',
    measurement: 4,
    threshold: 2,
    bucket: '2-5',
    fingerprint: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    context: { unstarted_issues: 4 },
    accountableUserId: null,
  },
];

beforeAll(async () => {
  mock = await startMockBedrock();
  process.env.BEDROCK_ENDPOINT = mock.url;
  // The SDK signs with these; the mock never looks at the signature.
  process.env.AWS_ACCESS_KEY_ID = 'mock';
  process.env.AWS_SECRET_ACCESS_KEY = 'mock';
  process.env.AWS_REGION = 'us-east-1';
  resetChatModel();
  resetLlmBreaker();
  clearJudgmentCache();
}, 30_000);

afterAll(async () => {
  delete process.env.BEDROCK_ENDPOINT;
  resetChatModel();
  await mock?.close();
});

describe('the real Converse client against the mock', () => {
  it('reaches /converse and parses a structured judgement back', async () => {
    const judge = makeJudge();
    const findings = await judge({
      signals: SIGNALS,
      participants: [
        { userId: '22222222-2222-2222-2222-222222222222', roles: ['assignee'] },
      ],
      scope: { workspaceId: '44444444-4444-4444-4444-444444444444' },
    });

    expect(mock.converseInvocations(), 'the client must actually reach /converse').toBe(1);
    expect(findings).toHaveLength(SIGNALS.length);
  }, 30_000);

  it('round-trips every fingerprint unchanged', async () => {
    clearJudgmentCache();
    const judge = makeJudge();
    const findings = await judge({
      signals: SIGNALS,
      participants: [],
      scope: { workspaceId: '44444444-4444-4444-4444-444444444444' },
    });

    // If this drifts, routeAction discards the findings and the run reports a
    // quiet workspace. Nothing else in the suite would notice.
    expect(findings.map((f) => f.fingerprint).sort()).toEqual(
      SIGNALS.map((s) => s.fingerprint).sort()
    );
  }, 30_000);

  it('batches the whole scope into ONE call, never one per signal', async () => {
    // Q32's cost cliff, asserted against the wire rather than against a fake.
    clearJudgmentCache();
    const before = mock.converseInvocations();

    const judge = makeJudge();
    await judge({
      signals: SIGNALS,
      participants: [],
      scope: { workspaceId: '55555555-5555-5555-5555-555555555555' },
    });

    expect(mock.converseInvocations() - before).toBe(1);
  }, 30_000);
});
