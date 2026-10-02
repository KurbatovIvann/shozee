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
import { SHEET_MS } from "./sheet-dismiss";

const CARD_SOURCE = readFileSync(
  new URL("./confirmation-card.tsx", import.meta.url),
  "utf8",
);

const HOST_SOURCE = readFileSync(
  new URL("./confirmation-card-host.tsx", import.meta.url),
  "utf8",
);

function cardNamed(title: string): ConfirmationCardView {
  return { title, lines: [], notes: [], summary: null, tone: "default" };
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
        risk: "high",
      },
    },
  });
}

type PendingArm = {
  readonly run: () => void;
  readonly delayMs: number;
  cancelled: boolean;
};

function machineUnderTest() {
  const states: ConfirmationCardState[] = [];
  const arms: PendingArm[] = [];
  const machine = createConfirmationCardMachine({
    onState: (state) => states.push(state),
    armDelayMs: SHEET_MS,
    schedule: (run, delayMs) => {
      const pending: PendingArm = { run, delayMs, cancelled: false };
      arms.push(pending);
      return () => {
        pending.cancelled = true;
      };
    },
  });
  function runArm(index: number): void {
    const pending = arms[index];
    if (pending === undefined || pending.cancelled) {
      return;
    }
    pending.run();
  }
  function settleSheet(): void {
    runArm(arms.length - 1);
  }
  return { machine, states, arms, runArm, settleSheet };
}

function openCard(
  card: ConfirmationCardView,
  presentationId: number,
): ConfirmationCardState {
  return { open: true, card, presentationId, confirmArmed: false };
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
      tone: "default",
    });
  });

  it("shows the requestSign warning the short title omits", () => {
    const warning =
      "Підтвердження не замінює володіння ключем — документ підписують на вашому пристрої.";
    expect(
      confirmationCardView(
        {
          challengeId: "ch-5",
          summary: "Запросити підписання документа KA-РХ-000001",
          preview: {
            title: "Запросити підписання документа KA-РХ-000001",
            lines: [{ label: "Документ", value: "KA-РХ-000001" }],
            notes: [warning],
          },
        },
        confirmationCardUk.fallbackTitle,
      ),
    ).toEqual({
      title: "Запросити підписання документа KA-РХ-000001",
      lines: [{ label: "Документ", value: "KA-РХ-000001" }],
      notes: [warning],
      summary: null,
      tone: "default",
    });
  });

  it("keeps the notes of a title the one-line header truncates", () => {
    const longTitle =
      "Поділитися документом KA-РХ-000001 з контрагентом «Науково-виробниче об'єднання Промислові Технології та Сервіс»";
    expect(
      confirmationCardView(
        {
          challengeId: "ch-6",
          summary: longTitle,
          preview: {
            title: longTitle,
            lines: [{ label: "Документ", value: "KA-РХ-000001" }],
            notes: ["Буде створено нове посилання, і воно діє 90 днів."],
          },
        },
        confirmationCardUk.fallbackTitle,
      ),
    ).toEqual({
      title: longTitle,
      lines: [{ label: "Документ", value: "KA-РХ-000001" }],
      notes: ["Буде створено нове посилання, і воно діє 90 днів."],
      summary: null,
      tone: "default",
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
      tone: "default",
    });
  });

  it("takes the danger tone from a high-risk challenge, not a local action list", () => {
    expect(
      confirmationCardView(
        {
          challengeId: "ch-7",
          summary: "Видалити клієнта?",
          risk: "high",
          preview: { title: "Видалити клієнта?", lines: [] },
        },
        confirmationCardUk.fallbackTitle,
      ).tone,
    ).toBe("danger");
    expect(
      confirmationCardView(
        { challengeId: "ch-8", summary: "Зберегти зміни?", risk: "write" },
        confirmationCardUk.fallbackTitle,
      ).tone,
    ).toBe("default");
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
    const { machine, states, settleSheet } = machineUnderTest();
    const card = cardNamed("Видалити групу?");
    const choice = machine.present(card);
    expect(states.at(-1)).toEqual(openCard(card, 1));
    settleSheet();
    machine.choose("confirm");
    expect(await choice).toBe("confirm");
    expect(states.at(-1)?.open).toBe(false);
  });

  it("arms the confirm only once the sheet-settle delay has elapsed", () => {
    const { machine, states, arms, settleSheet } = machineUnderTest();
    void machine.present(cardNamed("Видалити групу?"));
    expect(arms.at(-1)?.delayMs).toBe(SHEET_MS);
    expect(states.at(-1)?.confirmArmed).toBe(false);
    settleSheet();
    expect(states.at(-1)?.confirmArmed).toBe(true);
  });

  it("cancels the pending arm of the card a re-present replaced", () => {
    const { machine, states, arms, runArm } = machineUnderTest();
    void machine.present(cardNamed("Перший"));
    void machine.present(cardNamed("Другий"));
    expect(arms[0]?.cancelled).toBe(true);
    runArm(0);
    expect(states.at(-1)?.confirmArmed).toBe(false);
  });

  it("cancels the first challenge when a second one is presented", async () => {
    const { machine, states, settleSheet } = machineUnderTest();
    const secondCard = cardNamed("Другий");
    const first = machine.present(cardNamed("Перший"));
    const second = machine.present(secondCard);
    expect(await first).toBe("cancel");
    expect(states.at(-1)).toEqual(openCard(secondCard, 2));
    settleSheet();
    machine.choose("confirm");
    expect(await second).toBe("confirm");
  });

  it("ignores a confirm press that lands before the re-presented card arms", async () => {
    const { machine, states, settleSheet } = machineUnderTest();
    const firstCard = cardNamed("Перший");
    const driftedCard = cardNamed("Оновлений");
    const first = machine.present(firstCard);
    settleSheet();
    machine.choose("confirm");
    expect(await first).toBe("confirm");

    const drifted = machine.present(driftedCard);
    const settled = vi.fn();
    void drifted.then(settled);
    machine.choose("confirm");
    await Promise.resolve();

    expect(settled).not.toHaveBeenCalled();
    expect(states.at(-1)).toEqual(openCard(driftedCard, 2));

    settleSheet();
    machine.choose("confirm");
    expect(await drifted).toBe("confirm");
  });

  it("does not arm a card the viewer is no longer looking at", async () => {
    const { machine, states } = machineUnderTest();
    const staleCard = cardNamed("Застарілий");
    const freshCard = cardNamed("Новий");
    const stale = machine.present(staleCard);
    const fresh = machine.present(freshCard);
    expect(await stale).toBe("cancel");

    machine.armConfirm(1);
    expect(states.at(-1)).toEqual(openCard(freshCard, 2));
    const settled = vi.fn();
    void fresh.then(settled);
    machine.choose("confirm");
    await Promise.resolve();

    expect(settled).not.toHaveBeenCalled();
    machine.choose("cancel");
    expect(await fresh).toBe("cancel");
  });

  it("settles cancel when the card closes and clears the card after it hides", async () => {
    const { machine, states } = machineUnderTest();
    const choice = machine.present(cardNamed("Видалити клієнта?"));
    machine.choose("cancel");
    expect(await choice).toBe("cancel");
    expect(states.at(-1)).toEqual({
      open: false,
      card: cardNamed("Видалити клієнта?"),
      presentationId: 1,
      confirmArmed: false,
    });
    machine.clearCard();
    expect(states.at(-1)).toEqual(CLOSED_CONFIRMATION_CARD);
  });

  it("ignores a late hide callback that arrives after the next card opened", async () => {
    const { machine, states, settleSheet } = machineUnderTest();
    const secondCard = cardNamed("Другий");
    const first = machine.present(cardNamed("Перший"));
    machine.choose("cancel");
    expect(await first).toBe("cancel");
    const second = machine.present(secondCard);
    machine.clearCard();
    expect(states.at(-1)).toEqual(openCard(secondCard, 2));
    settleSheet();
    machine.choose("confirm");
    expect(await second).toBe("confirm");
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
    expect(CARD_SOURCE).toContain("lines={view.lines}");
    expect(CARD_SOURCE).toContain("notes={view.notes}");
    expect(CARD_SOURCE).toContain("view.summary");
  });

  it("drives the primary button tone from the view, not a hardcoded variant", () => {
    expect(CARD_SOURCE).toContain(
      'variant={view.tone === "danger" ? "danger" : "primary"}',
    );
  });

  it("disables the confirm button until the presentation arms", () => {
    expect(CARD_SOURCE).toContain("disabled={props.confirmDisabled}");
    expect(HOST_SOURCE).toContain("confirmDisabled={!state.confirmArmed}");
  });

  it("leaves the arm schedule to the machine instead of a host timer", () => {
    expect(HOST_SOURCE).not.toContain("setTimeout");
    expect(HOST_SOURCE).toContain("armDelayMs: SHEET_MS");
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
