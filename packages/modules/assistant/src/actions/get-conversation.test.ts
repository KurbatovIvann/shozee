import { describe, expect, it } from "vitest";

import { STAFF_CONVERSATION_AUTHOR_INVARIANT } from "./conversation-view.contract.js";
import {
  getConversationContract,
  getConversationInputSchema,
} from "./get-conversation.contract.js";

describe("assistant.getConversation contract", () => {
  it("is a staff client read with assistant:use, AI-internal, and no audit", () => {
    expect(getConversationContract.name).toBe("assistant.getConversation");
    expect(getConversationContract.principal).toBe("staff");
    expect(getConversationContract.transport).toBe("client");
    expect(getConversationContract.risk).toBe("read");
    expect(getConversationContract.permissions).toEqual(["assistant:use"]);
    expect(getConversationContract.aiExposure).toBe("internal");
    expect(getConversationContract.audit).toBe(false);
    expect(getConversationContract.idempotent).toBe(false);
    expect(getConversationContract.emits).toEqual([]);
    expect(getConversationContract.description).toContain(
      STAFF_CONVERSATION_AUTHOR_INVARIANT,
    );
    expect(getConversationContract.timeout).toBe(5_000);
  });

  it("takes conversationId only and rejects companyId", () => {
    expect(Object.keys(getConversationInputSchema.shape).toSorted()).toEqual([
      "conversationId",
    ]);
    expect(
      getConversationInputSchema.safeParse({ conversationId: "not-a-uuid" })
        .success,
    ).toBe(false);
    expect(
      getConversationInputSchema.safeParse({
        conversationId: "11111111-1111-4111-8111-111111111111",
        companyId: "22222222-2222-4222-8222-222222222222",
      }).success,
    ).toBe(false);
    expect(
      getConversationInputSchema.safeParse({
        conversationId: "11111111-1111-4111-8111-111111111111",
        userId: "22222222-2222-4222-8222-222222222222",
      }).success,
    ).toBe(false);
  });
});
