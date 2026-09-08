import { describe, expect, it } from "vitest";

import {
  STAFF_CONVERSATION_AUTHOR_INVARIANT,
  TOOL_RUNS_MAX,
} from "./conversation-view.contract.js";
import { MODEL_TRACE_JSON_MAX } from "./record-assistant-turn.contract.js";
import {
  checkpointAssistantTurnContract,
  checkpointAssistantTurnInputSchema,
} from "./checkpoint-assistant-turn.contract.js";

const conversationId = "11111111-1111-4111-8111-111111111111";
const messageId = "22222222-2222-4222-8222-222222222222";
const executionId = "33333333-3333-4333-8333-333333333333";

describe("assistant.checkpointAssistantTurn contract", () => {
  it("is a staff internal write with assistant:use, idempotent audit, and AI-internal", () => {
    expect(checkpointAssistantTurnContract.name).toBe(
      "assistant.checkpointAssistantTurn",
    );
    expect(checkpointAssistantTurnContract.principal).toBe("staff");
    expect(checkpointAssistantTurnContract.transport).toBe("internal");
    expect(checkpointAssistantTurnContract.risk).toBe("write");
    expect(checkpointAssistantTurnContract.permissions).toEqual([
      "assistant:use",
    ]);
    expect(checkpointAssistantTurnContract.aiExposure).toBe("internal");
    expect(checkpointAssistantTurnContract.audit).toBe(true);
    expect(checkpointAssistantTurnContract.idempotent).toBe(true);
    expect(checkpointAssistantTurnContract.requiresConfirmation).toBe(false);
    expect(checkpointAssistantTurnContract.emits).toEqual([]);
    expect(checkpointAssistantTurnContract.errors).toEqual([
      "VALIDATION",
      "NOT_FOUND",
    ]);
    expect(checkpointAssistantTurnContract.description).toContain(
      STAFF_CONVERSATION_AUTHOR_INVARIANT,
    );
    expect(checkpointAssistantTurnContract.description).toContain("stageRun");
    expect(checkpointAssistantTurnContract.description).toContain(
      "executionId",
    );
    expect(checkpointAssistantTurnContract.timeout).toBe(5_000);
  });

  it("accepts begin, stageRun, finishRun, and complete kinds", () => {
    expect(
      checkpointAssistantTurnInputSchema.parse({
        kind: "begin",
        conversationId,
      }),
    ).toEqual({ kind: "begin", conversationId });
    expect(
      checkpointAssistantTurnInputSchema.parse({
        kind: "stageRun",
        conversationId,
        messageId,
        seq: 0,
        actionName: "orders.list",
        toolName: "orders_list_page",
        toolCallId: "call_1",
        toolInput: { limit: 20 },
      }),
    ).toMatchObject({
      kind: "stageRun",
      toolInput: { limit: 20 },
      seq: 0,
    });
    expect(
      checkpointAssistantTurnInputSchema.parse({
        kind: "finishRun",
        conversationId,
        executionId,
        outcome: "success",
        resultIds: [messageId],
        modelTrace: { kind: "page.summary" },
      }),
    ).toMatchObject({
      kind: "finishRun",
      outcome: "success",
    });
    expect(
      checkpointAssistantTurnInputSchema.parse({
        kind: "complete",
        conversationId,
        messageId,
        body: "Listed.",
      }),
    ).toEqual({
      kind: "complete",
      conversationId,
      messageId,
      body: "Listed.",
    });
  });

  it("does not accept a mutated recordAssistantTurn payload as a checkpoint", () => {
    expect(
      checkpointAssistantTurnInputSchema.safeParse({
        conversationId,
        body: "Done.",
        toolRuns: [
          {
            actionName: "orders.create",
            toolCallId: "call_1",
            outcome: "success",
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      checkpointAssistantTurnInputSchema.safeParse({
        kind: "record",
        conversationId,
        body: "Done.",
        toolRuns: [],
      }).success,
    ).toBe(false);
    expect(
      checkpointAssistantTurnInputSchema.safeParse({
        kind: "begin",
        conversationId,
        body: "Done.",
        toolRuns: [],
      }).success,
    ).toBe(false);
    expect(
      checkpointAssistantTurnInputSchema.safeParse({
        kind: "begin",
        conversationId,
        companyId: "44444444-4444-4444-8444-444444444444",
      }).success,
    ).toBe(false);
  });

  it("rejects oversized toolInput and finishRun started outcome", () => {
    expect(
      checkpointAssistantTurnInputSchema.safeParse({
        kind: "stageRun",
        conversationId,
        messageId,
        seq: 0,
        actionName: "orders.list",
        toolName: "orders_list_page",
        toolCallId: "call_huge",
        toolInput: { pad: "x".repeat(MODEL_TRACE_JSON_MAX) },
      }).success,
    ).toBe(false);
    expect(
      checkpointAssistantTurnInputSchema.safeParse({
        kind: "stageRun",
        conversationId,
        messageId,
        seq: TOOL_RUNS_MAX + 1,
        actionName: "orders.list",
        toolName: "orders_list_page",
        toolCallId: "call_seq",
        toolInput: {},
      }).success,
    ).toBe(false);
    expect(
      checkpointAssistantTurnInputSchema.safeParse({
        kind: "finishRun",
        conversationId,
        executionId,
        outcome: "started",
      }).success,
    ).toBe(false);
    expect(
      checkpointAssistantTurnInputSchema.safeParse({
        kind: "complete",
        conversationId,
        messageId,
        body: "",
      }).success,
    ).toBe(false);
  });
});
