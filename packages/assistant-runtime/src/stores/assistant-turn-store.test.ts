import { chatMessageSchema } from "@showzy/assistant-kit";
import { ASSISTANT_TURN_KINDS } from "@showzy/db/schema/assistant";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { assistantTurnKindSchema } from "../queue.js";
import {
  assistantBudgetHoldFromStored,
  assistantBudgetHoldToStored,
  assistantTurnMessageId,
  assistantTurnPlaceholder,
} from "./assistant-turn-store.js";

const COMMAND = "0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0";

describe("a turn's message ids", () => {
  /**
   * The person's message id comes from the command, never from a random
   * source: a repeated command must name the message it already stored.
   */
  it("are the same for the same command in any casing", () => {
    const chat = { kind: "chat" as const, commandId: COMMAND };
    const shouted = { kind: "chat" as const, commandId: COMMAND.toUpperCase() };

    expect(assistantTurnMessageId(chat, "user")).toBe(
      assistantTurnMessageId(shouted, "user"),
    );
    expect(assistantTurnMessageId(chat, "assistant")).toBe(
      assistantTurnMessageId(shouted, "assistant"),
    );
  });

  it("never share an id between a turn's two messages, or a send and an answer", () => {
    const ids = [
      assistantTurnMessageId({ kind: "chat", commandId: COMMAND }, "user"),
      assistantTurnMessageId({ kind: "chat", commandId: COMMAND }, "assistant"),
      assistantTurnMessageId(
        { kind: "answer", commandId: COMMAND },
        "assistant",
      ),
    ];

    expect(new Set(ids).size).toBe(3);
  });

  it("are lowercase uuids the message schema accepts", () => {
    const id = assistantTurnMessageId(
      { kind: "chat", commandId: COMMAND },
      "user",
    );

    expect(z.uuid().safeParse(id).success).toBe(true);
    expect(id).toBe(id.toLowerCase());
    expect(id[14]).toBe("8");
  });
});

describe("the placeholder", () => {
  it("is an assistant message whose text is still streaming, after what was earned", () => {
    const messageId = assistantTurnMessageId(
      { kind: "answer", commandId: COMMAND },
      "assistant",
    );
    const card = {
      kind: "card" as const,
      cardId: "order:1",
      revision: 1,
      type: "order",
      payload: { orderId: "1" },
    };

    const placeholder = assistantTurnPlaceholder({
      messageId,
      createdAt: "2026-09-11T10:00:00.000Z",
      earned: [card],
    });

    expect(chatMessageSchema.parse(placeholder)).toEqual(placeholder);
    expect(placeholder.parts).toEqual([
      card,
      { kind: "text", text: "", status: "streaming" },
    ]);
  });
});

describe("a stored budget hold", () => {
  it("gives back the reservation it was given", () => {
    const hold = {
      companyReservedUsd: 0.1,
      globalReservedUsd: 0.000_123,
      kyivDate: "2026-09-11",
    };

    const stored = assistantBudgetHoldToStored(hold);

    expect(stored).toEqual({
      companyReservedMicroUsd: 100_000,
      globalReservedMicroUsd: 123,
      kyivDate: "2026-09-11",
    });
    expect(assistantBudgetHoldFromStored(stored)).toEqual(hold);
  });
});

describe("the turn kind", () => {
  /**
   * The job id is derived from the stored kind. The queue's list and the
   * table's CHECK are two spellings of one fact, so they are pinned together.
   */
  it("is the same list on the queue and in the turn table", () => {
    expect(assistantTurnKindSchema.options).toEqual([...ASSISTANT_TURN_KINDS]);
  });
});
