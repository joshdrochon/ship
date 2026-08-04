/**
 * The single state object threaded through every node (PRESEARCH.md Q18).
 *
 * ── Why one object rather than per-node arguments ───────────────────────────
 * Every node reads from and writes to this, so a LangSmith trace shows exactly
 * what each node saw and what it added. Passing arguments node-to-node would
 * make the trace show call shapes instead of project state, which is the thing
 * a reviewer actually needs to read.
 *
 * ── The separation this file exists to enforce ──────────────────────────────
 * `signals` and `findings` are deliberately different fields (FG-068):
 *
 *   signals   MEASURED   — SQL crossed a stated threshold. Deterministic.
 *                          Reproducible from the database alone.
 *   findings  JUDGED     — a model decided the measurement was worth a human's
 *                          attention, and to whom. Not reproducible.
 *
 * Collapsing them into one list would save a field and destroy the property
 * that matters: in a trace, the boundary between "the database says so" and
 * "the model thinks so" is visible as a state transition rather than buried in
 * a node's internals. When a finding is wrong, that boundary is the first thing
 * you look at — was the measurement wrong, or the judgement?
 *
 * ── Reducers ───────────────────────────────────────────────────────────────
 * The three fetch nodes run as a parallel fan-out (Q16), so their writes land
 * concurrently. Each writes a DIFFERENT field, so last-write-wins is correct
 * and no merge logic is needed. `messages` is the exception — it accumulates
 * across on-demand turns, so it concatenates.
 */
import { Annotation } from '@langchain/langgraph';

import type { Signal } from '../detectors/types.js';
import type { Finding } from '../llm/types.js';

/** How the run was invoked. Drives the first conditional edge (Q17). */
export type Mode = 'proactive' | 'on_demand';

/**
 * What the run is looking at.
 *
 * Proactive runs scope to a workspace and let the detectors find their own
 * targets. On-demand runs scope to the document the user is looking at — the
 * chat endpoint sends route params, never rendered content (Q7).
 */
export interface Scope {
  workspaceId: string;
  /** On-demand only: the document the user is asking about. */
  documentId?: string;
  documentType?: string;
  /** The active tab in the UI, which narrows what the question is likely about. */
  tab?: string;
}

/**
 * A person in scope, with their role DERIVED rather than read from a column.
 *
 * Ship has no role column (Q5). Roles come from structure: who an issue is
 * assigned to, who owns the sprint or project, who a person document reports
 * to. That is a real constraint, not a shortcut — it means the agent cannot
 * know about a role the data does not express, and Q6 records the consequence
 * (there is no reviewer field, so review-bottleneck findings route to the
 * assignee rather than to a reviewer who does not exist in the schema).
 */
export interface Participant {
  userId: string;
  personDocumentId: string | null;
  name: string | null;
  /** Derived structurally. A person can hold more than one. */
  roles: Array<'assignee' | 'sprint_owner' | 'project_owner' | 'reports_to'>;
}

/**
 * A finding already surfaced and still open.
 *
 * Carried in state so `judge_signals` can skip it without a second query, and
 * so the trace shows what was suppressed rather than leaving it invisible. A
 * finding that vanishes with no record of why is indistinguishable from a
 * detector that broke.
 */
export interface SuppressedRef {
  fingerprint: string;
  signalType: string;
  targetId: string;
  escalationCount: number;
  lastSurfacedAt: Date | null;
}

/**
 * The action a finding proposes, classified by blast radius (Q3/Q4).
 *
 * `additive` runs without asking. `mutation` never does. The classification is
 * computed from the request shape before the action runs — never asked of the
 * model, which is exactly what you cannot trust it to self-assess (Q4).
 */
export type ActionClass = 'additive' | 'mutation';

export interface ProposedAction {
  class: ActionClass;
  kind: 'comment' | 'notify' | 'history_note' | 'state_change' | 'reassign' | 'sprint_move';
  targetId: string;
  /** Human-readable description of what would happen. Shown at the approval gate. */
  describe: string;
  /** Everything needed to execute it later, after an approval that may be hours away. */
  payload: Record<string, unknown>;
}

/** A proposal suspended at the approval gate, serialised into the checkpointer. */
export interface Pending {
  findingIndex: number;
  action: ProposedAction;
  recipientUserId: string | null;
  observationId: string | null;
}

/** One turn of on-demand conversation. */
export interface Message {
  role: 'user' | 'agent';
  content: string;
}

/**
 * Why `default` is specified on every channel.
 *
 * A node that reads an undefined array and calls `.length` on it fails at
 * runtime inside the graph, where the error surfaces as a node failure rather
 * than as the missing-initialiser it is. Defaults make every field readable
 * from the first node onward.
 */
export const GraphState = Annotation.Root({
  mode: Annotation<Mode>({
    reducer: (_prev, next) => next,
    default: () => 'proactive' as Mode,
  }),

  scope: Annotation<Scope>({
    reducer: (_prev, next) => next,
    default: () => ({ workspaceId: '' }),
  }),

  /**
   * Who invoked this. A user id on-demand; null on proactive runs, where the
   * actor is the agent itself. Kept explicit rather than inferred from `mode`
   * so an audit entry never has to guess.
   */
  actor: Annotation<string | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),

  // ── measured ─────────────────────────────────────────────────────────────

  signals: Annotation<Signal[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),

  participants: Annotation<Participant[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),

  suppressed: Annotation<SuppressedRef[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),

  /**
   * Upper bound of the scanned window, captured before the detectors run and
   * written to the watermark only at `deliver` (Q24). Held in state so the
   * value that gets committed is provably the one the scan used, rather than a
   * fresh `new Date()` at the end that would silently skip anything written
   * during the run.
   */
  scannedThrough: Annotation<Date | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),

  // ── judged ───────────────────────────────────────────────────────────────

  findings: Annotation<Finding[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),

  pending: Annotation<Pending | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),

  /** On-demand only. Accumulates rather than replacing. */
  messages: Annotation<Message[]>({
    reducer: (prev, next) => prev.concat(next),
    default: () => [],
  }),

  /** On-demand only: the grounded answer, read-only by construction (Q3). */
  answer: Annotation<string | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),

  // ── outcome ──────────────────────────────────────────────────────────────

  /**
   * Why the run ended. Recorded rather than inferred so a quiet run is
   * distinguishable from a broken one in the trace — the single most important
   * thing to be able to tell apart, because both look like silence.
   */
  outcome: Annotation<
    | 'quiet_no_signals'
    | 'quiet_all_suppressed'
    | 'quiet_nothing_survived_judgment'
    | 'delivered'
    | 'awaiting_approval'
    | 'answered'
    | 'ai_unavailable'
    | null
  >({
    reducer: (_prev, next) => next,
    default: () => null,
  }),

  /** Non-fatal problems. A degraded run still delivers what it has. */
  errors: Annotation<string[]>({
    reducer: (prev, next) => prev.concat(next),
    default: () => [],
  }),
});

export type GraphStateType = typeof GraphState.State;
export type GraphUpdate = Partial<GraphStateType>;
