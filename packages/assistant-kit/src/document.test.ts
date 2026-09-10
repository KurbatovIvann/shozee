/**
 * The document: live and a reload are the same bytes.
 *
 * Parts are stored when they settle, not re-derived later from prompt state.
 * Two renderers reading two derivations is how one turn can show one card live
 * and a different set afterwards, and how the same record can appear twice.
 */
import { describe, expect, it } from "vitest";

import type { DocumentPart } from "./document.js";
import { fixtureInteractions } from "./fixture.js";
import { createAssistantKit } from "./kit.js";
import { testDeps } from "./testing.js";

const CONVERSATION = "11111111-1111-4111-8111-111111111111";
const BIND = "owner-1:scope-1";
const MESSAGE = "33333333-3333-4333-8333-333333333333";
const SCOPE = { conversationId: CONVERSATION, bind: BIND };

function newKit() {
  return createAssistantKit(testDeps(fixtureInteractions));
}

const TEXT: DocumentPart = {
  kind: "text",
  text: "here it is",
  status: "complete",
};

function card(
  revision: number,
  rows: number,
): Extract<DocumentPart, { kind: "card" }> {
  return {
    kind: "card",
    cardId: "card-1",
    revision,
    type: "collection",
    payload: { rows },
  };
}

describe("a reload returns what the live turn wrote", () => {
  it("keeps the parts and their order", async () => {
    const kit = newKit();
    const parts = [TEXT, card(1, 3)];

    await kit.document.write(SCOPE, {
      kind: "append",
      messageId: MESSAGE,
      role: "assistant",
      parts,
    });
    const document = await kit.document.read(SCOPE);

    const message = document.messages.find((m) => m.messageId === MESSAGE);
    expect(message?.parts).toEqual(parts);
    expect(JSON.stringify(message?.parts)).toBe(JSON.stringify(parts));
  });
});

/**
 * SHO-551. The rule is the writer's, so no producer has to remember it: the
 * previous design made it a second write kind, and nothing ever chose it.
 */
describe("a card updates in place", () => {
  it("replaces by cardId in a later write instead of appending a second card", async () => {
    const kit = newKit();

    await kit.document.write(SCOPE, {
      kind: "append",
      messageId: MESSAGE,
      role: "assistant",
      parts: [card(1, 3), TEXT],
    });
    await kit.document.write(SCOPE, {
      kind: "append",
      messageId: MESSAGE,
      role: "assistant",
      parts: [card(1, 9)],
    });

    const document = await kit.document.read(SCOPE);
    const parts = document.messages.flatMap((message) => message.parts);
    const cards = parts.filter((part) => part.kind === "card");

    expect(cards).toHaveLength(1);
    expect(cards[0]?.revision).toBe(2);
    expect(cards[0]?.payload).toEqual({ rows: 9 });
    // Where it was first shown, not moved below the text that followed it.
    expect(parts.map((part) => part.kind)).toEqual(["card", "text"]);
  });

  it("collapses the same cardId twice in one write", async () => {
    const kit = newKit();

    await kit.document.write(SCOPE, {
      kind: "append",
      messageId: MESSAGE,
      role: "assistant",
      parts: [card(1, 3), TEXT, card(1, 9)],
    });

    const parts = (await kit.document.read(SCOPE)).messages.flatMap(
      (message) => message.parts,
    );

    expect(parts.map((part) => part.kind)).toEqual(["card", "text"]);
    expect(parts.find((part) => part.kind === "card")).toMatchObject({
      revision: 2,
      payload: { rows: 9 },
    });
  });

  it("leaves a card with the same id in another message alone", async () => {
    const kit = newKit();
    const later = "66666666-6666-4666-8666-666666666666";

    await kit.document.write(SCOPE, {
      kind: "append",
      messageId: MESSAGE,
      role: "assistant",
      parts: [card(1, 3)],
    });
    await kit.document.write(SCOPE, {
      kind: "append",
      messageId: later,
      role: "assistant",
      parts: [card(1, 9)],
    });

    const document = await kit.document.read(SCOPE);

    // A list shown in an earlier turn stays as it was shown then.
    expect(
      document.messages.map((message) =>
        message.parts.map((part) =>
          part.kind === "card" ? [part.revision, part.payload] : part.kind,
        ),
      ),
    ).toEqual([[[1, { rows: 3 }]], [[1, { rows: 9 }]]]);
  });
});

describe("partial text is never presented as the answer", () => {
  it("settles a streaming part to complete", async () => {
    const kit = newKit();
    const streaming: DocumentPart = {
      kind: "text",
      text: "here",
      status: "streaming",
    };

    await kit.document.write(SCOPE, {
      kind: "append",
      messageId: MESSAGE,
      role: "assistant",
      parts: [streaming],
    });
    await kit.document.write(SCOPE, {
      kind: "append",
      messageId: MESSAGE,
      role: "assistant",
      parts: [TEXT],
    });

    const document = await kit.document.read(SCOPE);
    const texts = document.messages
      .flatMap((message) => message.parts)
      .filter((part) => part.kind === "text");

    expect(texts.at(-1)?.status).toBe("complete");
  });

  it("keeps a settled card when the text part ends in error", async () => {
    const kit = newKit();
    const failed: DocumentPart = { kind: "text", text: "", status: "error" };

    await kit.document.write(SCOPE, {
      kind: "append",
      messageId: MESSAGE,
      role: "assistant",
      parts: [card(1, 3), failed],
    });

    const document = await kit.document.read(SCOPE);
    const parts = document.messages.flatMap((message) => message.parts);

    expect(parts.filter((part) => part.kind === "card")).toHaveLength(1);
    expect(parts.filter((part) => part.kind === "text").at(-1)?.status).toBe(
      "error",
    );
  });
});

describe("a document belongs to one owner", () => {
  const OTHER = { conversationId: CONVERSATION, bind: "owner-2:scope-2" };

  it("reads as empty for anyone else — the same as a conversation that does not exist", async () => {
    const kit = newKit();
    await kit.document.write(SCOPE, {
      kind: "append",
      messageId: MESSAGE,
      role: "assistant",
      parts: [TEXT],
    });

    const foreign = await kit.document.read(OTHER);
    const fresh = await kit.document.read({
      conversationId: "99999999-9999-4999-8999-999999999999",
      bind: BIND,
    });

    expect(foreign.messages).toEqual([]);
    expect(foreign.messages).toEqual(fresh.messages);
    // A conversation id is not a secret, so the two must be indistinguishable.
    expect(JSON.stringify(foreign.messages)).toBe(
      JSON.stringify(fresh.messages),
    );
  });

  it("refuses a write from anyone else instead of appending to it", async () => {
    const kit = newKit();
    await kit.document.write(SCOPE, {
      kind: "append",
      messageId: MESSAGE,
      role: "assistant",
      parts: [TEXT],
    });

    const refused = await kit.document.write(OTHER, {
      kind: "append",
      messageId: "88888888-8888-4888-8888-888888888888",
      role: "assistant",
      parts: [{ kind: "text", text: "not yours", status: "complete" }],
    });

    expect(refused.kind).toBe("wrong_owner");
    const owner = await kit.document.read(SCOPE);
    expect(owner.messages).toHaveLength(1);
    expect(JSON.stringify(owner)).not.toContain("not yours");
  });
});
