import {
  CUSTOMERS_LIST_CUSTOMERS_TOOL_NAME,
  ORDERS_CREATE_TOOL_NAME,
  ORDERS_LIST_COUNTS_TOOL_NAME,
  ORDERS_LIST_PAGE_TOOL_NAME,
  STAFF_ASSISTANT_TOOL_SEARCH_NAME,
} from "@showzy/ai";
import { describe, expect, it } from "vitest";

import { GATE_CLASSIFIES_SCENARIOS } from "./scenarios/gate-classifies.js";
import { HITL_CONFIRMATION_SCENARIOS } from "./scenarios/hitl.js";
import { MODEL_SPEAKS_SCENARIOS } from "./scenarios/model-speaks.js";
import { PLAIN_REPLY_SCENARIOS } from "./scenarios/plain-reply.js";
import { PROOF_SCENARIOS } from "./scenarios/proof.js";
import { collectEvalToolCalls } from "./trace.js";

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
    expect(PROOF_SCENARIOS[1]?.turns[0]?.text).toBe(
      "покажи замовлення Каті Самбуки",
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

describe("PLAIN_REPLY_SCENARIOS", () => {
  it("defines the three T5 corpus ids", () => {
    expect(PLAIN_REPLY_SCENARIOS.map((scenario) => scenario.id)).toEqual([
      "t5.plain-reply.list",
      "t5.plain-reply.aggregate",
      "t5.plain-reply.chitchat",
    ]);
    expect(PLAIN_REPLY_SCENARIOS[0]?.expectation.ordered?.[0]?.name).toBe(
      ORDERS_LIST_PAGE_TOOL_NAME,
    );
    expect(PLAIN_REPLY_SCENARIOS[1]?.expectation.ordered?.[0]?.name).toBe(
      ORDERS_LIST_COUNTS_TOOL_NAME,
    );
    expect(PLAIN_REPLY_SCENARIOS[2]?.expectation.none).toBe(true);
    expect(PLAIN_REPLY_SCENARIOS[0]?.expectation.textExcludes).toContain(
      '{"spoken"',
    );
  });
});

describe("MODEL_SPEAKS_SCENARIOS", () => {
  it("defines the three T6 corpus ids", () => {
    expect(MODEL_SPEAKS_SCENARIOS.map((scenario) => scenario.id)).toEqual([
      "t6.model-speaks.last-3-orders",
      "t6.model-speaks.counts-this-week",
      "t6.model-speaks.find-customer-katya",
    ]);
    expect(MODEL_SPEAKS_SCENARIOS[0]?.turns[0]?.text).toBe(
      "останні 3 замовлення",
    );
    expect(MODEL_SPEAKS_SCENARIOS[1]?.turns[0]?.text).toBe(
      "скільки замовлень цього тижня",
    );
    expect(MODEL_SPEAKS_SCENARIOS[2]?.turns[0]?.text).toBe(
      "знайди клієнта Катя",
    );
    expect(MODEL_SPEAKS_SCENARIOS[0]?.expectation.ordered?.[0]?.name).toBe(
      ORDERS_LIST_PAGE_TOOL_NAME,
    );
    expect(MODEL_SPEAKS_SCENARIOS[1]?.expectation.ordered?.[0]?.name).toBe(
      ORDERS_LIST_COUNTS_TOOL_NAME,
    );
    expect(MODEL_SPEAKS_SCENARIOS[2]?.expectation.ordered?.[0]?.name).toBe(
      CUSTOMERS_LIST_CUSTOMERS_TOOL_NAME,
    );
    expect(
      MODEL_SPEAKS_SCENARIOS[0]?.expectation.textIncludesToolValues,
    ).toEqual(["orderNumber"]);
    expect(
      MODEL_SPEAKS_SCENARIOS[1]?.expectation.textIncludesToolValues,
    ).toEqual(["orderCount"]);
    expect(
      MODEL_SPEAKS_SCENARIOS[2]?.expectation.textIncludesToolValues,
    ).toEqual(["customerName"]);
    for (const scenario of MODEL_SPEAKS_SCENARIOS) {
      expect(scenario.expectation.textExcludes).toEqual(
        expect.arrayContaining([
          '{"spoken"',
          '"spoken":',
          "```",
          "|",
          "Останні замовлення",
          "Latest orders",
          "Клієнти",
          "Customers",
          "Знайшов",
          "Found",
        ]),
      );
      expect(scenario.expectation.textExcludes).not.toContain(" замовлень");
      expect(scenario.expectation.textExcludes).not.toContain(" orders");
      expect(scenario.expectation.textExcludes).not.toContain(
        "{{count}} order",
      );
    }
  });
});

describe("GATE_CLASSIFIES_SCENARIOS", () => {
  it("defines the four SHO-428 corpus ids", () => {
    expect(GATE_CLASSIFIES_SCENARIOS.map((scenario) => scenario.id)).toEqual([
      "t7.sho-428.create-order-cake-macarons",
      "t7.sho-428.last-3-orders",
      "t7.sho-428.counts-today",
      "t7.sho-428.macarons-lemon-picker",
    ]);
    expect(GATE_CLASSIFIES_SCENARIOS[0]?.turns[0]?.text).toContain(
      "створи замовлення для",
    );
    expect(GATE_CLASSIFIES_SCENARIOS[0]?.turns[0]?.text).toContain(
      "3 торта 10 макаронс",
    );
    expect(GATE_CLASSIFIES_SCENARIOS[1]?.turns[0]?.text).toBe(
      "покажи останні 3 замовлення",
    );
    expect(GATE_CLASSIFIES_SCENARIOS[2]?.turns[0]?.text).toBe(
      "скільки замовлень сьогодні",
    );
    expect(GATE_CLASSIFIES_SCENARIOS[3]?.turns[0]?.text).toBe("макаронс лемон");
    expect(GATE_CLASSIFIES_SCENARIOS[0]?.expectation.ordered?.[0]?.name).toBe(
      ORDERS_CREATE_TOOL_NAME,
    );
    expect(GATE_CLASSIFIES_SCENARIOS[1]?.expectation.ordered?.[0]?.name).toBe(
      ORDERS_LIST_PAGE_TOOL_NAME,
    );
    expect(
      GATE_CLASSIFIES_SCENARIOS[1]?.expectation.ordered?.[0]
        ?.requireSuccessfulResult,
    ).toBe(true);
    expect(GATE_CLASSIFIES_SCENARIOS[2]?.expectation.ordered?.[0]?.name).toBe(
      ORDERS_LIST_COUNTS_TOOL_NAME,
    );
    expect(GATE_CLASSIFIES_SCENARIOS[3]?.expectation.requireChoice).toBe(true);
    expect(
      GATE_CLASSIFIES_SCENARIOS[3]?.expectation.ordered?.[0]
        ?.requireResultStatus,
    ).toBe("needs_choice");
  });
});

describe("HITL_CONFIRMATION_SCENARIOS", () => {
  it("defines the SHO-516 confirmation pause id", () => {
    expect(HITL_CONFIRMATION_SCENARIOS.map((scenario) => scenario.id)).toEqual([
      "t3.sho-516.delete-archived-customer-confirmation",
    ]);
    expect(HITL_CONFIRMATION_SCENARIOS[0]?.turns[0]?.text).toContain(
      "Олена Архівна",
    );
    expect(HITL_CONFIRMATION_SCENARIOS[0]?.turns[0]?.text).not.toContain(
      "Катя Самбука",
    );
    expect(
      HITL_CONFIRMATION_SCENARIOS[0]?.expectation.requireConfirmation,
    ).toBe(true);
    expect(
      HITL_CONFIRMATION_SCENARIOS[0]?.expectation.ordered?.[0]
        ?.requireResultStatus,
    ).toBe("confirmation_required");
  });
});

describe("collectEvalToolCalls", () => {
  it("ignores a leftover json tool name and overlays execute results", () => {
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
