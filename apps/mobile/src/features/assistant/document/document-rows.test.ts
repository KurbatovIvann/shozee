/**
 * What the thread renders from a stored conversation.
 *
 * The cases worth pinning are the ones the old path got wrong: a question that
 * has been answered must leave nothing tappable, a card must appear once, and a
 * failed turn must be distinguishable from a silent one.
 */
import type {
  AssistantChatDocument,
  AssistantChatMessage,
  AssistantChatPart,
  AssistantPause,
} from "@showzy/validation/assistant-chat";
import { describe, expect, it } from "vitest";

import {
  ASSISTANT_ORPHAN_INTERACTION_ROW_ID,
  ASSISTANT_PENDING_USER_ROW_ID,
  ASSISTANT_WAITING_ROW_ID,
  assistantDocumentRows,
} from "./document-rows";

const CONVERSATION = "33333333-3333-4333-8333-333333333333";
const USER_MESSAGE = "11111111-1111-4111-8111-111111111111";
const REPLY_MESSAGE = "22222222-2222-4222-8222-222222222222";
const INTERACTION = "44444444-4444-4444-8444-444444444444";

function textPart(text: string): AssistantChatPart {
  return { kind: "text", text, status: "complete" };
}

function message(
  messageId: string,
  role: "user" | "assistant",
  parts: readonly AssistantChatPart[],
): AssistantChatMessage {
  return {
    messageId,
    role,
    createdAt: "2026-09-09T10:00:00.000Z",
    parts: [...parts],
  };
}

function choicePause(overrides?: Partial<AssistantPause>): AssistantPause {
  return {
    kind: "choice",
    interactionId: INTERACTION,
    revision: 1,
    status: "open",
    prompt: {
      subject: "Катя",
      options: [
        { optionId: "opt-a", label: "Катя Самбука" },
        { optionId: "opt-b", label: "Катя Іванова" },
      ],
      optionsTruncated: false,
    },
    expiresAt: "2026-09-09T10:15:00.000Z",
    ...overrides,
  };
}

function document(
  messages: readonly AssistantChatMessage[],
  openPause: AssistantPause | null = null,
): AssistantChatDocument {
  return {
    conversationId: CONVERSATION,
    bind: "user-1:company-1",
    messages: [...messages],
    openPause,
  };
}

function rows(
  input: AssistantChatDocument,
  waiting = false,
): ReturnType<typeof assistantDocumentRows> {
  return assistantDocumentRows({ document: input, locale: "uk", waiting });
}

const ORDER_CARD: AssistantChatPart = {
  kind: "card",
  cardId: "order-entity:order-1",
  revision: 1,
  type: "order-entity",
  payload: {
    kind: "order-entity",
    destination: { kind: "screen", href: "/orders/order-1" },
    orderId: "order-1",
    orderNumber: "CO-1",
    customerNameSnapshot: "Катя Самбука",
    status: "new",
    total: { amountMinor: "50000", currency: "UAH" },
  },
};

describe("assistantDocumentRows", () => {
  it("renders the person's words and the reply in order", () => {
    const result = rows(
      document([
        message(USER_MESSAGE, "user", [textPart("Скільки замовлень?")]),
        message(REPLY_MESSAGE, "assistant", [textPart("Три.")]),
      ]),
    );

    expect(result.map((row) => [row.role, row.text])).toEqual([
      ["user", "Скільки замовлень?"],
      ["assistant", "Три."],
    ]);
    expect(result.every((row) => row.interaction === null)).toBe(true);
  });

  it("attaches an open question to the message that asked it", () => {
    const pause = choicePause();
    const result = rows(
      document(
        [
          message(USER_MESSAGE, "user", [textPart("Замовлення для Каті")]),
          message(REPLY_MESSAGE, "assistant", [
            textPart("Яку Катю?"),
            {
              kind: "interaction",
              interactionId: INTERACTION,
              revision: 1,
              pause,
            },
          ]),
        ],
        pause,
      ),
    );

    expect(result).toHaveLength(2);
    expect(result[1]?.interaction).toEqual({
      kind: "choice",
      interactionId: INTERACTION,
      revision: 1,
      subject: "Катя",
      options: [
        { optionId: "opt-a", label: "Катя Самбука" },
        { optionId: "opt-b", label: "Катя Іванова" },
      ],
      optionsTruncated: false,
    });
  });

  /**
   * The defect the old path spent six commits on: an answered question kept
   * reappearing, so the client had to remember every id it had already dealt
   * with. Here the record of the question stays in the message and nothing is
   * answerable, with no local memory involved.
   */
  it("leaves nothing tappable once the question is answered", () => {
    const asked = choicePause();
    const result = rows(
      document(
        [
          message(REPLY_MESSAGE, "assistant", [
            textPart("Яку Катю?"),
            {
              kind: "interaction",
              interactionId: INTERACTION,
              revision: 1,
              pause: asked,
            },
          ]),
          message(USER_MESSAGE, "assistant", [textPart("Готово."), ORDER_CARD]),
        ],
        null,
      ),
    );

    expect(result.every((row) => row.interaction === null)).toBe(true);
    expect(result[1]?.surfaces).toHaveLength(1);
  });

  it("gives an open question its own row when its message is gone", () => {
    const pause = choicePause();
    const result = rows(document([], pause));

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe(ASSISTANT_ORPHAN_INTERACTION_ROW_ID);
    expect(result[0]?.interaction?.kind).toBe("choice");
  });

  it("reads a confirmation as a confirmation", () => {
    const pause: AssistantPause = {
      kind: "confirmation",
      interactionId: INTERACTION,
      revision: 2,
      status: "open",
      prompt: { summary: "Створити замовлення на 500 ₴?" },
      expiresAt: "2026-09-09T10:05:00.000Z",
    };
    const result = rows(document([], pause));

    expect(result[0]?.interaction).toEqual({
      kind: "confirmation",
      interactionId: INTERACTION,
      revision: 2,
      summary: "Створити замовлення на 500 ₴?",
    });
  });

  it("renders nothing for a kind or a prompt it cannot read", () => {
    const unknownKind = rows(
      document([], choicePause({ kind: "signature-request" })),
    );
    const brokenPrompt = rows(
      document([], choicePause({ prompt: { subject: "Катя" } })),
    );

    expect(unknownKind).toEqual([]);
    expect(brokenPrompt).toEqual([]);
  });

  it("localizes a stored card without re-deriving it from tool parts", () => {
    const result = rows(
      document([message(REPLY_MESSAGE, "assistant", [ORDER_CARD])]),
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.surfaces.map((surface) => surface.kind)).toEqual([
      "order-entity",
    ]);
  });

  /**
   * Three omissions are guaranteed: a `type` outside the registry, a payload
   * whose own `kind` disagrees with it, and a payload that makes localization
   * throw. A payload that is malformed but localizes without throwing is *not*
   * caught — `AssistantSurfaceData` has no schema to check it against. Named
   * here so the guarantee is not read as more than it is.
   */
  it("omits a card it cannot render, and keeps the rest of the message", () => {
    const result = rows(
      document([
        message(REPLY_MESSAGE, "assistant", [
          textPart("Ось."),
          { ...ORDER_CARD, cardId: "a", type: "future-surface" },
          { ...ORDER_CARD, cardId: "b", payload: { kind: "orders-list" } },
          { ...ORDER_CARD, cardId: "c", payload: { kind: "order-entity" } },
        ]),
      ]),
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.surfaces).toEqual([]);
    expect(result[0]?.text).toBe("Ось.");
  });

  it("marks a failed turn instead of dropping it", () => {
    const result = rows(
      document([
        message(USER_MESSAGE, "user", [textPart("Порахуй")]),
        message(REPLY_MESSAGE, "assistant", [
          { kind: "text", text: "", status: "error" },
        ]),
      ]),
    );

    expect(result).toHaveLength(2);
    expect(result[1]?.failed).toBe(true);
    expect(result[1]?.text).toBe("");
  });

  it("drops a message with nothing in it", () => {
    const result = rows(
      document([
        message(USER_MESSAGE, "user", [textPart("")]),
        message(REPLY_MESSAGE, "assistant", [textPart("Так.")]),
      ]),
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.role).toBe("assistant");
  });

  it("echoes a message that has been sent but not yet stored", () => {
    const result = assistantDocumentRows({
      document: document([
        message(REPLY_MESSAGE, "assistant", [textPart("Готово.")]),
      ]),
      locale: "uk",
      waiting: true,
      pending: "Ще одне замовлення",
    });

    // The person's own words first, then the wait — the order they happened in.
    expect(result.map((row) => [row.role, row.text])).toEqual([
      ["assistant", "Готово."],
      ["user", "Ще одне замовлення"],
      ["assistant", ""],
    ]);
    expect(result[1]?.id).toBe(ASSISTANT_PENDING_USER_ROW_ID);
    expect(result[2]?.waiting).toBe(true);
  });

  it("shows nothing extra once the document carries the message", () => {
    const result = assistantDocumentRows({
      document: document([
        message(USER_MESSAGE, "user", [textPart("Ще одне замовлення")]),
        message(REPLY_MESSAGE, "assistant", [textPart("Готово.")]),
      ]),
      locale: "uk",
      waiting: false,
      pending: null,
    });

    expect(result.map((row) => row.text)).toEqual([
      "Ще одне замовлення",
      "Готово.",
    ]);
  });

  it("adds one trailing row while a request is in flight, hiding nothing", () => {
    const result = rows(
      document([
        message(USER_MESSAGE, "user", [textPart("Ще одне")]),
        message(REPLY_MESSAGE, "assistant", [textPart("Готово.")]),
      ]),
      true,
    );

    expect(result).toHaveLength(3);
    expect(result[1]?.text).toBe("Готово.");
    expect(result[2]).toMatchObject({
      id: ASSISTANT_WAITING_ROW_ID,
      waiting: true,
    });
  });

  it("never puts a surface on a user row", () => {
    const result = rows(
      document([message(USER_MESSAGE, "user", [textPart("Ось"), ORDER_CARD])]),
    );

    expect(result[0]?.surfaces).toEqual([]);
  });
});
