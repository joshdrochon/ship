/**
 * The one outbound model call FleetGraph makes, and everything wrapped round it.
 *
 * ── Two providers, and why there are two ───────────────────────────────────
 * PRESEARCH.md Q25 chose Bedrock for one reason only: Ship already used it, so
 * the credentials, the breaker and the mock were all sitting there. That reason
 * turned out to be false. `terraform/render/*.tf` declares no AWS environment
 * variables at all, and `api/src/services/ai-analysis.ts:39` already recorded
 * the same thing about the API — "no AWS credentials at all". So the deployed
 * cron had no more access to Bedrock than a laptop does.
 *
 * That is not a degraded deployment, it is an inert one. `makeJudge` throws
 * `JudgementUnavailableError` on an unreachable provider, the graph routes to
 * `close_quiet`, and `closeQuiet` deliberately holds the watermark. All correct,
 * and the sum of it is an agent that detects drift and tells nobody, forever.
 * MVP requirement 1 wants one proactive detection reaching a human end-to-end;
 * with no reachable model there is no path to one.
 *
 * The provider was never a requirement — the brief names none. So the direct
 * Anthropic API is now the primary, selected by `ANTHROPIC_API_KEY`, and Bedrock
 * stays as the fallback for one specific job: `BEDROCK_ENDPOINT` still steers
 * CI and `./start.sh` at the local mock, which is engineering requirement 3's
 * stable fake and must keep working. Hence the precedence below — an explicit
 * mock endpoint outranks a real key, so a key leaking into a CI environment
 * cannot turn a deterministic suite into a billed one.
 *
 * Everything downstream is untouched. `PromptedModel` is structural, the
 * breaker fronts the call rather than the client, and judge/answer never learn
 * which provider answered.
 *
 * ── Why the breaker is shared rather than copied ────────────────────────────
 * It already exists, is already tested, and already fronts Bedrock with the
 * exact values below. PRESEARCH.md Q25 decides to reuse it, and the reason is
 * written in its own header: "a retry makes a single request more likely to
 * succeed, but when the dependency is down it multiplies the load and
 * multiplies the latency every caller waits through." That reasoning does not
 * change because a second process is doing the calling. A second copy would be
 * a second thing to keep correct.
 *
 * It lives in `@ship/shared`. It used to be imported through
 * `../../../api/dist/services/circuitBreaker.js` — a relative path into another
 * package's build output, which worked and had one consequence nobody wanted:
 * `api` could then never import anything from `agent`, because that would close
 * a build cycle with no package able to compile first.
 *
 * That cycle is the entire reason `POST /api/fleetgraph/chat` returned 503
 * `agent_not_wired` while its route, schema, rate limit and tests were
 * finished. The graph existed; `api` had no legal way to reach it.
 *
 * A dependency-free utility used by two packages belongs in `shared/`, which
 * turns the dependency graph from a loop into a line: shared → agent → api.
 *
 * ── The failure modes these values protect against ─────────────────────────
 * Same four as `ai-analysis.ts`, inherited rather than re-derived:
 *
 *  - CONNECT_TIMEOUT_MS — an endpoint that accepts a TCP connection and never
 *    completes the handshake. Without it a cron run hangs forever holding a
 *    database connection, and the "never hang" requirement is not met by luck.
 *  - REQUEST_TIMEOUT_MS — a model call that starts and stalls. This is also the
 *    hard ceiling in the Q30 latency budget: judgement cannot breach the 5-min
 *    SLA because it fails into `ai_unavailable` at 20 s and is judged next run.
 *  - MAX_ATTEMPTS — a single throttled (429) or 5xx response. The SDK's own
 *    retry is exponential backoff with jitter; bounded at 3 so a bad minute
 *    does not become a queue of runs.
 *  - The breaker — a Bedrock outage, an expired role, or no AWS credentials at
 *    all. After 5 consecutive failures it opens for 60 s and subsequent calls
 *    return without touching the network.
 *
 * ── BEDROCK_ENDPOINT, and why it goes in through `endpointProvider` ─────────
 * Engineering requirement 3 wants a stable fake for every external service, and
 * Ship already has one: `BEDROCK_ENDPOINT` redirects the API's Bedrock client
 * at a local mock (`docker-compose.mocks.yml`, `e2e/fixtures/mock-bedrock.ts`).
 * The same variable steers this client, so the agent's model calls are as fake
 * in CI as the API's are.
 *
 * It cannot go in as `clientOptions.endpoint`: `ChatBedrockConverse` builds its
 * `BedrockRuntimeClient` as `{ ...clientOptions, endpoint: endpointHost ? ... }`,
 * so a supplied `endpoint` is overwritten with `undefined` on every construction.
 * Its own `endpointHost` field is not usable either — it hardcodes `https://`,
 * and both mocks serve plaintext. `endpointProvider` is spread from
 * `clientOptions` and never overwritten, and it takes a full URL including the
 * scheme, so it is the one seam that survives. Named here because it looks
 * eccentric otherwise.
 */
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatBedrockConverse } from '@langchain/aws';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

import { CircuitBreaker, CircuitOpenError , type CircuitBreakerStats } from '@ship/shared';

/**
 * Inherited from `api/src/services/ai-analysis.ts` rather than chosen again.
 * Two model ids across one product means two answers to "what did it say", and
 * the mock expectations are written against this one.
 */
const BEDROCK_MODEL_ID = 'global.anthropic.claude-opus-4-5-20251101-v1:0';
const REGION = 'us-east-1';

/**
 * The direct-API default, overridable by env.
 *
 * Overridable because the failure it guards against is un-debuggable from a
 * cron log: a key without access to this particular model fails as a 404 on the
 * model id, which reads identically to an outage from behind the breaker. One
 * env var turns that into a thing an operator can fix without a deploy.
 */
const ANTHROPIC_MODEL_ID = process.env.FLEETGRAPH_MODEL_ID ?? 'claude-opus-4-5-20251101';

/**
 * The Q31 output budget. Judgement returns a handful of short sentences; 2048
 * is the existing cap and is far more than the schema can fill.
 */
const MAX_TOKENS = 2048;

const CONNECT_TIMEOUT_MS = 3_000;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 3;
const BREAKER_FAILURE_THRESHOLD = 5;
const BREAKER_COOLDOWN_MS = 60_000;

/**
 * One breaker for the provider, shared by judgement and on-demand answers.
 *
 * Per-path breakers would let the chat path keep hammering a dependency that
 * the proactive path has already established is down — the breaker guards the
 * dependency, not the caller.
 */
const bedrockBreaker = new CircuitBreaker({
  name: 'fleetgraph-bedrock',
  failureThreshold: BREAKER_FAILURE_THRESHOLD,
  cooldownMs: BREAKER_COOLDOWN_MS,
});

/** For the health endpoint (Q28) and for tests. */
export function getLlmBreakerStats(): CircuitBreakerStats {
  return bedrockBreaker.stats;
}

/** Test seam: lets a suite start from a known circuit state. */
export function resetLlmBreaker(): void {
  bedrockBreaker.reset();
}

export { CircuitBreaker, CircuitOpenError };

/**
 * A prompted model, reduced to the one method the callers use.
 *
 * Declared structurally rather than as `ChatBedrockConverse` so a test can pass
 * a counting fake without constructing a LangChain object or a network stub —
 * requirement 3 again, and the reason FG-109 can prove the provider was never
 * called rather than proving a mock was never called. Both a raw
 * `ChatBedrockConverse` and the runnable returned by `withStructuredOutput`
 * satisfy it.
 */
export interface PromptedModel<T = unknown> {
  invoke(messages: Array<{ role: 'system' | 'user'; content: string }>): Promise<T>;
}

let chatModel: BaseChatModel | null = null;
let chatModelInitFailed = false;

/** Which provider a call would reach right now. `none` means judgement degrades. */
export type ModelProvider = 'anthropic' | 'bedrock' | 'none';

/**
 * Decide the provider from the environment, without constructing anything.
 *
 * Separate from `getChatModel` so the health endpoint (Q28) and the tests can
 * ask the question without paying for a client or caching one — and so the
 * precedence rule is one readable expression rather than a shape inferred from
 * a chain of try/catch.
 *
 * `BEDROCK_ENDPOINT` first: that variable is only ever set to point at a mock
 * (`docker-compose.mocks.yml`, `e2e/fixtures/mock-bedrock.ts`). If it is set,
 * the environment has explicitly asked for the fake, and a real key present in
 * the same environment must not quietly win and start billing a test run.
 */
export function selectProvider(env: NodeJS.ProcessEnv = process.env): ModelProvider {
  if (env.BEDROCK_ENDPOINT) return 'bedrock';
  if (env.ANTHROPIC_API_KEY) return 'anthropic';
  // Bedrock is still worth attempting: an EC2/ECS role supplies credentials
  // through the chain with no environment variable to detect. On Render there
  // is no such role, so this is the branch that degrades to `ai_unavailable`.
  return 'bedrock';
}

/** For the health endpoint and for the startup log line. */
export function describeProvider(env: NodeJS.ProcessEnv = process.env): {
  provider: ModelProvider;
  model: string;
  mocked: boolean;
} {
  const provider = selectProvider(env);
  return {
    provider,
    model: provider === 'anthropic' ? ANTHROPIC_MODEL_ID : BEDROCK_MODEL_ID,
    mocked: Boolean(env.BEDROCK_ENDPOINT),
  };
}

/**
 * The shared chat model, built on first use.
 *
 * Lazy for the reason `ai-analysis.ts` is lazy: constructing it resolves the
 * AWS credential chain, which is slow and throws when there are no credentials.
 * A cron process that has nothing to judge must not pay that, and a process
 * with no credentials must still start.
 *
 * Returns null instead of throwing, so a missing credential degrades to
 * `ai_unavailable` on the one path that needs the model rather than taking down
 * the run — detection keeps working without judgement (Q25's first rung).
 */
export function getChatModel(): BaseChatModel | null {
  if (chatModelInitFailed) return null;
  if (chatModel) return chatModel;

  try {
    chatModel =
      selectProvider() === 'anthropic' ? buildAnthropicModel() : buildBedrockModel();
    return chatModel;
  } catch (err) {
    console.warn(
      '[fleetgraph] model client init failed; judgement degrades to ai_unavailable:',
      err instanceof Error ? err.message : err
    );
    chatModelInitFailed = true;
    return null;
  }
}

/**
 * The direct Anthropic API client.
 *
 * The same four failure modes are covered as on the Bedrock path, through
 * different field names — requirement 4 is about the behaviour, not the SDK:
 *
 *  - `timeout` is the per-request ceiling, matching REQUEST_TIMEOUT_MS. There is
 *    no separate connect timeout in this SDK, so a stalled handshake is caught
 *    by the same 20 s rather than by a tighter 3 s. Slower to fail, still
 *    bounded, and still inside the Q30 latency budget.
 *  - `maxRetries` is retries, not attempts, so it is one less than MAX_ATTEMPTS
 *    to keep the total number of requests identical across providers. The SDK
 *    retries 429 and 5xx with exponential backoff and jitter.
 *  - The breaker is unchanged: it wraps `callModel`, not the client, so it
 *    counts failures from whichever provider answered.
 */
function buildAnthropicModel(): BaseChatModel {
  return new ChatAnthropic({
    model: ANTHROPIC_MODEL_ID,
    maxTokens: MAX_TOKENS,
    // Deterministic-as-it-gets. Severity that changes between runs on
    // unchanged input is a finding nobody can act on with confidence.
    temperature: 0,
    maxRetries: MAX_ATTEMPTS - 1,
    clientOptions: { timeout: REQUEST_TIMEOUT_MS },
  });
}

function buildBedrockModel(): BaseChatModel {
  const endpoint = process.env.BEDROCK_ENDPOINT;

  return new ChatBedrockConverse({
    model: BEDROCK_MODEL_ID,
    region: REGION,
    maxTokens: MAX_TOKENS,
    temperature: 0,
    clientOptions: {
      maxAttempts: MAX_ATTEMPTS,
      // Handler options, not a handler instance: the SDK constructs the
      // NodeHttpHandler itself, so this needs no @smithy/* import.
      requestHandler: {
        connectionTimeout: CONNECT_TIMEOUT_MS,
        requestTimeout: REQUEST_TIMEOUT_MS,
      },
      ...(endpoint ? { endpointProvider: () => ({ url: new URL(endpoint) }) } : {}),
    },
  });
}

/** Test seam: forget the cached client so a new env can take effect. */
export function resetChatModel(): void {
  chatModel = null;
  chatModelInitFailed = false;
}

/**
 * Run an outbound model call behind the breaker.
 *
 * Callers get a discriminated result rather than an exception, because both
 * failure shapes are ordinary control flow here: the whole degradation ladder
 * (Q25) is "return without judgement and try again next run", never "throw".
 */
export async function callModel<T>(
  fn: () => Promise<T>,
  breaker: CircuitBreaker = bedrockBreaker
): Promise<
  { ok: true; value: T } | { ok: false; reason: 'circuit_open' | 'provider_error'; error: unknown }
> {
  try {
    return { ok: true, value: await breaker.run(fn) };
  } catch (err) {
    if (err instanceof CircuitOpenError) {
      return { ok: false, reason: 'circuit_open', error: err };
    }
    return { ok: false, reason: 'provider_error', error: err };
  }
}
