/**
 * The judgement prompt — the second of the two gates in PRESEARCH.md Q2.
 *
 * ── This prompt receives MEASUREMENTS. That is a privacy boundary. ──────────
 * Everything below is rendered from `Signal` fields: identifiers, a title, a
 * number, the threshold it crossed, a bucket, and a small map of pre-computed
 * facts. No document body, no comment text, no plan or retro content, no email
 * address, no person's name ever reaches Bedrock from this prompt.
 *
 * That is not a token optimisation, and it must not be relaxed as one. Ship
 * holds government work; the set of data that leaves the deployment for a
 * third-party model is a thing someone will eventually have to certify, and it
 * is defensible precisely because it is small and mechanical: the SQL layer did
 * the finding (Q1's decision 4), so the model never needs to search raw project
 * data to do its job. Q31 records the token consequence — 2,000–4,000 input
 * tokens instead of an order of magnitude more — but the boundary would be
 * worth keeping at any token price.
 *
 * If a future signal type wants to send document content, that is a decision to
 * take deliberately and write down, not a field to add to `Signal.context`.
 *
 * ── What the model is actually being asked ─────────────────────────────────
 * Not "did this cross a line" — SQL already answered that, deterministically,
 * and re-asking it would invite the model to do arithmetic on timestamps, which
 * it is bad at (Q2). It is asked the question SQL cannot answer: given
 * everything here at once, is THIS instance worth interrupting a human for
 * right now, and how loudly.
 *
 * ── Why every signal is judged in one call ─────────────────────────────────
 * Q32 names per-signal judgement as a cost cliff — N calls per run instead of
 * one. But batching is not only cheaper: severity is comparative. "The sprint
 * ends in two days" changes what the four other signals in that sprint mean,
 * and a model shown one signal at a time cannot see that. The batch is the
 * unit of judgement, not a bundling optimisation.
 */
import { z } from 'zod';

import { SEVERITIES } from '../types.js';
import type { JudgeParticipant, JudgeScope } from '../types.js';
import type { Signal } from '../../detectors/types.js';

/**
 * The shape the model must return, in the model's own vocabulary.
 *
 * snake_case here and camelCase on `Finding` is deliberate rather than sloppy:
 * this is the wire format the prompt describes, and the parser is the one place
 * the two vocabularies meet. Renaming the wire format to match TypeScript would
 * put a translation step inside the prompt instead, where it cannot be tested.
 */
export const JudgmentSchema = z.object({
  /** Copied from the input. The parser rejects any value it did not send. */
  fingerprint: z.string(),
  worth_surfacing: z.boolean(),
  severity: z.enum(SEVERITIES),
  /**
   * Who the phrasing is written for. The parser accepts this only when it
   * matches a user the deterministic layer already named (Q6); anything else
   * becomes null and the graph falls back to the accountable user.
   */
  recipient: z.string().nullable(),
  phrasing: z.string(),
});

export const JudgmentBatchSchema = z.object({
  judgments: z.array(JudgmentSchema),
});

export type JudgmentBatch = z.infer<typeof JudgmentBatchSchema>;

/**
 * Everything the model is told about how to judge.
 *
 * Written as a bar to judge against rather than a rubric to compute, because a
 * rubric is just the deterministic gate again — and we already have one of
 * those, in SQL, for free.
 */
export const JUDGE_SYSTEM_PROMPT = `You are FleetGraph, a project-intelligence agent for a work-tracking product.

A deterministic SQL layer has already measured everything below and confirmed each item crossed a stated threshold. You are NOT asked whether the threshold was crossed — it was. Do not recompute dates, durations, or counts; you do not have the raw data and the measurements given to you are authoritative.

You are asked the question the measurements cannot answer: for each item, is it worth interrupting a specific human about RIGHT NOW, and how loudly.

Judge the batch as a whole. Items interact: a sprint ending in two days makes idle work inside that sprint more urgent, and one person carrying most of the load explains why several of their items are stalled. Severity is comparative — if everything is high, nothing is.

WORTH SURFACING
Set worth_surfacing to true only if a named person could take a useful action today. Set it to false when:
- the measurement is only marginally past its threshold and nothing else in the batch makes it urgent
- another item in the batch is the same underlying problem stated better, and surfacing both would be noise
- the situation is already visibly being handled by the surrounding state
Being false is a normal, common outcome. A quiet result is a healthy project, not a failed run.

SEVERITY
- high: work is blocked or a commitment is about to be missed, and the recipient must act today
- medium: real drift that will become a problem if it is ignored this week
- low: worth recording, not worth interrupting anyone about

RECIPIENT
Each item names its accountable user id. Use it. If you genuinely think it is wrong, return null rather than a different id — routing is decided by structure, not by you, and an unexpected id is discarded.

PHRASING
One or two sentences, addressed to the recipient, in plain professional English:
- Lead with the measured fact, including the number. "This has been in review for 6 working days."
- Say what would help. Do not instruct, do not blame, do not speculate about causes you were not given.
- Never invent detail. You have only the measurements shown; if something is not there, it does not go in the sentence.
- No greetings, no sign-offs, no emoji, no exclamation marks.

Return one judgment for EVERY item you were given, including the ones you set worth_surfacing to false. Copy each fingerprint back exactly as given. Never invent a fingerprint.`;

/** Human-readable label for a signal type, so the prompt is not reading enums. */
const SIGNAL_LABELS: Record<string, string> = {
  stalled_work: 'Stalled work (in progress, not moving)',
  sprint_miss_risk: 'Sprint-miss risk (sprint ending with unstarted work)',
  review_bottleneck: 'Review bottleneck (waiting on review)',
  load_imbalance: 'Load imbalance (one person carrying much more than the team median)',
  rework_churn: 'Rework churn (work reopened repeatedly)',
};

/**
 * Render one signal as measurements.
 *
 * Every line here is a number, an identifier, a title, or a threshold. Adding a
 * line that is none of those crosses the boundary this file exists to hold.
 */
function renderSignal(signal: Signal, index: number): string {
  const context = Object.entries(signal.context)
    .filter(([, value]) => value !== null && value !== '')
    .map(([key, value]) => `    ${key}: ${String(value)}`)
    .join('\n');

  return [
    `ITEM ${index + 1}`,
    `  fingerprint: ${signal.fingerprint}`,
    `  type: ${SIGNAL_LABELS[signal.type] ?? signal.type}`,
    `  target: ${signal.targetType} "${signal.targetTitle}" (${signal.targetId})`,
    `  measured: ${signal.measurement} (threshold ${signal.threshold}, bucket ${signal.bucket})`,
    `  accountable_user_id: ${signal.accountableUserId ?? 'unresolved'}`,
    context ? `  measurements:\n${context}` : '  measurements: none',
  ].join('\n');
}

/**
 * Render the batch the model judges.
 *
 * Deterministic by construction — same signals in the same order produce byte-
 * identical output. FG-107's content-hash cache is hashed over this string, so
 * any nondeterminism here (a timestamp, a set iteration, an unsorted map) would
 * silently disable the cache and turn one finding back into a model call on
 * every run, which is the Q32 cliff.
 */
export function renderJudgeInput(input: {
  signals: readonly Signal[];
  participants: readonly JudgeParticipant[];
  scope: JudgeScope;
}): string {
  const roster = input.participants.length
    ? input.participants
        .map((p) => `  ${p.userId}: ${[...p.roles].sort().join(', ') || 'no derived role'}`)
        .join('\n')
    : '  (none resolved)';

  return [
    `WORKSPACE: ${input.scope.workspaceId}`,
    input.scope.documentId ? `FOCUS DOCUMENT: ${input.scope.documentId}` : null,
    '',
    'PEOPLE IN SCOPE (user id: derived roles — no names are sent)',
    roster,
    '',
    `MEASURED ITEMS (${input.signals.length})`,
    '',
    input.signals.map(renderSignal).join('\n\n'),
  ]
    .filter((line) => line !== null)
    .join('\n');
}
