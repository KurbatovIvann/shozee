/**
 * SCENARIOS.md 16-18 — live and reload are the same bytes.
 *
 * The document is written when a part settles and read back as stored. It is
 * not recomposed later from prompt state, which is how one turn could show a
 * card live and a different set after reload.
 */
import { describe, expect, it } from "vitest";

import type { DocumentPart } from "./document.js";
import { createAssistantKit, type AssistantKit } from "./kit.js";
import { testDeps, type TestDeps } from "./testing.js";

const CONVERSATION = "11111111-1111-4111-8111-111111111111";
const BIND = "actor-1:tenant-1";
const MESSAGE = "33333333-3333-4333-8333-333333333333";

function newKit(): { kit: AssistantKit; deps: TestDeps } {
  const deps = testDeps();
  return { kit: createAssistantKit(deps), deps };
}

const TEXT: DocumentPart = { kind: "text", text: "here it is", status: "complete" };

function card(revision: number, rows: number): DocumentPart {
  return {
    kind: "surface",
    cardId: "card-1",
    revision,
    surface: "collection",
    payload: { rows },
  };
}

describe("scenario 16 - reload returns what live wrote", () => {
  it("keeps the parts and their order", async () => {
    const { kit } = newKit();
    const parts = [TEXT, card(1, 3)];

    await kit.document.write(CONVERSATION, {
      kind: "append",
      messageId: MESSAGE,
      role: "assistant",
      parts,
    });
    const document = await kit.document.read({ conversationId: CONVERSATION, bind: BIND });

    const message = document.messages.find((m) => m.messageId === MESSAGE);
    expect(message?.parts).toEqual(parts);
    expect(JSON.stringify(message?.parts)).toBe(JSON.stringify(parts));
  });
});

describe("scenario 17 - a card updates in place", () => {
  it("replaces by cardId instead of appending a second card", async () => {
    const { kit } = newKit();

    await kit.document.write(CONVERSATION, {
      kind: "append",
      messageId: MESSAGE,
      role: "assistant",
      parts: [card(1, 3)],
    });
    await kit.document.write(CONVERSATION, {
      kind: "replace_card",
      messageId: MESSAGE,
      part: card(2, 9) as Extract<DocumentPart, { kind: "surface" }>,
    });

    const document = await kit.document.read({ conversationId: CONVERSATION, bind: BIND });
    const surfaces = document.messages
      .flatMap((message) => message.parts)
      .filter((part) => part.kind === "surface");

    expect(surfaces).toHaveLength(1);
    expect(surfaces[0]?.revision).toBe(2);
    expect(surfaces[0]?.payload).toEqual({ rows: 9 });
  });
});

describe("scenario 18 - partial text is never presented as the answer", () => {
  it("settles a streaming part to complete", async () => {
    const { kit } = newKit();
    const streaming: DocumentPart = {
      kind: "text",
      text: "here",
      status: "streaming",
    };

    await kit.document.write(CONVERSATION, {
      kind: "append",
      messageId: MESSAGE,
      role: "assistant",
      parts: [streaming],
    });
    await kit.document.write(CONVERSATION, {
      kind: "append",
      messageId: MESSAGE,
      role: "assistant",
      parts: [TEXT],
    });

    const document = await kit.document.read({ conversationId: CONVERSATION, bind: BIND });
    const texts = document.messages
      .flatMap((message) => message.parts)
      .filter((part) => part.kind === "text");

    expect(texts.at(-1)?.status).toBe("complete");
  });

  it("keeps a settled card when the text part ends in error", async () => {
    const { kit } = newKit();
    const failed: DocumentPart = { kind: "text", text: "", status: "error" };

    await kit.document.write(CONVERSATION, {
      kind: "append",
      messageId: MESSAGE,
      role: "assistant",
      parts: [card(1, 3), failed],
    });

    const document = await kit.document.read({ conversationId: CONVERSATION, bind: BIND });
    const parts = document.messages.flatMap((message) => message.parts);

    expect(parts.filter((part) => part.kind === "surface")).toHaveLength(1);
    expect(parts.filter((part) => part.kind === "text").at(-1)?.status).toBe(
      "error",
    );
  });
});
