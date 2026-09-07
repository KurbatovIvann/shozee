import { describe, expect, it } from "vitest";

import { STAFF_CONVERSATION_AUTHOR_INVARIANT } from "./conversation-view.contract.js";
import {
  LIST_CONVERSATIONS_CURSOR_MAX,
  LIST_CONVERSATIONS_DEFAULT_LIMIT,
  LIST_CONVERSATIONS_MAX_LIMIT,
  formatListConversationsCursor,
  listConversationsContract,
  parseListConversationsCursor,
} from "./list-conversations.contract.js";

describe("assistant.listConversations contract", () => {
  it("is a staff client read with assistant:use, AI-internal, and no audit", () => {
    expect(listConversationsContract.name).toBe("assistant.listConversations");
    expect(listConversationsContract.principal).toBe("staff");
    expect(listConversationsContract.transport).toBe("client");
    expect(listConversationsContract.risk).toBe("read");
    expect(listConversationsContract.permissions).toEqual(["assistant:use"]);
    expect(listConversationsContract.aiExposure).toBe("internal");
    expect(listConversationsContract.audit).toBe(false);
    expect(listConversationsContract.idempotent).toBe(false);
    expect(listConversationsContract.emits).toEqual([]);
    expect(listConversationsContract.description).toContain(
      STAFF_CONVERSATION_AUTHOR_INVARIANT,
    );
    expect(listConversationsContract.timeout).toBe(5_000);
    expect(listConversationsContract.rateLimit).toBeUndefined();
    expect(LIST_CONVERSATIONS_DEFAULT_LIMIT).toBe(20);
    expect(LIST_CONVERSATIONS_MAX_LIMIT).toBe(50);
    expect(LIST_CONVERSATIONS_CURSOR_MAX).toBe(80);
  });

  it("defaults limit and rejects a malformed cursor, oversized limit, and companyId", () => {
    expect(listConversationsContract.input.parse({}).limit).toBe(
      LIST_CONVERSATIONS_DEFAULT_LIMIT,
    );
    expect(
      listConversationsContract.input.safeParse({ cursor: "nope" }).success,
    ).toBe(false);
    expect(
      listConversationsContract.input.safeParse({
        limit: LIST_CONVERSATIONS_MAX_LIMIT + 1,
      }).success,
    ).toBe(false);
    expect(
      listConversationsContract.input.safeParse({ limit: 0 }).success,
    ).toBe(false);
    expect(
      listConversationsContract.input.safeParse({
        companyId: "11111111-1111-4111-8111-111111111111",
      }).success,
    ).toBe(false);
    expect(
      listConversationsContract.input.safeParse({
        userId: "11111111-1111-4111-8111-111111111111",
      }).success,
    ).toBe(false);
    expect(
      listConversationsContract.input.safeParse({ scope: "all" }).success,
    ).toBe(false);
    expect(parseListConversationsCursor("nope")).toBeUndefined();
  });

  it("round-trips an updatedAt/id cursor", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const updatedAt = new Date("2026-03-01T00:00:00.000Z");
    const cursor = formatListConversationsCursor(updatedAt, id);
    expect(parseListConversationsCursor(cursor)).toEqual({
      updatedAt: "2026-03-01T00:00:00.000Z",
      id,
    });
  });
});
