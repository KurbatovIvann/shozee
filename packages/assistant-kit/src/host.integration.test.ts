/**
 * SCENARIOS.md 13-16 at the loop level: a real `streamText`, a real tool that
 * pauses, a real claim, and a real resumed turn — on a mock model, so it runs
 * in milliseconds and costs nothing.
 *
 * This is the check none of the three previous attempts had: that the protocol
 * actually composes with the SDK. The strongest assertion in the file is that
 * the pausing tool executes **once**. The old runtime re-entered it, which is
 * why a picker could produce two entities or none.
 */
import { simulateReadableStream, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { continueHostTurn, runHostTurn } from "./host.js";
import { createAssistantKit } from "./kit.js";
import type { ToolOutcome } from "./outcome.js";
import { testDeps } from "./testing.js";

const CONVERSATION = "11111111-1111-4111-8111-111111111111";
const FIRST_MESSAGE = "44444444-4444-4444-8444-444444444444";
const SECOND_MESSAGE = "55555555-5555-4555-8555-555555555555";

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

function toolCallStream(toolCallId: string, toolName: string, input: unknown) {
  const serialized = JSON.stringify(input);
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        { type: "tool-input-start" as const, id: toolCallId, toolName },
        { type: "tool-input-delta" as const, id: toolCallId, delta: serialized },
        { type: "tool-input-end" as const, id: toolCallId },
        {
          type: "tool-call" as const,
          toolCallId,
          toolName,
          input: serialized,
        },
        {
          type: "finish" as const,
          finishReason: { unified: "tool-calls" as const, raw: "tool_use" },
          usage: USAGE,
        },
      ],
    }),
  };
}

function textStream(text: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        { type: "text-start" as const, id: "t1" },
        { type: "text-delta" as const, id: "t1", delta: text },
        { type: "text-end" as const, id: "t1" },
        {
          type: "finish" as const,
          finishReason: { unified: "stop" as const, raw: "end_turn" },
          usage: USAGE,
        },
      ],
    }),
  };
}

interface CreateInput {
  readonly label: string;
}

interface Slice {
  readonly kit: ReturnType<typeof createAssistantKit>;
  readonly model: MockLanguageModelV4;
  readonly tools: Parameters<typeof runHostTurn>[0]["tools"];
  readonly calls: { create: number; list: number };
}

/**
 * One ambiguous write tool and one read tool. Neither throws to signal
 * ambiguity: `needs_choice` is an ordinary return value.
 */
function slice(): Slice {
  const calls = { create: 0, list: 0 };
  const model = new MockLanguageModelV4({
    doStream: [
      toolCallStream("toolu_create", "thing_create", { label: "two matches" }),
      toolCallStream("toolu_list", "thing_list", { limit: 5 }),
      textStream("Готово, ось перелік."),
    ],
  });

  const tools = {
    thing_create: tool({
      description: "create one",
      inputSchema: z.object({ label: z.string() }),
      execute: (input): ToolOutcome<CreateInput> => {
        calls.create += 1;
        return {
          kind: "needs_choice",
          subject: input.label,
          options: [
            { optionId: "opt-a", label: "A", entityId: "entity-a" },
            { optionId: "opt-b", label: "B", entityId: "entity-b" },
          ],
          optionsTruncated: false,
          resume: { label: input.label },
        };
      },
    }),
    thing_list: tool({
      description: "list them",
      inputSchema: z.object({ limit: z.number() }),
      execute: (): ToolOutcome<never> => {
        calls.list += 1;
        return {
          kind: "ok",
          result: { rows: 2 },
          surface: {
            cardId: "card-list",
            surface: "collection",
            payload: { rows: 2 },
          },
        };
      },
    }),
  };

  return { kit: createAssistantKit(testDeps()), model, tools, calls };
}

describe("vertical slice: pause, answer, resume", () => {
  it("pauses on the first turn and stores the real provider id", async () => {
    const { kit, model, tools } = slice();

    const turn = await runHostTurn({
      kit,
      conversationId: CONVERSATION,
      messageId: FIRST_MESSAGE,
      model,
      messages: [{ role: "user", content: "create one for the second match" }],
      tools,
    });

    expect(turn.kind).toBe("paused");
    expect(turn.pause?.kind).toBe("choice");
    // The id came from the SDK, not from the host.
    expect(JSON.stringify(turn.messages)).toContain("toolu_create");

    const open = await kit.peek(CONVERSATION);
    expect(open?.interactionId).toBe(turn.pause?.interactionId);
    // The wire view of the pause never carries the entity ids behind it.
    expect(JSON.stringify(open)).not.toContain("entity-a");
  });

  it("runs the whole round trip and executes the pausing tool once", async () => {
    const { kit, model, tools, calls } = slice();

    const first = await runHostTurn({
      kit,
      conversationId: CONVERSATION,
      messageId: FIRST_MESSAGE,
      model,
      messages: [{ role: "user", content: "create one for the second match" }],
      tools,
    });
    if (first.pause === null) throw new Error("expected a pause");

    const claimed = await kit.claim<CreateInput>({
      conversationId: CONVERSATION,
      interactionId: first.pause.interactionId,
      revision: first.pause.revision,
      answer: { kind: "select", optionId: "opt-b" },
    });
    if (claimed.kind !== "claimed") throw new Error("expected claimed");

    // The server resolves the option; the client only ever sent `opt-b`.
    const entityId = kit.entityIdFor(claimed.record, "opt-b");
    expect(entityId).toBe("entity-b");

    const second = await continueHostTurn<CreateInput>({
      kit,
      conversationId: CONVERSATION,
      messageId: SECOND_MESSAGE,
      model,
      tools,
      claimed,
      resolved: {
        kind: "ok",
        result: { entityId, number: "1" },
        surface: {
          cardId: "card-entity",
          surface: "entity",
          payload: { entityId, number: "1" },
        },
      },
    });

    expect(second.kind).toBe("settled");
    // The paused call is resolved by the host, never re-executed.
    expect(calls.create).toBe(1);
    expect(calls.list).toBe(1);
    // The placeholder is gone from the history the model was given.
    expect(JSON.stringify(second.messages)).not.toContain("needs_choice");
    expect(await kit.peek(CONVERSATION)).toBeNull();
  });

  it("shows one entity card, one list card and the text — no duplicate", async () => {
    const { kit, model, tools } = slice();

    const first = await runHostTurn({
      kit,
      conversationId: CONVERSATION,
      messageId: FIRST_MESSAGE,
      model,
      messages: [{ role: "user", content: "create one" }],
      tools,
    });
    if (first.pause === null) throw new Error("expected a pause");

    const claimed = await kit.claim<CreateInput>({
      conversationId: CONVERSATION,
      interactionId: first.pause.interactionId,
      revision: first.pause.revision,
      answer: { kind: "select", optionId: "opt-b" },
    });
    if (claimed.kind !== "claimed") throw new Error("expected claimed");

    await continueHostTurn<CreateInput>({
      kit,
      conversationId: CONVERSATION,
      messageId: SECOND_MESSAGE,
      model,
      tools,
      claimed,
      resolved: {
        kind: "ok",
        result: { entityId: "entity-b" },
        surface: {
          cardId: "card-entity",
          surface: "entity",
          payload: { entityId: "entity-b" },
        },
      },
    });

    const document = await kit.document.read(CONVERSATION);
    const parts = document.messages.flatMap((message) => message.parts);
    const surfaces = parts.filter((part) => part.kind === "surface");

    expect(surfaces.map((part) => part.cardId).sort()).toEqual([
      "card-entity",
      "card-list",
    ]);
    expect(surfaces.filter((part) => part.surface === "entity")).toHaveLength(1);
    expect(parts.filter((part) => part.kind === "text").at(-1)?.text).toContain(
      "Готово",
    );
  });

  it("reload returns what live wrote", async () => {
    const { kit, model, tools } = slice();

    const live = await runHostTurn({
      kit,
      conversationId: CONVERSATION,
      messageId: FIRST_MESSAGE,
      model,
      messages: [{ role: "user", content: "create one" }],
      tools,
    });

    const reloaded = await kit.document.read(CONVERSATION);
    const parts = reloaded.messages.flatMap((message) => message.parts);

    expect(parts).toEqual(live.parts);
    expect(JSON.stringify(parts)).toBe(JSON.stringify(live.parts));
    // The open pause comes from the pause store, not from the stored document.
    expect(reloaded.openPause?.interactionId).toBe(live.pause?.interactionId);
  });

  it("a second tool in the same step does not act once a pause is captured", async () => {
    const { kit, tools, calls } = slice();
    const both = new MockLanguageModelV4({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start" as const, warnings: [] },
              {
                type: "tool-call" as const,
                toolCallId: "toolu_create",
                toolName: "thing_create",
                input: JSON.stringify({ label: "x" }),
              },
              {
                type: "tool-call" as const,
                toolCallId: "toolu_list",
                toolName: "thing_list",
                input: JSON.stringify({ limit: 5 }),
              },
              {
                type: "finish" as const,
                finishReason: { unified: "tool-calls" as const, raw: "tool_use" },
                usage: USAGE,
              },
            ],
          }),
        },
      ],
    });

    const turn = await runHostTurn({
      kit,
      conversationId: CONVERSATION,
      messageId: FIRST_MESSAGE,
      model: both,
      messages: [{ role: "user", content: "create one and list them" }],
      tools,
    });

    expect(turn.kind).toBe("paused");
    expect(calls.create).toBe(1);
    // The read never ran: a write must not overtake an unanswered question.
    expect(calls.list).toBe(0);
  });
});
