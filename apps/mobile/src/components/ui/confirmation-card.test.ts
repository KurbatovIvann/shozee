import { readFileSync } from "node:fs";

import { ORPCError } from "@orpc/client";
import { describe, expect, it, vi } from "vitest";

import { submitWithProtocolConfirmation } from "../../api/protocol-confirm";
import { confirmationCardUk } from "../../i18n/copy";
import {
  CLOSED_CONFIRMATION_CARD,
  createConfirmationCardMachine,
  type ConfirmationCardState,
} from "./confirmation-card.machine";
import {
  confirmationCardView,
  type ConfirmationCardView,
} from "./confirmation-card.model";

const CARD_SOURCE = readFileSync(
  new URL("./confirmation-card.tsx", import.meta.url),
  "utf8",
);

function cardNamed(title: string): ConfirmationCardView {
  return { title, lines: [], notes: [], summary: null };
}

function confirmationRequired(challengeId: string) {
  return new ORPCError("CONFIRMATION_REQUIRED", {
    defined: true,
    status: 409,
    message: "Confirm.",
    data: {
      challenge: {
        challengeId,
        summary: "Delete?",
        expiresAt: "2026-08-28T00:00:00.000Z",
      },
    },
  });
}

function machineUnderTest() {
  const states: ConfirmationCardState[] = [];
  const machine = createConfirmationCardMachine({
    onState: (state) => states.push(state),
  });
  return { machine, states };
}

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

describe("createConfirmationCardMachine", () => {
  it("opens on present and settles the choice the viewer made", async () => {
    const { machine, states } = machineUnderTest();
    const choice = machine.present(cardNamed("Видалити групу?"));
    expect(states.at(-1)).toEqual({
      open: true,
      card: cardNamed("Видалити групу?"),
    });
    machine.choose("confirm");
    expect(await choice).toBe("confirm");
    expect(states.at(-1)?.open).toBe(false);
  });

  it("cancels the first challenge when a second one is presented", async () => {
    const { machine, states } = machineUnderTest();
    const first = machine.present(cardNamed("Перший"));
    const second = machine.present(cardNamed("Другий"));
    expect(await first).toBe("cancel");
    expect(states.at(-1)).toEqual({ open: true, card: cardNamed("Другий") });
    machine.choose("confirm");
    expect(await second).toBe("confirm");
  });

  it("settles cancel when the card closes and clears the card after it hides", async () => {
    const { machine, states } = machineUnderTest();
    const choice = machine.present(cardNamed("Видалити клієнта?"));
    machine.choose("cancel");
    expect(await choice).toBe("cancel");
    expect(states.at(-1)).toEqual({
      open: false,
      card: cardNamed("Видалити клієнта?"),
    });
    machine.clearCard();
    expect(states.at(-1)).toEqual(CLOSED_CONFIRMATION_CARD);
  });

  it("never confirms the write when the viewer declines the card", async () => {
    const { machine } = machineUnderTest();
    const confirm = vi.fn(() => Promise.resolve("confirmed"));
    const pending = submitWithProtocolConfirmation({
      submit: () => Promise.reject(confirmationRequired("ch-9")),
      present: (challenge) =>
        machine.present(
          confirmationCardView(challenge, confirmationCardUk.fallbackTitle),
        ),
      confirm,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    machine.choose("cancel");
    expect(await pending).toEqual({ outcome: "declined" });
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe("confirmation card presenter wiring", () => {
  it("renders title, lines and notes from the view, not from local copy", () => {
    expect(CARD_SOURCE).toContain("view.title");
    expect(CARD_SOURCE).toContain("view.lines.map");
    expect(CARD_SOURCE).toContain("view.notes.map");
    expect(CARD_SOURCE).toContain("view.summary");
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
