/**
 * Business Day Calculator
 *
 * Calculates business days excluding weekends and federal holidays.
 * Uses OPM-defined federal holiday schedules for 2025 and 2026.
 */

// Federal holidays follow OPM rules:
// - If holiday falls on Saturday, observed on Friday
// - If holiday falls on Sunday, observed on Monday

const FEDERAL_HOLIDAYS_2025: string[] = [
  '2025-01-01', // New Year's Day
  '2025-01-20', // Martin Luther King Jr. Day
  '2025-02-17', // Presidents' Day
  '2025-05-26', // Memorial Day
  '2025-06-19', // Juneteenth
  '2025-07-04', // Independence Day
  '2025-09-01', // Labor Day
  '2025-10-13', // Columbus Day
  '2025-11-11', // Veterans Day
  '2025-11-27', // Thanksgiving Day
  '2025-12-25', // Christmas Day
];

const FEDERAL_HOLIDAYS_2026: string[] = [
  '2026-01-01', // New Year's Day
  '2026-01-19', // Martin Luther King Jr. Day
  '2026-02-16', // Presidents' Day
  '2026-05-25', // Memorial Day
  '2026-06-19', // Juneteenth
  '2026-07-03', // Independence Day (observed - July 4 is Saturday)
  '2026-09-07', // Labor Day
  '2026-10-12', // Columbus Day
  '2026-11-11', // Veterans Day
  '2026-11-26', // Thanksgiving Day
  '2026-12-25', // Christmas Day
];

// Combined set for quick lookup
const FEDERAL_HOLIDAYS = new Set([
  ...FEDERAL_HOLIDAYS_2025,
  ...FEDERAL_HOLIDAYS_2026,
]);

/**
 * Parse an ISO date string to a Date object in UTC
 */
function parseDate(dateStr: string): Date {
  const parts = dateStr.split('-');
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  return new Date(Date.UTC(year, month - 1, day));
}

/**
 * Format a Date object to ISO date string (YYYY-MM-DD)
 */
function formatDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Check if a date is a weekend (Saturday or Sunday)
 */
function isWeekend(date: Date): boolean {
  const day = date.getUTCDay();
  return day === 0 || day === 6; // Sunday = 0, Saturday = 6
}

/**
 * Check if a date is a federal holiday
 */
function isFederalHoliday(dateStr: string): boolean {
  return FEDERAL_HOLIDAYS.has(dateStr);
}

/**
 * Check if a date is a business day (not weekend, not federal holiday)
 *
 * @param dateStr - ISO date string (YYYY-MM-DD)
 * @returns true if the date is a business day
 */
export function isBusinessDay(dateStr: string): boolean {
  const date = parseDate(dateStr);

  if (isWeekend(date)) {
    return false;
  }

  if (isFederalHoliday(dateStr)) {
    return false;
  }

  return true;
}

/**
 * Get the next business day from a given date
 * If the given date is a business day, returns the next business day after it
 *
 * @param dateStr - ISO date string (YYYY-MM-DD)
 * @returns ISO date string of the next business day
 */
export function getNextBusinessDay(dateStr: string): string {
  const date = parseDate(dateStr);

  // Move to the next day
  date.setUTCDate(date.getUTCDate() + 1);
  let currentDateStr = formatDate(date);

  // Keep moving forward until we find a business day
  while (!isBusinessDay(currentDateStr)) {
    date.setUTCDate(date.getUTCDate() + 1);
    currentDateStr = formatDate(date);
  }

  return currentDateStr;
}

/**
 * Add a number of business days to a date
 *
 * @param dateStr - ISO date string (YYYY-MM-DD) starting date
 * @param days - Number of business days to add (positive or negative)
 * @returns ISO date string of the resulting date
 */
export function addBusinessDays(dateStr: string, days: number): string {
  if (days === 0) {
    return dateStr;
  }

  const date = parseDate(dateStr);
  const direction = days > 0 ? 1 : -1;
  let remaining = Math.abs(days);

  while (remaining > 0) {
    date.setUTCDate(date.getUTCDate() + direction);
    const currentDateStr = formatDate(date);

    if (isBusinessDay(currentDateStr)) {
      remaining--;
    }
  }

  return formatDate(date);
}

/**
 * Count business days between two dates (exclusive of start, inclusive of end)
 *
 * @param startDateStr - ISO date string (YYYY-MM-DD) start date
 * @param endDateStr - ISO date string (YYYY-MM-DD) end date
 * @returns Number of business days between the dates
 */
export function businessDaysBetween(startDateStr: string, endDateStr: string): number {
  const startDate = parseDate(startDateStr);
  const endDate = parseDate(endDateStr);

  // Determine direction
  const forward = endDate >= startDate;
  const direction = forward ? 1 : -1;

  let count = 0;
  const current = new Date(startDate);

  while (true) {
    current.setUTCDate(current.getUTCDate() + direction);
    const currentDateStr = formatDate(current);

    if (forward) {
      if (current > endDate) break;
    } else {
      if (current < endDate) break;
    }

    if (isBusinessDay(currentDateStr)) {
      count++;
    }
  }

  return forward ? count : -count;
}

/**
 * Get the list of federal holidays for a given year
 *
 * @param year - The year to get holidays for
 * @returns Array of ISO date strings for federal holidays
 */
export function getFederalHolidays(year: number): string[] {
  if (year === 2025) {
    return [...FEDERAL_HOLIDAYS_2025];
  }
  if (year === 2026) {
    return [...FEDERAL_HOLIDAYS_2026];
  }
  // Return empty for unsupported years - caller should handle gracefully
  return [];
}
