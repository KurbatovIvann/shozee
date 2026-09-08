import { describe, expect, it } from "vitest";

import {
  choiceEnvelopeFromPublicPending,
  confirmationFromPublicPending,
  entityFromResumeCards,
  partsFromResumeEnvelope,
  pendingHostMetaFromPublic,
  assistantHostInteractionResultSchema,
  assistantResumeEnvelopeSchema,
} from "./resume-envelope";

const challengeId = "22222222-2222-4222-8222-222222222222";
const choiceId = "33333333-3333-4333-8333-333333333333";
const optionId = "88888888-8888-4888-8888-888888888888";
const orderId = "0f0e2d5c-4a1b-4c3d-9e8f-102938475601";

const confirmationPending = {
  kind: "confirmation" as const,
  id: challengeId,
  version: 1,
  status: "open" as const,
  actionName: "customers.deleteCustomer",
  challengeId,
  summary: "Delete this archived customer.",
  expiresAt: "2026-09-08T12:00:00.000Z",
  toolCallId: "call-delete",
};

const choicePending = {
  kind: "choice" as const,
  id: choiceId,
  version: 3,
  status: "open" as const,
  actionName: "orders.create",
  envelope: {
    status: "needs_choice" as const,
    challengeId: choiceId,
    reason: "variant_required" as const,
    productName: "Macarons",
    options: [{ id: optionId, label: "Lemon" }],
    optionsTruncated: false,
  },
};

describe("shared resume envelope (SHO-522)", () => {
  it("parses the same schema for choice and confirm", () => {
    const choiceBody = {
      speech: "Select a variant.",
      cards: [{ kind: "choice", envelope: choicePending.envelope }],
      pending: choicePending,
    };
    const confirmBody = {
      speech: "Confirm delete.",
      cards: [
        {
          kind: "confirmation",
          envelope: confirmationFromPublicPending(confirmationPending),
        },
      ],
      pending: confirmationPending,
    };
    expect(assistantResumeEnvelopeSchema.parse(choiceBody).pending?.kind).toBe(
      "choice",
    );
    expect(assistantResumeEnvelopeSchema.parse(confirmBody).pending?.kind).toBe(
      "confirmation",
    );
    expect(
      assistantHostInteractionResultSchema.parse({
        status: "ok",
        ...choiceBody,
      }).status,
    ).toBe("ok");
    expect(
      assistantHostInteractionResultSchema.parse({
        status: "ok",
        ...confirmBody,
      }).status,
    ).toBe("ok");
  });

  it("omits canonical input from public pending", () => {
    const parsed = assistantResumeEnvelopeSchema.parse({
      speech: "Select a variant.",
      cards: [],
      pending: choicePending,
    });
    expect(JSON.stringify(parsed)).not.toContain("canonicalInput");
    expect(JSON.stringify(parsed)).not.toContain("optionMap");
  });

  it("maps envelope cards into chat parts including a successor picker", () => {
    const envelope = assistantResumeEnvelopeSchema.parse({
      speech: "Pick the next line.",
      cards: [
        { kind: "choice", envelope: choicePending.envelope },
        {
          kind: "surface",
          surface: "order-entity",
          data: { kind: "order-entity", orderId, orderNumber: "1049" },
        },
      ],
      pending: choicePending,
    });
    const parts = partsFromResumeEnvelope(envelope);
    expect(parts[0]).toEqual({ type: "text", text: "Pick the next line." });
    expect(parts[1]).toEqual({
      type: "data-choice",
      data: choicePending.envelope,
    });
    expect(parts.some((part) => part.type === "dynamic-tool")).toBe(true);
    expect(entityFromResumeCards(envelope.cards)).toEqual({
      orderId,
      orderNumber: "1049",
    });
    expect(choiceEnvelopeFromPublicPending(choicePending).challengeId).toBe(
      choiceId,
    );
    expect(pendingHostMetaFromPublic(confirmationPending)).toEqual({
      id: challengeId,
      version: 1,
      kind: "confirmation",
    });
  });
});
