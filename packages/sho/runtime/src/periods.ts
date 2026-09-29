import type { Period } from "./dates.ts";

// The calendar day a period is read on, in the business's time zone (Europe/Kyiv for Shozee).
export interface Day {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

// Inclusive calendar days, YYYY-MM-DD. Shozee's createdFrom is `from` at 00:00 and createdTo is the day after `to` at 00:00, both Europe/Kyiv.
export interface PeriodDates {
  readonly from: string;
  readonly to: string;
}

const DAY_MS = 86_400_000;
const RANGE = /^range:(\d{2})-(\d{2})\.\.(\d{2})-(\d{2})$/;
const YEAR_RANGE = /^range:(\d{4})-(\d{2})-(\d{2})\.\.(\d{4})-(\d{2})-(\d{2})$/;
const QUARTER_MONTHS = 3;
const LAST_DAYS = /^last_days:(\d+)$/;

function iso(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

function dated(from: number, to: number): PeriodDates {
  return { from: iso(from), to: iso(to) };
}

function valid(year: number, month: number, day: number): boolean {
  const time = new Date(Date.UTC(year, month - 1, day));
  return month >= 1 && month <= 12 && time.getUTCFullYear() === year && time.getUTCMonth() === month - 1 && time.getUTCDate() === day;
}

// A spoken range has no year (spec §6): it is the latest one that has started by today, because future periods are not spoken (D17).
function rangeDates(match: RegExpMatchArray, today: Day, now: number): PeriodDates | null {
  const [startMonth, startDay, endMonth, endDay] = match.slice(1, 5).map(Number);
  if (startMonth === undefined || startDay === undefined || endMonth === undefined || endDay === undefined) return null;
  let year = today.year;
  if (Date.UTC(year, startMonth - 1, startDay) > now) year -= 1;
  const endYear = Date.UTC(year, endMonth - 1, endDay) < Date.UTC(year, startMonth - 1, startDay) ? year + 1 : year;
  if (!valid(year, startMonth, startDay) || !valid(endYear, endMonth, endDay)) return null;
  return dated(Date.UTC(year, startMonth - 1, startDay), Date.UTC(endYear, endMonth - 1, endDay));
}

// The calendar days of a period value (spec §4, D57; v3 quarters and ranges with a year, D69), counted from `today`. Weeks start on Monday; «this» periods end today; null for a value it does not know.
export function periodDates(period: Period | string, today: Day): PeriodDates | null {
  if (!valid(today.year, today.month, today.day)) return null;
  const now = Date.UTC(today.year, today.month - 1, today.day);
  const weekday = (new Date(now).getUTCDay() + 6) % 7;
  switch (period) {
    case "today":
      return dated(now, now);
    case "yesterday":
      return dated(now - DAY_MS, now - DAY_MS);
    case "this_week":
      return dated(now - weekday * DAY_MS, now);
    case "last_week":
      return dated(now - (weekday + 7) * DAY_MS, now - (weekday + 1) * DAY_MS);
    case "this_month":
      return dated(Date.UTC(today.year, today.month - 1, 1), now);
    case "last_month":
      return dated(Date.UTC(today.year, today.month - 2, 1), Date.UTC(today.year, today.month - 1, 0));
    case "this_year":
      return dated(Date.UTC(today.year, 0, 1), now);
    case "this_quarter":
      return dated(Date.UTC(today.year, quarterStart(today.month) - 1, 1), now);
    case "last_quarter": {
      const start = quarterStart(today.month) - QUARTER_MONTHS;
      return dated(Date.UTC(today.year, start - 1, 1), Date.UTC(today.year, start - 1 + QUARTER_MONTHS, 0));
    }
    case "last_year":
      return dated(Date.UTC(today.year - 1, 0, 1), Date.UTC(today.year - 1, 11, 31));
  }
  const days = LAST_DAYS.exec(period);
  if (days) {
    const count = Number(days[1]);
    return count >= 1 ? dated(now - (count - 1) * DAY_MS, now) : null;
  }
  const range = RANGE.exec(period);
  if (range) return rangeDates(range, today, now);
  const years = YEAR_RANGE.exec(period);
  return years ? yearRangeDates(years) : null;
}

// The first month of the quarter a month is in (intents v3 §5.3: `this_quarter`, `last_quarter`, D69).
function quarterStart(month: number): number {
  return Math.floor((month - 1) / QUARTER_MONTHS) * QUARTER_MONTHS + 1;
}

// A range with a spoken year (v3, D69): the days as said.
function yearRangeDates(match: RegExpMatchArray): PeriodDates | null {
  const [startYear = 0, startMonth = 0, startDay = 0, endYear = 0, endMonth = 0, endDay = 0] = match.slice(1, 7).map(Number);
  if (!valid(startYear, startMonth, startDay) || !valid(endYear, endMonth, endDay)) return null;
  return dated(Date.UTC(startYear, startMonth - 1, startDay), Date.UTC(endYear, endMonth - 1, endDay));
}
