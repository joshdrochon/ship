/**
 * What a detector produces.
 *
 * A Signal is a MEASUREMENT, not a judgement. It records that a threshold was
 * crossed and by how much; whether that is worth a human's attention is decided
 * later, by the model, with context the SQL cannot see (PRESEARCH.md Q2).
 *
 * The separation is deliberate and visible in the graph state: `signals` stay
 * distinct from `findings` so a LangSmith trace shows exactly where determinism
 * ends and the model begins (Q18).
 */

/** The five signal families from PRESEARCH.md Q1. */
export const SIGNAL_TYPES = [
  'stalled_work',
  'sprint_miss_risk',
  'review_bottleneck',
  'load_imbalance',
  'rework_churn',
] as const;

export type SignalType = (typeof SIGNAL_TYPES)[number];

export interface Signal {
  type: SignalType;

  /** The document this is about — an issue, a sprint, or a project. */
  targetId: string;
  targetType: 'issue' | 'sprint' | 'project';
  targetTitle: string;

  /**
   * The measured value that crossed the threshold, and the threshold itself.
   * Both travel to the model so it judges against a stated bar rather than
   * re-deriving one.
   */
  measurement: number;
  threshold: number;

  /**
   * Business-day bucket the measurement falls into. Part of the fingerprint, so
   * an issue idle 5 days and the same issue idle 20 days are DIFFERENT findings
   * and each gets surfaced once (PRESEARCH.md Q20).
   */
  bucket: string;

  /** Stable suppression key. See fingerprint.ts. */
  fingerprint: string;

  /**
   * Everything else the judgment prompt needs, already measured. The model never
   * queries — it receives facts (Q31). Keeps the prompt small and keeps the
   * model out of arithmetic it is bad at.
   */
  context: Record<string, string | number | null>;

  /** Who is accountable, resolved per signal type (PRESEARCH.md Q6). */
  accountableUserId: string | null;
}

/** One workspace's scan result. */
export interface DetectorRun {
  workspaceId: string;
  /** Upper bound of the window scanned — becomes the watermark on completion. */
  scannedThrough: Date;
  signals: Signal[];
}

/**
 * Thresholds, in business days unless stated.
 *
 * Constants rather than literals so the tests and the judgment prompt cite the
 * same number, and so changing one is a single edit with a visible diff.
 */
export const THRESHOLDS = {
  /** in_progress with no movement for this long */
  STALLED_WORK_DAYS: 5,
  /** in_review with no movement for this long */
  REVIEW_BOTTLENECK_DAYS: 2,
  /** sprint ends within this long and still has unstarted work */
  SPRINT_MISS_DAYS: 2,
  /** assignee's in-progress count exceeds the team median by this multiple */
  LOAD_IMBALANCE_FACTOR: 2,
  /** a team smaller than this makes a median meaningless */
  LOAD_IMBALANCE_MIN_TEAM: 3,
  /** done -> in_progress transitions within one sprint */
  REWORK_CHURN_REOPENS: 2,
} as const;
