/**
 * The messages: live and a reload are the same bytes.
 *
 * Parts are stored when they settle, not re-derived later from prompt state.
 * Two renderers reading two derivations is how one turn can show one card live
 * and a different set afterwards, and how the same record can appear twice.
 */
import { describe, expect, it } from "vitest";

import type { ChatWindow, ChatPart } from "./messages.js";
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

const TEXT: ChatPart = {
  kind: "text",
  text: "here it is",
  status: "complete",
};

function card(
  revision: number,
  rows: number,
): Extract<ChatPart, { kind: "card" }> {
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

    await kit.messages.write(SCOPE, {
      kind: "append",
      messageId: MESSAGE,
      role: "assistant",
      parts,
    });
    const window = await kit.messages.read(SCOPE);

    const message = window.messages.find((m) => m.messageId === MESSAGE);
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

    await kit.messages.write(SCOPE, {
      kind: "append",
      messageId: MESSAGE,
      role: "assistant",
      parts: [card(1, 3), TEXT],
    });
    await kit.messages.write(SCOPE, {
      kind: "append",
      messageId: MESSAGE,
      role: "assistant",
      parts: [card(1, 9)],
    });

    const window = await kit.messages.read(SCOPE);
    const parts = window.messages.flatMap((message) => message.parts);
    const cards = parts.filter((part) => part.kind === "card");

    expect(cards).toHaveLength(1);
    expect(cards[0]?.revision).toBe(2);
    expect(cards[0]?.payload).toEqual({ rows: 9 });
    // Where it was first shown, not moved below the text that followed it.
    expect(parts.map((part) => part.kind)).toEqual(["card", "text"]);
  });

  it("collapses the same cardId twice in one write", async () => {
    const kit = newKit();

    await kit.messages.write(SCOPE, {
      kind: "append",
      messageId: MESSAGE,
      role: "assistant",
      parts: [card(1, 3), TEXT, card(1, 9)],
    });

    const parts = (await kit.messages.read(SCOPE)).messages.flatMap(
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

    await kit.messages.write(SCOPE, {
      kind: "append",
      messageId: MESSAGE,
      role: "assistant",
      parts: [card(1, 3)],
    });
    await kit.messages.write(SCOPE, {
      kind: "append",
      messageId: later,
      role: "assistant",
      parts: [card(1, 9)],
    });

    const window = await kit.messages.read(SCOPE);

    // A list shown in an earlier turn stays as it was shown then.
    expect(
      window.messages.map((message) =>
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
    const streaming: ChatPart = {
      kind: "text",
      text: "here",
      status: "streaming",
    };

    await kit.messages.write(SCOPE, {
      kind: "append",
      messageId: MESSAGE,
      role: "assistant",
      parts: [streaming],
    });
    await kit.messages.write(SCOPE, {
      kind: "append",
      messageId: MESSAGE,
      role: "assistant",
      parts: [TEXT],
    });

    const window = await kit.messages.read(SCOPE);
    const texts = window.messages
      .flatMap((message) => message.parts)
      .filter((part) => part.kind === "text");

    expect(texts.at(-1)?.status).toBe("complete");
  });

  it("keeps a settled card when the text part ends in error", async () => {
    const kit = newKit();
    const failed: ChatPart = { kind: "text", text: "", status: "error" };

    await kit.messages.write(SCOPE, {
      kind: "append",
      messageId: MESSAGE,
      role: "assistant",
      parts: [card(1, 3), failed],
    });

    const window = await kit.messages.read(SCOPE);
    const parts = window.messages.flatMap((message) => message.parts);

    expect(parts.filter((part) => part.kind === "card")).toHaveLength(1);
    expect(parts.filter((part) => part.kind === "text").at(-1)?.status).toBe(
      "error",
    );
  });
});

describe("a conversation belongs to one owner", () => {
  const OTHER = { conversationId: CONVERSATION, bind: "owner-2:scope-2" };

  it("reads as empty for anyone else — the same as a conversation that does not exist", async () => {
    const kit = newKit();
    await kit.messages.write(SCOPE, {
      kind: "append",
      messageId: MESSAGE,
      role: "assistant",
      parts: [TEXT],
    });

    const foreign = await kit.messages.read(OTHER);
    const fresh = await kit.messages.read({
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
    await kit.messages.write(SCOPE, {
      kind: "append",
      messageId: MESSAGE,
      role: "assistant",
      parts: [TEXT],
    });

    const refused = await kit.messages.write(OTHER, {
      kind: "append",
      messageId: "88888888-8888-4888-8888-888888888888",
      role: "assistant",
      parts: [{ kind: "text", text: "not yours", status: "complete" }],
    });

    expect(refused.kind).toBe("wrong_owner");
    const owner = await kit.messages.read(SCOPE);
    expect(owner.messages).toHaveLength(1);
    expect(JSON.stringify(owner)).not.toContain("not yours");
  });
});

/**
 * SHO-555. A year of daily use is one conversation, so a read returns the
 * latest window and a cursor, never the whole log.
 */
describe("a read is a window onto the log", () => {
  function kitWithWindow(messages: number) {
    return createAssistantKit(
      testDeps(fixtureInteractions, { windowMessages: messages }),
    );
  }

  function idOf(n: number): string {
    return `aaaaaaaa-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
  }

  async function writeTexts(
    kit: ReturnType<typeof kitWithWindow>,
    count: number,
  ): Promise<void> {
    for (let n = 1; n <= count; n += 1) {
      await kit.messages.write(SCOPE, {
        kind: "append",
        messageId: idOf(n),
        role: n % 2 === 1 ? "user" : "assistant",
        parts: [
          { kind: "text", text: `message ${String(n)}`, status: "complete" },
        ],
      });
    }
  }

  function textsOf(window: ChatWindow): string[] {
    return window.messages
      .flatMap((message) => message.parts)
      .map((part) => (part.kind === "text" ? part.text : part.kind));
  }

  it("returns the latest messages, and a cursor to the ones before them", async () => {
    const kit = kitWithWindow(2);
    await writeTexts(kit, 5);

    const latest = await kit.messages.read(SCOPE);
    expect(textsOf(latest)).toEqual(["message 4", "message 5"]);
    expect(latest.olderCursor).not.toBeNull();

    const before = await kit.messages.read(SCOPE, {
      before: latest.olderCursor ?? "",
    });
    expect(textsOf(before)).toEqual(["message 2", "message 3"]);

    const first = await kit.messages.read(SCOPE, {
      before: before.olderCursor ?? "",
    });
    expect(textsOf(first)).toEqual(["message 1"]);
    expect(first.olderCursor).toBeNull();
  });

  it("pages back to the whole log, in order, with nothing missing or repeated", async () => {
    const kit = kitWithWindow(3);
    await writeTexts(kit, 10);

    let window = await kit.messages.read(SCOPE);
    const pages = [textsOf(window)];
    while (window.olderCursor !== null) {
      window = await kit.messages.read(SCOPE, {
        before: window.olderCursor,
      });
      pages.unshift(textsOf(window));
    }

    expect(pages.flat()).toEqual(
      Array.from({ length: 10 }, (_, index) => `message ${String(index + 1)}`),
    );
  });

  it("has no cursor when the conversation fits in one window", async () => {
    const kit = kitWithWindow(5);
    await writeTexts(kit, 5);

    expect((await kit.messages.read(SCOPE)).olderCursor).toBeNull();
  });
});

/**
 * A message is finished once the request that wrote it ends. Reopening one
 * would let a turn change what a person already read — or, with a lapsed lease,
 * let a slow turn write into the middle of a newer one.
 */
describe("a message is written only while it is the latest", () => {
  it("refuses an id the log already holds further back, and leaves both as they were", async () => {
    const kit = newKit();
    const later = "66666666-6666-4666-8666-666666666666";
    await kit.messages.write(SCOPE, {
      kind: "append",
      messageId: MESSAGE,
      role: "assistant",
      parts: [TEXT],
    });
    await kit.messages.write(SCOPE, {
      kind: "append",
      messageId: later,
      role: "assistant",
      parts: [card(1, 3)],
    });

    await expect(
      kit.messages.write(SCOPE, {
        kind: "append",
        messageId: MESSAGE,
        role: "assistant",
        parts: [card(1, 9)],
      }),
    ).rejects.toThrow();

    const window = await kit.messages.read(SCOPE);
    expect(window.messages.map((message) => message.parts)).toEqual([
      [TEXT],
      [card(1, 3)],
    ]);
  });
});

describe("a message this build cannot read", () => {
  const FUTURE = "77777777-7777-4777-8777-777777777777";
  const LATER = "88888888-8888-4888-8888-888888888888";

  /** What a newer deploy might store: a part kind this one has never seen. */
  const fromNewerDeploy = {
    messageId: FUTURE,
    role: "assistant",
    createdAt: "2026-09-10T12:00:00.000Z",
    parts: [{ kind: "voice", clipId: "clip-1" }],
  };

  function slice() {
    const deps = testDeps(fixtureInteractions);
    return { deps, kit: createAssistantKit(deps) };
  }

  it("is skipped and reported, and the rest of the conversation still reads", async () => {
    const { deps, kit } = slice();
    await kit.messages.write(SCOPE, {
      kind: "append",
      messageId: MESSAGE,
      role: "user",
      parts: [TEXT],
    });
    await deps.messages.insert(CONVERSATION, {
      messageId: FUTURE,
      bind: BIND,
      message: fromNewerDeploy,
    });

    const window = await kit.messages.read(SCOPE);

    expect(window.messages.map((message) => message.messageId)).toEqual([
      MESSAGE,
    ]);
    expect(deps.unreadable).toEqual([{ conversationId: CONVERSATION, seq: 2 }]);
  });

  /**
   * SHO-555, the defect this storage exists to remove. A document that failed
   * its schema read as empty, and the next write stored itself over the whole
   * history. Deploying a new part kind and rolling back was enough.
   */
  it("survives the next write untouched, and so does everything before it", async () => {
    const { deps, kit } = slice();
    await kit.messages.write(SCOPE, {
      kind: "append",
      messageId: MESSAGE,
      role: "user",
      parts: [TEXT],
    });
    await deps.messages.insert(CONVERSATION, {
      messageId: FUTURE,
      bind: BIND,
      message: fromNewerDeploy,
    });

    await kit.messages.write(SCOPE, {
      kind: "append",
      messageId: LATER,
      role: "user",
      parts: [TEXT],
    });

    const stored = await deps.messages.page(CONVERSATION, { limit: 10 });
    expect(stored.records.map((record) => record.messageId)).toEqual([
      MESSAGE,
      FUTURE,
      LATER,
    ]);
    expect(stored.records[1]?.message).toEqual(fromNewerDeploy);
    expect(
      (await kit.messages.read(SCOPE)).messages.map(
        (message) => message.messageId,
      ),
    ).toEqual([MESSAGE, LATER]);
  });

  it("is not merged into when it is the latest — the write is refused instead", async () => {
    const { deps, kit } = slice();
    await deps.messages.insert(CONVERSATION, {
      messageId: FUTURE,
      bind: BIND,
      message: fromNewerDeploy,
    });

    await expect(
      kit.messages.write(SCOPE, {
        kind: "append",
        messageId: FUTURE,
        role: "assistant",
        parts: [TEXT],
      }),
    ).rejects.toThrow("not overwritten");

    const stored = await deps.messages.page(CONVERSATION, { limit: 10 });
    expect(stored.records.map((record) => record.message)).toEqual([
      fromNewerDeploy,
    ]);
  });
});
