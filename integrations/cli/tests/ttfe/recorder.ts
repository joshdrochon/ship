/**
 * PF-591 / PF-592 / PF-593 — the stage clock, the artifact, and the first line
 * of a failure.
 *
 * ── Monotonic, not wall ────────────────────────────────────────────────────
 * `performance.now()`, which is what p.7's own sketch uses. `Date.now()` moves
 * when NTP does, and a drill whose graded number can go backwards mid-run is a
 * drill that will one day report a negative stage.
 *
 * ── Why gaps are measured rather than assumed to be zero ───────────────────
 * PF-591 requires the six stage times PLUS the inter-stage gaps to reconcile
 * with the total to within 1 ms. Five stages summing to 8 s inside a 55 s run is
 * a measurement bug, and without the reconciliation nobody sees it — the run
 * still says "under 60 s" and the missing 47 s is real work that no stage owns.
 *
 * ── A failure that produces no artifact produces no diagnosis ──────────────
 * `write()` is called on the failure path too, with `pass: false` and whatever
 * stages did complete (PF-593). p.14 ends the PRD with *"The TTFE drill is the
 * rubric"*; the artifact is what a grader reads when it goes red.
 */
import { STAGE_LABELS, STAGE_IDS, type StageId } from './stages.js';

export interface StageRecord {
  id: StageId;
  elapsedMs: number;
  /** Monotonic, relative to the recorder's own origin. Not in the artifact. */
  startedAt: number;
  endedAt: number;
}

export interface TtfeArtifact {
  mode: string;
  commit: string;
  startedAtIso: string;
  stages: { id: StageId; elapsedMs: number }[];
  totalMs: number;
  pass: boolean;
  /** Present only on a failed run — PF-593's first line, verbatim. */
  failure?: { stage: StageId | null; elapsedMs: number | null; message: string };
  /** Everything else the four consumers of this file read. */
  metrics: Record<string, number | string | boolean | null>;
}

/**
 * PF-593 — a stage failure that NAMES the stage and its elapsed ms.
 *
 * A generic runner timeout names nothing. This wraps whatever the stage threw
 * (including a timeout raised inside the stage) so the first line a grader reads
 * is the stage id and the number, before any stack.
 */
export class StageFailure extends Error {
  constructor(
    readonly stage: StageId,
    readonly elapsedMs: number,
    readonly cause: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`ttfe stage "${stage}" (${STAGE_LABELS[stage]}) FAILED after ${Math.round(elapsedMs)} ms: ${detail}`);
    this.name = 'StageFailure';
  }
}

export class StageRecorder {
  private readonly records: StageRecord[] = [];
  private readonly extra: Record<string, number | string | boolean | null> = {};
  readonly startedAtIso = new Date().toISOString();

  /**
   * Runs `body` as the named stage.
   *
   * The elapsed time is taken in a `finally`, so a stage that throws still has a
   * number — which is the whole of PF-593's "names the stage, its elapsed ms,
   * and the assertion".
   */
  async stage<T>(id: StageId, body: () => Promise<T>): Promise<T> {
    const startedAt = performance.now();
    try {
      const result = await body();
      // ONE reading of the clock, used for both fields. Two calls would make
      // `elapsedMs` a few microseconds longer than `endedAt - startedAt` and put
      // a systematic bias into the reconciliation the tolerance exists to catch.
      const endedAt = performance.now();
      this.records.push({ id, startedAt, endedAt, elapsedMs: endedAt - startedAt });
      return result;
    } catch (error) {
      const endedAt = performance.now();
      const elapsedMs = endedAt - startedAt;
      this.records.push({ id, startedAt, endedAt, elapsedMs });
      throw new StageFailure(id, elapsedMs, error);
    }
  }

  record(key: string, value: number | string | boolean | null): void {
    this.extra[key] = value;
  }

  get stages(): readonly StageRecord[] {
    return this.records;
  }

  /** First stage start → last stage end. p.8's `performance.now() - t0`. */
  get totalMs(): number {
    const first = this.records[0];
    const last = this.records[this.records.length - 1];
    if (first === undefined || last === undefined) return 0;
    return last.endedAt - first.startedAt;
  }

  /** Sum of the measured holes BETWEEN stages. Should be small; is never assumed. */
  get gapMs(): number {
    let total = 0;
    for (let i = 1; i < this.records.length; i += 1) {
      const previous = this.records[i - 1];
      const current = this.records[i];
      if (previous === undefined || current === undefined) continue;
      total += current.startedAt - previous.endedAt;
    }
    return total;
  }

  get stageSumMs(): number {
    return this.records.reduce((sum, record) => sum + record.elapsedMs, 0);
  }

  /** PF-591's third assertion, as one number a test compares to the tolerance. */
  get reconciliationErrorMs(): number {
    return Math.abs(this.totalMs - (this.stageSumMs + this.gapMs));
  }

  missingStages(): StageId[] {
    const seen = new Set(this.records.map((record) => record.id));
    return STAGE_IDS.filter((id) => !seen.has(id));
  }

  toArtifact(mode: string, commit: string, failure?: unknown): TtfeArtifact {
    const stageFailure = failure instanceof StageFailure ? failure : null;
    return {
      mode,
      commit,
      startedAtIso: this.startedAtIso,
      stages: this.records.map(({ id, elapsedMs }) => ({ id, elapsedMs: round(elapsedMs) })),
      totalMs: round(this.totalMs),
      pass: failure === undefined,
      ...(failure === undefined
        ? {}
        : {
            failure: {
              stage: stageFailure?.stage ?? null,
              elapsedMs: stageFailure === null ? null : round(stageFailure.elapsedMs),
              message: failure instanceof Error ? failure.message : String(failure),
            },
          }),
      metrics: {
        ...this.extra,
        stageSumMs: round(this.stageSumMs),
        interStageGapMs: round(this.gapMs),
        reconciliationErrorMs: round(this.reconciliationErrorMs),
      },
    };
  }

  /** The human-readable table p.6 also asks for. The gate reads the JSON. */
  toTable(): string {
    const lines = [
      '  stage                    elapsed',
      '  ────────────────────────────────',
      ...this.records.map(
        (record) => `  ${STAGE_LABELS[record.id].padEnd(24)} ${`${Math.round(record.elapsedMs)} ms`.padStart(7)}`,
      ),
      '  ────────────────────────────────',
      `  ${'TOTAL'.padEnd(24)} ${`${Math.round(this.totalMs)} ms`.padStart(7)}`,
    ];
    return lines.join('\n');
  }
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
