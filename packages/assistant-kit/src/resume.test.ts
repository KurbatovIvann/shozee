/**
 * SCENARIOS.md 11-12 — the reason this package exists.
 *
 * Resume replays what was already sent, with exactly one change: the paused
 * tool-result's output becomes the resolved one. It does not append a second
 * result for that call (no provider accepts two), and it does not trim the
 * tool message (that would make resume a reconstruction again).
 */
import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import { createAssistantKit, type AssistantKit, type OpenPauseInput } from "./kit.js";
import type { Answer } from "./pause.js";
import { continuationOf, pausedHistory, testDeps, type TestDeps } from "./testing.js";
import type { ToolOutcome } from "./outcome.js";

interface Input {
  readonly n: number;
}

const CONVERSATION = "11111111-1111-4111-8111-111111111111";
const SELECT_A: Answer = { kind: "select", optionId: "opt-a" };
const PAUSED_ID = "toolu_stable";
const HISTORY: readonly ModelMessage[] = pausedHistory({ id: PAUSED_ID });

function newKit(): { kit: AssistantKit; deps: TestDeps } {
  const deps = testDeps();
  return { kit: createAssistantKit(deps), deps };
}

function openInput(): OpenPauseInput<Input> {
  const outcome: Extract<ToolOutcome<Input>, { kind: "needs_choice" }> = {
    kind: "needs_choice",
    subject: "two matches",
    options: [
      { optionId: "opt-a", label: "A", entityId: "entity-a" },
      { optionId: "opt-b", label: "B", entityId: "entity-b" },
    ],
    optionsTruncated: false,
    resume: { n: 1 },
  };
  return {
    conversationId: CONVERSATION,
    outcome,
    continuation: continuationOf({ messages: HISTORY, id: PAUSED_ID }),
  };
}

async function claimOne(kit: AssistantKit) {
  const opened = await kit.open(openInput());
  if (opened.kind !== "opened") throw new Error("expected opened");
  const claimed = await kit.claim<Input>({
    conversationId: CONVERSATION,
    interactionId: opened.pause.interactionId,
    revision: 1,
    answer: SELECT_A,
  });
  if (claimed.kind !== "claimed") throw new Error("expected claimed");
  return claimed;
}

/** `tool` content also carries approval responses, which have no output. */
function toolResultsIn(messages: readonly ModelMessage[]) {
  return messages
    .flatMap((message) => (message.role === "tool" ? message.content : []))
    .filter((part) => part.type === "tool-result");
}

describe("scenario 11 - resume replays, it does not re-derive", () => {
  it("changes exactly one output and nothing else", async () => {
    const { kit } = newKit();
    const claimed = await claimOne(kit);

    const resumed = kit.resume(claimed, { entityId: "entity-a" });

    expect(resumed.messages).toHaveLength(HISTORY.length);
    // Every message but the tool message is untouched.
    expect(resumed.messages.slice(0, -1)).toEqual(HISTORY.slice(0, -1));
    expect(JSON.stringify(resumed.messages.slice(0, -1))).toBe(
      JSON.stringify(HISTORY.slice(0, -1)),
    );
  });

  it("does not rewrite the tool call id at any boundary", async () => {
    const { kit } = newKit();
    const claimed = await claimOne(kit);

    const resumed = kit.resume(claimed, { entityId: "entity-a" });

    expect(JSON.stringify(resumed.messages)).toContain(PAUSED_ID);
    expect(JSON.stringify(resumed.messages)).not.toContain("choice:");
    expect(JSON.stringify(resumed.messages)).not.toContain("phase-a:");
  });
});

describe("scenario 12 - the paused call is finished, not reissued", () => {
  it("keeps one tool result for the paused call, carrying the resolved output", async () => {
    const { kit } = newKit();
    const claimed = await claimOne(kit);
    const output = { entityId: "entity-a", number: "1" };

    const resumed = kit.resume(claimed, output);
    const results = toolResultsIn(resumed.messages).filter(
      (part) => part.toolCallId === PAUSED_ID,
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.output).toEqual({ type: "json", value: output });
  });

  it("adds no second assistant tool-call to the replayed history", async () => {
    const { kit } = newKit();
    const claimed = await claimOne(kit);

    const resumed = kit.resume(claimed, { entityId: "entity-a" });

    const calls = resumed.messages.flatMap((message) =>
      message.role === "assistant" && Array.isArray(message.content)
        ? message.content.filter((part) => part.type === "tool-call")
        : [],
    );
    expect(calls).toHaveLength(1);
  });

  it("leaves the needs_choice placeholder nowhere in the resumed history", async () => {
    const { kit } = newKit();
    const claimed = await claimOne(kit);

    const resumed = kit.resume(claimed, { entityId: "entity-a" });

    expect(JSON.stringify(resumed.messages)).not.toContain("needs_choice");
  });
});
