/**
 * Judgement: signals in, findings out. One model call for the whole batch.
 *
 * ── The entrypoint is a plain function on purpose ──────────────────────────
 * No graph import, no graph awareness, no LangGraph types. The graph injects it
 * through `GraphDeps.judge` (see `graph/deps.ts`), which means two things a
 * direct import would not give: FG-092 can assert a quiet run made zero model
 * calls by counting on a fake rather than by mocking a module, and this file is
 * testable on its own with nothing running.
 *
 * ── Zero signals costs zero tokens, and it is checked here too ─────────────
 * The graph's triage gate already terminates a quiet run before reaching this
 * (Q17). The guard below is the second line: 480 scans a day are affordable
 * only because almost all of them spend nothing, and a refactor that reroutes
 * around the gate must not be able to turn calm into spend without anyone
 * noticing.
 *
 * ── Cached on content, not on time (Q26) ───────────────────────────────────
 * A finding whose underlying state has not changed has not become more or less
 * true with age, so the cache key is a SHA-256 of the exact prompt bytes — the
 * same pattern `api/src/services/ai-analysis.ts` uses to skip re-analysing
 * unchanged content. Anything that changes the judgement (a new signal, a
 * moved measurement, a different roster) changes the rendered prompt and
 * therefore the key. A TTL would do the opposite: it would make judgements
 * expire and re-fire on state nobody touched, which is the Q23 failure and the
 * Q32 cost cliff in one.
 *
 * ── Failure is control flow, not an exception ──────────────────────────────
 * Every failure path returns `ai_unavailable` with a reason. The signals then
 * persist unjudged and are judged next run (Q24). Nothing here throws, because
 * the brief's requirement is that the agent never crashes, hangs, or loops, and
 * a judge that throws makes that a property of its callers instead.
 */
import { createHash } from 'crypto';

import { callModel, getChatModel, type PromptedModel } from './client.js';
import { JUDGE_SYSTEM_PROMPT, JudgmentBatchSchema, renderJudgeInput } from './prompts/judge.js';
import { AI_UNAVAILABLE } from './types.js';
import type {
  Finding,
  JudgeParticipant,
  JudgeScope,
  JudgmentResult,
  Severity,
} from './types.js';
import type { Signal } from '../detectors/types.js';
import type { CircuitBreaker } from './client.js';

export interface JudgeInput {
  signals: readonly Signal[];
  participants: readonly JudgeParticipant[];
  scope: JudgeScope;
}

export interface JudgeDeps {
  /** Injected in tests. Defaults to the shared Bedrock client, bound to the schema. */
  model?: PromptedModel;
  /** Injected in tests so a suite can start from an open circuit. */
  breaker?: CircuitBreaker;
}

/**
 * Same construction as `computeContentHash` in `api/src/services/ai-analysis.ts`.
 *
 * Not imported from there: that one is module-private, and exporting it would
 * be an edit to a file another lane owns. The pattern is three lines and the
 * shared thing that matters is the *behaviour* — SHA-256 over the input, used
 * as a cache key — not the function object.
 */
function computeContentHash(content: unknown): string {
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

/**
 * Judgements already made, keyed by the hash of the input that produced them.
 *
 * Bounded, and the bound is a memory guard rather than an expiry policy: the
 * on-demand process is long-lived, and an unbounded map keyed on content grows
 * with every distinct project state the process ever sees. Eviction is oldest-
 * first, which for a cron that re-judges the same drifting projects is the
 * right end to drop from — the entries that matter are re-inserted on the next
 * run at the cost of one model call, and correctness never depended on the
 * cache.
 */
const MAX_CACHE_ENTRIES = 500;
const judgmentCache = new Map<string, Finding[]>();

/** Test seam. Also useful operationally if a prompt change ships mid-process. */
export function clearJudgmentCache(): void {
  judgmentCache.clear();
}

function cacheJudgment(key: string, findings: Finding[]): void {
  if (judgmentCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = judgmentCache.keys().next();
    if (!oldest.done) judgmentCache.delete(oldest.value);
  }
  judgmentCache.set(key, findings);
}

/**
 * The model bound to the judgement schema.
 *
 * `withStructuredOutput` puts the schema on the Converse request as a tool
 * definition, so the shape is constrained at the provider rather than asked for
 * in prose and hoped for. We still re-validate the result: FG-103 wants a
 * defined behaviour when the output does not conform, and "trust the library's
 * validation" is not a behaviour that can be tested.
 */
function defaultModel(): PromptedModel | null {
  const chat = getChatModel();
  if (!chat) return null;
  return chat.withStructuredOutput(JudgmentBatchSchema, { name: 'judgment' });
}

/**
 * Judge every signal in a scope.
 *
 * Returns one finding per input signal, in input order, including the ones the
 * model considered not worth surfacing. The graph filters; the judge reports.
 * A signal the model skipped entirely comes back as `worthSurfacing: false`,
 * which is the safe reading — silence is not consent to interrupt someone.
 */
export async function judgeSignals(
  input: JudgeInput,
  deps: JudgeDeps = {}
): Promise<JudgmentResult> {
  if (input.signals.length === 0) {
    return { status: 'judged', findings: [], fromCache: false };
  }

  const rendered = renderJudgeInput(input);
  const key = computeContentHash({ system: JUDGE_SYSTEM_PROMPT, user: rendered });

  const cached = judgmentCache.get(key);
  if (cached) {
    return { status: 'judged', findings: cached, fromCache: true };
  }

  const model = deps.model ?? defaultModel();
  if (!model) {
    // No credentials, or client construction failed. Detection keeps working;
    // judgement is what degrades (Q25, first rung of the ladder).
    return { status: AI_UNAVAILABLE, reason: 'provider_error', findings: [] };
  }

  const call = await callModel(
    () =>
      model.invoke([
        { role: 'system', content: JUDGE_SYSTEM_PROMPT },
        { role: 'user', content: rendered },
      ]),
    deps.breaker
  );

  if (!call.ok) {
    console.warn(
      `[fleetgraph] judgement unavailable (${call.reason}):`,
      call.error instanceof Error ? call.error.message : call.error
    );
    return { status: AI_UNAVAILABLE, reason: call.reason, findings: [] };
  }

  const parsed = JudgmentBatchSchema.safeParse(call.value);
  if (!parsed.success) {
    // A malformed judgement is treated exactly like an unreachable provider:
    // signals stay unjudged and are judged again next run. The alternative —
    // salvaging whatever fields parsed — would surface half-judged findings to
    // humans, which is worse than surfacing none.
    console.warn('[fleetgraph] judgement output failed validation:', parsed.error.message);
    return { status: AI_UNAVAILABLE, reason: 'invalid_output', findings: [] };
  }

  const findings = assemble(input, parsed.data.judgments);
  cacheJudgment(key, findings);

  return { status: 'judged', findings, fromCache: false };
}

/**
 * Turn the model's batch into findings, one per input signal.
 *
 * Driven by the SIGNALS, not by the model's array — that inversion is the
 * safety property. A judgement that names a fingerprint we did not send has
 * nowhere to land, so an invented target cannot reach the action layer at all,
 * and a signal the model forgot still produces a finding rather than
 * disappearing.
 */
function assemble(input: JudgeInput, judgments: ReadonlyArray<{
  fingerprint: string;
  worth_surfacing: boolean;
  severity: Severity;
  recipient: string | null;
  phrasing: string;
}>): Finding[] {
  const byFingerprint = new Map(judgments.map((j) => [j.fingerprint, j]));

  // Ids the deterministic layer has already named. The model may echo one of
  // these back; it may not introduce a new one (Q6).
  const knownRecipients = new Set<string>();
  for (const s of input.signals) if (s.accountableUserId) knownRecipients.add(s.accountableUserId);
  for (const p of input.participants) knownRecipients.add(p.userId);

  const unmatched = judgments.filter((j) => !input.signals.some((s) => s.fingerprint === j.fingerprint));
  if (unmatched.length) {
    console.warn(
      `[fleetgraph] discarded ${unmatched.length} judgement(s) with unrecognised fingerprints`
    );
  }

  return input.signals.map((signal) => {
    const judged = byFingerprint.get(signal.fingerprint);

    if (!judged) {
      return {
        fingerprint: signal.fingerprint,
        severity: 'low' as const,
        recipientUserId: signal.accountableUserId,
        worthSurfacing: false,
        // No phrasing, because there is no judgement to phrase. Empty is
        // honest; inventing a sentence here would put words in the model's
        // mouth and they would be indistinguishable from real ones downstream.
        phrasing: '',
      };
    }

    let recipientUserId: string | null = null;
    if (judged.recipient && knownRecipients.has(judged.recipient)) {
      recipientUserId = judged.recipient;
    } else if (judged.recipient) {
      console.warn(
        `[fleetgraph] judgement named an unknown recipient for ${signal.fingerprint}; falling back to structural routing`
      );
    }

    return {
      fingerprint: signal.fingerprint,
      severity: judged.severity,
      recipientUserId,
      worthSurfacing: judged.worth_surfacing,
      phrasing: judged.phrasing.trim(),
    };
  });
}

/**
 * Adapter for the graph's injected `JudgeFn`, which is typed `Promise<Finding[]>`.
 *
 * The union that `judgeSignals` returns is the honest shape — an unreachable
 * provider and a calm project are different events — but the graph's seam
 * predates it and flattening happens in exactly one place rather than at every
 * call site. `ai_unavailable` flattens to no findings, which is the correct
 * graph behaviour anyway: nothing to route, nothing to deliver, signals judged
 * next run.
 */
export function makeJudge(deps: JudgeDeps = {}) {
  return async function judge(input: JudgeInput): Promise<Finding[]> {
    const result = await judgeSignals(input, deps);
    return result.findings;
  };
}
