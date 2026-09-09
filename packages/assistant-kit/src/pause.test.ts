/**
 * The pause store: a Map, a fixed clock, no model.
 *
 * Nothing here names a kind this package knows about — `pick` and `confirm`
 * come from the fixture registry, exactly as a consumer's kinds would.
 */
import { describe, expect, it } from "vitest";

import { fixtureInteractions, PICK_PROMPT, PICK_SECRET } from "./fixture.js";
import { providerToolCallId } from "./ids.js";
import { createInteractions } from "./interaction.js";
import { createAssistantKit } from "./kit.js";
import { publicPauseSchema } from "./pause.js";
import { continuationOf, testDeps } from "./testing.js";

const CONVERSATION = "11111111-1111-4111-8111-111111111111";
const BIND = "owner-1:scope-1";
const OTHER = "owner-2:scope-2";
const ABSENT_INTERACTION = "22222222-2222-4222-8222-222222222222";
const CHOSE_A = { chose: "opt-a" };

function newKit() {
  const deps = testDeps(fixtureInteractions);
  return { kit: createAssistantKit(deps), deps };
}

type Kit = ReturnType<typeof newKit>["kit"];
type OpenArgs = Parameters<Kit["open"]>[0];

function openInput(overrides?: Partial<OpenArgs>): OpenArgs {
  return {
    conversationId: CONVERSATION,
    bind: BIND,
    kind: "pick",
    prompt: PICK_PROMPT,
    secret: PICK_SECRET,
    continuation: continuationOf(),
    ...overrides,
  };
}

async function openPick(kit: Kit) {
  const opened = await kit.open(openInput());
  if (opened.kind !== "opened") throw new Error(`expected opened, got ${opened.kind}`);
  return opened.pause;
}

describe("an unsendable tool call id cannot be stored", () => {
  it("rejects ids outside what a provider accepts", () => {
    expect(providerToolCallId("choice:abc").kind).toBe("illegal");
    expect(providerToolCallId("phase-a:1").kind).toBe("illegal");
    expect(providerToolCallId("").kind).toBe("illegal");
  });

  it("accepts a provider id and an underscore-minted one", () => {
    expect(providerToolCallId("toolu_01ABC").kind).toBe("ok");
    expect(providerToolCallId("choice_abc").kind).toBe("ok");
  });

  it("stores the continuation id unchanged", async () => {
    const { kit } = newKit();
    const pause = await openPick(kit);

    const claimed = await kit.claim({
      conversationId: CONVERSATION,
      bind: BIND,
      interactionId: pause.interactionId,
      revision: 1,
      answer: CHOSE_A,
    });

    expect(claimed.kind).toBe("claimed");
    if (claimed.kind !== "claimed") return;
    expect(claimed.record.continuation.pausedToolCall.id).toBe("toolu_01");
  });
});

describe("the kind decides what is acceptable", () => {
  it("refuses a kind the registry does not have", async () => {
    const { kit } = newKit();

    const opened = await kit.open(openInput({ kind: "nope" } as never));

    expect(opened.kind).toBe("unknown_kind");
  });

  it("refuses a prompt the kind's schema rejects", async () => {
    const { kit } = newKit();

    const opened = await kit.open(
      openInput({ prompt: { question: "which one" } }),
    );

    expect(opened.kind).toBe("invalid_prompt");
  });

  it("takes the ttl from the kind, not from the deployment", async () => {
    const { kit, deps } = newKit();
    const picked = await openPick(kit);

    const confirmed = await createAssistantKit(
      testDeps(fixtureInteractions),
    ).open({
      conversationId: CONVERSATION,
      bind: BIND,
      kind: "confirm",
      prompt: { question: "are you sure" },
      secret: { replay: { n: 1 } },
      continuation: continuationOf(),
    });
    if (confirmed.kind !== "opened") throw new Error("expected opened");

    const pickTtl = Date.parse(picked.expiresAt) - deps.clock.now().getTime();
    const confirmTtl =
      Date.parse(confirmed.pause.expiresAt) - deps.clock.now().getTime();
    expect(pickTtl).toBeGreaterThan(confirmTtl);
  });

  it("treats a pause whose kind is no longer registered as unknown", async () => {
    const { kit, deps } = newKit();
    const pause = await openPick(kit);

    // The deploy that removed the kind did not remove the open pause.
    const narrowed = createAssistantKit({
      ...deps,
      interactions: createInteractions({}),
    });
    const claimed = await narrowed.claim({
      conversationId: CONVERSATION,
      bind: BIND,
      interactionId: pause.interactionId,
      revision: 1,
      answer: CHOSE_A,
    });

    expect(claimed.kind).toBe("unknown_kind");
  });
});

describe("one open interaction per conversation", () => {
  it("refuses a second open and returns the current pause", async () => {
    const { kit } = newKit();
    const first = await kit.open(openInput());
    const second = await kit.open(openInput());

    expect(first.kind).toBe("opened");
    expect(second.kind).toBe("already_open");
    if (second.kind !== "already_open" || first.kind !== "opened") return;
    expect(second.current.interactionId).toBe(first.pause.interactionId);
  });
});

describe("a claim is consumed exactly once", () => {
  it("the second claim is gone", async () => {
    const { kit } = newKit();
    const pause = await openPick(kit);
    const claim = {
      conversationId: CONVERSATION,
      bind: BIND,
      interactionId: pause.interactionId,
      revision: 1,
      answer: CHOSE_A,
    };

    expect((await kit.claim(claim)).kind).toBe("claimed");
    expect((await kit.claim(claim)).kind).toBe("gone");
  });

  it("concurrent claims produce exactly one winner", async () => {
    const { kit } = newKit();
    const pause = await openPick(kit);
    const claim = {
      conversationId: CONVERSATION,
      bind: BIND,
      interactionId: pause.interactionId,
      revision: 1,
      answer: CHOSE_A,
    };

    const results = await Promise.all([
      kit.claim(claim),
      kit.claim(claim),
      kit.claim(claim),
    ]);

    expect(results.filter((result) => result.kind === "claimed")).toHaveLength(1);
  });

  it("hands back what the kind resolved, not the raw answer", async () => {
    const { kit } = newKit();
    const pause = await openPick(kit);

    const claimed = await kit.claim({
      conversationId: CONVERSATION,
      bind: BIND,
      interactionId: pause.interactionId,
      revision: 1,
      answer: { chose: "opt-b" },
    });

    expect(claimed.kind).toBe("claimed");
    if (claimed.kind !== "claimed") return;
    expect(claimed.value).toEqual({ chosen: "value-b", replay: { n: 1 } });
  });
});

describe("an answer that cannot mean anything does not burn the claim", () => {
  it("refuses a body the kind's schema rejects, and the pause stays open", async () => {
    const { kit } = newKit();
    const pause = await openPick(kit);

    const bad = await kit.claim({
      conversationId: CONVERSATION,
      bind: BIND,
      interactionId: pause.interactionId,
      revision: 1,
      answer: { agreed: true },
    });

    expect(bad.kind).toBe("invalid_answer");
    expect(
      (await kit.peek({ conversationId: CONVERSATION, bind: BIND }))?.status,
    ).toBe("open");
  });

  it("refuses an option the interaction never offered, and the pause stays open", async () => {
    const { kit } = newKit();
    const pause = await openPick(kit);

    const bad = await kit.claim({
      conversationId: CONVERSATION,
      bind: BIND,
      interactionId: pause.interactionId,
      revision: 1,
      answer: { chose: "opt-z" },
    });

    expect(bad.kind).toBe("unresolvable");
    const still = await kit.peek({ conversationId: CONVERSATION, bind: BIND });
    expect(still?.status).toBe("open");

    // And the real answer still works afterwards.
    const good = await kit.claim({
      conversationId: CONVERSATION,
      bind: BIND,
      interactionId: pause.interactionId,
      revision: 1,
      answer: CHOSE_A,
    });
    expect(good.kind).toBe("claimed");
  });
});

describe("a stale revision is refused, not applied", () => {
  it("returns the current pause instead of answering an unseen draft", async () => {
    const { kit } = newKit();
    const pause = await openPick(kit);

    await kit.revise({
      conversationId: CONVERSATION,
      bind: BIND,
      interactionId: pause.interactionId,
      next: {
        kind: "pick",
        prompt: { question: "changed", options: [{ id: "opt-c", label: "C" }] },
        secret: { byOption: { "opt-c": "value-c" }, replay: { n: 5 } },
        continuation: continuationOf(),
      },
    });

    const stale = await kit.claim({
      conversationId: CONVERSATION,
      bind: BIND,
      interactionId: pause.interactionId,
      revision: 1,
      answer: CHOSE_A,
    });

    expect(stale.kind).toBe("stale");
    if (stale.kind !== "stale") return;
    expect(stale.current.revision).toBeGreaterThan(1);
  });

  it("revise keeps the interaction identity and raises the revision", async () => {
    const { kit } = newKit();
    const pause = await openPick(kit);

    const revised = await kit.revise({
      conversationId: CONVERSATION,
      bind: BIND,
      interactionId: pause.interactionId,
      next: {
        kind: "pick",
        prompt: PICK_PROMPT,
        secret: PICK_SECRET,
        continuation: continuationOf(),
      },
    });

    expect(revised.kind).toBe("opened");
    if (revised.kind !== "opened") return;
    expect(revised.pause.revision).toBe(pause.revision + 1);
    expect(revised.pause.interactionId).toBe(pause.interactionId);
  });
});

describe("an expired pause is not resumable", () => {
  it("a claim after the kind's ttl returns expired", async () => {
    const { kit, deps } = newKit();
    const pause = await openPick(kit);

    deps.clock.advance(15 * 60 * 1000 + 1);

    const expired = await kit.claim({
      conversationId: CONVERSATION,
      bind: BIND,
      interactionId: pause.interactionId,
      revision: 1,
      answer: CHOSE_A,
    });

    expect(expired.kind).toBe("expired");
  });
});

describe("the wire view cannot carry a secret", () => {
  it("shows the prompt and nothing behind it", async () => {
    const { kit } = newKit();
    const pause = await openPick(kit);

    const parsed = publicPauseSchema.parse(pause);
    const flat = JSON.stringify(parsed);

    expect(flat).not.toContain("value-a");
    expect(flat).not.toContain("byOption");
    expect(flat).not.toContain("replay");
    expect(Object.keys(parsed)).not.toContain("secret");
  });
});

describe("another owner's pause reads as absent", () => {
  it("a claim under a different bind is gone, not refused", async () => {
    const { kit } = newKit();
    const pause = await openPick(kit);

    const foreign = await kit.claim({
      conversationId: CONVERSATION,
      bind: OTHER,
      interactionId: pause.interactionId,
      revision: 1,
      answer: CHOSE_A,
    });
    const absent = await kit.claim({
      conversationId: CONVERSATION,
      bind: OTHER,
      interactionId: ABSENT_INTERACTION,
      revision: 1,
      answer: CHOSE_A,
    });

    // Deliberately the same answer: probing must teach nothing.
    expect(foreign.kind).toBe("gone");
    expect(absent.kind).toBe("gone");
  });

  it("peek and document read under a different bind see no pause", async () => {
    const { kit } = newKit();
    await openPick(kit);

    expect(await kit.peek({ conversationId: CONVERSATION, bind: OTHER })).toBeNull();
    const document = await kit.document.read({
      conversationId: CONVERSATION,
      bind: OTHER,
    });
    expect(document.openPause).toBeNull();
  });

  it("the owner still sees it", async () => {
    const { kit } = newKit();
    await openPick(kit);

    expect(
      await kit.peek({ conversationId: CONVERSATION, bind: BIND }),
    ).not.toBeNull();
  });
});

describe("an answer whose action had no effect is answerable again", () => {
  it("release reopens at the same revision", async () => {
    const { kit } = newKit();
    const pause = await openPick(kit);
    const claim = {
      conversationId: CONVERSATION,
      bind: BIND,
      interactionId: pause.interactionId,
      revision: 1,
      answer: CHOSE_A,
    };

    expect((await kit.claim(claim)).kind).toBe("claimed");
    expect((await kit.claim(claim)).kind).toBe("gone");

    const released = await kit.release({
      conversationId: CONVERSATION,
      bind: BIND,
      interactionId: pause.interactionId,
    });
    expect(released.kind).toBe("released");
    expect((await kit.claim(claim)).kind).toBe("claimed");
  });

  it("release on a pause that was never claimed is gone", async () => {
    const { kit } = newKit();
    const pause = await openPick(kit);

    const released = await kit.release({
      conversationId: CONVERSATION,
      bind: BIND,
      interactionId: pause.interactionId,
    });
    expect(released.kind).toBe("gone");
  });
});

describe("an answer that outruns the pause is not silently lost", () => {
  it("a claim before the pause exists is gone, and nothing is written", async () => {
    const { kit, deps } = newKit();

    const early = await kit.claim({
      conversationId: CONVERSATION,
      bind: BIND,
      interactionId: ABSENT_INTERACTION,
      revision: 1,
      answer: CHOSE_A,
    });

    expect(early.kind).toBe("gone");
    expect(deps.documents.writes).toHaveLength(0);
  });
});
