import { describe, expect, it } from "vitest";

import { ORDERS_LIST_PAGE_TOOL_NAME } from "./action-tool.js";
import { STAFF_ASSISTANT_CLIP_SHRINK_ARRAY_MAX } from "./clip-tool-result.js";
import { STAFF_ASSISTANT_TOOL_RUNS_MAX } from "./tool-run.js";
import { staffAssistantModelMessagesFromPersisted } from "./messages.js";
import {
  budgetStaffAssistantToolRuns,
  staffAssistantToolCallInput,
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
  toolName: string = ORDERS_LIST_PAGE_TOOL_NAME,
): StaffAssistantPersistedMessage {
  return {
    role: "assistant",
    body,
    toolRuns: [{ action, toolCallId, toolName, modelTrace }],
  };
}

describe("staffAssistantToolCallInput", () => {
  it("returns persisted façade args and reconstructs {} for pre-T2 rows", () => {
    expect(
      staffAssistantToolCallInput({ toolInput: { kind: "page", limit: 20 } }),
    ).toEqual({ kind: "page", limit: 20 });
    expect(staffAssistantToolCallInput({ toolInput: null })).toEqual({});
    expect(staffAssistantToolCallInput({ toolInput: undefined })).toEqual({});
  });
});

describe("staffAssistantTraceDigest", () => {
  it("builds a one-line identity summary with the façade ToolSet key", () => {
    const digest = staffAssistantTraceDigest(
      ORDERS_LIST_PAGE_TOOL_NAME,
      pageTrace([
        { orderNumber: "12", name: "Катя" },
        { orderNumber: "13" },
        { orderNumber: "14" },
      ]),
    );
    expect(digest).toBe(
      `${ORDERS_LIST_PAGE_TOOL_NAME} → 3 results: #12 (Катя), #13, #14`,
    );
    expect(digest).not.toContain("orders.list");
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
        ORDERS_LIST_PAGE_TOOL_NAME,
        pageTrace([{ orderNumber: "10", name: "Anna" }]),
      ),
    );
    expect(budgeted[3]?.toolRuns?.[0]?.modelTrace).toBe(
      staffAssistantTraceDigest(
        ORDERS_LIST_PAGE_TOOL_NAME,
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
      staffAssistantTraceDigest(ORDERS_LIST_PAGE_TOOL_NAME, middle),
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

  it("digests an oversized tier-1 trace instead of dropping it", () => {
    // Identity-compacting cannot rescue it: the identity field is the bulk.
    const only = { orderNumber: "3", name: "Катя ".repeat(4_000) };
    const budgeted = budgetStaffAssistantToolRuns([
      toolTurn("only", "orders.list", "call_huge", only),
    ]);
    const kept = budgeted[0]?.toolRuns?.[0]?.modelTrace;
    expect(kept).not.toBeNull();
    expect(kept).toBe(
      staffAssistantTraceDigest(ORDERS_LIST_PAGE_TOOL_NAME, only),
    );
  });

  it("reduces an oversized tier-1 trace before spending older digests", () => {
    const oldest = pageTrace([{ orderNumber: "1", name: "Anna" }]);
    const middle = pageTrace([{ orderNumber: "2", name: "Boris" }]);
    // Alone over the cap: dropping the two ≤300-char digests cannot help.
    const newest = { orderNumber: "3", name: "z".repeat(21_000) };
    const budgeted = budgetStaffAssistantToolRuns([
      toolTurn("old", "orders.list", "call_1", oldest),
      toolTurn("mid", "orders.list", "call_2", middle),
      toolTurn("new", "orders.list", "call_3", newest),
    ]);
    expect(budgeted[0]?.toolRuns?.[0]?.modelTrace).toBe(
      staffAssistantTraceDigest(ORDERS_LIST_PAGE_TOOL_NAME, oldest),
    );
    expect(budgeted[1]?.toolRuns?.[0]?.modelTrace).toBe(
      staffAssistantTraceDigest(ORDERS_LIST_PAGE_TOOL_NAME, middle),
    );
    expect(budgeted[2]?.toolRuns?.[0]?.modelTrace).toBe(
      staffAssistantTraceDigest(ORDERS_LIST_PAGE_TOOL_NAME, newest),
    );
  });

  it("drops the oldest runs of a turn that alone cannot fit under the cap", () => {
    // A turn may record up to STAFF_ASSISTANT_TOOL_RUNS_MAX runs, and that
    // many digests do not fit in 8 000 chars. Tier 1 is reduced before it is
    // dropped and goes last, but the cap wins: the turn keeps its newest
    // runs and loses the rest. Documented in ADR-0034 rule 3. With 300-char
    // digests that is 26 kept / 24 dropped at 7 800 chars.
    const runs = Array.from(
      { length: STAFF_ASSISTANT_TOOL_RUNS_MAX },
      (_, index) => ({
        action: "orders.list",
        toolCallId: `call_${String(index)}`,
        toolName: ORDERS_LIST_PAGE_TOOL_NAME,
        modelTrace: pageTrace([
          { orderNumber: String(index), name: "Катя ".repeat(60) },
        ]),
      }),
    );
    const budgeted = budgetStaffAssistantToolRuns([
      { role: "assistant", body: "listed a lot", toolRuns: runs },
    ]);

    const out = budgeted[0]?.toolRuns ?? [];
    expect(out).toHaveLength(STAFF_ASSISTANT_TOOL_RUNS_MAX);
    const keptIndexes = out.flatMap((run, index) =>
      run.modelTrace === null ? [] : [index],
    );
    expect(keptIndexes.length).toBeLessThan(STAFF_ASSISTANT_TOOL_RUNS_MAX);
    const digestChars = STAFF_ASSISTANT_TRACE_DIGEST_MAX;
    expect(keptIndexes).toHaveLength(
      Math.floor(STAFF_ASSISTANT_HISTORY_TRACE_MAX / digestChars),
    );

    // Survivors are a contiguous newest-first suffix, and every one is a
    // digest — nothing kept a full trace while a sibling was dropped.
    expect(keptIndexes).toEqual(
      Array.from(
        { length: keptIndexes.length },
        (_, offset) =>
          STAFF_ASSISTANT_TOOL_RUNS_MAX - keptIndexes.length + offset,
      ),
    );
    for (const index of keptIndexes) {
      expect(out[index]?.modelTrace).toBe(
        staffAssistantTraceDigest(
          ORDERS_LIST_PAGE_TOOL_NAME,
          runs[index]?.modelTrace,
        ),
      );
    }

    const chars = out.reduce(
      (total, run) =>
        total +
        (typeof run.modelTrace === "string" ? run.modelTrace.length : 0),
      0,
    );
    expect(chars).toBeLessThanOrEqual(STAFF_ASSISTANT_HISTORY_TRACE_MAX);
    // Dropped runs lose the trace entirely, so no orphan tool-call survives.
    expect(
      staffAssistantModelMessagesFromPersisted(budgeted).filter(
        (message) => message.role === "tool",
      ),
    ).toHaveLength(1);
  });

  it("falls back to the registry action when toolName was not stored", () => {
    const budgeted = budgetStaffAssistantToolRuns([
      {
        role: "assistant",
        body: "listed",
        toolRuns: [
          {
            action: "orders.list",
            toolCallId: "call_legacy",
            modelTrace: pageTrace([{ orderNumber: "10" }]),
          },
        ],
      },
      {
        role: "assistant",
        body: "listed again",
        toolRuns: [
          {
            action: "orders.list",
            toolCallId: "call_new",
            modelTrace: pageTrace([{ orderNumber: "11" }]),
          },
        ],
      },
    ]);
    expect(budgeted[0]?.toolRuns?.[0]?.modelTrace).toBe(
      staffAssistantTraceDigest(
        "orders.list",
        pageTrace([{ orderNumber: "10" }]),
      ),
    );
  });
});
