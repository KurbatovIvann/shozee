/**
 * The loop, against a real `streamText` on a mock model: a tool pauses, the
 * pause is stored, an answer is claimed, and the resumed turn finishes.
 *
 * The strongest assertion here is that the pausing tool executes **once**. A
 * runtime that re-enters it is one where a picker can produce two records or
 * none.
 */
import { tool, type LanguageModel } from "ai";
import { z } from "zod";
import { describe, expect, it } from "vitest";

import { fixtureInteractions } from "./fixture.js";
import { continueHostTurn, runHostTurn } from "./host.js";
import { createAssistantKit } from "./kit.js";
import type { ToolOutcome } from "./outcome.js";
import {
  stubModel,
  stubModelFailingAfter,
  stubTextStep,
  stubToolCallStep,
  testDeps,
  type MemoryPauseStore,
} from "./testing.js";

const CONVERSATION = "11111111-1111-4111-8111-111111111111";
const BIND = "owner-1:scope-1";
const FIRST_MESSAGE = "44444444-4444-4444-8444-444444444444";
const SECOND_MESSAGE = "55555555-5555-4555-8555-555555555555";
const SCOPE = { conversationId: CONVERSATION, bind: BIND };

function slice() {
  const calls = { make: 0, list: 0 };
  const model = stubModel([
    stubToolCallStep("toolu_make", "thing_make", { label: "two matches" }),
    stubToolCallStep("toolu_list", "thing_list", { limit: 5 }),
    stubTextStep("Готово, ось перелік."),
  ]);

  const tools = {
    thing_make: tool({
      description: "make one",
      inputSchema: z.object({ label: z.string() }),
      execute: (input): ToolOutcome => {
        calls.make += 1;
        return {
          kind: "pause",
          interaction: "pick",
          prompt: {
            question: input.label,
            options: [
              { id: "opt-a", label: "A" },
              { id: "opt-b", label: "B" },
            ],
          },
          secret: {
            byOption: { "opt-a": "value-a", "opt-b": "value-b" },
            replay: input,
          },
        };
      },
    }),
    thing_list: tool({
      description: "list them",
      inputSchema: z.object({ limit: z.number() }),
      execute: (): ToolOutcome => {
        calls.list += 1;
        return {
          kind: "ok",
          result: { rows: 2 },
          card: {
            cardId: "card-list",
            type: "collection",
            payload: { rows: 2 },
          },
        };
      },
    }),
  };

  const deps = testDeps(fixtureInteractions);
  return { kit: createAssistantKit(deps), deps, model, tools, calls };
}

type Slice = ReturnType<typeof slice>;

async function firstTurn(s: Slice, model?: LanguageModel) {
  return await runHostTurn({
    kit: s.kit,
    conversationId: CONVERSATION,
    bind: BIND,
    messageId: FIRST_MESSAGE,
    model: model ?? s.model,
    messages: [{ role: "user", content: "make one for the second match" }],
    tools: s.tools,
  });
}

describe("the first turn pauses", () => {
  it("stores the provider's own id and hides the secret", async () => {
    const s = slice();

    const turn = await firstTurn(s);

    expect(turn.kind).toBe("paused");
    expect(turn.pause?.kind).toBe("pick");
    expect(JSON.stringify(turn.messages)).toContain("toolu_make");

    const open = await s.kit.peek(SCOPE);
    expect(open?.interactionId).toBe(turn.pause?.interactionId);
    expect(JSON.stringify(open)).not.toContain("value-a");
    expect(JSON.stringify(open)).not.toContain("byOption");
  });

  it("refuses a pause on a kind the registry does not have", async () => {
    const s = slice();
    const rogue = {
      thing_make: tool({
        description: "make one",
        inputSchema: z.object({ label: z.string() }),
        execute: (): ToolOutcome => ({
          kind: "pause",
          interaction: "not_registered",
          prompt: {},
          secret: {},
        }),
      }),
    };

    const turn = await runHostTurn({
      kit: s.kit,
      conversationId: CONVERSATION,
      bind: BIND,
      messageId: FIRST_MESSAGE,
      model: s.model,
      messages: [{ role: "user", content: "make one" }],
      tools: rogue,
    });

    expect(turn.kind).toBe("pause_rejected");
    expect(turn.rejection).toContain("not_registered");
    expect(await s.kit.peek(SCOPE)).toBeNull();
  });
});

describe("the whole round trip", () => {
  it("executes the pausing tool once and settles", async () => {
    const s = slice();
    const first = await firstTurn(s);
    if (first.pause === null) throw new Error("expected a pause");

    const claimed = await s.kit.claim({
      ...SCOPE,
      interactionId: first.pause.interactionId,
      revision: first.pause.revision,
      answer: { chose: "opt-b" },
    });
    if (claimed.kind !== "claimed") throw new Error("expected claimed");

    // The kind resolved the option; the client only ever sent `opt-b`.
    expect(claimed.value).toEqual({
      chosen: "value-b",
      replay: { label: "two matches" },
    });

    const second = await continueHostTurn({
      kit: s.kit,
      conversationId: CONVERSATION,
      bind: BIND,
      messageId: SECOND_MESSAGE,
      model: s.model,
      tools: s.tools,
      claimed,
      resolved: {
        kind: "ok",
        result: { id: "value-b" },
        card: {
          cardId: "card-made",
          type: "record",
          payload: { id: "value-b" },
        },
      },
    });

    expect(second.kind).toBe("settled");
    expect(s.calls.make).toBe(1);
    expect(s.calls.list).toBe(1);
    expect(await s.kit.peek(SCOPE)).toBeNull();
  });

  it("shows one earned card, one follow-up card and the text", async () => {
    const s = slice();
    const first = await firstTurn(s);
    if (first.pause === null) throw new Error("expected a pause");

    const claimed = await s.kit.claim({
      ...SCOPE,
      interactionId: first.pause.interactionId,
      revision: first.pause.revision,
      answer: { chose: "opt-b" },
    });
    if (claimed.kind !== "claimed") throw new Error("expected claimed");

    await continueHostTurn({
      kit: s.kit,
      conversationId: CONVERSATION,
      bind: BIND,
      messageId: SECOND_MESSAGE,
      model: s.model,
      tools: s.tools,
      claimed,
      resolved: {
        kind: "ok",
        result: { id: "value-b" },
        card: {
          cardId: "card-made",
          type: "record",
          payload: { id: "value-b" },
        },
      },
    });

    const document = await s.kit.document.read(SCOPE);
    const parts = document.messages.flatMap((message) => message.parts);
    const cards = parts.filter((part) => part.kind === "card");

    expect(cards.map((part) => part.cardId).sort()).toEqual([
      "card-list",
      "card-made",
    ]);
    expect(cards.filter((part) => part.type === "record")).toHaveLength(1);
    expect(parts.filter((part) => part.kind === "text").at(-1)?.text).toContain(
      "Готово",
    );
  });
});

describe("a reload returns what the live turn wrote", () => {
  it("matches part for part, and the open pause comes from the pause store", async () => {
    const s = slice();
    const live = await firstTurn(s);

    const reloaded = await s.kit.document.read(SCOPE);
    const parts = reloaded.messages.flatMap((message) => message.parts);

    expect(parts).toEqual(live.parts);
    expect(JSON.stringify(parts)).toBe(JSON.stringify(live.parts));
    expect(reloaded.openPause?.interactionId).toBe(live.pause?.interactionId);
  });
});

describe("a write does not overtake an unanswered question", () => {
  it("skips a second tool in the same step once a pause is captured", async () => {
    const s = slice();
    const both = stubModel([
      {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({
              type: "tool-call",
              toolCallId: "toolu_make",
              toolName: "thing_make",
              input: JSON.stringify({ label: "x" }),
            });
            controller.enqueue({
              type: "tool-call",
              toolCallId: "toolu_list",
              toolName: "thing_list",
              input: JSON.stringify({ limit: 5 }),
            });
            controller.enqueue({
              type: "finish",
              finishReason: { unified: "tool-calls", raw: "tool_use" },
              usage: {
                inputTokens: {
                  total: 1,
                  noCache: 1,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
              },
            });
            controller.close();
          },
        }),
      },
    ]);

    const turn = await firstTurn(s, both);

    expect(turn.kind).toBe("paused");
    expect(s.calls.make).toBe(1);
    expect(s.calls.list).toBe(0);
  });
});

/**
 * SHO-546. A tool wrote to the domain, and then the turn did not finish.
 *
 * The write stands — nothing here rolls a domain action back — so the only
 * question is whether the person is told. The card is the one part that says
 * "this happened", and it used to be dropped on the way out.
 *
 * The two ways a turn ends early are different code paths, because the SDK
 * treats them differently: an abort rejects every promise on the result, and a
 * provider failure after a step has finished rejects none of them.
 */
describe("a turn that breaks after a tool has written", () => {
  /** Step one calls the tool that produces a card; step two never arrives. */
  const oneCardThenNothing = () =>
    stubToolCallStep("toolu_list", "thing_list", { limit: 5 });

  it("keeps the card when the provider fails mid-loop, and says the turn broke", async () => {
    const s = slice();

    const turn = await firstTurn(
      s,
      stubModelFailingAfter([oneCardThenNothing()]),
    );

    expect(turn.interrupted).toBe(true);
    expect(s.calls.list).toBe(1);

    const parts = (await s.kit.document.read(SCOPE)).messages.flatMap(
      (message) => message.parts,
    );
    expect(
      parts.filter((part) => part.kind === "card").map((part) => part.cardId),
    ).toEqual(["card-list"]);
    // Marked, not presented as a reply: an empty `complete` text would read as
    // the assistant having nothing to say about an order it had just created.
    expect(
      parts.filter((part) => part.kind === "text").map((part) => part.status),
    ).toEqual(["error"]);

    // This path keeps its memory: the step that ran did finish.
    expect(JSON.stringify(turn.messages)).toContain("toolu_list");
  });

  it("keeps the card when the request is aborted inside the tool", async () => {
    const s = slice();
    const controller = new AbortController();
    const aborting = {
      thing_list: tool({
        description: "list them",
        inputSchema: z.object({ limit: z.number() }),
        execute: (): ToolOutcome => {
          s.calls.list += 1;
          // The phone went into the background while the write was running.
          controller.abort();
          return {
            kind: "ok",
            result: { rows: 2 },
            card: {
              cardId: "card-list",
              type: "collection",
              payload: { rows: 2 },
            },
          };
        },
      }),
    };

    const turn = await runHostTurn({
      kit: s.kit,
      conversationId: CONVERSATION,
      bind: BIND,
      messageId: FIRST_MESSAGE,
      model: stubModel([oneCardThenNothing(), stubTextStep("не встигне")]),
      messages: [{ role: "user", content: "list them" }],
      tools: aborting,
      abortSignal: controller.signal,
    });

    expect(turn.interrupted).toBe(true);
    expect(s.calls.list).toBe(1);

    const parts = (await s.kit.document.read(SCOPE)).messages.flatMap(
      (message) => message.parts,
    );
    expect(
      parts.filter((part) => part.kind === "card").map((part) => part.cardId),
    ).toEqual(["card-list"]);
    expect(
      parts.filter((part) => part.kind === "text").map((part) => part.status),
    ).toEqual(["error"]);

    // And the decision about history, asserted so it stays a decision: the step
    // never finished, so there is nothing to keep. The model will not remember
    // this call. SHO-547 is what stops a repeat writing twice.
    expect(turn.messages).toEqual([{ role: "user", content: "list them" }]);
  });

  /**
   * The SDK reports this one as an ordinary finished result — the abort landed
   * where there was nothing in flight to reject. The host still calls it
   * interrupted, because the person's connection dropped either way.
   */
  it("marks an abort that lands between steps, and keeps the finished step", async () => {
    const s = slice();
    const controller = new AbortController();

    const turn = await runHostTurn({
      kit: s.kit,
      conversationId: CONVERSATION,
      bind: BIND,
      messageId: FIRST_MESSAGE,
      model: stubModelFailingAfter([oneCardThenNothing()], {
        before: () => {
          controller.abort();
        },
      }),
      messages: [{ role: "user", content: "list them" }],
      tools: s.tools,
      abortSignal: controller.signal,
    });

    expect(turn.interrupted).toBe(true);
    expect(JSON.stringify(turn.messages)).toContain("toolu_list");
    expect(
      (await s.kit.document.read(SCOPE)).messages
        .flatMap((message) => message.parts)
        .filter((part) => part.kind === "card"),
    ).toHaveLength(1);
  });

  /**
   * The negative. `onError` is what makes a broken turn visible, and a callback
   * that fires on a clean run would mark every reply as failed.
   */
  it("does not mark a turn that finished", async () => {
    const s = slice();

    const turn = await runHostTurn({
      kit: s.kit,
      conversationId: CONVERSATION,
      bind: BIND,
      messageId: FIRST_MESSAGE,
      model: stubModel([oneCardThenNothing(), stubTextStep("Готово.")]),
      messages: [{ role: "user", content: "list them" }],
      tools: s.tools,
    });

    expect(turn.interrupted).toBe(false);
    expect(
      (await s.kit.document.read(SCOPE)).messages
        .flatMap((message) => message.parts)
        .filter((part) => part.kind === "text")
        .map((part) => part.status),
    ).toEqual(["complete"]);
  });
});

/**
 * SHO-551. Two calls in one turn that show the same thing — a page and then the
 * next one — produce a card under the same id twice. The document must hold one
 * card, and the turn must report the one a reload will read.
 */
describe("a card written twice in a turn is one card", () => {
  function growingList() {
    let rows = 0;
    return {
      thing_list: tool({
        description: "list them",
        inputSchema: z.object({ limit: z.number() }),
        execute: (input): ToolOutcome => {
          rows += input.limit;
          return {
            kind: "ok",
            result: { rows },
            card: {
              cardId: "card-list",
              type: "collection",
              payload: { rows },
            },
          };
        },
      }),
    };
  }

  it("keeps the later payload in the first card's place", async () => {
    const s = slice();

    const turn = await runHostTurn({
      kit: s.kit,
      conversationId: CONVERSATION,
      bind: BIND,
      messageId: FIRST_MESSAGE,
      model: stubModel([
        stubToolCallStep("toolu_page_1", "thing_list", { limit: 5 }),
        stubToolCallStep("toolu_page_2", "thing_list", { limit: 5 }),
        stubTextStep("Ось і наступні."),
      ]),
      messages: [{ role: "user", content: "list them, and the next ones" }],
      tools: growingList(),
    });

    const parts = (await s.kit.document.read(SCOPE)).messages.flatMap(
      (message) => message.parts,
    );
    expect(parts.map((part) => part.kind)).toEqual(["card", "text"]);
    expect(parts[0]).toMatchObject({ revision: 2, payload: { rows: 10 } });
    // Live and reload agree on how many cards there are, not only on order.
    expect(turn.parts).toEqual(parts);
  });

  it("updates the card an answer earned instead of adding a second", async () => {
    const s = slice();
    const first = await firstTurn(s);
    if (first.pause === null) throw new Error("expected a pause");
    const claimed = await s.kit.claim({
      ...SCOPE,
      interactionId: first.pause.interactionId,
      revision: first.pause.revision,
      answer: { chose: "opt-b" },
    });
    if (claimed.kind !== "claimed") throw new Error("expected claimed");

    // The earned card is stored before generation; the follow-up list call
    // writes the same id in a second write to the same message.
    const second = await continueHostTurn({
      kit: s.kit,
      conversationId: CONVERSATION,
      bind: BIND,
      messageId: SECOND_MESSAGE,
      model: s.model,
      tools: s.tools,
      claimed,
      resolved: {
        kind: "ok",
        result: { rows: 1 },
        card: { cardId: "card-list", type: "collection", payload: { rows: 1 } },
      },
    });

    const message = (await s.kit.document.read(SCOPE)).messages.find(
      (candidate) => candidate.messageId === SECOND_MESSAGE,
    );
    const cards = message?.parts.filter((part) => part.kind === "card") ?? [];
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ revision: 2, payload: { rows: 2 } });
    expect(second.parts).toEqual(message?.parts);
  });
});

describe("the pause store is the only place a pause lives", () => {
  it("keeps exactly one key for the conversation", async () => {
    const s = slice();
    await firstTurn(s);

    const store: MemoryPauseStore = s.deps.pauses;
    expect([...store.entries.keys()]).toEqual([`pause:${CONVERSATION}`]);
  });
});
