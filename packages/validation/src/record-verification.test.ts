import { afterEach, describe, expect, it } from "vitest";

import {
  RECORD_VERIFICATION,
  RECORD_VERIFICATION_POLICIES,
  RECORD_VOUCH_ON_WRITE,
  recordCountSpec,
  recordCounts,
  recordCountsSql,
  vouchAfterWrite,
  type RecordProvenance,
} from "./record-verification.js";

const AI_UNVOUCHED: RecordProvenance = {
  createdVia: "ai",
  vouchedBy: null,
};
const UI_UNVOUCHED: RecordProvenance = {
  createdVia: "ui",
  vouchedBy: null,
};
const UNKNOWN_UNVOUCHED: RecordProvenance = {
  createdVia: null,
  vouchedBy: null,
};
const AI_VOUCHED: RecordProvenance = {
  createdVia: "ai",
  vouchedBy: "user-anna",
};
const SYSTEM_UNVOUCHED: RecordProvenance = {
  createdVia: "system",
  vouchedBy: null,
};
const WEBHOOK_UNVOUCHED: RecordProvenance = {
  createdVia: "webhook",
  vouchedBy: null,
};

const sqlOps = {
  alwaysTrue: "TRUE",
  isNull: (column: string) => `${column} IS NULL`,
  isNotNull: (column: string) => `${column} IS NOT NULL`,
  eq: (column: string, value: "ui") => `${column} = '${value}'`,
  or: (clauses: readonly string[]) => `(${clauses.join(" OR ")})`,
};

const sqlColumns = {
  createdVia: "created_via",
  vouchedBy: "vouched_by",
};

afterEach(() => {
  RECORD_VERIFICATION.mode = "narrow";
});

describe("@showzy/validation/record-verification", () => {
  it("defaults to narrow and does not switch strict on", () => {
    expect(RECORD_VERIFICATION.mode).toBe("narrow");
    expect(RECORD_VERIFICATION_POLICIES.narrow.unvouched).toBe("none");
    expect(recordCountSpec().kind).toBe("all");
  });

  it("under narrow, every row counts including ai with null vouch", () => {
    expect(recordCounts(AI_UNVOUCHED)).toBe(true);
    expect(recordCounts(UI_UNVOUCHED)).toBe(true);
    expect(recordCounts(UNKNOWN_UNVOUCHED)).toBe(true);
    expect(recordCounts(AI_VOUCHED)).toBe(true);
    expect(recordCounts(SYSTEM_UNVOUCHED)).toBe(true);
    expect(recordCounts(WEBHOOK_UNVOUCHED)).toBe(true);
    expect(recordCounts(AI_UNVOUCHED, "narrow")).toBe(true);
  });

  it("under strict, non-ui unvouched rows do not count; ui and grandfathered null do", () => {
    expect(recordCounts(AI_UNVOUCHED, "strict")).toBe(false);
    expect(recordCounts(SYSTEM_UNVOUCHED, "strict")).toBe(false);
    expect(recordCounts(WEBHOOK_UNVOUCHED, "strict")).toBe(false);
    expect(recordCounts(UI_UNVOUCHED, "strict")).toBe(true);
    expect(recordCounts(UNKNOWN_UNVOUCHED, "strict")).toBe(true);
    expect(recordCounts(AI_VOUCHED, "strict")).toBe(true);
  });

  it("SQL translation matches the JS predicate spec", () => {
    expect(recordCountsSql(sqlColumns, sqlOps, "narrow")).toBe("TRUE");
    expect(recordCountsSql(sqlColumns, sqlOps, "strict")).toBe(
      "(created_via IS NULL OR created_via = 'ui' OR vouched_by IS NOT NULL)",
    );
  });

  it("AI content update clears a vouch; AI state transition keeps it", () => {
    const content = vouchAfterWrite({
      channel: "ai",
      writeKind: "content",
      vouchedBy: "user-anna",
    });
    const transition = vouchAfterWrite({
      channel: "ai",
      writeKind: "state_transition",
      vouchedBy: "user-anna",
    });
    expect(content).toBe("clear");
    expect(transition).toBe("keep");
    expect(content).not.toBe(transition);
    expect(RECORD_VOUCH_ON_WRITE.ai.content).toBe("clear");
    expect(RECORD_VOUCH_ON_WRITE.ai.state_transition).toBe("keep");
    expect(
      vouchAfterWrite({
        channel: "ui",
        writeKind: "content",
        vouchedBy: "user-anna",
      }),
    ).toBe("keep");
    expect(
      vouchAfterWrite({
        channel: "ai",
        writeKind: "content",
        vouchedBy: null,
      }),
    ).toBe("keep");
  });

  it("flipping RECORD_VERIFICATION.mode is the only edit that changes counted totals", () => {
    const rows: ReadonlyArray<RecordProvenance & { gross: number }> = [
      { ...UI_UNVOUCHED, gross: 100 },
      { ...AI_UNVOUCHED, gross: 50 },
      { ...UNKNOWN_UNVOUCHED, gross: 25 },
      { ...AI_VOUCHED, gross: 10 },
    ];
    const countedGross = () =>
      rows
        .filter((row) => recordCounts(row))
        .reduce((sum, row) => sum + row.gross, 0);

    expect(RECORD_VERIFICATION.mode).toBe("narrow");
    expect(countedGross()).toBe(185);

    RECORD_VERIFICATION.mode = "strict";
    expect(recordCountSpec().kind).toBe("or");
    expect(countedGross()).toBe(135);
    expect(recordCountsSql(sqlColumns, sqlOps)).toBe(
      "(created_via IS NULL OR created_via = 'ui' OR vouched_by IS NOT NULL)",
    );
  });
});
