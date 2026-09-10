/**
 * One turn at a time, per conversation.
 *
 * The document is read-modify-write, so two turns on one conversation
 * interleave their reads and the later write discards the earlier one — with
 * nothing anywhere saying it happened (SHO-548). Neither of the things that
 * look like they would prevent it does: `busy` in a client is per client, and
 * the serial tool chain inside a turn is per turn.
 *
 * The lease is a `setIfAbsent` on a second key, the same primitive that makes
 * one pause per conversation. What is worth testing is not that a Map can hold
 * a key, but the two edges: the second caller is told rather than queued, and a
 * holder whose lease has lapsed cannot release the lock someone else now has.
 */
import { describe, expect, it } from "vitest";

import { fixtureInteractions } from "./fixture.js";
import { createAssistantKit } from "./kit.js";
import { testDeps } from "./testing.js";

const CONVERSATION = "11111111-1111-4111-8111-111111111111";
const OTHER_CONVERSATION = "22222222-2222-4222-8222-222222222222";
const BIND = "owner-1:scope-1";
const SCOPE = { conversationId: CONVERSATION, bind: BIND };

function newKit() {
  const deps = testDeps(fixtureInteractions);
  return { kit: createAssistantKit(deps), deps };
}

async function began(kit: ReturnType<typeof newKit>["kit"]): Promise<string> {
  const lease = await kit.turn.begin(SCOPE);
  if (lease.kind !== "began") {
    throw new Error(`expected began, got ${lease.kind}`);
  }
  return lease.token;
}

describe("the turn lease", () => {
  it("admits one and refuses the next", async () => {
    const { kit } = newKit();

    await began(kit);

    expect((await kit.turn.begin(SCOPE)).kind).toBe("busy");
  });

  it("frees the conversation when the turn ends", async () => {
    const { kit } = newKit();
    const token = await began(kit);

    expect(await kit.turn.end(SCOPE, token)).toBe(true);

    expect((await kit.turn.begin(SCOPE)).kind).toBe("began");
  });

  it("holds one conversation, not the assistant", async () => {
    const { kit } = newKit();
    await began(kit);

    const elsewhere = await kit.turn.begin({
      conversationId: OTHER_CONVERSATION,
      bind: BIND,
    });

    expect(elsewhere.kind).toBe("began");
  });

  /**
   * The reason `end` takes a token. A turn that overran its lease would
   * otherwise release the lock a later turn is holding, and then two would run
   * — the exact thing this exists to stop, produced by the cleanup.
   */
  it("cannot be released by a holder whose lease has lapsed", async () => {
    const { kit, deps } = newKit();
    const lapsed = await began(kit);
    // The lease ran out and someone else took the conversation.
    deps.pauses.entries.delete(`turn:${CONVERSATION}`);
    const current = await began(kit);

    expect(await kit.turn.end(SCOPE, lapsed)).toBe(false);

    expect((await kit.turn.begin(SCOPE)).kind).toBe("busy");
    expect(await kit.turn.end(SCOPE, current)).toBe(true);
  });

  it("reports a lease that was already gone", async () => {
    const { kit, deps } = newKit();
    const token = await began(kit);
    deps.pauses.entries.delete(`turn:${CONVERSATION}`);

    // `false` is what tells a caller the lock did not cover the whole turn.
    expect(await kit.turn.end(SCOPE, token)).toBe(false);
  });

  it("keeps its key apart from the pause on the same conversation", async () => {
    const { kit, deps } = newKit();
    await began(kit);

    expect([...deps.pauses.entries.keys()]).toEqual([`turn:${CONVERSATION}`]);
  });
});
