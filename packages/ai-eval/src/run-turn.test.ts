import {
  CUSTOMERS_LIST_CUSTOMERS_TOOL_NAME,
  ORDERS_LIST_COUNTS_TOOL_NAME,
  ORDERS_LIST_PAGE_TOOL_NAME,
  STAFF_ASSISTANT_SUCCESS_SPEECH_FALLBACK,
  STAFF_ASSISTANT_TOOL_SEARCH_NAME,
} from "@showzy/ai";
import {
  MockLanguageModelV3,
  mockSpokenStream,
  mockTextStream,
  mockToolCallStream,
} from "@showzy/ai/test";
import { listCustomersContract } from "@showzy/customers/contract";
import { listOrdersContract } from "@showzy/orders/contract";
import { describe, expect, it, vi } from "vitest";

import { matchEvalExpectation } from "./expectation.js";
import { createEvalLogger } from "./log.js";
import { isRecord } from "./record.js";
import { runStaffAssistantEvalTurn } from "./run-turn.js";
import { MODEL_SPEAKS_SCENARIOS } from "./scenarios/model-speaks.js";
import { PROOF_SCENARIOS } from "./scenarios/proof.js";

const silentLogger = createEvalLogger({
  write() {
    /* discard */
  },
});

const CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";

function evalModels(model: MockLanguageModelV3) {
  return {
    languageModel: model,
    replyModelId: "mock-sonnet",
    gateModelId: "mock-haiku",
  };
}

describe("runStaffAssistantEvalTurn", () => {
  it("captures a counts façade call from a mock model without hitting the network", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("network must not run"));
    const execute = vi.fn(() =>
      Promise.resolve({ kind: "aggregate", total: 1, buckets: [] }),
    );
    const result = await runStaffAssistantEvalTurn({
      models: evalModels(
        new MockLanguageModelV3({
          doStream: [
            mockToolCallStream(
              "call-counts",
              ORDERS_LIST_COUNTS_TOOL_NAME,
              JSON.stringify({ period: "today" }),
            ),
            mockSpokenStream("1"),
          ],
        }),
      ),
      messages: [{ role: "user", content: "скільки замовлень сьогодні" }],
      contracts: [listOrdersContract],
      execute,
      logger: silentLogger,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
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
      models: evalModels(
        new MockLanguageModelV3({
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
      ),
      messages: [{ role: "user", content: "покажи замовлення Каті Самбуки" }],
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

  it("does not execute tools when the mock only speaks", async () => {
    const execute = vi.fn(() => Promise.resolve({}));
    const result = await runStaffAssistantEvalTurn({
      models: evalModels(
        new MockLanguageModelV3({
          doStream: [mockTextStream("I only help with this company.")],
        }),
      ),
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
      models: evalModels(
        new MockLanguageModelV3({
          doStream: [
            mockToolCallStream(
              "call-search",
              STAFF_ASSISTANT_TOOL_SEARCH_NAME,
              JSON.stringify({ query: "help" }),
            ),
            mockSpokenStream("I can help with orders."),
          ],
        }),
      ),
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

  it("keeps a markdown table as model speech", async () => {
    const table = "| order | total |\n| **#12** | 10 |";
    const execute = vi.fn(() =>
      Promise.resolve({
        kind: "page.summary",
        rows: [{ orderNumber: "12" }],
        nextCursor: null,
      }),
    );
    const result = await runStaffAssistantEvalTurn({
      models: evalModels(
        new MockLanguageModelV3({
          doStream: [
            mockToolCallStream(
              "call-page",
              ORDERS_LIST_PAGE_TOOL_NAME,
              JSON.stringify({ limit: 3 }),
            ),
            mockTextStream(table),
          ],
        }),
      ),
      messages: [{ role: "user", content: "останні 3 замовлення" }],
      contracts: [listOrdersContract],
      execute,
      logger: silentLogger,
    });
    expect(result.trace.speechSource).toBe("model");
    expect(result.trace.text).toBe(table);
    expect(
      matchEvalExpectation(
        MODEL_SPEAKS_SCENARIOS[0]?.expectation ?? {},
        result.trace,
      ),
    ).toEqual({ ok: true });
  });

  it("still falls back on leftover JSON", async () => {
    const execute = vi.fn(() =>
      Promise.resolve({
        kind: "page.summary",
        rows: [{ orderNumber: "12" }],
        nextCursor: null,
      }),
    );
    const result = await runStaffAssistantEvalTurn({
      models: evalModels(
        new MockLanguageModelV3({
          doStream: [
            mockToolCallStream("call-page", ORDERS_LIST_PAGE_TOOL_NAME, "{}"),
            mockSpokenStream("12"),
          ],
        }),
      ),
      messages: [{ role: "user", content: "останні 3 замовлення" }],
      contracts: [listOrdersContract],
      execute,
      logger: silentLogger,
    });
    expect(result.trace.speechSource).toBe("fallback");
    expect(result.trace.text).toBe(STAFF_ASSISTANT_SUCCESS_SPEECH_FALLBACK.uk);
    expect(result.trace.text).not.toBe("12");
  });

  it("records façade counts args so this_week matches", async () => {
    let executeInput: unknown;
    const execute = vi.fn((_actionName: string, input: unknown) => {
      executeInput = input;
      return Promise.resolve({
        kind: "aggregate",
        orderCount: 4,
        buckets: [],
      });
    });
    const result = await runStaffAssistantEvalTurn({
      models: evalModels(
        new MockLanguageModelV3({
          doStream: [
            mockToolCallStream(
              "call-counts",
              ORDERS_LIST_COUNTS_TOOL_NAME,
              JSON.stringify({ period: "this_week" }),
            ),
            mockTextStream("4"),
          ],
        }),
      ),
      messages: [{ role: "user", content: "скільки замовлень цього тижня" }],
      contracts: [listOrdersContract],
      execute,
      logger: silentLogger,
    });
    expect(execute).toHaveBeenCalled();
    expect(isRecord(executeInput)).toBe(true);
    if (!isRecord(executeInput)) {
      return;
    }
    expect(executeInput["kind"]).toBe("aggregate");
    expect(isRecord(executeInput["filter"])).toBe(true);
    if (!isRecord(executeInput["filter"])) {
      return;
    }
    expect(typeof executeInput["filter"]["createdFrom"]).toBe("string");
    expect(typeof executeInput["filter"]["createdTo"]).toBe("string");
    expect(executeInput).not.toHaveProperty("period");
    expect(result.trace.toolCalls[0]?.args).toMatchObject({
      period: "this_week",
    });
    expect(result.trace.toolCalls[0]?.args).not.toHaveProperty("kind");
    expect(result.trace.toolCalls[0]?.args).not.toHaveProperty("createdFrom");
    expect(result.trace.toolCalls[0]?.args).not.toHaveProperty("createdTo");
    expect(result.trace.speechSource).toBe("model");
    expect(
      matchEvalExpectation(
        MODEL_SPEAKS_SCENARIOS[1]?.expectation ?? {},
        result.trace,
      ),
    ).toEqual({ ok: true });
  });
});
