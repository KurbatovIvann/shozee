import {
  CUSTOMERS_LIST_CUSTOMERS_TOOL_NAME,
  ORDERS_CREATE_TOOL_NAME,
  ORDERS_LIST_COUNTS_TOOL_NAME,
  ORDERS_LIST_PAGE_TOOL_NAME,
  STAFF_ASSISTANT_TOOL_SEARCH_NAME,
} from "@showzy/ai";
import { describe, expect, it } from "vitest";

import { collectEvalToolCalls } from "./trace.js";
import { PROOF_SCENARIOS } from "./scenarios/proof.js";

describe("PROOF_SCENARIOS", () => {
  it("defines the five card-named proof ids", () => {
    expect(PROOF_SCENARIOS.map((scenario) => scenario.id)).toEqual([
      "proof.orders-counts-today",
      "proof.orders-for-katya",
      "proof.create-order-katya-napoleon",
      "proof.weather-chitchat",
      "proof.capability-tool-search",
    ]);
    expect(PROOF_SCENARIOS[0]?.turns[0]?.text).toBe(
      "скільки замовлень сьогодні",
    );
    expect(PROOF_SCENARIOS[0]?.expectation.ordered?.[0]?.name).toBe(
      ORDERS_LIST_COUNTS_TOOL_NAME,
    );
    expect(PROOF_SCENARIOS[1]?.expectation.ordered?.[0]?.name).toBe(
      CUSTOMERS_LIST_CUSTOMERS_TOOL_NAME,
    );
    expect(PROOF_SCENARIOS[1]?.expectation.ordered?.[1]?.name).toBe(
      ORDERS_LIST_PAGE_TOOL_NAME,
    );
    expect(PROOF_SCENARIOS[2]?.expectation.ordered?.[0]?.name).toBe(
      ORDERS_CREATE_TOOL_NAME,
    );
    expect(PROOF_SCENARIOS[3]?.expectation.none).toBe(true);
    expect(PROOF_SCENARIOS[4]?.expectation.first).toBe(
      STAFF_ASSISTANT_TOOL_SEARCH_NAME,
    );
  });
});

describe("collectEvalToolCalls", () => {
  it("skips the synthetic json tool and overlays execute results", () => {
    const calls = collectEvalToolCalls(
      [
        {
          type: "tool-input-available",
          toolCallId: "json-1",
          toolName: "json",
          input: { spoken: "hi" },
        },
        {
          type: "tool-input-available",
          toolCallId: "c1",
          toolName: ORDERS_LIST_COUNTS_TOOL_NAME,
          input: { period: "today" },
        },
      ],
      new Map([["c1", { total: 2 }]]),
    );
    expect(calls).toEqual([
      {
        toolCallId: "c1",
        name: ORDERS_LIST_COUNTS_TOOL_NAME,
        args: { period: "today" },
        result: { total: 2 },
      },
    ]);
  });
});
