/**
 * The pin between the two halves of the chat protocol.
 *
 * `@showzy/assistant-kit` declares the window a server writes;
 * `@showzy/validation/assistant-chat` declares the window a client reads.
 * Neither may import the other — a client app cannot depend on the kit, and the
 * kit carries no knowledge of this product. `apps/api` is the only place that
 * sees both, so the agreement is proven here.
 *
 * The strong case is the first test: a window produced by a real turn, parsed
 * by the client's schema. A field the kit adds and the client does not know
 * fails on `strictObject` before it can reach a screen.
 */
import { createAssistantKit, runHostTurn } from "@showzy/assistant-kit";
import { chatWindowSchema } from "@showzy/assistant-kit";
import {
  stubModel,
  stubTextModel,
  stubToolCallStep,
  testDeps,
} from "@showzy/assistant-kit/testing";
import {
  assistantChatWindowSchema,
  assistantInteractionFromPause,
} from "@showzy/validation/assistant-chat";
import {
  assistantInteractions,
  assistantTurnMessageId,
  assistantTurnPlaceholder,
} from "@showzy/assistant-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { AssistantKitResponse } from "./assistant-kit-http.js";

const CONVERSATION = "33333333-3333-4333-8333-333333333333";
const BIND = "user-1:11111111-1111-4111-8111-1111111111aa";

const pausingInput = z.object({ label: z.string() });

/** Plain object rather than the SDK's `tool()`: no direct `ai` dependency. */
const PAUSING_TOOLS = {
  orders_create: {
    description: "create one",
    inputSchema: pausingInput,
    execute: (input: z.output<typeof pausingInput>) => ({
      kind: "pause" as const,
      interaction: "choice",
      prompt: {
        subject: input.label,
        options: [
          { optionId: "opt-a", label: "A" },
          { optionId: "opt-b", label: "B" },
        ],
        optionsTruncated: false,
      },
      secret: {
        byOption: { "opt-a": "entity-a", "opt-b": "entity-b" },
        toolName: "orders_create",
        input,
        target: { kind: "customer" as const, query: input.label },
      },
    }),
  },
};

function kit() {
  return createAssistantKit(testDeps(assistantInteractions));
}

async function turn(options: {
  readonly pausing: boolean;
}): Promise<ReturnType<typeof kit>> {
  const instance = kit();
  await runHostTurn({
    system: "you are a test",
    kit: instance,
    conversationId: CONVERSATION,
    bind: BIND,
    messageId: "55555555-5555-4555-8555-555555555555",
    model: options.pausing
      ? stubModel([
          stubToolCallStep("toolu_create", "orders_create", {
            label: "two matches",
          }),
        ])
      : stubTextModel("Готово."),
    tools: options.pausing ? PAUSING_TOOLS : {},
    messages: [{ role: "user", content: "create one" }],
  });
  return instance;
}

describe("the window a server writes and the window a client reads", () => {
  it("agrees on a settled turn", async () => {
    const instance = await turn({ pausing: false });

    const window = await instance.messages.read({
      conversationId: CONVERSATION,
      bind: BIND,
    });

    expect(chatWindowSchema.safeParse(window).success).toBe(true);
    const client = assistantChatWindowSchema.safeParse(window);
    expect(client.success).toBe(true);
    expect(client.success && client.data.openPause).toBeNull();
  });

  it("agrees on a paused turn, and the client can read the question", async () => {
    const instance = await turn({ pausing: true });

    const window = await instance.messages.read({
      conversationId: CONVERSATION,
      bind: BIND,
    });

    const client = assistantChatWindowSchema.safeParse(window);
    expect(client.success).toBe(true);
    if (!client.success) {
      return;
    }
    const open = client.data.openPause;
    expect(open).not.toBeNull();
    if (open === null) {
      return;
    }
    // The prompt survives the round trip as something renderable, and the
    // server's `secret` has no field on the wire able to carry it.
    const interaction = assistantInteractionFromPause(open);
    expect(interaction).toEqual({
      kind: "choice",
      interactionId: open.interactionId,
      revision: 1,
      subject: "two matches",
      options: [
        { optionId: "opt-a", label: "A" },
        { optionId: "opt-b", label: "B" },
      ],
      optionsTruncated: false,
    });
    expect(JSON.stringify(window)).not.toContain("byOption");
  });

  it("agrees on a window with older messages behind it, and carries no owner", async () => {
    const instance = createAssistantKit(
      testDeps(assistantInteractions, { windowMessages: 1 }),
    );
    const scope = { conversationId: CONVERSATION, bind: BIND };
    for (const messageId of [
      "55555555-5555-4555-8555-555555555551",
      "55555555-5555-4555-8555-555555555552",
    ]) {
      await instance.messages.write(scope, {
        kind: "append",
        messageId,
        role: "user",
        parts: [{ kind: "text", text: "привіт", status: "complete" }],
      });
    }

    const window = await instance.messages.read(scope);

    expect(window.olderCursor).not.toBeNull();
    // Whose conversation it is stays on the server: the client never needed it.
    expect(window).not.toHaveProperty("bind");
    expect(chatWindowSchema.safeParse(window).success).toBe(true);
    expect(assistantChatWindowSchema.safeParse(window).success).toBe(true);
  });

  /**
   * An accepted turn answers with a window that ends in this placeholder
   * (ADR-0039), so a client must read it before any worker has written to it.
   */
  it("agrees on an accepted turn's placeholder, with and without an earned card", () => {
    const commandId = "66666666-6666-4666-8666-666666666666";
    const placeholders = [
      assistantTurnPlaceholder({
        messageId: assistantTurnMessageId(
          { kind: "chat", commandId },
          "assistant",
        ),
        createdAt: "2026-09-11T10:00:00.000Z",
      }),
      assistantTurnPlaceholder({
        messageId: assistantTurnMessageId(
          { kind: "answer", commandId },
          "assistant",
        ),
        createdAt: "2026-09-11T10:00:00.000Z",
        earned: [
          {
            kind: "card",
            cardId: "order:1",
            revision: 1,
            type: "orders-order",
            payload: { orderId: "77777777-7777-4777-8777-777777777777" },
          },
        ],
      }),
    ];

    for (const placeholder of placeholders) {
      // A read returns the stored message with the store's revision beside it.
      const window = {
        conversationId: CONVERSATION,
        messages: [{ ...placeholder, revision: 1 }],
        olderCursor: null,
        openPause: null,
      };
      expect(chatWindowSchema.safeParse(window).success).toBe(true);
      expect(assistantChatWindowSchema.safeParse(window).success).toBe(true);
    }
  });

  /**
   * A turn stopped from outside — its worker gone, its deadline passed — ends
   * with an `interrupted` text part (ADR-0039). Both sides read it: the kit
   * does not skip it as unreadable, and the client does not drop the message.
   */
  it("agrees on a reply that was interrupted", async () => {
    const instance = kit();
    const scope = { conversationId: CONVERSATION, bind: BIND };
    await instance.messages.write(scope, {
      kind: "append",
      messageId: "55555555-5555-4555-8555-555555555555",
      role: "assistant",
      parts: [
        {
          kind: "card",
          cardId: "order:1",
          type: "orders-order",
          payload: { orderId: "77777777-7777-4777-8777-777777777777" },
          revision: 1,
        },
        { kind: "text", text: "", status: "interrupted" },
      ],
    });

    const window = await instance.messages.read(scope);

    expect(window.messages).toHaveLength(1);
    expect(chatWindowSchema.safeParse(window).success).toBe(true);
    const client = assistantChatWindowSchema.safeParse(window);
    expect(client.success).toBe(true);
    expect(
      client.success &&
        client.data.messages[0]?.parts.map((part) =>
          part.kind === "text" ? part.status : part.kind,
        ),
    ).toEqual(["card", "interrupted"]);
  });

  /**
   * The body an accepted turn answers with (SHO-563). `accepted` is a member of
   * the response union at compile time — a route cannot answer it without the
   * union saying so — and the window it carries is the one both sides read.
   */
  it("agrees on the body an accepted turn answers with", () => {
    const commandId = "66666666-6666-4666-8666-666666666666";
    const window = {
      conversationId: CONVERSATION,
      messages: [
        {
          ...assistantTurnPlaceholder({
            messageId: assistantTurnMessageId(
              { kind: "chat", commandId },
              "assistant",
            ),
            createdAt: "2026-09-11T10:00:00.000Z",
          }),
          revision: 1,
        },
      ],
      olderCursor: null,
      openPause: null,
    };
    const body: AssistantKitResponse = { status: "accepted", window };

    expect(body.status).toBe("accepted");
    expect(chatWindowSchema.safeParse(window).success).toBe(true);
    expect(assistantChatWindowSchema.safeParse(window).success).toBe(true);
  });

  it("refuses a field one side would add without the other", () => {
    const window = {
      conversationId: CONVERSATION,
      messages: [],
      olderCursor: null,
      openPause: null,
      // A field a future kit might start writing.
      lastReadAt: "2026-09-09T00:00:00.000Z",
    };

    expect(chatWindowSchema.safeParse(window).success).toBe(false);
    expect(assistantChatWindowSchema.safeParse(window).success).toBe(false);
  });
});
