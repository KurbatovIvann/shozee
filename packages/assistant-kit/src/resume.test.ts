/**
 * SCENARIOS.md 11-12 — the reason this package exists.
 *
 * Resume replays what was already sent. It does not re-derive a conversation
 * from persisted rows, so there is no id to mint, no tool result to merge in,
 * and no execution id to stage.
 */
import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import { createAssistantKit, type AssistantKit, type OpenPauseInput } from "./kit.js";
import type { Answer } from "./pause.js";
import { continuationOf, testDeps, type TestDeps } from "./testing.js";
import type { ToolOutcome } from "./outcome.js";

interface Input {
  readonly n: number;
}

const CONVERSATION = "11111111-1111-4111-8111-111111111111";
const SELECT_A: Answer = { kind: "select", optionId: "opt-a" };

const MESSAGES: readonly ModelMessage[] = [
  { role: "system", content: "rules" },
  { role: "user", content: "do the thing for the second one" },
  {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: "toolu_stable",
        toolName: "widget_create",
        input: { n: 1 },
      },
    ],
  },
];

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
    continuation: continuationOf({
      messages: MESSAGES,
      id: "toolu_stable",
      name: "widget_create",
    }),
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

describe("scenario 11 - resume replays, it does not re-derive", () => {
  it("returns the stored messages unchanged", async () => {
    const { kit } = newKit();
    const claimed = await claimOne(kit);

    const resumed = kit.resume(claimed, { ok: true });

    expect(resumed.messages).toEqual(MESSAGES);
    expect(JSON.stringify(resumed.messages)).toBe(JSON.stringify(MESSAGES));
  });

  it("does not rewrite the tool call id at any boundary", async () => {
    const { kit } = newKit();
    const claimed = await claimOne(kit);

    const resumed = kit.resume(claimed, { ok: true });

    expect(resumed.toolResult.toolCallId).toBe("toolu_stable");
    expect(JSON.stringify(resumed.messages)).toContain("toolu_stable");
  });
});

describe("scenario 12 - the paused call is finished, not reissued", () => {
  it("carries exactly one tool result, addressed to the paused call", async () => {
    const { kit } = newKit();
    const claimed = await claimOne(kit);
    const output = { entityId: "entity-a" };

    const resumed = kit.resume(claimed, output);

    expect(resumed.toolResult).toEqual({
      toolCallId: "toolu_stable",
      toolName: "widget_create",
      output,
    });
  });

  it("adds no second assistant tool-call to the replayed history", async () => {
    const { kit } = newKit();
    const claimed = await claimOne(kit);

    const resumed = kit.resume(claimed, { ok: true });

    const calls = resumed.messages.flatMap((message) =>
      message.role === "assistant" && Array.isArray(message.content)
        ? message.content.filter((part) => part.type === "tool-call")
        : [],
    );
    expect(calls).toHaveLength(1);
  });
});
