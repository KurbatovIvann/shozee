/**
 * The pin between the event stream's client schemas and what the server holds
 * (SHO-562).
 *
 * `@showzy/validation/assistant-events` is client-safe, so it cannot import the
 * owned schema or the queue contract; it declares a turn's kind and final status
 * again. `apps/api` sees all three, so the agreement is proven here — one value
 * added on the server side fails this test rather than a phone.
 */
import { createAssistantKit } from "@showzy/assistant-kit";
import { testDeps } from "@showzy/assistant-kit/testing";
import {
  assistantInteractions,
  assistantTurnKindSchema,
} from "@showzy/assistant-runtime";
import {
  ASSISTANT_TURN_FINAL_STATUSES,
  ASSISTANT_TURN_KINDS,
} from "@showzy/db/schema/assistant";
import {
  assistantMessageUpdatedEventSchema,
  assistantSnapshotEventSchema,
  assistantStreamTurnKindSchema,
  assistantStreamTurnStatusSchema,
} from "@showzy/validation/assistant-events";
import { describe, expect, it } from "vitest";

const CONVERSATION = "33333333-3333-4333-8333-333333333333";
const MESSAGE = "55555555-5555-4555-8555-555555555555";
const BIND = "user-1:11111111-1111-4111-8111-1111111111aa";

describe("assistant event wire", () => {
  it("names the same turn kinds as the turn row and the queue contract", () => {
    expect([...assistantStreamTurnKindSchema.options].sort()).toEqual(
      [...ASSISTANT_TURN_KINDS].sort(),
    );
    expect([...assistantStreamTurnKindSchema.options].sort()).toEqual(
      [...assistantTurnKindSchema.options].sort(),
    );
  });

  it("names the same final statuses as the turn row", () => {
    expect([...assistantStreamTurnStatusSchema.options].sort()).toEqual(
      [...ASSISTANT_TURN_FINAL_STATUSES].sort(),
    );
  });

  it("reads a window the kit wrote, with the revision of a message it updated, as a snapshot and as message.updated", async () => {
    const kit = createAssistantKit(testDeps(assistantInteractions));
    const scope = { conversationId: CONVERSATION, bind: BIND };
    await kit.messages.write(scope, {
      kind: "append",
      messageId: MESSAGE,
      role: "assistant",
      parts: [{ kind: "text", text: "Шукаю", status: "streaming" }],
    });
    await kit.messages.write(scope, {
      kind: "append",
      messageId: MESSAGE,
      role: "assistant",
      parts: [{ kind: "text", text: "Готово.", status: "complete" }],
    });

    const window = await kit.messages.read(scope);
    const latest = window.messages.at(-1);

    expect(latest?.revision).toBe(2);
    expect(
      assistantSnapshotEventSchema.safeParse({ type: "snapshot", window })
        .success,
    ).toBe(true);
    expect(
      assistantMessageUpdatedEventSchema.safeParse({
        type: "message.updated",
        conversationId: CONVERSATION,
        message: latest,
      }).success,
    ).toBe(true);
  });
});
