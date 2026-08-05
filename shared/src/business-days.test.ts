import { describe, it, expect } from 'vitest';
import {
  isBusinessDay,
  getNextBusinessDay,
  addBusinessDays,
  businessDaysBetween,
  getFederalHolidays,
} from './business-days.js';

describe('business-days', () => {
  describe('isBusinessDay', () => {
    it('returns true for a regular weekday', () => {
      // Wednesday January 15, 2025
      expect(isBusinessDay('2025-01-15')).toBe(true);
    });

    it('returns false for Saturday', () => {
      // Saturday January 18, 2025
      expect(isBusinessDay('2025-01-18')).toBe(false);
    });

    it('returns false for Sunday', () => {
      // Sunday January 19, 2025
      expect(isBusinessDay('2025-01-19')).toBe(false);
    });

    it('returns false for federal holidays', () => {
      // New Year's Day 2025
      expect(isBusinessDay('2025-01-01')).toBe(false);
      // MLK Day 2025
      expect(isBusinessDay('2025-01-20')).toBe(false);
      // Thanksgiving 2025
      expect(isBusinessDay('2025-11-27')).toBe(false);
    });

    it('returns false for observed holidays (July 4 2026 observed on Friday)', () => {
      // July 4, 2026 is Saturday, observed on Friday July 3
      expect(isBusinessDay('2026-07-03')).toBe(false);
      // July 4 itself (Saturday) is also not a business day
      expect(isBusinessDay('2026-07-04')).toBe(false);
    });

    it('returns true for the day after a holiday', () => {
      // January 2, 2025 (day after New Year's)
      expect(isBusinessDay('2025-01-02')).toBe(true);
    });
  });

  describe('getNextBusinessDay', () => {
    it('returns Monday for Friday', () => {
      // Friday January 17, 2025 -> Monday January 20, 2025 is MLK Day
      // So next business day is Tuesday January 21, 2025
      expect(getNextBusinessDay('2025-01-17')).toBe('2025-01-21');
    });

    it('returns Monday for Saturday', () => {
      // Saturday January 11, 2025 -> Monday January 13, 2025
      expect(getNextBusinessDay('2025-01-11')).toBe('2025-01-13');
    });

    it('returns Monday for Sunday', () => {
      // Sunday January 12, 2025 -> Monday January 13, 2025
      expect(getNextBusinessDay('2025-01-12')).toBe('2025-01-13');
    });

    it('skips federal holidays', () => {
      // Wednesday December 24, 2025 -> Thursday December 25 is Christmas
      // So next business day is Friday December 26, 2025
      expect(getNextBusinessDay('2025-12-24')).toBe('2025-12-26');
    });

    it('skips weekends and holidays combined', () => {
      // Thursday November 26, 2026 is Thanksgiving
      // Friday is not a federal holiday, but let's check a weekend after holiday
      // Wednesday Nov 25, 2026 -> Thanksgiving is Nov 26 -> Friday Nov 27
      expect(getNextBusinessDay('2025-11-26')).toBe('2025-11-28'); // Skip Thanksgiving
    });
  });

  describe('addBusinessDays', () => {
    it('returns same date when adding 0 days', () => {
      expect(addBusinessDays('2025-01-15', 0)).toBe('2025-01-15');
    });

    it('adds 1 business day correctly', () => {
      // Wednesday January 15 + 1 = Thursday January 16
      expect(addBusinessDays('2025-01-15', 1)).toBe('2025-01-16');
    });

    it('skips weekends when adding days', () => {
      // Friday January 17, 2025 + 1 business day = Monday January 20 (MLK Day)
      // So it should be Tuesday January 21
      expect(addBusinessDays('2025-01-17', 1)).toBe('2025-01-21');
    });

    it('handles multiple business days across weekends', () => {
      // Wednesday January 15, 2025 + 5 business days
      // Jan 16 (Thu), 17 (Fri), [skip 18-19 weekend], [skip 20 MLK Day], 21 (Tue), 22 (Wed)
      expect(addBusinessDays('2025-01-15', 5)).toBe('2025-01-23');
    });

    it('correctly skips holiday weeks', () => {
      // Monday November 24, 2025 + 3 business days
      // Nov 25 (Tue), 26 (Wed), [skip 27 Thanksgiving], 28 (Fri)
      expect(addBusinessDays('2025-11-24', 3)).toBe('2025-11-28');
    });

    it('handles negative days (subtracting)', () => {
      // Wednesday January 22, 2025 - 1 business day = Tuesday January 21
      expect(addBusinessDays('2025-01-22', -1)).toBe('2025-01-21');
    });

    it('handles negative days across weekends', () => {
      // Monday January 13, 2025 - 1 business day = Friday January 10
      expect(addBusinessDays('2025-01-13', -1)).toBe('2025-01-10');
    });
  });

  describe('businessDaysBetween', () => {
    it('returns 0 for same date', () => {
      expect(businessDaysBetween('2025-01-15', '2025-01-15')).toBe(0);
    });

    it('counts 1 business day correctly', () => {
      // Jan 15 to Jan 16 = 1 business day
      expect(businessDaysBetween('2025-01-15', '2025-01-16')).toBe(1);
    });

    it('excludes weekends from count', () => {
      // Friday Jan 17 to Monday Jan 20 = 0 (MLK Day is Monday)
      // Friday Jan 17 to Tuesday Jan 21 = 1
      expect(businessDaysBetween('2025-01-17', '2025-01-21')).toBe(1);
    });

    it('calculates correctly across holidays', () => {
      // Wednesday November 26 to Friday November 28
      // Nov 27 is Thanksgiving, Nov 28 is Friday
      // So only 1 business day (Friday the 28th)
      expect(businessDaysBetween('2025-11-26', '2025-11-28')).toBe(1);
    });

    it('handles negative ranges (end before start)', () => {
      // Tuesday Jan 21 to Wednesday Jan 15 (going backwards)
      // Jan 20 (MLK Day - skip), Jan 19 (Sun - skip), Jan 18 (Sat - skip)
      // Jan 17 (Fri), Jan 16 (Thu), Jan 15 (Wed) = 3 business days
      expect(businessDaysBetween('2025-01-21', '2025-01-15')).toBe(-3);
    });

    it('counts full week correctly', () => {
      // Monday Jan 6 to Friday Jan 10 = 4 business days (Tue, Wed, Thu, Fri)
      expect(businessDaysBetween('2025-01-06', '2025-01-10')).toBe(4);
    });
  });

  describe('getFederalHolidays', () => {
    it('returns 2025 holidays', () => {
      const holidays = getFederalHolidays(2025);
      expect(holidays).toContain('2025-01-01'); // New Year's
      expect(holidays).toContain('2025-01-20'); // MLK Day
      expect(holidays).toContain('2025-07-04'); // Independence Day
      expect(holidays).toContain('2025-11-27'); // Thanksgiving
      expect(holidays).toContain('2025-12-25'); // Christmas
      expect(holidays.length).toBe(11);
    });

    it('returns 2026 holidays', () => {
      const holidays = getFederalHolidays(2026);
      expect(holidays).toContain('2026-01-01'); // New Year's
      expect(holidays).toContain('2026-07-03'); // Independence Day (observed)
      expect(holidays).toContain('2026-11-26'); // Thanksgiving
      expect(holidays.length).toBe(11);
    });

    it('returns empty array for unsupported years', () => {
      expect(getFederalHolidays(2024)).toEqual([]);
      expect(getFederalHolidays(2027)).toEqual([]);
    });
  });
});
