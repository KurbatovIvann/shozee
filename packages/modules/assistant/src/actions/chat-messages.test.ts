import { describe, expect, it } from "vitest";

import { CHAT_MESSAGES_PAGE_MAX } from "./chat-message-record.contract.js";
import { STAFF_CONVERSATION_AUTHOR_INVARIANT } from "./conversation-view.contract.js";
import {
  insertChatMessageContract,
  insertChatMessageInputSchema,
} from "./insert-chat-message.contract.js";
import {
  readChatMessagesContract,
  readChatMessagesInputSchema,
} from "./read-chat-messages.contract.js";
import {
  updateChatMessageContract,
  updateChatMessageInputSchema,
} from "./update-chat-message.contract.js";

const CONVERSATION = "11111111-1111-4111-8111-111111111111";
const MESSAGE = "22222222-2222-4222-8222-222222222222";

describe("the message-log contracts", () => {
  /**
   * A model able to write the transcript it is being shown could rewrite what
   * it was told it did, so none of these is a tool and none is on `/rpc`.
   */
  it("are staff internal actions under assistant:use, audited when they write", () => {
    for (const [contract, risk] of [
      [readChatMessagesContract, "read"],
      [insertChatMessageContract, "write"],
      [updateChatMessageContract, "write"],
    ] as const) {
      expect(contract.principal, contract.name).toBe("staff");
      expect(contract.transport, contract.name).toBe("internal");
      expect(contract.aiExposure, contract.name).toBe("internal");
      expect(contract.permissions, contract.name).toEqual(["assistant:use"]);
      expect(contract.risk, contract.name).toBe(risk);
      expect(contract.audit, contract.name).toBe(risk === "write");
      expect(contract.idempotent, contract.name).toBe(false);
      expect(contract.emits, contract.name).toEqual([]);
      expect(contract.description, contract.name).toContain(
        STAFF_CONVERSATION_AUTHOR_INVARIANT,
      );
    }
    expect(insertChatMessageContract.errors).toContain("CONFLICT");
  });

  it("never take a company id", () => {
    const companyId = "33333333-3333-4333-8333-333333333333";
    expect(
      readChatMessagesInputSchema.safeParse({
        conversationId: CONVERSATION,
        limit: 10,
        companyId,
      }).success,
    ).toBe(false);
    expect(
      insertChatMessageInputSchema.safeParse({
        conversationId: CONVERSATION,
        messageId: MESSAGE,
        bind: "owner",
        message: {},
        companyId,
      }).success,
    ).toBe(false);
    expect(
      updateChatMessageInputSchema.safeParse({
        conversationId: CONVERSATION,
        seq: 1,
        messageId: MESSAGE,
        message: {},
        companyId,
      }).success,
    ).toBe(false);
  });

  it("caps a page, and refuses a position below one", () => {
    const page = (input: Record<string, unknown>) =>
      readChatMessagesInputSchema.safeParse({
        conversationId: CONVERSATION,
        ...input,
      }).success;

    expect(page({ limit: CHAT_MESSAGES_PAGE_MAX })).toBe(true);
    expect(page({ limit: CHAT_MESSAGES_PAGE_MAX + 1 })).toBe(false);
    expect(page({ limit: 0 })).toBe(false);
    expect(page({})).toBe(false);
    expect(page({ limit: 10, beforeSeq: 1 })).toBe(true);
    expect(page({ limit: 10, beforeSeq: 0 })).toBe(false);
  });

  it("stores only an object as a message", () => {
    const insert = (message: unknown) =>
      insertChatMessageInputSchema.safeParse({
        conversationId: CONVERSATION,
        messageId: MESSAGE,
        bind: "owner",
        message,
      }).success;

    expect(insert({ parts: [] })).toBe(true);
    expect(insert(undefined)).toBe(false);
    expect(insert(null)).toBe(false);
    expect(insert([])).toBe(false);
    expect(insert("text")).toBe(false);
  });
});
