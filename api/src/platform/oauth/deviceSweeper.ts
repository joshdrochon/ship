/**
 * PF-144 — the device-code sweeper, and Pre-Search 1.1's concurrency answer.
 * Lane L05, slice S4.
 *
 * ---------------------------------------------------------------------------
 * A FUNCTION ON AN INJECTED CLOCK, NEVER A BARE TIMER.
 * ---------------------------------------------------------------------------
 * `sweepDeviceCodes` takes the clock and returns a count. It schedules nothing.
 * That is what lets a test call it directly with a `FakeClock` advanced past an
 * expiry instead of waiting — PRD p.11 forbids `setTimeout` waits for timing
 * behaviour by name, and p.9's zero-flake budget over 20 runs depends on it.
 *
 * A caller that wants it to run periodically composes it with `Clock.setTimeout`
 * at the composition root, which is where the choice of a real timer belongs.
 * Mirrors L04's `sweepAuthorizationCodes` (PF-112) deliberately.
 *
 * ---------------------------------------------------------------------------
 * TWO CUT-OFFS, NOT ONE, AND THEY ARE RETAINED FOR DIFFERENT REASONS.
 * ---------------------------------------------------------------------------
 *   unredeemed + expired   dead weight the moment it expires. Nothing can ever
 *                          use it again, so it goes at `expires_at`.
 *   consumed / decided     must OUTLIVE its own TTL. A consumed row is what
 *                          makes a second poll answerable with `invalid_grant`
 *                          rather than with "unknown device code", and a denied
 *                          row is what makes `access_denied` reachable instead
 *                          of the client polling to expiry and reporting the
 *                          wrong reason (PF-133). One hour.
 */
import type { Clock } from '../clock.js';
import {
  CONSUMED_DEVICE_CODE_RETENTION_SECONDS,
  DEVICE_CODE_TTL_SECONDS,
  type IDeviceCodeRepo,
} from './deviceCodes.js';

export interface SweepDeviceCodesDeps {
  deviceCodeRepo: IDeviceCodeRepo;
  clock: Clock;
}

/**
 * Deletes expired-unredeemed rows and aged-out consumed rows.
 *
 * Returns the number removed, so a caller can log or assert on it rather than
 * inferring the sweep happened.
 */
export async function sweepDeviceCodes(deps: SweepDeviceCodesDeps): Promise<number> {
  const now = deps.clock.nowMs();
  return deps.deviceCodeRepo.deleteSwept(
    new Date(now),
    new Date(now - CONSUMED_DEVICE_CODE_RETENTION_SECONDS * 1000),
  );
}

/**
 * PRE-SEARCH 1.1's ANSWER, AS ARITHMETIC RATHER THAN AS REASSURANCE.
 *
 * PRD p.15 asks: *"How many concurrent CLI sessions will run device flow during
 * a demo, and does your polling-rate response (`slow_down` semantics) handle
 * them correctly?"*
 *
 * Handed to L25's PF-753 as numbers, because "it will be fine" is not an answer
 * to a question about capacity.
 *
 * **How many rows.** One row per `ship login`, and a row lives at most
 * `DEVICE_CODE_TTL_SECONDS` (600). So the live set is bounded by
 * logins-per-ten-minutes, not by total logins ever — the table is
 * self-limiting even with no sweeper at all, and the sweeper only bounds the
 * consumed tail. At a demo rate of, say, 20 logins in ten minutes the live set
 * is 20 rows. `estimateLiveDeviceCodes` below is that arithmetic, exported so
 * the write-up and the test read the same function.
 *
 * **Whether `slow_down` handles them correctly.** Yes, and by construction
 * rather than by tuning: `interval_seconds` and `last_polled_at` are columns on
 * each row (PF-137), so N concurrent flows have N independent throttles. One
 * client polling too fast cannot slow another's flow, and the test drives ten
 * interleaved flows to prove it rather than arguing it.
 *
 * **What it costs.** One indexed lookup per poll per session —
 * `WHERE device_code_hash = $1` against `UNIQUE(device_code_hash)`. At the
 * default 5-second interval, 20 concurrent flows is 4 lookups/second. The
 * `user_code` lookup is the non-indexed one (see `pgDeviceCodeRepo.ts`), and it
 * happens ONCE per flow at the verification screen, not per poll.
 */
export function estimateLiveDeviceCodes(loginsPerTenMinutes: number): number {
  // A row lives 600 s, so everything started inside the last ten minutes is
  // potentially live and nothing older can be.
  const windowMinutes = DEVICE_CODE_TTL_SECONDS / 60;
  return Math.ceil(loginsPerTenMinutes * (windowMinutes / 10));
}

/**
 * Polls per second across N concurrent flows at a given interval.
 *
 * The other half of the cost answer. Exported for the same reason: a number in
 * a document that nothing computes is a number that goes stale.
 */
export function estimatePollsPerSecond(concurrentFlows: number, intervalSeconds: number): number {
  return concurrentFlows / intervalSeconds;
}
