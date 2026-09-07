import { describe, expect, it } from "vitest";

import {
  CONVERSATION_TITLE_MAX,
  STAFF_CONVERSATION_AUTHOR_INVARIANT,
} from "./conversation-view.contract.js";
import {
  createConversationContract,
  createConversationInputSchema,
  createConversationOutputSchema,
} from "./create-conversation.contract.js";

describe("assistant.createConversation contract", () => {
  it("is a staff client write with assistant:use, idempotent audit, and AI-internal", () => {
    expect(createConversationContract.name).toBe(
      "assistant.createConversation",
    );
    expect(createConversationContract.principal).toBe("staff");
    expect(createConversationContract.transport).toBe("client");
    expect(createConversationContract.risk).toBe("write");
    expect(createConversationContract.permissions).toEqual(["assistant:use"]);
    expect(createConversationContract.aiExposure).toBe("internal");
    expect(createConversationContract.audit).toBe(true);
    expect(createConversationContract.idempotent).toBe(true);
    expect(createConversationContract.emits).toEqual([]);
    expect(createConversationContract.description).toContain(
      STAFF_CONVERSATION_AUTHOR_INVARIANT,
    );
    expect(createConversationContract.timeout).toBe(5_000);
    expect(createConversationContract.rateLimit).toBeUndefined();
  });

  it("does not accept companyId and caps an optional title", () => {
    expect(Object.keys(createConversationInputSchema.shape).toSorted()).toEqual(
      ["title"],
    );
    expect(
      Object.keys(createConversationOutputSchema.shape).toSorted(),
    ).toEqual(["createdAt", "id", "title", "updatedAt", "userId"]);
    expect(
      createConversationInputSchema.safeParse({
        companyId: "11111111-1111-4111-8111-111111111111",
      }).success,
    ).toBe(false);
    expect(
      createConversationInputSchema.safeParse({
        userId: "11111111-1111-4111-8111-111111111111",
      }).success,
    ).toBe(false);
    expect(
      createConversationInputSchema.safeParse({
        title: "x".repeat(CONVERSATION_TITLE_MAX + 1),
      }).success,
    ).toBe(false);
    expect(
      createConversationInputSchema.safeParse({ title: "  " }).success,
    ).toBe(false);
    expect(createConversationInputSchema.parse({}).title).toBeUndefined();
  });
});
