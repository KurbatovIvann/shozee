/**
 * Europe/Kyiv calendar helpers for staff-assistant façades (SHO-360).
 * Relative language stays off the domain API. No extra npm timezone
 * dependency — `Intl` plus an offset round-trip.
 */

export const STAFF_ASSISTANT_TIME_ZONE = "Europe/Kyiv";

export const ORDERS_LIST_PERIODS = [
  "today",
  "this_week",
  "this_month",
] as const;

export type OrdersListPeriod = (typeof ORDERS_LIST_PERIODS)[number];

type KyivDate = {
  readonly year: number;
  readonly month: number;
  readonly day: number;
};

function partValue(
  parts: Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
): string {
  return parts.find((part) => part.type === type)?.value ?? "";
}

function kyivDateParts(now: Date): KyivDate {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: STAFF_ASSISTANT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  return {
    year: Number(partValue(parts, "year")),
    month: Number(partValue(parts, "month")),
    day: Number(partValue(parts, "day")),
  };
}

function timeZoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const asUtc = Date.UTC(
    Number(partValue(parts, "year")),
    Number(partValue(parts, "month")) - 1,
    Number(partValue(parts, "day")),
    Number(partValue(parts, "hour")),
    Number(partValue(parts, "minute")),
    Number(partValue(parts, "second")),
  );
  return asUtc - instant.getTime();
}

function zonedLocalToUtcMs(
  date: KyivDate,
  hour: number,
  minute: number,
  second: number,
  milli: number,
): number {
  // Offset is derived from second-aligned instants: `formatToParts` has
  // no millisecond field, so a 23:59:59.999 guess would skew the offset.
  const utcGuess = Date.UTC(
    date.year,
    date.month - 1,
    date.day,
    hour,
    minute,
    second,
    0,
  );
  const offset = timeZoneOffsetMs(
    new Date(utcGuess),
    STAFF_ASSISTANT_TIME_ZONE,
  );
  let utc = utcGuess - offset;
  const verified = timeZoneOffsetMs(new Date(utc), STAFF_ASSISTANT_TIME_ZONE);
  if (verified !== offset) {
    utc = utcGuess - verified;
  }
  return utc + milli;
}

function startOfKyivDayUtc(date: KyivDate): Date {
  return new Date(zonedLocalToUtcMs(date, 0, 0, 0, 0));
}

function endOfKyivDayUtc(date: KyivDate): Date {
  return new Date(zonedLocalToUtcMs(date, 23, 59, 59, 999));
}

function addCalendarDays(date: KyivDate, days: number): KyivDate {
  const utc = Date.UTC(date.year, date.month - 1, date.day + days);
  const shifted = new Date(utc);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function mondayOfWeek(date: KyivDate): KyivDate {
  const jsDay = new Date(
    Date.UTC(date.year, date.month - 1, date.day),
  ).getUTCDay();
  const mondayBased = (jsDay + 6) % 7;
  return addCalendarDays(date, -mondayBased);
}

function lastDayOfMonth(date: KyivDate): KyivDate {
  const last = new Date(Date.UTC(date.year, date.month, 0));
  return {
    year: last.getUTCFullYear(),
    month: last.getUTCMonth() + 1,
    day: last.getUTCDate(),
  };
}

/**
 * Map a façade `period` onto inclusive UTC ISO bounds in Europe/Kyiv.
 * Week starts Monday. `createdTo` is the last millisecond of the local day.
 */
export function mapOrdersListPeriod(
  period: OrdersListPeriod,
  now: Date,
): { readonly createdFrom: string; readonly createdTo: string } {
  const today = kyivDateParts(now);
  if (period === "today") {
    return {
      createdFrom: startOfKyivDayUtc(today).toISOString(),
      createdTo: endOfKyivDayUtc(today).toISOString(),
    };
  }
  if (period === "this_week") {
    const monday = mondayOfWeek(today);
    const sunday = addCalendarDays(monday, 6);
    return {
      createdFrom: startOfKyivDayUtc(monday).toISOString(),
      createdTo: endOfKyivDayUtc(sunday).toISOString(),
    };
  }
  const first = { year: today.year, month: today.month, day: 1 };
  const last = lastDayOfMonth(today);
  return {
    createdFrom: startOfKyivDayUtc(first).toISOString(),
    createdTo: endOfKyivDayUtc(last).toISOString(),
  };
}

type KyivRange = readonly [KyivDate, KyivDate];

const firstOfMonth = (date: KyivDate): KyivDate => ({
  year: date.year,
  month: date.month,
  day: 1,
});

const KYIV_PERIOD_BOUNDS: Readonly<
  Record<string, (today: KyivDate) => KyivRange>
> = {
  today: (today) => [today, today],
  yesterday: (today) => [
    addCalendarDays(today, -1),
    addCalendarDays(today, -1),
  ],
  tomorrow: (today) => [addCalendarDays(today, 1), addCalendarDays(today, 1)],
  this_week: (today) => [
    mondayOfWeek(today),
    addCalendarDays(mondayOfWeek(today), 6),
  ],
  last_week: (today) => [
    addCalendarDays(mondayOfWeek(today), -7),
    addCalendarDays(mondayOfWeek(today), -1),
  ],
  next_week: (today) => [
    addCalendarDays(mondayOfWeek(today), 7),
    addCalendarDays(mondayOfWeek(today), 13),
  ],
  this_month: (today) => [firstOfMonth(today), lastDayOfMonth(today)],
  last_month: (today) => {
    const last = addCalendarDays(firstOfMonth(today), -1);
    return [firstOfMonth(last), last];
  },
  next_month: (today) => {
    const first = addCalendarDays(lastDayOfMonth(today), 1);
    return [first, lastDayOfMonth(first)];
  },
  this_year: (today) => [
    { year: today.year, month: 1, day: 1 },
    { year: today.year, month: 12, day: 31 },
  ],
  last_year: (today) => [
    { year: today.year - 1, month: 1, day: 1 },
    { year: today.year - 1, month: 12, day: 31 },
  ],
};

export const KYIV_NAMED_PERIODS: readonly string[] = Object.freeze(
  Object.keys(KYIV_PERIOD_BOUNDS),
);

export const KYIV_LAST_DAYS_MAX = 366;

const LAST_DAYS_PERIOD = /^last_(\d{1,3})_days$/;
const SPELLED_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const SPELLED_MONTH = /^(\d{4})-(\d{2})$/;
const SPELLED_YEAR = /^(\d{4})$/;
const RANGE_SEPARATOR = "..";

function isRealDate(date: KyivDate): boolean {
  const utc = new Date(Date.UTC(date.year, date.month - 1, date.day));
  return (
    utc.getUTCFullYear() === date.year &&
    utc.getUTCMonth() + 1 === date.month &&
    utc.getUTCDate() === date.day
  );
}

function spelledBounds(period: string): KyivRange | null {
  const day = SPELLED_DAY.exec(period);
  if (day !== null) {
    const date = {
      year: Number(day[1]),
      month: Number(day[2]),
      day: Number(day[3]),
    };
    return isRealDate(date) ? [date, date] : null;
  }
  const month = SPELLED_MONTH.exec(period);
  if (month !== null) {
    const first = { year: Number(month[1]), month: Number(month[2]), day: 1 };
    return isRealDate(first) ? [first, lastDayOfMonth(first)] : null;
  }
  const year = SPELLED_YEAR.exec(period);
  return year === null
    ? null
    : [
        { year: Number(year[1]), month: 1, day: 1 },
        { year: Number(year[1]), month: 12, day: 31 },
      ];
}

function periodBounds(period: string, today: KyivDate): KyivRange | null {
  const named = KYIV_PERIOD_BOUNDS[period];
  if (named !== undefined) {
    return named(today);
  }
  const lastDays = LAST_DAYS_PERIOD.exec(period);
  if (lastDays !== null) {
    const days = Number(lastDays[1]);
    return days >= 1 && days <= KYIV_LAST_DAYS_MAX
      ? [addCalendarDays(today, -(days - 1)), today]
      : null;
  }
  if (period.includes(RANGE_SEPARATOR)) {
    const [from, to, ...rest] = period.split(RANGE_SEPARATOR);
    if (rest.length > 0 || from === undefined || to === undefined) {
      return null;
    }
    const start = spelledBounds(from);
    const end = spelledBounds(to);
    return start === null || end === null ? null : [start[0], end[1]];
  }
  return spelledBounds(period);
}

export function kyivNamedPeriodRange(
  period: string,
  now: Date,
): { readonly createdFrom: string; readonly createdTo: string } | null {
  const bounds = periodBounds(period.trim(), kyivDateParts(now));
  if (bounds === null) {
    return null;
  }
  const [first, last] = bounds;
  const createdFrom = startOfKyivDayUtc(first).toISOString();
  const createdTo = endOfKyivDayUtc(last).toISOString();
  return createdFrom <= createdTo ? { createdFrom, createdTo } : null;
}

/** Europe/Kyiv calendar date as `YYYY-MM-DD` (assistant budget keys). */
export function kyivCalendarDate(now: Date): string {
  const date = kyivDateParts(now);
  return `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

/**
 * Whole seconds until the next Europe/Kyiv midnight, never less than 1
 * (RATE_LIMITED `retryAfterSec` must not be optimistic).
 */
export function secondsUntilKyivMidnight(now: Date): number {
  const nextMidnight = startOfKyivDayUtc(
    addCalendarDays(kyivDateParts(now), 1),
  );
  return Math.max(
    1,
    Math.ceil((nextMidnight.getTime() - now.getTime()) / 1000),
  );
}

/** English clock line for the uncached turn-context addendum. */
export function staffAssistantClockLines(now: Date): string {
  const weekday = new Intl.DateTimeFormat("en-GB", {
    timeZone: STAFF_ASSISTANT_TIME_ZONE,
    weekday: "long",
  }).format(now);
  const date = new Intl.DateTimeFormat("en-GB", {
    timeZone: STAFF_ASSISTANT_TIME_ZONE,
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(now);
  const offsetPart = new Intl.DateTimeFormat("en-GB", {
    timeZone: STAFF_ASSISTANT_TIME_ZONE,
    timeZoneName: "shortOffset",
  })
    .formatToParts(now)
    .find((part) => part.type === "timeZoneName")?.value;
  const utcOffset = (offsetPart ?? "UTC").replace(/^GMT/, "UTC");
  return `Today is ${weekday}, ${date} in ${STAFF_ASSISTANT_TIME_ZONE} (${utcOffset}). The calendar week starts on Monday.`;
}
