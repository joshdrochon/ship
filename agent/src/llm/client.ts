/**
 * The one outbound model call FleetGraph makes, and everything wrapped round it.
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
import { ChatBedrockConverse } from '@langchain/aws';

import { CircuitBreaker, CircuitOpenError , type CircuitBreakerStats } from '@ship/shared';

/**
 * Inherited from `api/src/services/ai-analysis.ts` rather than chosen again.
 * Two model ids across one product means two answers to "what did it say", and
 * the mock expectations are written against this one.
 */
const MODEL_ID = 'global.anthropic.claude-opus-4-5-20251101-v1:0';
const REGION = 'us-east-1';

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

let chatModel: ChatBedrockConverse | null = null;
let chatModelInitFailed = false;

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
export function getChatModel(): ChatBedrockConverse | null {
  if (chatModelInitFailed) return null;
  if (chatModel) return chatModel;

  try {
    const endpoint = process.env.BEDROCK_ENDPOINT;

    chatModel = new ChatBedrockConverse({
      model: MODEL_ID,
      region: REGION,
      maxTokens: MAX_TOKENS,
      // Deterministic-as-it-gets. Severity that changes between runs on
      // unchanged input is a finding nobody can act on with confidence.
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

    return chatModel;
  } catch (err) {
    console.warn(
      '[fleetgraph] Bedrock client init failed; judgement degrades to ai_unavailable:',
      err instanceof Error ? err.message : err
    );
    chatModelInitFailed = true;
    return null;
  }
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
