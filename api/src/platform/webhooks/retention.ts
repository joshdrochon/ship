/**
 * PF-483 — the delivery log's growth rate, its retention window, and the prune
 * that enforces both.
 *
 * Pre-Search 1.1 (PRD p.15) asks the growth rate and *"how long is the log
 * retained"*. PRD p.10's Include Assumptions requires *"delivery log rows ×
 * retention days × bytes per row"* and *"state both retention windows and
 * explain why each is set there."*
 *
 * The numbers are EXPORTED rather than written in a document, so the Pre-Search
 * write-up and the code cannot disagree and `retention.test.ts` can assert the
 * arithmetic instead of a prose claim.
 */
import type { Clock } from '../clock.js';
import type { IDeliveryLog } from './deliveryLog.js';

/**
 * p.9's tier table, as the two points it gives.
 *
 * Deliveries, not events: one event fans out to N subscriptions, and the log
 * records deliveries.
 */
export const DELIVERIES_PER_DAY = {
  /** 100 users. */
  small: 5_000,
  /** 100 000 users. */
  large: 5_000_000,
} as const;

/**
 * The attempt multiplier. **1 for a healthy subscriber, 6 for a dead one**, so
 * the ceiling is 6×.
 *
 * Sizing at 6× is deliberately pessimistic and deliberately not adjusted down by
 * a "realistic" failure rate: a failure rate is a guess, and the number this
 * exercise wants is a ceiling. Note that PF-482's circuit breaker is what stops
 * the multiplier being unbounded — without it a permanently-broken subscription
 * pays 6× on every event forever, which is the runaway Pre-Search 1.2 asks about.
 */
export const ATTEMPT_MULTIPLIER_CEILING = 6;

/**
 * Bytes per row, derived from the schema rather than guessed.
 *
 *   fixed columns      ~160 B — 5 UUIDs (16 B each stored) + 2 ints + a
 *                      timestamptz + short enum text, plus row overhead (~24 B)
 *                      and the per-row index entries
 *   idempotency_key    ~75 B — `<uuid>:<uuid>` is 73 characters
 *   event_type         ~20 B
 *   signature_header   ~80 B — `t=<10 digits>,v1=<64 hex>`
 *   response_excerpt   ≤ 280 B, capped by the CHECK in migration 051 (PF-460)
 *   raw_body           ~500 B — the envelope over `documentSchema`'s seven
 *                      scalar fields (decision D7); bounded, not user content
 *                      of arbitrary size, because the payload is a projection
 *
 * `response_excerpt`'s cap is the reason this number is a CEILING rather than an
 * average: without it one subscriber's HTML error page is a megabyte per
 * attempt, and the whole estimate becomes unbounded by something we do not
 * control.
 */
export const BYTES_PER_ROW = 160 + 75 + 20 + 80 + 280 + 500;

/**
 * **30 days.** The retention window, and why it is set there.
 *
 * Matched to L12's audit-log window (decision D10) rather than chosen
 * independently: a developer debugging an integration reads the delivery log and
 * the audit trail together, and two windows would mean one of them silently
 * runs out first — the worst version of a retention policy, because the gap only
 * shows up mid-investigation.
 *
 * Long enough that a developer returning from a fortnight away can still see
 * what happened; short enough that the storage below is a rounding error at the
 * small tier and a manageable number at the large one.
 */
export const RETENTION_DAYS = 30;

/**
 * The SECOND window p.10 asks about: dead-lettered rows are retained
 * **indefinitely** until replayed or dismissed.
 *
 * Deleting the DLQ is deleting the thing the portal exists to show (p.4:
 * *"visible in the developer portal"*), and a 30-day window that quietly empties
 * it turns that requirement into one that holds for a while. The cost is
 * bounded by the same circuit breaker: a permanently-broken subscription
 * accumulates dead letters at the breaker's rate, not at the event rate.
 */
export const DLQ_RETAINED_INDEFINITELY = true;

/** Bytes of delivery log at steady state, for a given deliveries-per-day rate. */
export function retentionBytes(
  deliveriesPerDay: number,
  multiplier: number = ATTEMPT_MULTIPLIER_CEILING,
): number {
  return deliveriesPerDay * multiplier * RETENTION_DAYS * BYTES_PER_ROW;
}

/**
 * The numbers the write-up quotes, COMPUTED rather than typed.
 *
 *   100 users        900 000 rows over 30 days → **~1.0 GB**
 *   100 000 users    900 million rows over 30 days → **~1.0 TB**
 *   …healthy (1×)    **~167 GB** at the same tier
 *
 * The large number is the interesting one, and it is a terabyte rather than the
 * ~100 GB a first pass guessed — the arithmetic was wrong by an order of
 * magnitude and the test caught it, which is why these are exported constants
 * with an assertion rather than a sentence in a document.
 *
 * What it says: at the top tier the delivery log is a **larger storage line item
 * than the documents it describes**, and both the 280-char excerpt cap (PF-460)
 * and the 30-day window are load-bearing rather than tidiness. Removing the
 * excerpt cap makes the figure unbounded, because it is then set by the largest
 * HTML error page any subscriber returns. The honest conclusion for the
 * write-up: at 100 000 users this table wants partitioning by `attempted_at` and
 * a shorter window for `delivered` rows than for failures — neither of which is
 * built this week, and saying so is better than quoting a number that implies it
 * is fine.
 */
export const RETENTION_ESTIMATE = {
  smallBytes: retentionBytes(DELIVERIES_PER_DAY.small),
  largeBytes: retentionBytes(DELIVERIES_PER_DAY.large),
  /** The healthy case, for contrast: 1× rather than 6×. */
  largeHealthyBytes: retentionBytes(DELIVERIES_PER_DAY.large, 1),
} as const;

/**
 * The prune. Deletes rows past the window and NEVER an unreplayed DLQ row.
 *
 * The exclusion is in the SQL predicate (`pgDeliveryLog.prune`), not applied by
 * this caller: a retention job that filtered afterwards would be one edit away
 * from deleting the DLQ, and the edit would look harmless.
 */
export async function pruneDeliveryLog(
  log: IDeliveryLog,
  clock: Clock,
  retentionDays: number = RETENTION_DAYS,
): Promise<number> {
  const cutoff = new Date(clock.nowMs() - retentionDays * 24 * 60 * 60 * 1000);
  return log.prune(cutoff.toISOString());
}
