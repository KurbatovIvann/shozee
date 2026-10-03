import { kyivCalendarDate, kyivNamedPeriodRange } from "@showzy/ai";
import {
  SHO_CUSTOMER_WRITE_PLANNER_PARAMS,
  SHO_DOCUMENT_WRITE_PLANNER_PARAMS,
  SHO_ORDER_LIFECYCLE_PLANNER_PARAMS,
  SHO_PRICING_WRITE_PLANNER_PARAMS,
  SHO_FOCUS_PARAM_TYPES,
  SHO_READ_PLANNER_PARAMS,
  SHO_WRITE_PLANNER_PARAMS,
} from "@showzy/assistant-runtime";
import {
  FOCUS_PARAM_TYPES,
  listItemType,
  loadV3Bundle,
  periodDates,
  type Bundle,
  type Day,
} from "@showzy/sho";
import { beforeAll, describe, expect, it } from "vitest";

const TODAYS: readonly Day[] = [
  { year: 2026, month: 9, day: 2 },
  { year: 2026, month: 1, day: 1 },
  { year: 2026, month: 3, day: 29 },
  { year: 2024, month: 2, day: 29 },
  { year: 2026, month: 12, day: 31 },
];

const noonOf = (day: Day): Date =>
  new Date(Date.UTC(day.year, day.month - 1, day.day, 12));

const SAMPLE_TOKENS: readonly string[] = [
  "last_days:1",
  "last_days:7",
  "last_days:30",
  "last_days:365",
  "last_days:4000",
  "range:03-01..03-31",
  "range:12-20..01-10",
  "range:2025-02-01..2025-02-28",
  "range:2026-01-01..2026-12-31",
];

const UNREADABLE_TOKENS: readonly string[] = [
  "",
  "range",
  "last_days",
  "previous",
];

const WRITE_INTENT_KINDS: readonly string[] = ["write", "high"];

const WRITE_PLANNER_PARAMS: Readonly<Record<string, readonly string[]>> = {
  ...SHO_WRITE_PLANNER_PARAMS,
  ...SHO_ORDER_LIFECYCLE_PLANNER_PARAMS,
  ...SHO_CUSTOMER_WRITE_PLANNER_PARAMS,
  ...SHO_DOCUMENT_WRITE_PLANNER_PARAMS,
  ...SHO_PRICING_WRITE_PLANNER_PARAMS,
};

let bundle: Bundle;

beforeAll(async () => {
  bundle = await loadV3Bundle();
});

function intentOf(action: string) {
  return Object.entries(bundle.intents).find(([name]) => name === action)?.[1];
}

describe("the read planners name only catalogue params", () => {
  it("knows every planned action as a read intent", () => {
    for (const action of Object.keys(SHO_READ_PLANNER_PARAMS)) {
      expect({ action, kind: intentOf(action)?.kind }).toEqual({
        action,
        kind: "read",
      });
    }
  });

  it("maps only params the bundle gives that intent", () => {
    for (const [action, names] of Object.entries(SHO_READ_PLANNER_PARAMS)) {
      const known = Object.keys(intentOf(action)?.params ?? {});
      expect({
        action,
        names: names.filter((name) => !known.includes(name)),
      }).toEqual({ action, names: [] });
    }
  });
});

describe("the write planners name only catalogue params", () => {
  it("knows every planned action as a write or destructive intent", () => {
    for (const action of Object.keys(WRITE_PLANNER_PARAMS)) {
      const kind = intentOf(action)?.kind ?? "none";
      expect({ action, writes: WRITE_INTENT_KINDS.includes(kind) }).toEqual({
        action,
        writes: true,
      });
    }
  });

  it("maps only params the bundle gives that intent", () => {
    for (const [action, names] of Object.entries(WRITE_PLANNER_PARAMS)) {
      const known = Object.keys(intentOf(action)?.params ?? {});
      expect({
        action,
        names: names.filter((name) => !known.includes(name)),
      }).toEqual({ action, names: [] });
    }
  });

  it("plans no action as both a read and a write", () => {
    const reads = Object.keys(SHO_READ_PLANNER_PARAMS);
    expect(
      Object.keys(WRITE_PLANNER_PARAMS).filter((action) =>
        reads.includes(action),
      ),
    ).toEqual([]);
  });
});

describe("kyiv-calendar reads the periods the Шо runtime emits", () => {
  const tokens = (): readonly string[] => [
    ...(bundle.enums["period"] ?? []).filter(
      (value) => !UNREADABLE_TOKENS.includes(value),
    ),
    ...SAMPLE_TOKENS,
  ];

  it("agrees with periodDates on every token, for every day", () => {
    for (const today of TODAYS) {
      const now = noonOf(today);
      for (const token of tokens()) {
        const theirs = periodDates(token, today);
        const ours = kyivNamedPeriodRange(token, now);
        const read =
          ours === null
            ? null
            : {
                from: kyivCalendarDate(new Date(ours.createdFrom)),
                to: kyivCalendarDate(new Date(ours.createdTo)),
              };
        expect({ token, today, read }).toEqual({
          token,
          today,
          read: theirs === null ? null : { from: theirs.from, to: theirs.to },
        });
      }
    }
  });

  it("refuses the tokens the runtime never resolves on its own", () => {
    const now = noonOf({ year: 2026, month: 9, day: 2 });
    for (const token of UNREADABLE_TOKENS) {
      expect({ token, read: kyivNamedPeriodRange(token, now) }).toEqual({
        token,
        read: null,
      });
    }
  });
});

describe("the focus guard and Шо read a param as the same record", () => {
  it("names the record type every declared param carries, lists included", () => {
    const declared: Record<string, string> = {};
    for (const intent of Object.values(bundle.intents)) {
      for (const [name, type] of Object.entries(intent.params)) {
        const record = FOCUS_PARAM_TYPES.get(
          listItemType(bundle, type) ?? type,
        );
        if (record === undefined) {
          continue;
        }
        const seen = declared[name];
        declared[name] =
          seen === undefined || seen === record ? record : `${seen}|${record}`;
      }
    }
    expect(declared).toEqual(SHO_FOCUS_PARAM_TYPES);
  });
});
