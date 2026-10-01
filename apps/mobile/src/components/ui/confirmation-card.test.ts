import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { confirmationCardUk } from "../../i18n/copy";
import { confirmationCardView } from "./confirmation-card.model";

const CARD_SOURCE = readFileSync(
  new URL("./confirmation-card.tsx", import.meta.url),
  "utf8",
);

const CALL_SITES = [
  "../../features/customers/groups/use-group-writes.ts",
  "../../features/customers/shared/use-counterparty-delete-write.ts",
  "../../features/customers/shared/use-customer-status-writes.ts",
  "../../features/documents/signing/use-document-signing.ts",
  "../../features/pricing/list/use-price-list-writes.ts",
] as const;

describe("confirmationCardView", () => {
  it("renders the server preview title, lines and notes verbatim", () => {
    expect(
      confirmationCardView(
        {
          challengeId: "ch-1",
          summary: "Delete?",
          preview: {
            title: "Видалити клієнта?",
            lines: [{ label: "Клієнт", value: "ТОВ «Ромашка»" }],
            notes: ["Цю дію не можна скасувати."],
          },
        },
        confirmationCardUk.fallbackTitle,
      ),
    ).toEqual({
      title: "Видалити клієнта?",
      lines: [{ label: "Клієнт", value: "ТОВ «Ромашка»" }],
      notes: ["Цю дію не можна скасувати."],
      summary: null,
    });
  });

  it("keeps a preview without notes as an empty note list", () => {
    expect(
      confirmationCardView(
        {
          challengeId: "ch-2",
          summary: "Delete?",
          preview: { title: "Видалити групу?", lines: [] },
        },
        confirmationCardUk.fallbackTitle,
      ).notes,
    ).toEqual([]);
  });

  it("falls back to the legacy summary when no preview is bound", () => {
    expect(
      confirmationCardView(
        { challengeId: "ch-3", summary: "Delete this counterparty?" },
        confirmationCardUk.fallbackTitle,
      ),
    ).toEqual({
      title: confirmationCardUk.fallbackTitle,
      lines: [],
      notes: [],
      summary: "Delete this counterparty?",
    });
  });

  it("shows no body when the challenge carries neither preview nor summary", () => {
    expect(
      confirmationCardView(
        { challengeId: "ch-4", summary: "" },
        confirmationCardUk.fallbackTitle,
      ).summary,
    ).toBeNull();
  });
});

describe("confirmation card presenter wiring", () => {
  it("renders title, lines and notes from the view, not from local copy", () => {
    expect(CARD_SOURCE).toContain("view.title");
    expect(CARD_SOURCE).toContain("view.lines.map");
    expect(CARD_SOURCE).toContain("view.notes.map");
    expect(CARD_SOURCE).toContain("view.summary");
  });

  it("sends every former confirm call site through the presenter", () => {
    for (const site of CALL_SITES) {
      const source = readFileSync(new URL(site, import.meta.url), "utf8");
      expect(source, site).toContain("useConfirmationCard");
      expect(source, site).toContain("present: (challenge)");
      expect(source, site).toContain('result.outcome === "declined"');
    }
  });

  it("leaves no hand-written delete or sign confirm copy at those call sites", () => {
    for (const site of CALL_SITES) {
      const source = readFileSync(new URL(site, import.meta.url), "utf8");
      expect(source, site).not.toContain("deleteGroupTitle");
      expect(source, site).not.toContain("deleteCounterpartyTitle");
      expect(source, site).not.toContain("confirm.deleteTitle");
      expect(source, site).not.toContain("signTitle");
    }
  });
});
