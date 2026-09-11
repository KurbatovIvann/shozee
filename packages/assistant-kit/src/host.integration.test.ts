/**
 * The loop, against a real `streamText` on a mock model: a tool pauses, the
 * pause is stored, an answer is claimed, and the resumed turn finishes.
 *
 * The strongest assertion here is that the pausing tool executes **once**. A
 * runtime that re-enters it is one where a picker can produce two records or
 * none.
 */
import { tool, type LanguageModel, type ModelMessage } from "ai";
import { z } from "zod";
import { describe, expect, it } from "vitest";

import { fixtureInteractions } from "./fixture.js";
import {
  MessageWriteRefusedError,
  continueHostTurn,
  runHostTurn,
} from "./host.js";
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

    const window = await s.kit.messages.read(SCOPE);
    const parts = window.messages.flatMap((message) => message.parts);
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

    const reloaded = await s.kit.messages.read(SCOPE);
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

    const parts = (await s.kit.messages.read(SCOPE)).messages.flatMap(
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

    const parts = (await s.kit.messages.read(SCOPE)).messages.flatMap(
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
      (await s.kit.messages.read(SCOPE)).messages
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
      (await s.kit.messages.read(SCOPE)).messages
        .flatMap((message) => message.parts)
        .filter((part) => part.kind === "text")
        .map((part) => part.status),
    ).toEqual(["complete"]);
  });
});

/**
 * SHO-551. Two calls in one turn that show the same thing — a page and then the
 * next one — produce a card under the same id twice. The message must hold one
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

    const parts = (await s.kit.messages.read(SCOPE)).messages.flatMap(
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

    const message = (await s.kit.messages.read(SCOPE)).messages.find(
      (candidate) => candidate.messageId === SECOND_MESSAGE,
    );
    const cards = message?.parts.filter((part) => part.kind === "card") ?? [];
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ revision: 2, payload: { rows: 2 } });
    expect(second.parts).toEqual(message?.parts);
  });
});

/**
 * SHO-568. A turn that outlives its request can still die — its process goes
 * away, or it passes its deadline. What it did before that must already be
 * stored: the card when its tool completed, the model's memory when its step
 * finished. And what was stored early must not be stored again at the end.
 */
describe("a turn stores what happened as it happens", () => {
  const history = () => {
    const saved: ModelMessage[][] = [];
    return {
      saved,
      saveHistory: (messages: readonly ModelMessage[]) => {
        saved.push([...messages]);
        return Promise.resolve();
      },
    };
  };

  it("stores a card when its tool completes, before a later step fails", async () => {
    const s = slice();
    const seen: string[][] = [];
    const tools = {
      ...s.tools,
      thing_peek: tool({
        description: "look at what is stored",
        inputSchema: z.object({}),
        execute: async (): Promise<ToolOutcome> => {
          const window = await s.kit.messages.read(SCOPE);
          seen.push(
            window.messages
              .flatMap((message) => message.parts)
              .flatMap((part) => (part.kind === "card" ? [part.cardId] : [])),
          );
          return { kind: "ok", result: { looked: true } };
        },
      }),
    };

    const turn = await runHostTurn({
      kit: s.kit,
      conversationId: CONVERSATION,
      bind: BIND,
      messageId: FIRST_MESSAGE,
      model: stubModelFailingAfter([
        stubToolCallStep("toolu_first", "thing_list", { limit: 5 }),
        stubToolCallStep("toolu_second", "thing_peek", {}),
      ]),
      messages: [{ role: "user", content: "list them" }],
      tools,
    });

    // Read from storage while the turn was still running.
    expect(seen).toEqual([["card-list"]]);
    expect(turn.interrupted).toBe(true);

    const message = (await s.kit.messages.read(SCOPE)).messages.find(
      (candidate) => candidate.messageId === FIRST_MESSAGE,
    );
    expect(message?.parts).toEqual([
      {
        kind: "card",
        cardId: "card-list",
        revision: 1,
        type: "collection",
        payload: { rows: 2 },
      },
      { kind: "text", text: "", status: "error" },
    ]);
    // One write for the card, one for the text. The end did not resend the card.
    expect(message?.revision).toBe(2);
    expect(turn.parts).toEqual(message?.parts);
  });

  it("does not write a card twice when the turn finishes", async () => {
    const s = slice();

    const turn = await runHostTurn({
      kit: s.kit,
      conversationId: CONVERSATION,
      bind: BIND,
      messageId: FIRST_MESSAGE,
      model: stubModel([
        stubToolCallStep("toolu_first", "thing_list", { limit: 5 }),
        stubTextStep("Готово."),
      ]),
      messages: [{ role: "user", content: "list them" }],
      tools: s.tools,
    });

    const message = (await s.kit.messages.read(SCOPE)).messages.find(
      (candidate) => candidate.messageId === FIRST_MESSAGE,
    );
    expect(message?.parts).toEqual([
      {
        kind: "card",
        cardId: "card-list",
        revision: 1,
        type: "collection",
        payload: { rows: 2 },
      },
      { kind: "text", text: "Готово.", status: "complete" },
    ]);
    expect(message?.revision).toBe(2);
    expect(turn.parts).toEqual(message?.parts);
  });

  it("keeps a card whose tool finishes after the abort landed", async () => {
    const s = slice();
    const controller = new AbortController();
    const slow = {
      thing_list: tool({
        description: "list them",
        inputSchema: z.object({ limit: z.number() }),
        execute: async (): Promise<ToolOutcome> => {
          controller.abort();
          // The write is still finishing when the run is already rejected.
          await Promise.resolve();
          await Promise.resolve();
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
      model: stubModel([
        stubToolCallStep("toolu_first", "thing_list", { limit: 5 }),
        stubTextStep("не встигне"),
      ]),
      messages: [{ role: "user", content: "list them" }],
      tools: slow,
      abortSignal: controller.signal,
    });

    const parts = (await s.kit.messages.read(SCOPE)).messages.flatMap(
      (message) => message.parts,
    );
    // Card first, then the broken text: the end waited for the tool's write.
    expect(parts.map((part) => part.kind)).toEqual(["card", "text"]);
    expect(turn.parts).toEqual(parts);
  });

  it("keeps the history of each finished step when a later step fails", async () => {
    const s = slice();
    const h = history();

    const turn = await runHostTurn({
      kit: s.kit,
      conversationId: CONVERSATION,
      bind: BIND,
      messageId: FIRST_MESSAGE,
      model: stubModelFailingAfter([
        stubToolCallStep("toolu_first", "thing_list", { limit: 5 }),
        stubToolCallStep("toolu_second", "thing_list", { limit: 5 }),
      ]),
      messages: [{ role: "user", content: "list them twice" }],
      tools: s.tools,
      saveHistory: h.saveHistory,
    });

    expect(turn.interrupted).toBe(true);
    expect(h.saved).toHaveLength(2);
    expect(JSON.stringify(h.saved[0])).toContain("toolu_first");
    expect(JSON.stringify(h.saved[0])).not.toContain("toolu_second");
    expect(JSON.stringify(h.saved[1])).toContain("toolu_second");
    // What was stored last is what the turn reports: a caller saving both
    // stores the same list twice, not the steps twice.
    expect(h.saved.at(-1)).toEqual(turn.messages);
  });

  it("saves a growing history that ends as the finished turn's, no step twice", async () => {
    const s = slice();
    const h = history();

    const turn = await runHostTurn({
      kit: s.kit,
      conversationId: CONVERSATION,
      bind: BIND,
      messageId: FIRST_MESSAGE,
      model: stubModel([
        stubToolCallStep("toolu_first", "thing_list", { limit: 5 }),
        stubTextStep("Готово."),
      ]),
      messages: [{ role: "user", content: "list them" }],
      tools: s.tools,
      saveHistory: h.saveHistory,
    });

    expect(turn.interrupted).toBe(false);
    expect(h.saved).toHaveLength(2);
    const [first, last] = h.saved;
    expect(last?.slice(0, first?.length)).toEqual(first);
    // `turn.messages` is the SDK's own accumulator on a clean run.
    expect(last).toEqual(turn.messages);
  });

  it("saves no history for the step that paused, nor for a step that died inside a tool", async () => {
    const paused = slice();
    const h = history();
    const turn = await runHostTurn({
      kit: paused.kit,
      conversationId: CONVERSATION,
      bind: BIND,
      messageId: FIRST_MESSAGE,
      model: paused.model,
      messages: [{ role: "user", content: "make one" }],
      tools: paused.tools,
      saveHistory: h.saveHistory,
    });
    expect(turn.kind).toBe("paused");
    // The continuation lives with the pause; it is the caller's to save.
    expect(h.saved).toEqual([]);

    const aborted = slice();
    const controller = new AbortController();
    const d = history();
    await runHostTurn({
      kit: aborted.kit,
      conversationId: CONVERSATION,
      bind: BIND,
      messageId: FIRST_MESSAGE,
      model: stubModel([
        stubToolCallStep("toolu_first", "thing_list", { limit: 5 }),
        stubTextStep("не встигне"),
      ]),
      messages: [{ role: "user", content: "list them" }],
      tools: {
        thing_list: tool({
          description: "list them",
          inputSchema: z.object({ limit: z.number() }),
          execute: (): ToolOutcome => {
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
      },
      abortSignal: controller.signal,
      saveHistory: d.saveHistory,
    });
    // The card stands; the step's memory does not (ADR-0039).
    expect(d.saved).toEqual([]);
    expect(
      (await aborted.kit.messages.read(SCOPE)).messages
        .flatMap((message) => message.parts)
        .filter((part) => part.kind === "card"),
    ).toHaveLength(1);
  });

  it("stops and rejects when a card cannot be stored", async () => {
    const deps = testDeps(fixtureInteractions);
    const kit = createAssistantKit({
      ...deps,
      messages: {
        ...deps.messages,
        insert: () => Promise.reject(new Error("log is down")),
      },
    });
    const s = slice();

    await expect(
      runHostTurn({
        kit,
        conversationId: CONVERSATION,
        bind: BIND,
        messageId: FIRST_MESSAGE,
        model: stubModel([
          stubToolCallStep("toolu_first", "thing_list", { limit: 5 }),
          stubToolCallStep("toolu_second", "thing_list", { limit: 5 }),
          stubTextStep("Готово."),
        ]),
        messages: [{ role: "user", content: "list them twice" }],
        tools: s.tools,
      }),
    ).rejects.toThrow("log is down");
    // Not a tool error the model reads and works around: the loop stopped.
    expect(s.calls.list).toBe(1);
  });

  it("stops and rejects when a step's history cannot be stored", async () => {
    const s = slice();

    await expect(
      runHostTurn({
        kit: s.kit,
        conversationId: CONVERSATION,
        bind: BIND,
        messageId: FIRST_MESSAGE,
        model: stubModel([
          stubToolCallStep("toolu_first", "thing_list", { limit: 5 }),
          stubToolCallStep("toolu_second", "thing_list", { limit: 5 }),
          stubTextStep("Готово."),
        ]),
        messages: [{ role: "user", content: "list them twice" }],
        tools: s.tools,
        saveHistory: () => Promise.reject(new Error("history is down")),
      }),
    ).rejects.toThrow("history is down");
    expect(s.calls.list).toBe(1);
  });
});

/** One step that calls several tools at once, as a provider may. */
function stubToolCallsStep(
  calls: readonly {
    readonly id: string;
    readonly name: string;
    readonly input: unknown;
  }[],
): { stream: ReadableStream } {
  return {
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        for (const call of calls) {
          controller.enqueue({
            type: "tool-call",
            toolCallId: call.id,
            toolName: call.name,
            input: JSON.stringify(call.input),
          });
        }
        controller.enqueue({
          type: "finish",
          finishReason: { unified: "tool-calls", raw: "tool_use" },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
        });
        controller.close();
      },
    }),
  };
}

describe("a turn whose writes cannot be stored", () => {
  it("lets no other tool in the same step act once a card could not be stored", async () => {
    const deps = testDeps(fixtureInteractions);
    const kit = createAssistantKit({
      ...deps,
      messages: {
        ...deps.messages,
        insert: () => Promise.reject(new Error("log is down")),
      },
    });
    const s = slice();
    const second = { calls: 0 };
    const tools = {
      ...s.tools,
      thing_record: tool({
        description: "record one",
        inputSchema: z.object({ label: z.string() }),
        execute: (): ToolOutcome => {
          second.calls += 1;
          return {
            kind: "ok",
            result: { id: "value-x" },
            card: {
              cardId: "card-record",
              type: "record",
              payload: { id: "value-x" },
            },
          };
        },
      }),
    };

    await expect(
      runHostTurn({
        kit,
        conversationId: CONVERSATION,
        bind: BIND,
        messageId: FIRST_MESSAGE,
        model: stubModel([
          stubToolCallsStep([
            { id: "toolu_first", name: "thing_list", input: { limit: 5 } },
            { id: "toolu_second", name: "thing_record", input: { label: "x" } },
          ]),
          stubTextStep("Готово."),
        ]),
        messages: [{ role: "user", content: "list them and record one" }],
        tools,
      }),
    ).rejects.toThrow("log is down");
    expect(s.calls.list).toBe(1);
    // Queued in the same step, and never run: no effect without its card.
    expect(second.calls).toBe(0);
  });

  it("rejects when the log refuses a card as another owner's, and stops", async () => {
    const s = slice();
    await s.kit.messages.write(
      { conversationId: CONVERSATION, bind: "owner-2:scope-2" },
      {
        kind: "append",
        messageId: SECOND_MESSAGE,
        role: "user",
        parts: [{ kind: "text", text: "not yours", status: "complete" }],
      },
    );

    await expect(
      runHostTurn({
        kit: s.kit,
        conversationId: CONVERSATION,
        bind: BIND,
        messageId: FIRST_MESSAGE,
        model: stubModel([
          stubToolCallStep("toolu_first", "thing_list", { limit: 5 }),
          stubToolCallStep("toolu_second", "thing_list", { limit: 5 }),
          stubTextStep("Готово."),
        ]),
        messages: [{ role: "user", content: "list them twice" }],
        tools: s.tools,
      }),
    ).rejects.toBeInstanceOf(MessageWriteRefusedError);
    expect(s.calls.list).toBe(1);
  });

  it("rejects when the log refuses the end of the turn as another owner's", async () => {
    const s = slice();
    await s.kit.messages.write(
      { conversationId: CONVERSATION, bind: "owner-2:scope-2" },
      {
        kind: "append",
        messageId: SECOND_MESSAGE,
        role: "user",
        parts: [{ kind: "text", text: "not yours", status: "complete" }],
      },
    );

    await expect(
      runHostTurn({
        kit: s.kit,
        conversationId: CONVERSATION,
        bind: BIND,
        messageId: FIRST_MESSAGE,
        model: stubModel([stubTextStep("Готово.")]),
        messages: [{ role: "user", content: "hello" }],
        tools: s.tools,
      }),
    ).rejects.toBeInstanceOf(MessageWriteRefusedError);
  });
});

/**
 * A caller whose only abort is its own deadline stores the break as
 * `interrupted` (ADR-0039). A text part is never re-marked once stored, so the
 * status has to be right the first time — and the in-request default stays
 * `error`.
 */
describe("the status an aborted run stores", () => {
  function abortingInsideTool(controller: AbortController) {
    return {
      thing_list: tool({
        description: "list them",
        inputSchema: z.object({ limit: z.number() }),
        execute: (): ToolOutcome => {
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
  }

  async function storedParts(s: Slice) {
    return (await s.kit.messages.read(SCOPE)).messages.flatMap(
      (message) => message.parts,
    );
  }

  it("stores `interrupted` for an abort inside a tool, and keeps the card", async () => {
    const s = slice();
    const controller = new AbortController();

    const turn = await runHostTurn({
      kit: s.kit,
      conversationId: CONVERSATION,
      bind: BIND,
      messageId: FIRST_MESSAGE,
      model: stubModel([
        stubToolCallStep("toolu_first", "thing_list", { limit: 5 }),
        stubTextStep("не встигне"),
      ]),
      messages: [{ role: "user", content: "list them" }],
      tools: abortingInsideTool(controller),
      abortSignal: controller.signal,
      abortedTextStatus: "interrupted",
    });

    const parts = await storedParts(s);
    expect(parts).toEqual([
      {
        kind: "card",
        cardId: "card-list",
        revision: 1,
        type: "collection",
        payload: { rows: 2 },
      },
      { kind: "text", text: "", status: "interrupted" },
    ]);
    expect(turn.interrupted).toBe(true);
    expect(turn.parts).toEqual(parts);
  });

  it("stores `interrupted` for an abort between steps, and keeps the card", async () => {
    const s = slice();
    const controller = new AbortController();

    const turn = await runHostTurn({
      kit: s.kit,
      conversationId: CONVERSATION,
      bind: BIND,
      messageId: FIRST_MESSAGE,
      model: stubModelFailingAfter(
        [stubToolCallStep("toolu_first", "thing_list", { limit: 5 })],
        {
          before: () => {
            controller.abort();
          },
        },
      ),
      messages: [{ role: "user", content: "list them" }],
      tools: s.tools,
      abortSignal: controller.signal,
      abortedTextStatus: "interrupted",
    });

    const parts = await storedParts(s);
    expect(parts.map((part) => part.kind)).toEqual(["card", "text"]);
    expect(
      parts.flatMap((part) => (part.kind === "text" ? [part.status] : [])),
    ).toEqual(["interrupted"]);
    expect(turn.parts).toEqual(parts);
  });

  it("stores `error` for an abort when the caller did not ask otherwise", async () => {
    const s = slice();
    const controller = new AbortController();

    await runHostTurn({
      kit: s.kit,
      conversationId: CONVERSATION,
      bind: BIND,
      messageId: FIRST_MESSAGE,
      model: stubModelFailingAfter(
        [stubToolCallStep("toolu_first", "thing_list", { limit: 5 })],
        {
          before: () => {
            controller.abort();
          },
        },
      ),
      messages: [{ role: "user", content: "list them" }],
      tools: s.tools,
      abortSignal: controller.signal,
    });

    expect(
      (await storedParts(s)).flatMap((part) =>
        part.kind === "text" ? [part.status] : [],
      ),
    ).toEqual(["error"]);
  });

  it("stores `error` for a provider failure even when asked for `interrupted`", async () => {
    const s = slice();

    await runHostTurn({
      kit: s.kit,
      conversationId: CONVERSATION,
      bind: BIND,
      messageId: FIRST_MESSAGE,
      model: stubModelFailingAfter([
        stubToolCallStep("toolu_first", "thing_list", { limit: 5 }),
      ]),
      messages: [{ role: "user", content: "list them" }],
      tools: s.tools,
      abortSignal: new AbortController().signal,
      abortedTextStatus: "interrupted",
    });

    expect(
      (await storedParts(s)).flatMap((part) =>
        part.kind === "text" ? [part.status] : [],
      ),
    ).toEqual(["error"]);
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
