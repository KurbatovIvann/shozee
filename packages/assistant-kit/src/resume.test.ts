/**
 * Resume — the reason this package exists.
 *
 * It replays what was already sent, with exactly one change: the paused
 * tool-result's output becomes the resolved one. It does not append a second
 * result for that call (no provider accepts two), and it does not trim the tool
 * message (that would make resume a reconstruction again).
 */
import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import { fixtureInteractions, PICK_PROMPT, PICK_SECRET } from "./fixture.js";
import { createAssistantKit } from "./kit.js";
import { continuationOf, pausedHistory, testDeps } from "./testing.js";

const CONVERSATION = "11111111-1111-4111-8111-111111111111";
const BIND = "owner-1:scope-1";
const PAUSED_ID = "toolu_stable";
const HISTORY: readonly ModelMessage[] = pausedHistory({ id: PAUSED_ID });

function newKit() {
  return createAssistantKit(testDeps(fixtureInteractions));
}

type Kit = ReturnType<typeof newKit>;

async function claimOne(kit: Kit) {
  const opened = await kit.open({
    conversationId: CONVERSATION,
    bind: BIND,
    kind: "pick",
    prompt: PICK_PROMPT,
    secret: PICK_SECRET,
    continuation: continuationOf({ messages: HISTORY, id: PAUSED_ID }),
  });
  if (opened.kind !== "opened") throw new Error("expected opened");
  const claimed = await kit.claim({
    conversationId: CONVERSATION,
    bind: BIND,
    interactionId: opened.pause.interactionId,
    revision: 1,
    answer: { chose: "opt-a" },
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

describe("resume replays, it does not re-derive", () => {
  it("changes exactly one output and nothing else", async () => {
    const kit = newKit();
    const claimed = await claimOne(kit);

    const resumed = kit.resume(claimed, { ok: true });

    expect(resumed.messages).toHaveLength(HISTORY.length);
    expect(resumed.messages.slice(0, -1)).toEqual(HISTORY.slice(0, -1));
    expect(JSON.stringify(resumed.messages.slice(0, -1))).toBe(
      JSON.stringify(HISTORY.slice(0, -1)),
    );
  });

  it("does not rewrite the tool call id at any boundary", async () => {
    const kit = newKit();
    const claimed = await claimOne(kit);

    const resumed = kit.resume(claimed, { ok: true });

    expect(JSON.stringify(resumed.messages)).toContain(PAUSED_ID);
    expect(JSON.stringify(resumed.messages)).not.toContain("choice:");
    expect(JSON.stringify(resumed.messages)).not.toContain("phase-a:");
  });
});

describe("the paused call is finished, not reissued", () => {
  it("keeps one tool result for it, carrying the resolved output", async () => {
    const kit = newKit();
    const claimed = await claimOne(kit);
    const output = { id: "value-a", label: "A" };

    const resumed = kit.resume(claimed, output);
    const results = toolResultsIn(resumed.messages).filter(
      (part) => part.toolCallId === PAUSED_ID,
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.output).toEqual({ type: "json", value: output });
  });

  it("adds no second assistant tool-call to the replayed history", async () => {
    const kit = newKit();
    const claimed = await claimOne(kit);

    const resumed = kit.resume(claimed, { ok: true });

    const calls = resumed.messages.flatMap((message) =>
      message.role === "assistant" && Array.isArray(message.content)
        ? message.content.filter((part) => part.type === "tool-call")
        : [],
    );
    expect(calls).toHaveLength(1);
  });

  it("leaves the placeholder nowhere in the resumed history", async () => {
    const kit = newKit();
    const claimed = await claimOne(kit);

    const resumed = kit.resume(claimed, { ok: true });

    expect(JSON.stringify(resumed.messages)).not.toContain("paused");
  });
});
