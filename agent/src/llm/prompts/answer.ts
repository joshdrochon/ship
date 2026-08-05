/**
 * The on-demand answer prompt — the other model call FleetGraph makes.
 *
 * ── Read-only, and enforced in two places ──────────────────────────────────
 * PRESEARCH.md Q3 limits autonomous action to things that are additive and
 * reversible, and answering a question is the only one of those that happens
 * without a human in the loop at all. So this path is read-only twice over:
 *
 *  1. In code — `answer.ts` never binds tools to the model. There is no tool
 *     schema on the request, so there is no tool call the model could emit and
 *     nothing on our side that would execute one if it did. This is the
 *     enforcement; the prompt below is not.
 *  2. In the prompt — the model is told it cannot change anything, so it stops
 *     offering to and starts saying what the person should do instead.
 *
 * The order matters. A prompt that says "you have no tools" is a request, not a
 * control; the reason this path is safe is that the request carries no tools.
 * The wording exists so the ANSWERS are useful, not so the boundary holds.
 *
 * ── Grounded means grounded in measurements ────────────────────────────────
 * Same boundary as the judgement prompt: the model is given the scope, the
 * derived roles, and the measured signals — never document bodies, comments, or
 * names. Q7 is explicit that the chat endpoint sends route params rather than
 * rendered content, and this is the prompt that has to be answerable under that
 * constraint. When the state does not contain the answer, saying so is the
 * correct output; an agent that fills gaps with plausible project detail is
 * worse than one that says "I cannot see that."
 */
import type { JudgeParticipant, JudgeScope } from '../types.js';
import type { Signal } from '../../detectors/types.js';

export const ANSWER_SYSTEM_PROMPT = `You are FleetGraph, a project-intelligence assistant inside a work-tracking product. You are answering a question a user asked while looking at a document.

You are READ-ONLY. You have no tools, no database access, and no ability to create, edit, assign, comment on, or move anything. You cannot take an action on the user's behalf and must not offer to. When something needs doing, say plainly what would need to happen and who is accountable, and leave it to the user to do it.

Everything you know is in the state below: the scope the user is looking at, the people in scope with their derived roles, and any measured signals a deterministic detector has already produced. That is all. You have not read the document, its comments, or its history.

Rules:
- Answer only from the state provided. Cite the measurement when you use it — "it has been in review for 6 working days", not "it has been a while".
- If the state does not contain the answer, say so directly and name what you would need. Do not guess, extrapolate, or fill a gap with a plausible-sounding detail. An honest "I cannot see that from here" is a correct answer.
- Do not restate the whole state back. Answer the question that was asked.
- Keep it short — a few sentences unless the question genuinely needs more. Plain professional English, no greetings, no sign-offs, no emoji.
- Refer to people by their role or user id, never by a name you were not given.`;

/**
 * Render the state the answer must be grounded in.
 *
 * Signals appear as the same measurements the judgement prompt sends. If the
 * scan found nothing, that is stated rather than omitted — "no signals" is an
 * answer to a large share of the questions people actually ask ("is anything
 * stuck here?"), and an absent section reads as missing data instead.
 */
export function renderAnswerInput(input: {
  scope: JudgeScope;
  question: string;
  participants: readonly JudgeParticipant[];
  signals: readonly Signal[];
}): string {
  const roster = input.participants.length
    ? input.participants
        .map((p) => `  ${p.userId}: ${[...p.roles].sort().join(', ') || 'no derived role'}`)
        .join('\n')
    : '  (none resolved)';

  const signals = input.signals.length
    ? input.signals
        .map(
          (s) =>
            `  - ${s.type} on ${s.targetType} "${s.targetTitle}": measured ${s.measurement}, ` +
            `threshold ${s.threshold}, accountable ${s.accountableUserId ?? 'unresolved'}`
        )
        .join('\n')
    : '  (none — no detector threshold is currently crossed in this scope)';

  return [
    'SCOPE',
    `  workspace: ${input.scope.workspaceId}`,
    input.scope.documentId ? `  document: ${input.scope.documentId}` : null,
    input.scope.documentType ? `  document type: ${input.scope.documentType}` : null,
    input.scope.tab ? `  active tab: ${input.scope.tab}` : null,
    '',
    'PEOPLE IN SCOPE (user id: derived roles — no names are sent)',
    roster,
    '',
    'MEASURED SIGNALS',
    signals,
    '',
    'QUESTION',
    `  ${input.question}`,
  ]
    .filter((line) => line !== null)
    .join('\n');
}
