import { randomUUID } from "node:crypto";

import {
  confirmationPendingRecord,
  pendingChoiceRecordFromChoiceRecord,
  type ChoiceRecord,
  type PendingBind,
  type PendingChoiceRecord,
  type PendingConfirmationRecord,
} from "@showzy/ai";
import { describe, expect, it } from "vitest";

import { createMemoryPendingStore } from "./pending.js";

const conversationId = "11111111-1111-4111-8111-111111111111";
const otherConversationId = "12121212-1212-4212-8212-121212121212";
const companyId = "22222222-2222-4222-8222-222222222222";
const otherCompanyId = "23232323-2323-4232-8232-232323232323";
const productId = "44444444-4444-4444-8444-444444444444";
const variantLemon = "55555555-5555-4555-8555-555555555555";
const variantVanilla = "66666666-6666-4666-8666-666666666666";
const customerId = "77777777-7777-4777-8777-777777777777";
const optionLemon = "88888888-8888-4888-8888-888888888888";
const optionVanilla = "99999999-9999-4999-8999-999999999999";

const bind: PendingBind = {
  actorId: "anna",
  companyId,
  conversationId,
};

function openChoice(choiceId: string = randomUUID()): PendingChoiceRecord {
  const record: ChoiceRecord = {
    status: "open",
    choiceId,
    actorId: "anna",
    companyId,
    conversationId,
    canonicalInput: {
      customer: { by: "id", id: customerId },
      items: [
        {
          product: { by: "id", id: productId },
          variantSelection: { kind: "unspecified" },
          quantity: { milli: "1000" },
        },
      ],
    },
    target: { lineIndex: 0, productId, productName: "Macarons" },
    optionMap: {
      [optionLemon]: variantLemon,
      [optionVanilla]: variantVanilla,
    },
    envelope: {
      status: "needs_choice",
      challengeId: choiceId,
      reason: "variant_required",
      productName: "Macarons",
      options: [
        { id: optionLemon, label: "Lemon" },
        { id: optionVanilla, label: "Vanilla" },
      ],
      optionsTruncated: false,
    },
  };
  return pendingChoiceRecordFromChoiceRecord(record, {
    actionName: "orders.create",
    toolCallId: "call-create",
    executionId: "exec-choice",
  });
}

function openConfirm(
  challengeId: string = randomUUID(),
): PendingConfirmationRecord {
  return confirmationPendingRecord({
    challengeId,
    approval: { source: "core", challengeId },
    bind,
    actionName: "customers.deleteCustomer",
    toolCallId: "call-delete",
    canonicalInput: { id: customerId },
    summary: "Delete this archived customer.",
    challengeExpiresAt: "2026-09-08T12:00:00.000Z",
    executionId: "exec-confirm",
  });
}

describe("createMemoryPendingStore", () => {
  it("lets the first claim win; a different option is conflict; same option replays", async () => {
    const store = createMemoryPendingStore();
    const record = openChoice();
    expect(await store.open(record)).toBe(true);
    const first = await store.claim({
      id: record.id,
      kind: "choice",
      bind,
      optionId: optionLemon,
    });
    expect(first.kind).toBe("claimed");
    const replay = await store.claim({
      id: record.id,
      kind: "choice",
      bind,
      optionId: optionLemon,
    });
    expect(replay.kind).toBe("replay");
    const other = await store.claim({
      id: record.id,
      kind: "choice",
      bind,
      optionId: optionVanilla,
    });
    expect(other.kind).toBe("conflict");
  });

  it("maps a wrong bind to forbidden (HTTP layer returns expired)", async () => {
    const store = createMemoryPendingStore();
    const record = openChoice();
    expect(await store.open(record)).toBe(true);
    const wrongActor = await store.claim({
      id: record.id,
      kind: "choice",
      bind: { ...bind, actorId: "oleg" },
      optionId: optionLemon,
    });
    expect(wrongActor.kind).toBe("forbidden");
    const wrongCompany = await store.claim({
      id: record.id,
      kind: "choice",
      bind: { ...bind, companyId: otherCompanyId },
      optionId: optionLemon,
    });
    expect(wrongCompany.kind).toBe("forbidden");
    const wrongConversation = await store.claim({
      id: record.id,
      kind: "choice",
      bind: { ...bind, conversationId: otherConversationId },
      optionId: optionLemon,
    });
    expect(wrongConversation.kind).toBe("forbidden");
    const stillOpen = await store.peekOpen({ conversationId, bind });
    expect(stillOpen.kind).toBe("found");
  });

  it("refuses a second open pending on the same conversation", async () => {
    const store = createMemoryPendingStore();
    expect(await store.open(openChoice())).toBe(true);
    expect(await store.open(openChoice())).toBe(false);
    expect(await store.open(openConfirm())).toBe(false);
  });

  it("abandon is version-CAS; stale version is expired; replay abandon is abandoned", async () => {
    const store = createMemoryPendingStore();
    const record = openConfirm();
    expect(await store.open(record)).toBe(true);
    const stale = await store.abandon({
      id: record.id,
      bind,
      expectedVersion: 2,
    });
    expect(stale.kind).toBe("expired");
    const first = await store.abandon({
      id: record.id,
      bind,
      expectedVersion: 1,
    });
    expect(first.kind).toBe("abandoned");
    const replay = await store.abandon({
      id: record.id,
      bind,
      expectedVersion: 1,
    });
    expect(replay.kind).toBe("replay");
    expect(await store.peekOpen({ conversationId, bind })).toEqual({
      kind: "empty",
    });
  });

  it("replace supersedes the old version and opens a new id; stale version expires", async () => {
    const store = createMemoryPendingStore();
    const original = openChoice();
    expect(await store.open(original)).toBe(true);
    const next = openChoice();
    const stale = await store.replace({
      id: original.id,
      bind,
      expectedVersion: 9,
      next,
    });
    expect(stale.kind).toBe("expired");
    const replaced = await store.replace({
      id: original.id,
      bind,
      expectedVersion: 1,
      next,
    });
    expect(replaced.kind).toBe("replaced");
    if (replaced.kind !== "replaced") {
      return;
    }
    expect(replaced.previous.status).toBe("superseded");
    expect(replaced.record.id).toBe(next.id);
    expect(replaced.record.status).toBe("open");
    const oldClaim = await store.claim({
      id: original.id,
      kind: "choice",
      bind,
      optionId: optionLemon,
    });
    expect(oldClaim.kind).toBe("expired");
    const open = await store.peekOpen({ conversationId, bind });
    expect(open.kind).toBe("found");
    if (open.kind === "found") {
      expect(open.record.id).toBe(next.id);
    }
  });

  it("complete after claim; replay of the same resolution; peekOpen is empty", async () => {
    const store = createMemoryPendingStore();
    const record = openChoice();
    expect(await store.open(record)).toBe(true);
    await store.claim({
      id: record.id,
      kind: "choice",
      bind,
      optionId: optionLemon,
    });
    const completed = await store.complete({
      id: record.id,
      kind: "choice",
      bind,
      optionId: optionLemon,
    });
    expect(completed.kind).toBe("completed");
    const replay = await store.complete({
      id: record.id,
      kind: "choice",
      bind,
      optionId: optionLemon,
    });
    expect(replay.kind).toBe("replay");
    expect(await store.peekOpen({ conversationId, bind })).toEqual({
      kind: "empty",
    });
  });
});
