import { describe, expect, it } from "vitest";

import { STAFF_CONVERSATION_AUTHOR_INVARIANT } from "./conversation-view.contract.js";
import {
  GET_MODEL_HISTORY_INCLUDE_TURN_KEYS_MAX,
  GET_MODEL_HISTORY_WINDOW,
  getModelHistoryContract,
  getModelHistoryInputSchema,
  getModelHistoryOutputSchema,
  modelHistoryMessageSchema,
  modelHistoryToolRunSchema,
} from "./get-model-history.contract.js";

describe("assistant.getModelHistory contract", () => {
  it("is a staff internal read with assistant:use, AI-internal, and no audit", () => {
    expect(getModelHistoryContract.name).toBe("assistant.getModelHistory");
    expect(getModelHistoryContract.principal).toBe("staff");
    expect(getModelHistoryContract.transport).toBe("internal");
    expect(getModelHistoryContract.risk).toBe("read");
    expect(getModelHistoryContract.permissions).toEqual(["assistant:use"]);
    expect(getModelHistoryContract.aiExposure).toBe("internal");
    expect(getModelHistoryContract.audit).toBe(false);
    expect(getModelHistoryContract.idempotent).toBe(false);
    expect(getModelHistoryContract.emits).toEqual([]);
    expect(getModelHistoryContract.description).toContain(
      STAFF_CONVERSATION_AUTHOR_INVARIANT,
    );
    expect(getModelHistoryContract.description).toContain("modelTrace");
    expect(getModelHistoryContract.description).toContain("toolName");
    expect(getModelHistoryContract.description).toContain("toolInput");
    expect(getModelHistoryContract.description).toContain("turnKey");
    expect(getModelHistoryContract.description).toContain(
      "unfinishedStartedRuns",
    );
    expect(getModelHistoryContract.timeout).toBe(5_000);
    expect(GET_MODEL_HISTORY_WINDOW).toBe(8);
    expect(getModelHistoryContract.description).toContain("includeTurnKeys");
  });

  it("takes conversationId and optional includeTurnKeys and rejects companyId", () => {
    expect(Object.keys(getModelHistoryInputSchema.shape).toSorted()).toEqual([
      "conversationId",
      "includeTurnKeys",
    ]);
    expect(Object.keys(getModelHistoryOutputSchema.shape).toSorted()).toEqual([
      "checkpointTurns",
      "conversationId",
      "messages",
      "unfinishedStartedRuns",
    ]);
    expect(Object.keys(modelHistoryMessageSchema.shape).toSorted()).toEqual([
      "id",
      "role",
      "text",
      "toolRuns",
      "turnKey",
    ]);
    expect(Object.keys(modelHistoryToolRunSchema.shape).toSorted()).toEqual([
      "action",
      "executionId",
      "modelTrace",
      "outcome",
      "seq",
      "toolCallId",
      "toolInput",
      "toolName",
    ]);
    expect(
      getModelHistoryInputSchema.safeParse({ conversationId: "not-a-uuid" })
        .success,
    ).toBe(false);
    expect(
      getModelHistoryInputSchema.safeParse({
        conversationId: "11111111-1111-4111-8111-111111111111",
      }).success,
    ).toBe(true);
    expect(
      getModelHistoryInputSchema.safeParse({
        conversationId: "11111111-1111-4111-8111-111111111111",
        companyId: "22222222-2222-4222-8222-222222222222",
      }).success,
    ).toBe(false);
    expect(
      getModelHistoryInputSchema.safeParse({
        conversationId: "11111111-1111-4111-8111-111111111111",
        userId: "22222222-2222-4222-8222-222222222222",
      }).success,
    ).toBe(false);
    expect(
      getModelHistoryInputSchema.safeParse({
        conversationId: "11111111-1111-4111-8111-111111111111",
        includeTurnKeys: [
          "begin:resume:11111111-1111-4111-8111-111111111111",
        ],
      }).success,
    ).toBe(true);
    expect(
      getModelHistoryInputSchema.safeParse({
        conversationId: "11111111-1111-4111-8111-111111111111",
        includeTurnKeys: Array.from(
          { length: GET_MODEL_HISTORY_INCLUDE_TURN_KEYS_MAX + 1 },
          (_, index) => `begin:${String(index).padStart(8, "0")}`,
        ),
      }).success,
    ).toBe(false);
  });
});
