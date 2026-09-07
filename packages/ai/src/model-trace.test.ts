import { describe, expect, it } from "vitest";

import { STAFF_ASSISTANT_CLIP_SHRINK_ARRAY_MAX } from "./clip-tool-result.js";
import {
  budgetStaffAssistantToolRuns,
  staffAssistantTraceDigest,
  STAFF_ASSISTANT_HISTORY_TRACE_MAX,
  STAFF_ASSISTANT_TRACE_DIGEST_MAX,
  type StaffAssistantPersistedMessage,
} from "./model-trace.js";

function pageTrace(
  rows: ReadonlyArray<{
    readonly orderNumber: string;
    readonly name?: string;
    readonly extra?: string;
  }>,
) {
  return {
    kind: "page.summary",
    rows: rows.map((row) => ({
      orderNumber: row.orderNumber,
      ...(row.name !== undefined ? { name: row.name } : {}),
      ...(row.extra !== undefined ? { extra: row.extra } : {}),
    })),
  };
}

function toolTurn(
  body: string,
  action: string,
  toolCallId: string,
  modelTrace: unknown,
): StaffAssistantPersistedMessage {
  return {
    role: "assistant",
    body,
    toolRuns: [{ action, toolCallId, modelTrace }],
  };
}

describe("staffAssistantTraceDigest", () => {
  it("builds a one-line identity summary without a model call", () => {
    const digest = staffAssistantTraceDigest(
      "orders.list",
      pageTrace([
        { orderNumber: "12", name: "Катя" },
        { orderNumber: "13" },
        { orderNumber: "14" },
      ]),
    );
    expect(digest).toBe("orders.list → 3 results: #12 (Катя), #13, #14");
    expect(digest.length).toBeLessThanOrEqual(STAFF_ASSISTANT_TRACE_DIGEST_MAX);
  });
});

describe("budgetStaffAssistantToolRuns", () => {
  it("keeps the last tool-bearing turn full and digests older turns", () => {
    const budgeted = budgetStaffAssistantToolRuns([
      { role: "user", body: "first" },
      toolTurn(
        "listed once",
        "orders.list",
        "call_old_1",
        pageTrace([{ orderNumber: "10", name: "Anna" }]),
      ),
      { role: "user", body: "second" },
      toolTurn(
        "listed twice",
        "orders.list",
        "call_old_2",
        pageTrace([{ orderNumber: "11", name: "Boris" }]),
      ),
      { role: "user", body: "third" },
      toolTurn(
        "listed thrice",
        "orders.list",
        "call_new",
        pageTrace([
          { orderNumber: "12", name: "Катя" },
          { orderNumber: "13" },
          { orderNumber: "14" },
        ]),
      ),
    ]);
    expect(budgeted[1]?.toolRuns?.[0]?.modelTrace).toBe(
      staffAssistantTraceDigest(
        "orders.list",
        pageTrace([{ orderNumber: "10", name: "Anna" }]),
      ),
    );
    expect(budgeted[3]?.toolRuns?.[0]?.modelTrace).toBe(
      staffAssistantTraceDigest(
        "orders.list",
        pageTrace([{ orderNumber: "11", name: "Boris" }]),
      ),
    );
    expect(budgeted[5]?.toolRuns?.[0]?.modelTrace).toEqual(
      pageTrace([
        { orderNumber: "12", name: "Катя" },
        { orderNumber: "13" },
        { orderNumber: "14" },
      ]),
    );
  });

  it("drops the oldest digest first when the window cap is exceeded", () => {
    const oldest = pageTrace([{ orderNumber: "1", name: "x".repeat(200) }]);
    const middle = pageTrace([{ orderNumber: "2", name: "y".repeat(200) }]);
    const newest = { pad: "z".repeat(7_600), orderNumber: "3" };
    const budgeted = budgetStaffAssistantToolRuns([
      toolTurn("old", "orders.list", "call_1", oldest),
      toolTurn("mid", "orders.list", "call_2", middle),
      toolTurn("new", "orders.list", "call_3", newest),
    ]);
    const oldestPayload = budgeted[0]?.toolRuns?.[0]?.modelTrace;
    const middlePayload = budgeted[1]?.toolRuns?.[0]?.modelTrace;
    const newestPayload = budgeted[2]?.toolRuns?.[0]?.modelTrace;
    expect(oldestPayload).toBeNull();
    expect(middlePayload).toBe(
      staffAssistantTraceDigest("orders.list", middle),
    );
    expect(newestPayload).toEqual(newest);
    expect(STAFF_ASSISTANT_HISTORY_TRACE_MAX).toBe(8_000);
  });

  it("shrinks tier-1 arrays when digests are gone and the cap still overflows", () => {
    const rows = Array.from({ length: 20 }, (_, index) => ({
      orderNumber: String(index),
      name: "n",
      extra: "e".repeat(600),
    }));
    const budgeted = budgetStaffAssistantToolRuns([
      toolTurn("only", "orders.list", "call_full", pageTrace(rows)),
    ]);
    const kept = budgeted[0]?.toolRuns?.[0]?.modelTrace;
    expect(kept).not.toBeNull();
    if (kept === null || typeof kept !== "object" || !("rows" in kept)) {
      throw new Error("expected shrunk page rows");
    }
    const shrunkRows = kept["rows"];
    expect(Array.isArray(shrunkRows)).toBe(true);
    if (!Array.isArray(shrunkRows)) {
      return;
    }
    expect(shrunkRows.length).toBeLessThanOrEqual(
      STAFF_ASSISTANT_CLIP_SHRINK_ARRAY_MAX,
    );
  });
});
