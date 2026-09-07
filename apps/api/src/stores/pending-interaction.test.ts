import { randomUUID } from "node:crypto";

import {
  confirmationPendingRecordFromPause,
  pendingRedisKey,
  type ConfirmationPendingRecord,
} from "@showzy/ai";
import { describe, expect, it } from "vitest";

import { createMemoryPendingInteractionStore } from "./pending-interaction.js";

const conversationId = "11111111-1111-4111-8111-111111111111";
const otherConversationId = "12121212-1212-4212-8212-121212121212";
const companyId = "22222222-2222-4222-8222-222222222222";
const otherCompanyId = "23232323-2323-4232-8232-232323232323";
const customerId = "77777777-7777-4777-8777-777777777777";

const bind = {
  actorId: "anna",
  companyId,
  conversationId,
};

function openConfirmation(
  challengeId: string = randomUUID(),
): ConfirmationPendingRecord {
  return confirmationPendingRecordFromPause({
    challengeId,
    bind,
    actionName: "customers.deleteCustomer",
    toolCallId: "call-delete",
    canonicalInput: { id: customerId },
    locale: "uk",
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  });
}

describe("createMemoryPendingInteractionStore", () => {
  it("names Redis keys pending:{kind}:{id}", () => {
    const id = randomUUID();
    expect(pendingRedisKey("confirmation", id)).toBe(
      `pending:confirmation:${id}`,
    );
    expect(pendingRedisKey("choice", id)).toBe(`pending:choice:${id}`);
  });

  it("lets the first confirmation claim win and rejects a different resolution", async () => {
    const store = createMemoryPendingInteractionStore();
    const record = openConfirmation();
    expect(await store.open(record)).toBe(true);
    const [first, second] = await Promise.all([
      store.claim({
        kind: "confirmation",
        id: record.id,
        bind,
        resolution: "confirmed",
      }),
      store.claim({
        kind: "confirmation",
        id: record.id,
        bind,
        resolution: "confirmed",
      }),
    ]);
    const kinds = [first.kind, second.kind].toSorted();
    expect(kinds).toEqual(["claimed", "replay"]);
    expect(
      await store.claim({
        kind: "confirmation",
        id: record.id,
        bind,
        resolution: "other",
      }),
    ).toEqual({ kind: "invalid_option" });
  });

  it("replays the same confirmation resolution after complete and stores resumeResult", async () => {
    const store = createMemoryPendingInteractionStore();
    const record = openConfirmation();
    await store.open(record);
    await store.claim({
      kind: "confirmation",
      id: record.id,
      bind,
      resolution: "confirmed",
    });
    const resumeResult = {
      status: "completed" as const,
      text: "Here is a short summary of the result.",
      actionName: "customers.deleteCustomer",
      toolCallId: "call-delete",
      output: { id: customerId },
    };
    const completed = await store.complete({
      kind: "confirmation",
      id: record.id,
      bind,
      resolution: "confirmed",
      resumeResult,
    });
    expect(completed.kind).toBe("completed");
    if (completed.kind !== "completed") {
      return;
    }
    expect(completed.record.kind).toBe("confirmation");
    if (completed.record.kind !== "confirmation") {
      return;
    }
    expect(completed.record.resumeResult).toEqual(resumeResult);
    const replay = await store.complete({
      kind: "confirmation",
      id: record.id,
      bind,
      resolution: "confirmed",
    });
    expect(replay.kind).toBe("replay");
    if (replay.kind !== "replay" || replay.record.kind !== "confirmation") {
      return;
    }
    expect(replay.record.resumeResult).toEqual(resumeResult);
  });

  it("returns expired and forbidden without executing a bind mismatch", async () => {
    const clock = { nowMs: 1_000_000 };
    const store = createMemoryPendingInteractionStore({
      now: () => clock.nowMs,
      ttlMs: 50,
    });
    const record = openConfirmation();
    await store.open(record);
    expect(
      await store.claim({
        kind: "confirmation",
        id: record.id,
        bind: { ...bind, companyId: otherCompanyId },
        resolution: "confirmed",
      }),
    ).toEqual({ kind: "forbidden" });
    expect(
      await store.claim({
        kind: "confirmation",
        id: record.id,
        bind: { ...bind, actorId: "boris" },
        resolution: "confirmed",
      }),
    ).toEqual({ kind: "forbidden" });
    expect(
      await store.claim({
        kind: "confirmation",
        id: record.id,
        bind: { ...bind, conversationId: otherConversationId },
        resolution: "confirmed",
      }),
    ).toEqual({ kind: "forbidden" });
    clock.nowMs += 51;
    expect(
      await store.claim({
        kind: "confirmation",
        id: record.id,
        bind,
        resolution: "confirmed",
      }),
    ).toEqual({ kind: "expired" });
  });

  it("unsafeReplaceCanonicalInput mutates stored confirmation input", async () => {
    const store = createMemoryPendingInteractionStore();
    const record = openConfirmation();
    await store.open(record);
    const tampered = { id: randomUUID() };
    await store.unsafeReplaceCanonicalInput?.({
      kind: "confirmation",
      id: record.id,
      canonicalInput: tampered,
    });
    const loaded = await store.get({ kind: "confirmation", id: record.id });
    expect(loaded?.canonicalInput).toEqual(tampered);
  });
});
