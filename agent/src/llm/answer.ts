/**
 * On-demand answers: a question about one document, answered from measurements.
 *
 * ── Read-only is a property of this file, not of the prompt ────────────────
 * The model is constructed here with no tools bound and no tool schema on the
 * request. There is therefore no tool call it could emit and nothing on this
 * side that would execute one — which is what makes Q3's "answering is the only
 * unapproved action" claim true. `prompts/answer.ts` also *tells* the model it
 * is read-only, but that is so the answers are useful, not so the boundary
 * holds. If a future change binds a tool here, the safety argument in Q3 stops
 * being true and the approval gate becomes the only thing left.
 *
 * ── Not cached ─────────────────────────────────────────────────────────────
 * Unlike judgement (Q26), a chat turn is not keyed on stable content — the same
 * question against the same state can follow different conversation history,
 * and a cache hit would replay an answer written for a different turn. The cost
 * control on this path is the per-user rate limit named in Q32, not a cache.
 */
import { callModel, getChatModel, type CircuitBreaker, type PromptedModel } from './client.js';
import { ANSWER_SYSTEM_PROMPT, renderAnswerInput } from './prompts/answer.js';
import { AI_UNAVAILABLE } from './types.js';
import type { AnswerResult, JudgeParticipant, JudgeScope } from './types.js';
import type { Signal } from '../detectors/types.js';

export interface AnswerInput {
  scope: JudgeScope;
  question: string;
  participants: readonly JudgeParticipant[];
  signals: readonly Signal[];
}

export interface AnswerDeps {
  model?: PromptedModel;
  breaker?: CircuitBreaker;
}

/**
 * What the user sees when the model cannot be reached.
 *
 * Deliberately says what is unavailable and what still works, because the
 * signals in the state were measured without the model and are still true. The
 * degradation is "no judgement", not "no information" (Q25).
 */
const UNAVAILABLE_TEXT =
  'I could not reach the language model just now, so I cannot answer in my own words. ' +
  'The measured signals for this document are still available and up to date.';

/**
 * Answer one question. Never throws.
 *
 * The model returns a plain string; there is no schema to validate, so the only
 * failure modes are an unreachable provider and an empty completion. Both come
 * back as `ai_unavailable` with text the UI can render as-is.
 */
export async function composeAnswer(
  input: AnswerInput,
  deps: AnswerDeps = {}
): Promise<AnswerResult> {
  // No tools bound. See the header — this is the enforcement.
  const model: PromptedModel | null = deps.model ?? getChatModel();
  if (!model) {
    return { status: AI_UNAVAILABLE, reason: 'provider_error', text: UNAVAILABLE_TEXT };
  }

  const call = await callModel(
    () =>
      model.invoke([
        { role: 'system', content: ANSWER_SYSTEM_PROMPT },
        { role: 'user', content: renderAnswerInput(input) },
      ]),
    deps.breaker
  );

  if (!call.ok) {
    console.warn(
      `[fleetgraph] answer unavailable (${call.reason}):`,
      call.error instanceof Error ? call.error.message : call.error
    );
    return { status: AI_UNAVAILABLE, reason: call.reason, text: UNAVAILABLE_TEXT };
  }

  const text = extractText(call.value);
  if (!text) {
    return { status: AI_UNAVAILABLE, reason: 'invalid_output', text: UNAVAILABLE_TEXT };
  }

  return { status: 'answered', text };
}

/**
 * Pull the text out of whatever the model returned.
 *
 * A LangChain `AIMessage.content` is a string in the ordinary case and an array
 * of typed blocks when the provider returns anything richer. Handling both here
 * keeps every caller from having to know that, and a shape we do not recognise
 * degrades to `ai_unavailable` rather than to `"[object Object]"` on screen.
 */
function extractText(value: unknown): string {
  if (typeof value === 'string') return value.trim();

  const content = (value as { content?: unknown } | null)?.content;
  if (typeof content === 'string') return content.trim();

  if (Array.isArray(content)) {
    return content
      .map((block) =>
        typeof block === 'string'
          ? block
          : typeof (block as { text?: unknown })?.text === 'string'
            ? (block as { text: string }).text
            : ''
      )
      .join('')
      .trim();
  }

  return '';
}

/** Adapter for the graph's injected `AnswerFn`, which is typed `Promise<string>`. */
export function makeAnswer(deps: AnswerDeps = {}) {
  return async function answer(input: AnswerInput): Promise<string> {
    const result = await composeAnswer(input, deps);

    // Throw rather than return UNAVAILABLE_TEXT. Same seam bug as makeJudge
    // (FG-281), and this one is more visible to a user.
    //
    // The text itself is honest — it says the model could not be reached. The
    // CHANNEL was the problem: returning it as a string made the graph set
    // `outcome: 'answered'` with a non-empty answer, so the chat endpoint
    // replied 200 and the UI rendered a degradation notice as a normal
    // assistant message. Ship already has an `ai_unavailable` state for
    // exactly this, and it never got the chance to show it.
    //
    // Caught by the chat route test returning 200 where it expected a 503,
    // immediately after the graph was wired for the first time.
    //
    // `composeAnswer` still returns the structured result for direct callers
    // that want to render the text themselves.
    if (result.status === AI_UNAVAILABLE) {
      throw new AnswerUnavailableError(result.reason ?? 'unknown');
    }

    return result.text;
  };
}

export class AnswerUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(`answer unavailable: ${reason}`);
    this.name = 'AnswerUnavailableError';
  }
}
