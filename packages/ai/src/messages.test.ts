import { describe, expect, it } from "vitest";

import {
  ORDERS_CREATE_TOOL_NAME,
  ORDERS_LIST_PAGE_TOOL_NAME,
} from "./action-tool.js";
import { STAFF_ASSISTANT_HISTORY_CACHE_PROVIDER_OPTIONS } from "./provider/anthropic.js";
import {
  applyStaffAssistantHistoryWindow,
  lastStaffAssistantUserMessage,
  pausedToolAttemptForChallenge,
  pausedToolAttemptFromToolRuns,
  resolvePausedToolAttempt,
  resolveStaffAssistantChatUserMessage,
  staffAssistantChatBodySchema,
  staffAssistantHistoryStats,
  staffAssistantModelMessages,
  staffAssistantModelMessagesFromPersisted,
  STAFF_ASSISTANT_CHAT_MESSAGES_MAX,
  STAFF_ASSISTANT_CHAT_MESSAGE_TEXT_MAX,
  STAFF_ASSISTANT_EMPTY_ASSISTANT_HISTORY_PLACEHOLDER,
  STAFF_ASSISTANT_MODEL_HISTORY_MAX,
} from "./messages.js";

const conversationId = "11111111-1111-4111-8111-111111111111";
const challengeId = "22222222-2222-4222-8222-222222222222";

function userMessage(text: string, id = "m1") {
  return {
    id,
    role: "user" as const,
    parts: [{ type: "text" as const, text }],
  };
}

const confirmationPart = {
  type: "data-confirmation" as const,
  data: {
    status: "confirmation_required" as const,
    challengeId,
    summary: "Delete this archived customer.",
    expiresAt: "2026-09-01T12:00:00.000Z",
    actionName: "customers.deleteCustomer",
    toolCallId: "call-delete",
  },
};

describe("staffAssistantChatBodySchema", () => {
  it("accepts a fresh body with text and messageId", () => {
    const parsed = staffAssistantChatBodySchema.safeParse({
      conversationId,
      text: "List orders",
      messageId: "m1",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.messages).toBeUndefined();
      expect(resolveStaffAssistantChatUserMessage(parsed.data)).toEqual({
        id: "m1",
        text: "List orders",
      });
    }
  });

  it("derives text and messageId from the last legacy user message", () => {
    const parsed = staffAssistantChatBodySchema.safeParse({
      conversationId,
      messages: [userMessage("List orders", "legacy-1")],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(resolveStaffAssistantChatUserMessage(parsed.data)).toEqual({
        id: "legacy-1",
        text: "List orders",
      });
    }
  });

  it("rejects incomplete or conflicting mixed representations", () => {
    expect(
      staffAssistantChatBodySchema.safeParse({
        conversationId,
        text: "List orders",
      }).success,
    ).toBe(false);
    expect(
      staffAssistantChatBodySchema.safeParse({
        conversationId,
        messageId: "m1",
      }).success,
    ).toBe(false);
    expect(
      staffAssistantChatBodySchema.safeParse({
        conversationId,
        text: "List orders",
        messageId: "m1",
        messages: [userMessage("Different text", "m1")],
      }).success,
    ).toBe(false);
    expect(
      staffAssistantChatBodySchema.safeParse({
        conversationId,
        text: "List orders",
        messageId: "m1",
        messages: [userMessage("List orders", "other-id")],
      }).success,
    ).toBe(false);
  });

  it("accepts matching mixed representations and confirmation-only messages", () => {
    expect(
      staffAssistantChatBodySchema.safeParse({
        conversationId,
        text: "List orders",
        messageId: "m1",
        messages: [userMessage("List orders", "m1")],
      }).success,
    ).toBe(true);
    expect(
      staffAssistantChatBodySchema.safeParse({
        conversationId,
        messages: [
          {
            id: "a",
            role: "assistant",
            parts: [confirmationPart],
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      staffAssistantChatBodySchema.safeParse({
        conversationId,
      }).success,
    ).toBe(true);
  });

  it("rejects a client summary field", () => {
    expect(
      staffAssistantChatBodySchema.safeParse({
        conversationId,
        messages: [userMessage("List orders")],
        summary: "Earlier they asked about orders.",
      }).success,
    ).toBe(false);
  });

  it("rejects companyId on the body", () => {
    expect(
      staffAssistantChatBodySchema.safeParse({
        conversationId,
        companyId: "22222222-2222-4222-8222-222222222222",
        messages: [userMessage("List orders")],
      }).success,
    ).toBe(false);
  });

  it("rejects more messages than the request cap", () => {
    const messages = Array.from(
      { length: STAFF_ASSISTANT_CHAT_MESSAGES_MAX + 1 },
      (_, index) => userMessage("List orders", `m${String(index)}`),
    );
    expect(
      staffAssistantChatBodySchema.safeParse({ conversationId, messages })
        .success,
    ).toBe(false);
  });

  it("rejects text longer than the append body cap", () => {
    const tooLong = "x".repeat(STAFF_ASSISTANT_CHAT_MESSAGE_TEXT_MAX + 1);
    expect(
      staffAssistantChatBodySchema.safeParse({
        conversationId,
        messages: [userMessage(tooLong)],
      }).success,
    ).toBe(false);
  });

  it("accepts text at the append body cap", () => {
    const atCap = "x".repeat(STAFF_ASSISTANT_CHAT_MESSAGE_TEXT_MAX);
    expect(
      staffAssistantChatBodySchema.safeParse({
        conversationId,
        messages: [userMessage(atCap)],
      }).success,
    ).toBe(true);
  });

  it("defaults locale to omitted (uk at the mount) and accepts uk or en", () => {
    const base = {
      conversationId,
      messages: [userMessage("List orders")],
    };
    const omitted = staffAssistantChatBodySchema.safeParse(base);
    expect(omitted.success).toBe(true);
    if (omitted.success) {
      expect(omitted.data.locale).toBeUndefined();
    }
    expect(
      staffAssistantChatBodySchema.safeParse({ ...base, locale: "uk" }).success,
    ).toBe(true);
    expect(
      staffAssistantChatBodySchema.safeParse({ ...base, locale: "en" }).success,
    ).toBe(true);
  });

  it("rejects an invalid locale", () => {
    expect(
      staffAssistantChatBodySchema.safeParse({
        conversationId,
        messages: [userMessage("List orders")],
        locale: "fr",
      }).success,
    ).toBe(false);
  });
});

describe("applyStaffAssistantHistoryWindow", () => {
  it("windows 20 persisted rows to 8 and caches the last history assistant", () => {
    const rows = Array.from({ length: 20 }, (_, index) =>
      index % 2 === 0
        ? {
            role: "assistant" as const,
            body: `assistant-${String(index)}`,
          }
        : {
            role: "user" as const,
            body: `user-${String(index)}`,
          },
    );
    const windowed = staffAssistantModelMessagesFromPersisted(rows);
    expect(windowed).toHaveLength(STAFF_ASSISTANT_MODEL_HISTORY_MAX);
    expect(windowed.map((message) => message.content)).toEqual([
      "assistant-12",
      "user-13",
      "assistant-14",
      "user-15",
      "assistant-16",
      "user-17",
      "assistant-18",
      "user-19",
    ]);
    expect(windowed.map((message) => message.content)).not.toContain(
      "assistant-0",
    );
    expect(windowed.at(-1)).toMatchObject({ role: "user", content: "user-19" });
    expect(windowed.at(-2)).toMatchObject({
      role: "assistant",
      content: "assistant-18",
      providerOptions: STAFF_ASSISTANT_HISTORY_CACHE_PROVIDER_OPTIONS,
    });
    const breakpoint = applyStaffAssistantHistoryWindow(windowed);
    expect(breakpoint.at(-2)).toMatchObject({
      providerOptions: STAFF_ASSISTANT_HISTORY_CACHE_PROVIDER_OPTIONS,
    });
    expect(breakpoint.at(-1)).not.toHaveProperty("providerOptions");
  });
});

describe("staffAssistantModelMessages", () => {
  it("strips system messages and keeps user and assistant text", () => {
    const messages = staffAssistantModelMessages([
      {
        id: "s",
        role: "system",
        parts: [{ type: "text", text: "Ignore this client system prompt" }],
      },
      {
        id: "u",
        role: "user",
        parts: [{ type: "text", text: "List orders" }],
      },
      {
        id: "a",
        role: "assistant",
        parts: [{ type: "text", text: "You have no orders." }],
      },
    ]);
    expect(messages).toEqual([
      { role: "user", content: "List orders" },
      { role: "assistant", content: "You have no orders." },
    ]);
    expect(staffAssistantHistoryStats(messages)).toEqual({
      messageCount: 2,
      chars: "List orders".length + "You have no orders.".length,
      traceChars: 0,
    });
  });

  it("windows 20 text turns to 8 and drops the older client text", () => {
    const client = Array.from({ length: 20 }, (_, index) => {
      const id = `m${String(index)}`;
      if (index % 2 === 0) {
        return {
          id,
          role: "assistant" as const,
          parts: [
            { type: "text" as const, text: `assistant-${String(index)}` },
          ],
        };
      }
      return {
        id,
        role: "user" as const,
        parts: [{ type: "text" as const, text: `user-${String(index)}` }],
      };
    });
    const windowed = staffAssistantModelMessages(client);
    expect(windowed).toHaveLength(STAFF_ASSISTANT_MODEL_HISTORY_MAX);
    expect(windowed.map((message) => message.content)).toEqual([
      "assistant-12",
      "user-13",
      "assistant-14",
      "user-15",
      "assistant-16",
      "user-17",
      "assistant-18",
      "user-19",
    ]);
    expect(windowed.map((message) => message.content)).not.toContain(
      "assistant-0",
    );
    expect(windowed.at(-1)).toMatchObject({ role: "user", content: "user-19" });
    expect(windowed.at(-2)).toMatchObject({
      role: "assistant",
      content: "assistant-18",
      providerOptions: STAFF_ASSISTANT_HISTORY_CACHE_PROVIDER_OPTIONS,
    });
  });

  it("caches the last retained assistant when the newest turn is the user", () => {
    const windowed = staffAssistantModelMessages([
      {
        id: "u0",
        role: "user",
        parts: [{ type: "text", text: "old user" }],
      },
      {
        id: "a0",
        role: "assistant",
        parts: [{ type: "text", text: "old assistant" }],
      },
      {
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "List orders" }],
      },
    ]);
    expect(windowed).toHaveLength(3);
    expect(windowed[1]).toMatchObject({
      role: "assistant",
      content: "old assistant",
      providerOptions: STAFF_ASSISTANT_HISTORY_CACHE_PROVIDER_OPTIONS,
    });
    expect(windowed[2]).toEqual({ role: "user", content: "List orders" });
    expect(windowed[2]).not.toHaveProperty("providerOptions");
    expect(staffAssistantHistoryStats(windowed).messageCount).toBe(3);
  });

  it("does not leave two consecutive user messages when the previous assistant has no text", () => {
    const windowed = staffAssistantModelMessages([
      {
        id: "u0",
        role: "user",
        parts: [{ type: "text", text: "Створи замовлення 10 макаронс" }],
      },
      {
        id: "a0",
        role: "assistant",
        parts: [],
      },
      {
        id: "u1",
        role: "user",
        parts: [
          {
            type: "text",
            text: "Створи клієнта Іван і замовлення 3 торти",
          },
        ],
      },
    ]);
    expect(windowed.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(windowed[1]).toMatchObject({
      role: "assistant",
      content: STAFF_ASSISTANT_EMPTY_ASSISTANT_HISTORY_PLACEHOLDER,
    });
    expect(windowed.filter((message) => message.role === "user")).toHaveLength(
      2,
    );
  });
});

describe("lastStaffAssistantUserMessage", () => {
  it("returns the latest non-empty user id and text", () => {
    expect(
      lastStaffAssistantUserMessage([
        {
          id: "u1",
          role: "user",
          parts: [{ type: "text", text: "first" }],
        },
        {
          id: "a",
          role: "assistant",
          parts: [{ type: "text", text: "ok" }],
        },
        {
          id: "u2",
          role: "user",
          parts: [{ type: "text", text: "Delete the customer" }],
        },
      ]),
    ).toEqual({ id: "u2", text: "Delete the customer" });
  });
});

describe("pausedToolAttemptForChallenge", () => {
  it("returns actionName and toolCallId from a matching data-confirmation part", () => {
    expect(
      pausedToolAttemptForChallenge(
        [
          userMessage("Delete the customer"),
          { id: "a", role: "assistant", parts: [confirmationPart] },
        ],
        challengeId,
      ),
    ).toEqual({
      actionName: "customers.deleteCustomer",
      toolCallId: "call-delete",
    });
  });

  it("ignores a confirmation part for a different challenge", () => {
    expect(
      pausedToolAttemptForChallenge(
        [
          {
            id: "a",
            role: "assistant",
            parts: [
              {
                type: "data-confirmation",
                data: {
                  status: "confirmation_required",
                  challengeId: "33333333-3333-4333-8333-333333333333",
                  summary: "Delete this customer group.",
                  expiresAt: "2026-09-01T12:00:00.000Z",
                  actionName: "customers.deleteGroup",
                  toolCallId: "call-group",
                },
              },
            ],
          },
        ],
        challengeId,
      ),
    ).toBeUndefined();
  });
});

describe("pausedToolAttemptFromToolRuns", () => {
  it("returns the last confirmation_required run for the challenge, including toolCallId", () => {
    expect(
      pausedToolAttemptFromToolRuns(
        [
          {
            actionName: "orders.create",
            toolCallId: "call-create",
            challengeId: null,
            outcome: "success",
          },
          {
            actionName: "customers.deleteCustomer",
            toolCallId: "call-delete",
            challengeId,
            outcome: "confirmation_required",
          },
        ],
        challengeId,
      ),
    ).toEqual({
      actionName: "customers.deleteCustomer",
      toolCallId: "call-delete",
    });
  });

  it("ignores a matching challenge on a non-paused outcome", () => {
    expect(
      pausedToolAttemptFromToolRuns(
        [
          {
            actionName: "customers.deleteCustomer",
            toolCallId: "call-delete",
            challengeId,
            outcome: "success",
          },
        ],
        challengeId,
      ),
    ).toBeUndefined();
  });
});

describe("resolvePausedToolAttempt", () => {
  const persisted = {
    actionName: "customers.deleteCustomer",
    toolCallId: "call-a",
  };
  const client = {
    actionName: "customers.deleteCustomer",
    toolCallId: "call-a",
  };

  it("uses persisted when only the tool-run exists", () => {
    expect(resolvePausedToolAttempt(persisted, undefined)).toEqual({
      status: "ok",
      attempt: persisted,
    });
  });

  it("uses the client envelope when persist has not finished", () => {
    expect(resolvePausedToolAttempt(undefined, client)).toEqual({
      status: "ok",
      attempt: client,
    });
  });

  it("uses persisted when both agree", () => {
    expect(resolvePausedToolAttempt(persisted, client)).toEqual({
      status: "ok",
      attempt: persisted,
    });
  });

  it("reports mismatch when actionName or toolCallId disagree", () => {
    expect(
      resolvePausedToolAttempt(persisted, {
        actionName: "customers.deleteCustomer",
        toolCallId: "forged",
      }),
    ).toEqual({ status: "mismatch" });
    expect(
      resolvePausedToolAttempt(persisted, {
        actionName: "customers.deleteGroup",
        toolCallId: "call-a",
      }),
    ).toEqual({ status: "mismatch" });
  });

  it("reports missing when neither source exists", () => {
    expect(resolvePausedToolAttempt(undefined, undefined)).toEqual({
      status: "missing",
    });
  });
});

describe("staffAssistantModelMessagesFromPersisted tool traces", () => {
  const listTrace = {
    kind: "page.summary",
    rows: [
      { orderNumber: "12", name: "Катя", totalGrossMinor: "120000" },
      { orderNumber: "13", name: "Леха", totalGrossMinor: "80000" },
    ],
  };
  const getTrace = { orderNumber: "12", status: "new" };

  it("emits tool-call then tool-result parts in stored order", () => {
    const messages = staffAssistantModelMessagesFromPersisted([
      { role: "user", body: "останні 2 замовлення" },
      {
        role: "assistant",
        body: "Ось вони.",
        toolRuns: [
          {
            action: "orders.list",
            toolCallId: "call_list",
            toolName: ORDERS_LIST_PAGE_TOOL_NAME,
            modelTrace: listTrace,
          },
          {
            action: "orders.get",
            toolCallId: "call_get",
            toolName: "orders_get",
            modelTrace: getTrace,
          },
        ],
      },
      { role: "user", body: "яке найдорожче?" },
    ]);
    const assistant = messages.find((message) => message.role === "assistant");
    const tool = messages.find((message) => message.role === "tool");
    expect(assistant?.content).toEqual([
      { type: "text", text: "Ось вони." },
      {
        type: "tool-call",
        toolCallId: "call_list",
        toolName: ORDERS_LIST_PAGE_TOOL_NAME,
        input: {},
      },
      {
        type: "tool-call",
        toolCallId: "call_get",
        toolName: "orders_get",
        input: {},
      },
    ]);
    expect(tool?.content).toEqual([
      {
        type: "tool-result",
        toolCallId: "call_list",
        toolName: ORDERS_LIST_PAGE_TOOL_NAME,
        output: { type: "json", value: listTrace },
      },
      {
        type: "tool-result",
        toolCallId: "call_get",
        toolName: "orders_get",
        output: { type: "json", value: getTrace },
      },
    ]);
    expect(JSON.stringify(assistant?.content)).not.toContain("orders.list");
    expect(JSON.stringify(tool?.content)).not.toContain("orders.list");
    expect(staffAssistantHistoryStats(messages).traceChars).toBeGreaterThan(0);
    expect(messages.at(-1)).toMatchObject({
      role: "user",
      content: "яке найдорожче?",
    });
    expect(messages.at(-2)?.role).toBe("tool");
    expect(messages.at(-2)).toMatchObject({
      providerOptions: STAFF_ASSISTANT_HISTORY_CACHE_PROVIDER_OPTIONS,
    });
  });

  it("reconstructs started runs without modelTrace as tool-calls from toolInput", () => {
    const toolInput = {
      customerId: "11111111-1111-4111-8111-111111111111",
      items: [
        {
          productId: "22222222-2222-4222-8222-222222222222",
          variantId: "33333333-3333-4333-8333-333333333333",
          quantityMilli: "1000",
        },
      ],
    };
    const messages = staffAssistantModelMessagesFromPersisted([
      { role: "user", body: "створи замовлення" },
      {
        role: "assistant",
        body: "",
        toolRuns: [
          {
            action: "orders.create",
            toolCallId: "call_started",
            toolName: ORDERS_CREATE_TOOL_NAME,
            toolInput,
            seq: 0,
            modelTrace: null,
            outcome: "started",
            executionId: "exec-started",
          },
        ],
      },
    ]);
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
    ]);
    expect(messages[1]?.content).toEqual([
      {
        type: "tool-call",
        toolCallId: "call_started",
        toolName: ORDERS_CREATE_TOOL_NAME,
        input: toolInput,
      },
    ]);
    expect(messages[2]?.content).toEqual([
      {
        type: "tool-result",
        toolCallId: "call_started",
        toolName: ORDERS_CREATE_TOOL_NAME,
        output: { type: "json", value: { status: "started" } },
      },
    ]);
    expect(typeof messages[1]?.content).not.toBe("string");
  });

  it("stays text-only when every modelTrace is null", () => {
    const messages = staffAssistantModelMessagesFromPersisted([
      { role: "user", body: "confirm" },
      {
        role: "assistant",
        body: "Need confirmation.",
        toolRuns: [
          {
            action: "customers.deleteCustomer",
            toolCallId: "call_hitl",
            modelTrace: null,
          },
        ],
      },
      { role: "user", body: "ok" },
    ]);
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(messages[1]).toMatchObject({
      role: "assistant",
      content: "Need confirmation.",
    });
    expect(staffAssistantHistoryStats(messages).traceChars).toBe(0);
  });

  it("keeps reconstructed tool-call/result pairs when the 8-turn window drops older text", () => {
    const rows = Array.from({ length: 12 }, (_, index) =>
      index % 2 === 0
        ? {
            role: "user" as const,
            body: `user-${String(index)}`,
          }
        : {
            role: "assistant" as const,
            body: `assistant-${String(index)}`,
            toolRuns: [
              {
                action: "orders.list",
                toolCallId: `call_${String(index)}`,
                modelTrace: { orderNumber: String(index) },
              },
            ],
          },
    );
    const windowed = staffAssistantModelMessagesFromPersisted(rows);
    const textTurns = windowed.filter(
      (message) => message.role === "user" || message.role === "assistant",
    );
    expect(textTurns).toHaveLength(STAFF_ASSISTANT_MODEL_HISTORY_MAX);
    const toolMessages = windowed.filter((message) => message.role === "tool");
    expect(toolMessages.length).toBeGreaterThan(0);
    for (const toolMessage of toolMessages) {
      if (!Array.isArray(toolMessage.content)) {
        throw new Error("expected tool-result parts");
      }
      for (const part of toolMessage.content) {
        expect(part.type).toBe("tool-result");
        if (part.type === "tool-result") {
          const matchingCall = windowed.some((message) => {
            if (
              message.role !== "assistant" ||
              !Array.isArray(message.content)
            ) {
              return false;
            }
            return message.content.some(
              (entry) =>
                entry.type === "tool-call" &&
                entry.toolCallId === part.toolCallId,
            );
          });
          expect(matchingCall).toBe(true);
        }
      }
    }
    expect(JSON.stringify(windowed)).not.toContain("user-0");
    expect(JSON.stringify(windowed)).not.toContain('"call_1"');
  });

  it("reconstructs tool-call input from persisted toolInput façade args", () => {
    const messages = staffAssistantModelMessagesFromPersisted([
      { role: "user", body: "list" },
      {
        role: "assistant",
        body: "Here.",
        toolRuns: [
          {
            action: "orders.list",
            toolCallId: "call_facade",
            toolName: ORDERS_LIST_PAGE_TOOL_NAME,
            toolInput: { kind: "page", limit: 20 },
            seq: 0,
            modelTrace: { kind: "page.summary" },
          },
        ],
      },
    ]);
    const assistant = messages.find((message) => message.role === "assistant");
    expect(assistant?.content).toEqual(
      expect.arrayContaining([
        {
          type: "tool-call",
          toolCallId: "call_facade",
          toolName: ORDERS_LIST_PAGE_TOOL_NAME,
          input: { kind: "page", limit: 20 },
        },
      ]),
    );
    expect(JSON.stringify(assistant?.content)).not.toContain('"input":{}');
  });

  it("pre-T2 rows without toolInput still reconstruct tool-call input as {}", () => {
    const messages = staffAssistantModelMessagesFromPersisted([
      { role: "user", body: "list" },
      {
        role: "assistant",
        body: "Here.",
        toolRuns: [
          {
            action: "orders.list",
            toolCallId: "call_legacy",
            toolName: ORDERS_LIST_PAGE_TOOL_NAME,
            toolInput: null,
            seq: null,
            modelTrace: { kind: "page.summary" },
          },
        ],
      },
    ]);
    const assistant = messages.find((message) => message.role === "assistant");
    expect(assistant?.content).toEqual(
      expect.arrayContaining([
        {
          type: "tool-call",
          toolCallId: "call_legacy",
          toolName: ORDERS_LIST_PAGE_TOOL_NAME,
          input: {},
        },
      ]),
    );
  });
});
