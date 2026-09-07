import {
  CUSTOMERS_LIST_CUSTOMERS_TOOL_NAME,
  ORDERS_LIST_COUNTS_TOOL_NAME,
  STAFF_ASSISTANT_TOOL_SEARCH_NAME,
} from "@showzy/ai";
import {
  MockLanguageModelV3,
  mockSpokenStream,
  mockStaffAssistantGateGenerate,
  mockToolCallStream,
} from "@showzy/ai/test";
import { listCustomersContract } from "@showzy/customers/contract";
import { listOrdersContract } from "@showzy/orders/contract";
import { describe, expect, it, vi } from "vitest";

import { matchEvalExpectation } from "./expectation.js";
import { createEvalLogger } from "./log.js";
import { runStaffAssistantEvalTurn } from "./run-turn.js";
import { PROOF_SCENARIOS } from "./scenarios/proof.js";

const silentLogger = createEvalLogger({
  write() {
    /* discard */
  },
});

const CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";

describe("runStaffAssistantEvalTurn", () => {
  it("captures a counts façade call from a mock model without hitting the network", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("network must not run"));
    const execute = vi.fn(() =>
      Promise.resolve({ kind: "aggregate", total: 1, buckets: [] }),
    );
    const result = await runStaffAssistantEvalTurn({
      models: {
        languageModel: new MockLanguageModelV3({
          doStream: [
            mockToolCallStream(
              "call-counts",
              ORDERS_LIST_COUNTS_TOOL_NAME,
              JSON.stringify({ period: "today" }),
            ),
            mockSpokenStream("1"),
          ],
        }),
        gateLanguageModel: new MockLanguageModelV3({
          doGenerate: mockStaffAssistantGateGenerate({
            mode: "job",
            intent: "orders_counts",
            confidence: "high",
          }),
        }),
        replyModelId: "mock-sonnet",
        gateModelId: "mock-haiku",
      },
      messages: [{ role: "user", content: "скільки замовлень сьогодні" }],
      contracts: [listOrdersContract],
      execute,
      logger: silentLogger,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    expect(result.forcedToolName).toBe(ORDERS_LIST_COUNTS_TOOL_NAME);
    expect(execute).toHaveBeenCalled();
    const scenario = PROOF_SCENARIOS.find(
      (entry) => entry.id === "proof.orders-counts-today",
    );
    expect(scenario).toBeDefined();
    expect(
      matchEvalExpectation(scenario?.expectation ?? {}, result.trace),
    ).toEqual({ ok: true });
  });

  it("records nominative customer search then a page by matched id", async () => {
    const execute = vi.fn((actionName: string) => {
      if (actionName === "customers.listCustomers") {
        return Promise.resolve({
          items: [{ id: CUSTOMER_ID, name: "Катя Самбука" }],
          nextCursor: null,
        });
      }
      return Promise.resolve({ items: [], nextCursor: null });
    });
    const result = await runStaffAssistantEvalTurn({
      models: {
        languageModel: new MockLanguageModelV3({
          doStream: [
            mockToolCallStream(
              "call-cust",
              CUSTOMERS_LIST_CUSTOMERS_TOOL_NAME,
              JSON.stringify({ search: "Катя Самбука" }),
            ),
            mockToolCallStream(
              "call-page",
              "orders_list_page",
              JSON.stringify({ customerIds: [CUSTOMER_ID] }),
            ),
            mockSpokenStream("1"),
          ],
        }),
        gateLanguageModel: new MockLanguageModelV3({
          doGenerate: mockStaffAssistantGateGenerate({
            mode: "job",
            intent: "other",
            confidence: "high",
          }),
        }),
        replyModelId: "mock-sonnet",
        gateModelId: "mock-haiku",
      },
      messages: [{ role: "user", content: "замовлення для Каті Самбуки" }],
      contracts: [listCustomersContract, listOrdersContract],
      execute,
      logger: silentLogger,
    });
    const scenario = PROOF_SCENARIOS.find(
      (entry) => entry.id === "proof.orders-for-katya",
    );
    expect(
      matchEvalExpectation(scenario?.expectation ?? {}, result.trace),
    ).toEqual({ ok: true });
  });

  it("attaches no tools on chitchat weather", async () => {
    const execute = vi.fn(() => Promise.resolve({}));
    const result = await runStaffAssistantEvalTurn({
      models: {
        languageModel: new MockLanguageModelV3({
          doStream: [mockSpokenStream("I only help with this company.")],
        }),
        gateLanguageModel: new MockLanguageModelV3({
          doGenerate: mockStaffAssistantGateGenerate({
            mode: "chitchat",
            confidence: "high",
          }),
        }),
        replyModelId: "mock-sonnet",
        gateModelId: "mock-haiku",
      },
      messages: [{ role: "user", content: "яка погода" }],
      contracts: [listOrdersContract],
      execute,
      logger: silentLogger,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(result.trace.toolCalls).toEqual([]);
    const scenario = PROOF_SCENARIOS.find(
      (entry) => entry.id === "proof.weather-chitchat",
    );
    expect(
      matchEvalExpectation(scenario?.expectation ?? {}, result.trace),
    ).toEqual({ ok: true });
  });

  it("keeps tool_search in the trace for a capability turn", async () => {
    const execute = vi.fn(() => Promise.resolve({}));
    const result = await runStaffAssistantEvalTurn({
      models: {
        languageModel: new MockLanguageModelV3({
          doStream: [
            mockToolCallStream(
              "call-search",
              STAFF_ASSISTANT_TOOL_SEARCH_NAME,
              JSON.stringify({ query: "help" }),
            ),
            mockSpokenStream("I can help with orders."),
          ],
        }),
        gateLanguageModel: new MockLanguageModelV3({
          doGenerate: mockStaffAssistantGateGenerate({
            mode: "capability",
            confidence: "high",
          }),
        }),
        replyModelId: "mock-sonnet",
        gateModelId: "mock-haiku",
      },
      messages: [{ role: "user", content: "чим можеш допомогти" }],
      contracts: [listOrdersContract],
      execute,
      logger: silentLogger,
    });
    expect(result.trace.toolCalls[0]?.name).toBe(
      STAFF_ASSISTANT_TOOL_SEARCH_NAME,
    );
    const scenario = PROOF_SCENARIOS.find(
      (entry) => entry.id === "proof.capability-tool-search",
    );
    expect(
      matchEvalExpectation(scenario?.expectation ?? {}, result.trace),
    ).toEqual({ ok: true });
  });
});
