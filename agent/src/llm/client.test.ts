/**
 * Provider selection, asserted rather than assumed.
 *
 * The bug this suite exists for is not a crash — it is silence. Bedrock was
 * chosen (PRESEARCH.md Q25) on the belief that Ship already had credentials for
 * it. `terraform/render/*.tf` declares no AWS environment variables at all, so
 * the deployed cron had none either. Judgement therefore returned
 * `ai_unavailable` on every run, `makeJudge` threw, the graph closed quiet, and
 * `closeQuiet` correctly held the watermark. Every layer behaved as designed and
 * the product of them was an agent that detects drift and notifies nobody.
 *
 * Nothing failed loudly enough to catch, because "no findings" is also what a
 * calm project looks like. So the assertions here are about which provider a
 * call would REACH, which is the fact that was wrong.
 *
 * The second test is the one with teeth: `BEDROCK_ENDPOINT` must outrank a real
 * key. That variable is only ever set to point at a mock, so if a key ever
 * reaches a CI environment, precedence is the only thing standing between a
 * deterministic suite and a billed one.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { selectProvider, describeProvider, getChatModel, resetChatModel } from './client.js';

/** Neither variable set, whatever the developer's shell happens to hold. */
const BARE: NodeJS.ProcessEnv = {};

describe('provider selection', () => {
  it('picks the direct Anthropic API when a key is present', () => {
    expect(selectProvider({ ANTHROPIC_API_KEY: 'sk-test' })).toBe('anthropic');
  });

  it('lets BEDROCK_ENDPOINT outrank a real key, so a mocked env stays mocked', () => {
    // Engineering requirement 3: the fake governs the test suite. A key leaking
    // into CI must not silently promote every judged run to a real API call.
    expect(
      selectProvider({ ANTHROPIC_API_KEY: 'sk-test', BEDROCK_ENDPOINT: 'http://localhost:1080' })
    ).toBe('bedrock');
  });

  it('falls back to Bedrock with neither set, because a role may still supply credentials', () => {
    // No environment variable announces an EC2/ECS instance role, so "no key"
    // is not the same as "no provider". On Render there is no role, and this is
    // the branch that degrades to ai_unavailable — which is the whole reason
    // the Anthropic path now exists.
    expect(selectProvider(BARE)).toBe('bedrock');
  });

  it('reports the model id and whether the endpoint is mocked', () => {
    expect(describeProvider({ ANTHROPIC_API_KEY: 'sk-test' })).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-4-5-20251101',
      mocked: false,
    });

    expect(describeProvider({ BEDROCK_ENDPOINT: 'http://localhost:1080' })).toEqual({
      provider: 'bedrock',
      model: 'global.anthropic.claude-opus-4-5-20251101-v1:0',
      mocked: true,
    });
  });
});

describe('getChatModel', () => {
  const saved = { key: process.env.ANTHROPIC_API_KEY, endpoint: process.env.BEDROCK_ENDPOINT };

  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.BEDROCK_ENDPOINT;
    resetChatModel();
  });

  afterEach(() => {
    if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved.key;
    if (saved.endpoint === undefined) delete process.env.BEDROCK_ENDPOINT;
    else process.env.BEDROCK_ENDPOINT = saved.endpoint;
    resetChatModel();
  });

  it('builds an Anthropic client that satisfies the judge and answer seams', () => {
    // Construction only — no network. What matters is that the object the two
    // callers use is shaped the way they use it: `answer.ts` calls `invoke`,
    // `judge.ts` calls `withStructuredOutput` first. A provider swap that
    // compiled but produced an object missing either would fail here rather
    // than at 03:00 in a cron run.
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-a-real-key';

    const model = getChatModel();
    expect(model, 'a key present must yield a client').toBeTruthy();
    expect(typeof model?.invoke).toBe('function');
    expect(typeof model?.withStructuredOutput).toBe('function');
    expect(model?.constructor.name).toBe('ChatAnthropic');
  });

  it('caches the client across calls', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-a-real-key';
    expect(getChatModel()).toBe(getChatModel());
  });

  it('builds the Bedrock client when the endpoint points at the mock', () => {
    process.env.BEDROCK_ENDPOINT = 'http://localhost:1080';
    expect(getChatModel()?.constructor.name).toBe('ChatBedrockConverse');
  });
});
