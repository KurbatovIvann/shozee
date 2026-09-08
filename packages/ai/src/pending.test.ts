import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CHOICE_TTL_MS } from "./choice.js";
import {
  assistantResumeEnvelopeSchema,
  confirmationPendingRecord,
  parsePendingRecord,
  pendingChoiceRecordFromChoiceRecord,
  pendingOpenRefuseOutput,
  pendingRedisKey,
  pendingTtlMs,
  publicPendingFromRecord,
  serializePendingRecord,
  PENDING_CONFIRMATION_TTL_MS,
  PENDING_OPEN_CODE,
  PENDING_REPLACE_TOOL_NAME,
} from "./pending.js";

const here = dirname(fileURLToPath(import.meta.url));
const conversationId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const choiceId = "33333333-3333-4333-8333-333333333333";
const challengeId = "44444444-4444-4444-8444-444444444444";
const customerId = "55555555-5555-4555-8555-555555555555";
const productId = "66666666-6666-4666-8666-666666666666";
const optionId = "77777777-7777-4777-8777-777777777777";
const variantId = "88888888-8888-4888-8888-888888888888";

describe("pending record schema", () => {
  it("serializes a choice record without dropping canonical input, and public view omits it", () => {
    const record = pendingChoiceRecordFromChoiceRecord(
      {
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
              quantity: { milli: "1000" },
            },
          ],
        },
        target: { lineIndex: 0, productId, productName: "Macarons" },
        optionMap: { [optionId]: variantId },
        envelope: {
          status: "needs_choice",
          challengeId: choiceId,
          reason: "variant_required",
          productName: "Macarons",
          options: [{ id: optionId, label: "Lemon" }],
          optionsTruncated: false,
        },
      },
      {
        actionName: "orders.create",
        toolCallId: "call-create",
        executionId: "exec-1",
      },
    );
    const roundTrip = parsePendingRecord(serializePendingRecord(record));
    expect(roundTrip).toMatchObject({
      kind: "choice",
      id: choiceId,
      actionName: "orders.create",
      executionId: "exec-1",
      canonicalInput: record.canonicalInput,
    });
    const publicView = publicPendingFromRecord(record);
    expect(publicView).toMatchObject({
      kind: "choice",
      id: choiceId,
      version: 1,
      status: "open",
    });
    expect(JSON.stringify(publicView)).not.toContain("canonicalInput");
    expect(JSON.stringify(publicView)).not.toContain(customerId);
  });

  it("uses the core challengeId as the confirmation pending id", () => {
    const record = confirmationPendingRecord({
      challengeId,
      bind: { actorId: "anna", companyId, conversationId },
      actionName: "customers.deleteCustomer",
      toolCallId: "call-delete",
      canonicalInput: { id: customerId },
      summary: "Delete this archived customer.",
      challengeExpiresAt: "2026-09-08T12:00:00.000Z",
      executionId: "exec-confirm",
    });
    expect(record.id).toBe(challengeId);
    expect(record.kind).toBe("confirmation");
    const publicView = publicPendingFromRecord(record);
    expect(publicView).toMatchObject({
      kind: "confirmation",
      id: challengeId,
      challengeId,
      actionName: "customers.deleteCustomer",
    });
    expect(JSON.stringify(publicView)).not.toContain("canonicalInput");
  });

  it("namespaces pending Redis keys by kind so confirmation never GETDELs", () => {
    expect(pendingRedisKey("choice", choiceId)).toBe(
      `pending:choice:${choiceId}`,
    );
    expect(pendingRedisKey("confirmation", challengeId)).toBe(
      `pending:confirmation:${challengeId}`,
    );
  });

  it("keeps confirmation TTL longer than core's 5 minutes by a short grace, shorter than choice", () => {
    expect(PENDING_CONFIRMATION_TTL_MS).toBe(5 * 60 * 1000 + 15_000);
    expect(pendingTtlMs("confirmation")).toBe(PENDING_CONFIRMATION_TTL_MS);
    expect(pendingTtlMs("choice")).toBe(CHOICE_TTL_MS);
    expect(pendingTtlMs("choice")).toBeGreaterThan(
      pendingTtlMs("confirmation"),
    );
  });

  it("parses the shared resume envelope for surfaces, choice, and confirmation", () => {
    const parsed = assistantResumeEnvelopeSchema.parse({
      speech: "Pick a flavour.",
      cards: [
        {
          kind: "surface",
          surface: "orders-list",
          data: { kind: "orders-list" },
        },
        {
          kind: "choice",
          envelope: {
            status: "needs_choice",
            challengeId: choiceId,
            reason: "variant_required",
            productName: "Macarons",
            options: [{ id: optionId, label: "Lemon" }],
            optionsTruncated: false,
          },
        },
        {
          kind: "confirmation",
          envelope: {
            status: "confirmation_required",
            challengeId,
            summary: "Delete this archived customer.",
            expiresAt: "2026-09-08T12:00:00.000Z",
            actionName: "customers.deleteCustomer",
            toolCallId: "call-delete",
          },
        },
      ],
      pending: {
        kind: "choice",
        id: choiceId,
        version: 1,
        status: "open",
        actionName: "orders.create",
        envelope: {
          status: "needs_choice",
          challengeId: choiceId,
          reason: "variant_required",
          productName: "Macarons",
          options: [{ id: optionId, label: "Lemon" }],
          optionsTruncated: false,
        },
      },
    });
    expect(parsed.cards).toHaveLength(3);
    expect(parsed.pending?.kind).toBe("choice");
  });

  it("structured refuse uses PENDING_OPEN and does not live in implementAction", () => {
    const refuse = pendingOpenRefuseOutput("en");
    expect(refuse).toEqual({
      status: "error",
      code: PENDING_OPEN_CODE,
      message: expect.stringContaining("replace"),
    });
    const pendingSrc = readFileSync(join(here, "pending.ts"), "utf8");
    expect(pendingSrc).not.toContain("implementAction");
    expect(PENDING_REPLACE_TOOL_NAME).toBe("pending_replace");
  });
});
