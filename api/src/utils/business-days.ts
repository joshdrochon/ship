/**
 * Re-export shim. The implementation moved to `@ship/shared` so the agent can
 * use it too — every FleetGraph detector threshold is expressed in business days
 * (PRESEARCH.md Q1), and a second copy of this logic in `agent/` would let the
 * two drift silently. Thresholds that disagree between the detector and the
 * product are worse than no detector.
 *
 * A shim rather than updating call sites, deliberately:
 * `api/src/services/accountability.test.ts` does
 *
 *     vi.mock('../utils/business-days.js', ...)
 *
 * to freeze the clock. Keeping this module path alive keeps that mock targeting
 * one small module. Pointing it at '@ship/shared' instead would mock the entire
 * shared package for that test file, which is a much broader blast radius for no
 * benefit.
 */
export {
  isBusinessDay,
  getNextBusinessDay,
  addBusinessDays,
  businessDaysBetween,
  getFederalHolidays,
} from '@ship/shared';
