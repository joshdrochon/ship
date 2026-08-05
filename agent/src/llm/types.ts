/**
 * What judgement produces, and the seam the graph reads it through.
 *
 * ── Why this file imports nothing from `../graph/` ──────────────────────────
 * `graph/state.ts` imports `Finding` from here. If this file reached back into
 * the graph the two would be a cycle, and the judge would stop being callable
 * on its own — which is exactly the property the unit tests depend on. So the
 * judgement entrypoint is a plain function: signals in, findings out, no graph
 * awareness. `JudgeScope` and `JudgeParticipant` below are structural mirrors
 * of the graph's `Scope` and `Participant`; TypeScript is structural, so the
 * graph's richer types satisfy them without either side importing the other.
 *
 * ── Signals are measured; findings are judged ───────────────────────────────
 * A `Signal` (see `../detectors/types.ts`) records that a threshold was crossed
 * and by how much. A `Finding` records that a model decided the measurement was
 * worth a human's attention, how loud it is, and how to say it. The two stay
 * separate types for the same reason they stay separate fields in graph state
 * (PRESEARCH.md Q18): in a trace, the boundary between "the database says so"
 * and "the model thinks so" has to be visible.
 *
 * ── A finding carries no target of its own ──────────────────────────────────
 * Only `fingerprint`, and it is the signal's fingerprint verbatim. The graph
 * looks the signal up by it and drops any finding it cannot match. That is the
 * safety property: a judgement cannot cause an action against a target the
 * measurement layer never named, because a judgement has no way to name one.
 * Everything the delivery layer needs about the target it reads from the
 * matched signal.
 */

/**
 * How loud a finding is.
 *
 * Three levels, not five. This drives one decision — whether a notification
 * interrupts now or waits — and a scale with more gradations than decisions is
 * a scale the model will use inconsistently for no gain.
 */
export const SEVERITIES = ['low', 'medium', 'high'] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface Finding {
  /**
   * Ties the judgement back to the Signal it came from. MUST be the signal's
   * fingerprint verbatim — the graph looks the signal up by it, and drops any
   * finding whose fingerprint has no matching signal.
   */
  fingerprint: string;

  severity: Severity;

  /**
   * Ship user id. Null means the model had no opinion and the graph falls back
   * to `signal.accountableUserId`.
   *
   * The judge only ever passes through an id the deterministic layer already
   * named — the accountable user for that signal, or a participant in scope.
   * Anything else becomes null. PRESEARCH.md Q6 rejects "let the model choose
   * the recipient" outright: routing that the model can invent is unauditable
   * when someone asks why they were not told.
   */
  recipientUserId: string | null;

  /**
   * The model's verdict on whether this instance deserves a human's attention
   * right now.
   *
   * False findings are returned, not dropped. Silently discarding them in the
   * judge would make "the model rejected it" indistinguishable from "the model
   * never saw it" in a trace, and that distinction is what tells us whether a
   * quiet week is a healthy project or a miscalibrated prompt.
   */
  worthSurfacing: boolean;

  /** One or two sentences, written for the recipient. */
  phrasing: string;
}

/**
 * The string the rest of Ship already uses for "the model was not reachable".
 *
 * `api/src/services/ai-analysis.ts` returns `{ error: 'ai_unavailable' }` and
 * the web UI knows how to render it. Reusing the token means a FleetGraph
 * outage looks like the outage the product already handles.
 */
export const AI_UNAVAILABLE = 'ai_unavailable' as const;

/** Why judgement did not happen. Distinguishing these matters in a trace. */
export type UnavailableReason =
  /** Breaker open — the provider was not called at all. */
  | 'circuit_open'
  /** The call was made and failed or timed out. */
  | 'provider_error'
  /** The call returned, but not in the shape the schema requires. */
  | 'invalid_output';

/**
 * Judgement outcome.
 *
 * A discriminated union rather than "empty array means something went wrong":
 * a quiet judgement (nothing worth surfacing) and an unreachable provider are
 * different events with different consequences — the first is the ordinary
 * case, the second means the signals persist unjudged and are judged next run
 * (Q24). Collapsing them would make an outage indistinguishable from calm.
 */
export type JudgmentResult =
  | { status: 'judged'; findings: Finding[]; fromCache: boolean }
  | { status: typeof AI_UNAVAILABLE; reason: UnavailableReason; findings: [] };

/**
 * Structural mirror of the graph's `Scope`.
 *
 * Only the fields judgement actually reads. The graph's type has more fields
 * and stays assignable to this one.
 */
export interface JudgeScope {
  workspaceId: string;
  documentId?: string;
  documentType?: string;
  tab?: string;
}

/**
 * Structural mirror of the graph's `Participant`, minus the name.
 *
 * The name is deliberately not read. Severity depends on ROLE — "the person
 * holding this also owns the sprint" changes the judgement, "the person is
 * called Alice" does not. Not sending names keeps the Q31 privacy boundary
 * tight for free, and the delivery layer still has the name because it works
 * from a user id against the database.
 */
export interface JudgeParticipant {
  userId: string;
  roles: readonly string[];
}

/** On-demand answer outcome. Same reasoning as `JudgmentResult`. */
export type AnswerResult =
  | { status: 'answered'; text: string }
  | { status: typeof AI_UNAVAILABLE; reason: UnavailableReason; text: string };
