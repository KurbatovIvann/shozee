import { describe, expect, it } from "vitest";

import {
  kyivCalendarDate,
  mapOrdersListPeriod,
  secondsUntilKyivMidnight,
  staffAssistantClockLines,
  STAFF_ASSISTANT_TIME_ZONE,
} from "./kyiv-calendar.js";

const WEDNESDAY_SEP_2 = new Date("2026-09-02T12:00:00.000Z");

describe("kyivCalendarDate", () => {
  it("formats the Europe/Kyiv calendar day as YYYY-MM-DD", () => {
    expect(kyivCalendarDate(WEDNESDAY_SEP_2)).toBe("2026-09-02");
    expect(kyivCalendarDate(new Date("2026-01-15T12:00:00.000Z"))).toBe(
      "2026-01-15",
    );
  });
});

describe("secondsUntilKyivMidnight", () => {
  it("counts whole seconds until the next Europe/Kyiv midnight", () => {
    expect(secondsUntilKyivMidnight(WEDNESDAY_SEP_2)).toBe(32_400);
    expect(secondsUntilKyivMidnight(new Date("2026-01-15T12:00:00.000Z"))).toBe(
      36_000,
    );
  });

  it("never returns less than 1", () => {
    const justBefore = new Date("2026-09-02T20:59:59.600Z");
    expect(secondsUntilKyivMidnight(justBefore)).toBe(1);
  });
});

function kyivWall(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: STAFF_ASSISTANT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}

describe("mapOrdersListPeriod", () => {
  it("maps today to inclusive Europe/Kyiv local day as UTC ISO", () => {
    const interval = mapOrdersListPeriod("today", WEDNESDAY_SEP_2);
    expect(interval).toEqual({
      createdFrom: "2026-09-01T21:00:00.000Z",
      createdTo: "2026-09-02T20:59:59.999Z",
    });
    expect(kyivWall(interval.createdFrom)).toBe("02/09/2026, 00:00:00");
    expect(kyivWall(interval.createdTo)).toBe("02/09/2026, 23:59:59");
  });

  it("maps this_week Monday–Sunday in Europe/Kyiv", () => {
    const interval = mapOrdersListPeriod("this_week", WEDNESDAY_SEP_2);
    expect(interval).toEqual({
      createdFrom: "2026-08-30T21:00:00.000Z",
      createdTo: "2026-09-06T20:59:59.999Z",
    });
    expect(kyivWall(interval.createdFrom)).toBe("31/08/2026, 00:00:00");
    expect(kyivWall(interval.createdTo)).toBe("06/09/2026, 23:59:59");
  });

  it("maps this_month to the inclusive local calendar month", () => {
    const interval = mapOrdersListPeriod("this_month", WEDNESDAY_SEP_2);
    expect(interval).toEqual({
      createdFrom: "2026-08-31T21:00:00.000Z",
      createdTo: "2026-09-30T20:59:59.999Z",
    });
    expect(kyivWall(interval.createdFrom)).toBe("01/09/2026, 00:00:00");
    expect(kyivWall(interval.createdTo)).toBe("30/09/2026, 23:59:59");
  });

  it("starts this_week on Monday when now is Sunday in Kyiv", () => {
    const sunday = new Date("2026-09-06T12:00:00.000Z");
    const interval = mapOrdersListPeriod("this_week", sunday);
    expect(kyivWall(interval.createdFrom)).toBe("31/08/2026, 00:00:00");
    expect(kyivWall(interval.createdTo)).toBe("06/09/2026, 23:59:59");
  });

  it("maps today across the Europe/Kyiv winter offset", () => {
    const winter = new Date("2026-01-15T12:00:00.000Z");
    const interval = mapOrdersListPeriod("today", winter);
    expect(interval).toEqual({
      createdFrom: "2026-01-14T22:00:00.000Z",
      createdTo: "2026-01-15T21:59:59.999Z",
    });
    expect(kyivWall(interval.createdFrom)).toBe("15/01/2026, 00:00:00");
    expect(kyivWall(interval.createdTo)).toBe("15/01/2026, 23:59:59");
  });
});

describe("staffAssistantClockLines", () => {
  it("names the Kyiv calendar date, UTC offset, and Monday week start", () => {
    const line = staffAssistantClockLines(WEDNESDAY_SEP_2);
    expect(line).toContain("Wednesday");
    expect(line).toContain("2 September 2026");
    expect(line).toContain("Europe/Kyiv");
    expect(line).toMatch(/UTC[+-]\d+/);
    expect(line).toContain("week starts on Monday");
  });
});
