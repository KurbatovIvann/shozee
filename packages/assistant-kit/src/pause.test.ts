/**
 * SCENARIOS.md 1-10. Kit level: a Map, a fixed clock, no model.
 *
 * Red until `createAssistantKit` exists. Each `it` names its scenario number
 * so a deletion has to argue with the defect it was written against.
 */
import { describe, expect, it } from "vitest";

import { providerToolCallId } from "./ids.js";
import { createAssistantKit, type AssistantKit, type OpenPauseInput } from "./kit.js";
import { publicPauseSchema, type Answer } from "./pause.js";
import { continuationOf, testDeps, type TestDeps } from "./testing.js";
import type { ToolOutcome } from "./outcome.js";

interface Input {
  readonly n: number;
}

const CONVERSATION = "11111111-1111-4111-8111-111111111111";
const ABSENT_INTERACTION = "22222222-2222-4222-8222-222222222222";

function newKit(): { kit: AssistantKit; deps: TestDeps } {
  const deps = testDeps();
  return { kit: createAssistantKit(deps), deps };
}

function choiceOutcome(
  resume: Input = { n: 1 },
): Extract<ToolOutcome<Input>, { kind: "needs_choice" }> {
  return {
    kind: "needs_choice",
    subject: "two matches",
    options: [
      { optionId: "opt-a", label: "A", entityId: "entity-a" },
      { optionId: "opt-b", label: "B", entityId: "entity-b" },
    ],
    optionsTruncated: false,
    resume,
  };
}

function confirmationOutcome(): Extract<
  ToolOutcome<Input>,
  { kind: "needs_confirmation" }
> {
  return { kind: "needs_confirmation", summary: "are you sure", resume: { n: 1 } };
}

function openInput(
  outcome: OpenPauseInput<Input>["outcome"] = choiceOutcome(),
): OpenPauseInput<Input> {
  return { conversationId: CONVERSATION, outcome, continuation: continuationOf() };
}

const SELECT_A: Answer = { kind: "select", optionId: "opt-a" };

describe("scenario 1 - an unsendable tool call id cannot be stored", () => {
  it("1a rejects the id shapes the old host minted", () => {
    expect(providerToolCallId("choice:abc").kind).toBe("illegal");
    expect(providerToolCallId("phase-a:1").kind).toBe("illegal");
    expect(providerToolCallId("").kind).toBe("illegal");
  });

  it("1a accepts a provider id and an underscore-minted one", () => {
    expect(providerToolCallId("toolu_01ABC").kind).toBe("ok");
    expect(providerToolCallId("choice_abc").kind).toBe("ok");
  });

  it("1b stores the continuation id unchanged", async () => {
    const { kit } = newKit();
    const opened = await kit.open(openInput());
    if (opened.kind !== "opened") throw new Error("expected opened");

    const claimed = await kit.claim<Input>({
      conversationId: CONVERSATION,
      interactionId: opened.pause.interactionId,
      revision: 1,
      answer: SELECT_A,
    });

    expect(claimed.kind).toBe("claimed");
    if (claimed.kind !== "claimed") return;
    expect(claimed.record.continuation.pausedToolCall.id).toBe("toolu_01");
  });
});

describe("scenario 2 - one open interaction per conversation", () => {
  it("refuses a second open and returns the current pause", async () => {
    const { kit } = newKit();
    const first = await kit.open(openInput());
    const second = await kit.open(openInput(choiceOutcome({ n: 2 })));

    expect(first.kind).toBe("opened");
    expect(second.kind).toBe("already_open");
    if (second.kind !== "already_open" || first.kind !== "opened") return;
    expect(second.current.interactionId).toBe(first.pause.interactionId);
  });
});

describe("scenario 3 - a claim is consumed exactly once", () => {
  it("the second claim is gone", async () => {
    const { kit } = newKit();
    const opened = await kit.open(openInput());
    if (opened.kind !== "opened") throw new Error("expected opened");
    const claim = {
      conversationId: CONVERSATION,
      interactionId: opened.pause.interactionId,
      revision: 1,
      answer: SELECT_A,
    };

    expect((await kit.claim<Input>(claim)).kind).toBe("claimed");
    expect((await kit.claim<Input>(claim)).kind).toBe("gone");
  });

  it("concurrent claims produce exactly one winner", async () => {
    const { kit } = newKit();
    const opened = await kit.open(openInput());
    if (opened.kind !== "opened") throw new Error("expected opened");
    const claim = {
      conversationId: CONVERSATION,
      interactionId: opened.pause.interactionId,
      revision: 1,
      answer: SELECT_A,
    };

    const results = await Promise.all([
      kit.claim<Input>(claim),
      kit.claim<Input>(claim),
      kit.claim<Input>(claim),
    ]);

    expect(results.filter((result) => result.kind === "claimed")).toHaveLength(1);
  });
});

describe("scenario 4 - a stale revision is refused, not applied", () => {
  it("returns the current pause instead of answering an unseen draft", async () => {
    const { kit } = newKit();
    const opened = await kit.open(openInput());
    if (opened.kind !== "opened") throw new Error("expected opened");

    await kit.revise<Input>({
      conversationId: CONVERSATION,
      interactionId: opened.pause.interactionId,
      next: { outcome: choiceOutcome({ n: 5 }), continuation: continuationOf() },
    });

    const stale = await kit.claim<Input>({
      conversationId: CONVERSATION,
      interactionId: opened.pause.interactionId,
      revision: 1,
      answer: SELECT_A,
    });

    expect(stale.kind).toBe("stale");
    if (stale.kind !== "stale") return;
    expect(stale.current.revision).toBeGreaterThan(1);
  });
});

describe("scenario 5 - the answer kind must match the pause kind", () => {
  it("a picker answer does not approve a confirmation", async () => {
    const { kit } = newKit();
    const opened = await kit.open(openInput(confirmationOutcome()));
    if (opened.kind !== "opened") throw new Error("expected opened");

    const wrong = await kit.claim<Input>({
      conversationId: CONVERSATION,
      interactionId: opened.pause.interactionId,
      revision: 1,
      answer: SELECT_A,
    });

    expect(wrong.kind).toBe("wrong_answer_kind");
    if (wrong.kind !== "wrong_answer_kind") return;
    expect(wrong.expected).toContain("approve");
  });
});

describe("scenario 6 - an expired pause is not resumable", () => {
  it("a claim after the ttl returns expired", async () => {
    const { kit, deps } = newKit();
    const opened = await kit.open(openInput());
    if (opened.kind !== "opened") throw new Error("expected opened");

    deps.clock.advance(deps.choiceTtlMs + 1);

    const expired = await kit.claim<Input>({
      conversationId: CONVERSATION,
      interactionId: opened.pause.interactionId,
      revision: 1,
      answer: SELECT_A,
    });

    expect(expired.kind).toBe("expired");
  });
});

describe("scenario 7 - the wire view cannot carry a secret", () => {
  it("has no resolved input, option map, or entity id", async () => {
    const { kit } = newKit();
    const opened = await kit.open(openInput());
    if (opened.kind !== "opened") throw new Error("expected opened");

    const parsed = publicPauseSchema.parse(opened.pause);
    const flat = JSON.stringify(parsed);

    expect(flat).not.toContain("entity-a");
    expect(flat).not.toContain("resolvedInput");
    expect(flat).not.toContain("optionMap");
    for (const option of parsed.options) {
      expect(Object.keys(option)).not.toContain("entityId");
    }
  });
});

describe("scenario 8 - the server resolves optionId", () => {
  it("maps a known option and refuses an unknown one", async () => {
    const { kit } = newKit();
    const opened = await kit.open(openInput());
    if (opened.kind !== "opened") throw new Error("expected opened");

    const claimed = await kit.claim<Input>({
      conversationId: CONVERSATION,
      interactionId: opened.pause.interactionId,
      revision: 1,
      answer: SELECT_A,
    });
    if (claimed.kind !== "claimed") throw new Error("expected claimed");

    expect(kit.entityIdFor(claimed.record, "opt-a")).toBe("entity-a");
    expect(kit.entityIdFor(claimed.record, "opt-z")).toBeUndefined();
  });
});

describe("scenario 9 - revise invalidates the previous answer", () => {
  it("raises the revision and keeps the interaction identity", async () => {
    const { kit } = newKit();
    const opened = await kit.open(openInput());
    if (opened.kind !== "opened") throw new Error("expected opened");

    const revised = await kit.revise<Input>({
      conversationId: CONVERSATION,
      interactionId: opened.pause.interactionId,
      next: { outcome: choiceOutcome({ n: 9 }), continuation: continuationOf() },
    });

    expect(revised.kind).toBe("opened");
    if (revised.kind !== "opened") return;
    expect(revised.pause.revision).toBe(opened.pause.revision + 1);
    expect(revised.pause.interactionId).toBe(opened.pause.interactionId);
  });
});

describe("scenario 10 - an answer that outruns the pause is not silently lost", () => {
  it("a claim before the pause exists is gone, and nothing is written", async () => {
    const { kit, deps } = newKit();

    const early = await kit.claim<Input>({
      conversationId: CONVERSATION,
      interactionId: ABSENT_INTERACTION,
      revision: 1,
      answer: SELECT_A,
    });

    expect(early.kind).toBe("gone");
    expect(deps.documents.writes).toHaveLength(0);
  });
});
