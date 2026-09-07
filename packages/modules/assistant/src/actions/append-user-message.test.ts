import { describe, expect, it } from "vitest";

import {
  MESSAGE_BODY_MAX,
  STAFF_CONVERSATION_AUTHOR_INVARIANT,
} from "./conversation-view.contract.js";
import {
  appendUserMessageContract,
  appendUserMessageInputSchema,
} from "./append-user-message.contract.js";

describe("assistant.appendUserMessage contract", () => {
  it("is a staff client write with assistant:use, idempotent audit, and AI-internal", () => {
    expect(appendUserMessageContract.name).toBe("assistant.appendUserMessage");
    expect(appendUserMessageContract.principal).toBe("staff");
    expect(appendUserMessageContract.transport).toBe("client");
    expect(appendUserMessageContract.risk).toBe("write");
    expect(appendUserMessageContract.permissions).toEqual(["assistant:use"]);
    expect(appendUserMessageContract.aiExposure).toBe("internal");
    expect(appendUserMessageContract.audit).toBe(true);
    expect(appendUserMessageContract.idempotent).toBe(true);
    expect(appendUserMessageContract.emits).toEqual([]);
    expect(appendUserMessageContract.description).toContain(
      STAFF_CONVERSATION_AUTHOR_INVARIANT,
    );
    expect(appendUserMessageContract.timeout).toBe(5_000);
  });

  it("does not accept role or companyId; body is required and capped", () => {
    expect(Object.keys(appendUserMessageInputSchema.shape).toSorted()).toEqual([
      "body",
      "conversationId",
    ]);
    expect(appendUserMessageInputSchema.safeParse({ body: "hi" }).success).toBe(
      false,
    );
    expect(
      appendUserMessageInputSchema.safeParse({
        conversationId: "11111111-1111-4111-8111-111111111111",
        body: "",
      }).success,
    ).toBe(false);
    expect(
      appendUserMessageInputSchema.safeParse({
        conversationId: "11111111-1111-4111-8111-111111111111",
        body: "x".repeat(MESSAGE_BODY_MAX + 1),
      }).success,
    ).toBe(false);
    expect(
      appendUserMessageInputSchema.safeParse({
        conversationId: "11111111-1111-4111-8111-111111111111",
        body: "hello",
        role: "assistant",
      }).success,
    ).toBe(false);
    expect(
      appendUserMessageInputSchema.safeParse({
        conversationId: "11111111-1111-4111-8111-111111111111",
        body: "hello",
        companyId: "22222222-2222-4222-8222-222222222222",
      }).success,
    ).toBe(false);
    expect(
      appendUserMessageInputSchema.safeParse({
        conversationId: "11111111-1111-4111-8111-111111111111",
        body: "hello",
        userId: "22222222-2222-4222-8222-222222222222",
      }).success,
    ).toBe(false);
  });
});
