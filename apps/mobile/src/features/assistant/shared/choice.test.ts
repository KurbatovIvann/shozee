import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { assistantCopy } from "../../../i18n/assistant";
import {
  CHOICE_CLAIMED_COPY,
  CHOICE_RETRY_COPY,
  CHOICE_TRUNCATED_COPY,
  CHOICE_TRUNCATED_MATCH_COPY,
  claimedOptionLabel,
  claimedRetryOptionId,
  choiceEnvelopeForWire,
  envelopeFromChoicePeek,
  isRestorableChoiceStatus,
  presentChoiceCardText,
} from "./choice";

const choiceId = "33333333-3333-4333-8333-333333333333";
const lemonId = "88888888-8888-4888-8888-888888888888";

const openEnvelope = {
  status: "needs_choice" as const,
  challengeId: choiceId,
  reason: "variant_required" as const,
  productName: "Macarons",
  options: [{ id: lemonId, label: "Lemon" }],
  optionsTruncated: false,
};

describe("envelopeFromChoicePeek", () => {
  it("expands T8a { status: expired } into a non-tappable expired envelope", () => {
    expect(envelopeFromChoicePeek(choiceId, { status: "expired" })).toEqual({
      status: "expired",
      challengeId: choiceId,
      options: [],
      optionsTruncated: false,
    });
  });

  it("keeps a live peek envelope", () => {
    expect(envelopeFromChoicePeek(choiceId, openEnvelope)).toEqual(
      openEnvelope,
    );
  });

  it("keeps a claimed peek envelope with the opaque claimedOptionId", () => {
    const claimed = {
      ...openEnvelope,
      status: "claimed" as const,
      claimedOptionId: lemonId,
    };
    expect(envelopeFromChoicePeek(choiceId, claimed)).toEqual(claimed);
    expect(
      choiceEnvelopeForWire({
        ...claimed,
        canonicalInput: { customer: { by: "id", id: choiceId } },
        target: { lineIndex: 0, productId: choiceId, productName: "Macarons" },
        optionMap: { [lemonId]: choiceId },
      }),
    ).toEqual(claimed);
    expect(isRestorableChoiceStatus("claimed")).toBe(true);
    expect(isRestorableChoiceStatus("completed")).toBe(false);
    expect(claimedRetryOptionId(claimed)).toBe(lemonId);
    expect(claimedOptionLabel(claimed)).toBe("Lemon");
    expect(claimedRetryOptionId(openEnvelope)).toBeUndefined();
  });

  it("does not treat an unreadable peek as expired", () => {
    expect(envelopeFromChoicePeek(choiceId, "nope")).toBeUndefined();
    expect(
      envelopeFromChoicePeek(choiceId, {
        code: "INTERNAL",
        status: 500,
        message: "Internal error.",
      }),
    ).toBeUndefined();
  });
});

describe("choiceEnvelopeForWire", () => {
  it("keeps a valid envelope and drops canonicalInput, target, and optionMap", () => {
    expect(
      choiceEnvelopeForWire({
        ...openEnvelope,
        canonicalInput: { customer: { by: "id", id: choiceId } },
        target: { lineIndex: 0, productId: choiceId, productName: "Macarons" },
        optionMap: { [lemonId]: choiceId },
      }),
    ).toEqual(openEnvelope);
  });
});

describe("choice truncated copy", () => {
  it("matches presenter copy and ChoiceCard i18n", () => {
    expect(CHOICE_TRUNCATED_COPY.en).toBe(
      "More variants exist. Reply with the exact flavour name.",
    );
    expect(CHOICE_TRUNCATED_COPY.uk).toBe(
      "Є ще варіанти. Напишіть точну назву смаку.",
    );
    const en = assistantCopy("en");
    const uk = assistantCopy("uk");
    expect(en.choiceTruncated).toBe(CHOICE_TRUNCATED_COPY.en);
    expect(uk.choiceTruncated).toBe(CHOICE_TRUNCATED_COPY.uk);
    expect(en.choiceTruncatedMatch).toBe(CHOICE_TRUNCATED_MATCH_COPY.en);
    expect(uk.choiceTruncatedMatch).toBe(CHOICE_TRUNCATED_MATCH_COPY.uk);
    expect(en.choiceClaimed).toBe(CHOICE_CLAIMED_COPY.en);
    expect(uk.choiceClaimed).toBe(CHOICE_CLAIMED_COPY.uk);
    expect(en.choiceRetry).toBe(CHOICE_RETRY_COPY.en);
    expect(uk.choiceRetry).toBe(CHOICE_RETRY_COPY.uk);
    expect(
      presentChoiceCardText({ ...openEnvelope, optionsTruncated: true }, "en"),
    ).toContain(CHOICE_TRUNCATED_COPY.en);
    expect(
      presentChoiceCardText(
        {
          ...openEnvelope,
          reason: "ambiguous",
          choiceKind: "product",
          productName: "макаронс",
          options: [{ id: lemonId, label: "Макаронси" }],
        },
        "en",
      ),
    ).toBe("Select a product matching макаронс: Макаронси.");
    expect(
      presentChoiceCardText(
        {
          ...openEnvelope,
          reason: "ambiguous",
          choiceKind: "customer",
          productName: "Katya",
          options: [{ id: lemonId, label: "Katya (…2233)" }],
          optionsTruncated: true,
        },
        "uk",
      ),
    ).toContain(CHOICE_TRUNCATED_MATCH_COPY.uk);
  });

  it("does not import @showzy/ai from ChoiceCard", () => {
    const card = readFileSync(
      new URL("../sheet/choice-card.tsx", import.meta.url),
      "utf8",
    );
    expect(card).toContain("ChoiceCard");
    expect(card).not.toContain("@showzy/ai");
    expect(card).toContain("Button");
    expect(card).toContain("Card");
    expect(card).toContain("choiceCardRetryOptionId");
    expect(card).toContain("choiceCardOfferedOptions");
    expect(card).toContain("attempted");
    expect(card).toContain("retryLabel");
    expect(card).not.toContain("props.choice.options.map");
    expect(card).not.toContain("completed");
  });
});
