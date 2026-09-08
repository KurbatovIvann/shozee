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
  mockStaffAssistantGateGenerate,
  mockTextStream,
  mockToolCallStream,
} from "@showzy/ai/test";
import { listCustomersContract } from "@showzy/customers/contract";
import { listOrdersContract } from "@showzy/orders/contract";
import { describe, expect, it, vi } from "vitest";

import { matchEvalExpectation } from "./expectation.js";
import { createEvalLogger } from "./log.js";
import { runStaffAssistantEvalTurn } from "./run-turn.js";
import { MODEL_SPEAKS_SCENARIOS } from "./scenarios/model-speaks.js";
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
            confidence: "high",
          }),
        }),
        replyModelId: "mock-sonnet",
        gateModelId: "mock-haiku",
      },
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

  it("MODEL_SPEAKS host keeps a markdown table as model speech", async () => {
    const table = "| order | total |\n| **#12** | 10 |";
    const execute = vi.fn(() =>
      Promise.resolve({
        kind: "page.summary",
        rows: [{ orderNumber: "12" }],
        nextCursor: null,
      }),
    );
    const gateLanguageModel = new MockLanguageModelV3({
      doGenerate: mockStaffAssistantGateGenerate({
        mode: "job",
        confidence: "high",
      }),
    });
    const newHost = await runStaffAssistantEvalTurn({
      host: "new",
      models: {
        languageModel: new MockLanguageModelV3({
          doStream: [
            mockToolCallStream(
              "call-page",
              ORDERS_LIST_PAGE_TOOL_NAME,
              JSON.stringify({ limit: 3 }),
            ),
            mockTextStream(table),
          ],
        }),
        gateLanguageModel,
        replyModelId: "mock-sonnet",
        gateModelId: "mock-haiku",
      },
      messages: [{ role: "user", content: "останні 3 замовлення" }],
      contracts: [listOrdersContract],
      execute,
      logger: silentLogger,
    });
    expect(gateLanguageModel.doGenerateCalls).toHaveLength(0);
    expect(newHost.trace.speechSource).toBe("model");
    expect(newHost.trace.text).toBe(table);
    expect(
      matchEvalExpectation(
        MODEL_SPEAKS_SCENARIOS[0]?.expectation ?? {},
        newHost.trace,
      ),
    ).toEqual({ ok: true });

    const live = await runStaffAssistantEvalTurn({
      models: {
        languageModel: new MockLanguageModelV3({
          doStream: [
            mockToolCallStream(
              "call-page-live",
              ORDERS_LIST_PAGE_TOOL_NAME,
              JSON.stringify({ limit: 3 }),
            ),
            mockTextStream(table),
          ],
        }),
        gateLanguageModel: new MockLanguageModelV3({
          doGenerate: mockStaffAssistantGateGenerate({
            mode: "job",
            confidence: "high",
          }),
        }),
        replyModelId: "mock-sonnet",
        gateModelId: "mock-haiku",
      },
      messages: [{ role: "user", content: "останні 3 замовлення" }],
      contracts: [listOrdersContract],
      execute,
      logger: silentLogger,
    });
    expect(live.trace.speechSource).not.toBe("model");
  });

  it("MODEL_SPEAKS host still falls back on leftover JSON", async () => {
    const execute = vi.fn(() =>
      Promise.resolve({
        kind: "page.summary",
        rows: [{ orderNumber: "12" }],
        nextCursor: null,
      }),
    );
    const result = await runStaffAssistantEvalTurn({
      host: "new",
      models: {
        languageModel: new MockLanguageModelV3({
          doStream: [
            mockToolCallStream("call-page", ORDERS_LIST_PAGE_TOOL_NAME, "{}"),
            mockSpokenStream("12"),
          ],
        }),
        replyModelId: "mock-sonnet",
        gateModelId: "mock-haiku",
      },
      messages: [{ role: "user", content: "останні 3 замовлення" }],
      contracts: [listOrdersContract],
      execute,
      logger: silentLogger,
    });
    expect(result.trace.speechSource).toBe("fallback");
    expect(result.trace.text).toBe(STAFF_ASSISTANT_SUCCESS_SPEECH_FALLBACK.uk);
    expect(result.trace.text).not.toBe("12");
  });

  it("MODEL_SPEAKS host records façade counts args so this_week matches", async () => {
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
      host: "new",
      models: {
        languageModel: new MockLanguageModelV3({
          doStream: [
            mockToolCallStream(
              "call-counts",
              ORDERS_LIST_COUNTS_TOOL_NAME,
              JSON.stringify({ period: "this_week" }),
            ),
            mockTextStream("4"),
          ],
        }),
        replyModelId: "mock-sonnet",
        gateModelId: "mock-haiku",
      },
      messages: [{ role: "user", content: "скільки замовлень цього тижня" }],
      contracts: [listOrdersContract],
      execute,
      logger: silentLogger,
    });
    expect(execute).toHaveBeenCalledWith(
      "orders.list",
      expect.objectContaining({
        kind: "aggregate",
        filter: expect.objectContaining({
          createdFrom: expect.any(String),
          createdTo: expect.any(String),
        }),
      }),
      { toolCallId: "call-counts" },
    );
    expect(executeInput).not.toHaveProperty("period");
    expect(result.trace.toolCalls[0]?.args).toMatchObject({
      period: "this_week",
    });
    expect(result.trace.toolCalls[0]?.args).not.toHaveProperty("kind");
    expect(result.trace.speechSource).toBe("model");
    expect(
      matchEvalExpectation(
        MODEL_SPEAKS_SCENARIOS[1]?.expectation ?? {},
        result.trace,
      ),
    ).toEqual({ ok: true });
  });
});
