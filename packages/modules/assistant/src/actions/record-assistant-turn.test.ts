import { describe, expect, it } from "vitest";

import {
  STAFF_CONVERSATION_AUTHOR_INVARIANT,
  TOOL_RUNS_MAX,
} from "./conversation-view.contract.js";
import {
  MODEL_TRACE_JSON_MAX,
  modelTracePostgresJsonbTextLength,
  recordAssistantTurnContract,
  recordAssistantTurnInputSchema,
} from "./record-assistant-turn.contract.js";

describe("assistant.recordAssistantTurn contract", () => {
  it("is a staff internal write with assistant:use, idempotent audit, and AI-internal", () => {
    expect(recordAssistantTurnContract.name).toBe(
      "assistant.recordAssistantTurn",
    );
    expect(recordAssistantTurnContract.principal).toBe("staff");
    expect(recordAssistantTurnContract.transport).toBe("internal");
    expect(recordAssistantTurnContract.risk).toBe("write");
    expect(recordAssistantTurnContract.permissions).toEqual(["assistant:use"]);
    expect(recordAssistantTurnContract.aiExposure).toBe("internal");
    expect(recordAssistantTurnContract.audit).toBe(true);
    expect(recordAssistantTurnContract.idempotent).toBe(true);
    expect(recordAssistantTurnContract.emits).toEqual([]);
    expect(recordAssistantTurnContract.description).toContain(
      STAFF_CONVERSATION_AUTHOR_INVARIANT,
    );
    expect(recordAssistantTurnContract.timeout).toBe(5_000);
  });

  it("stores action name, toolCallId, challengeId, result ids, and outcome — not status", () => {
    const conversationId = "11111111-1111-4111-8111-111111111111";
    const parsed = recordAssistantTurnInputSchema.parse({
      conversationId,
      body: "Done.",
      toolRuns: [
        {
          actionName: "orders.create",
          toolCallId: "call_1",
          resultIds: ["33333333-3333-4333-8333-333333333333"],
          outcome: "success",
        },
      ],
    });
    expect(parsed.toolRuns[0]).toEqual({
      actionName: "orders.create",
      toolCallId: "call_1",
      resultIds: ["33333333-3333-4333-8333-333333333333"],
      outcome: "success",
    });
    expect(parsed.toolRuns[0]).not.toHaveProperty("status");
    expect(
      recordAssistantTurnInputSchema.parse({
        conversationId,
        body: "Pick a variant.",
        toolRuns: [
          {
            actionName: "orders.create",
            toolCallId: "call_choice",
            challengeId: "44444444-4444-4444-8444-444444444444",
            outcome: "choice_required",
          },
        ],
      }).toolRuns[0],
    ).toEqual({
      actionName: "orders.create",
      toolCallId: "call_choice",
      challengeId: "44444444-4444-4444-8444-444444444444",
      resultIds: [],
      outcome: "choice_required",
    });
    expect(
      recordAssistantTurnInputSchema.safeParse({
        conversationId,
        body: "Done.",
        toolRuns: [
          {
            actionName: "orders.create",
            toolCallId: "call_1",
            outcome: "confirmed",
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      recordAssistantTurnInputSchema.safeParse({
        conversationId,
        body: "Done.",
        companyId: "22222222-2222-4222-8222-222222222222",
      }).success,
    ).toBe(false);
    expect(
      recordAssistantTurnInputSchema.safeParse({
        conversationId,
        body: "Done.",
        userId: "22222222-2222-4222-8222-222222222222",
      }).success,
    ).toBe(false);
    expect(
      recordAssistantTurnInputSchema.safeParse({
        conversationId,
        body: "Done.",
        toolRuns: Array.from({ length: TOOL_RUNS_MAX + 1 }, (_, index) => ({
          actionName: "orders.list",
          toolCallId: `call_${String(index)}`,
          outcome: "success" as const,
        })),
      }).success,
    ).toBe(false);
  });

  it("accepts optional bounded modelTrace and rejects oversized JSON", () => {
    const conversationId = "11111111-1111-4111-8111-111111111111";
    const parsed = recordAssistantTurnInputSchema.parse({
      conversationId,
      body: "Listed.",
      toolRuns: [
        {
          actionName: "orders.list",
          toolCallId: "call_trace",
          outcome: "success",
          modelTrace: { kind: "page.summary", rows: [{ orderNumber: "12" }] },
        },
      ],
    });
    expect(parsed.toolRuns[0]?.modelTrace).toEqual({
      kind: "page.summary",
      rows: [{ orderNumber: "12" }],
    });
    expect(
      recordAssistantTurnInputSchema.parse({
        conversationId,
        body: "Listed.",
        toolRuns: [
          {
            actionName: "orders.list",
            toolCallId: "call_trace_named",
            outcome: "success",
            toolName: "orders_list_page",
            modelTrace: { kind: "page.summary", rows: [{ orderNumber: "12" }] },
          },
        ],
      }).toolRuns[0]?.toolName,
    ).toBe("orders_list_page");
    expect(
      recordAssistantTurnInputSchema.safeParse({
        conversationId,
        body: "Listed.",
        toolRuns: [
          {
            actionName: "orders.list",
            toolCallId: "call_huge",
            outcome: "success",
            modelTrace: { pad: "x".repeat(MODEL_TRACE_JSON_MAX) },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      recordAssistantTurnInputSchema.safeParse({
        conversationId,
        body: "Listed.",
        toolRuns: [
          {
            actionName: "orders.list",
            toolCallId: "call_stringify_ok_postgres_over",
            outcome: "success",
            modelTrace: { pad: "x".repeat(21_990) },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      recordAssistantTurnInputSchema.safeParse({
        conversationId,
        body: "Listed.",
        toolRuns: [
          {
            actionName: "orders.list",
            toolCallId: "call_postgres_limit",
            outcome: "success",
            modelTrace: { pad: "x".repeat(21_989) },
          },
        ],
      }).success,
    ).toBe(true);
    expect(modelTracePostgresJsonbTextLength({ pad: "x".repeat(21_990) })).toBe(
      MODEL_TRACE_JSON_MAX + 1,
    );
    expect(JSON.stringify({ pad: "x".repeat(21_990) }).length).toBe(
      MODEL_TRACE_JSON_MAX,
    );
  });
});
