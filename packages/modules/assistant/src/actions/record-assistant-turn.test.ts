import { describe, expect, it } from "vitest";

import {
  STAFF_CONVERSATION_AUTHOR_INVARIANT,
  TOOL_RUNS_MAX,
} from "./conversation-view.contract.js";
import {
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
});
