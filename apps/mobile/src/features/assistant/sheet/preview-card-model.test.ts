import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type {
  AssistantPreview,
  AssistantPreviewLevel,
} from "@showzy/validation/assistant-chat";

import {
  assistantPreviewCardModel,
  assistantPreviewPresentationKey,
  type AssistantPreviewCardCopy,
} from "./preview-card-model";

const PREVIEW_CARD = readFileSync(
  new URL("./preview-card.tsx", import.meta.url),
  "utf8",
);
const SERVER_CARD = readFileSync(
  new URL("../../../components/ui/confirmation-card.tsx", import.meta.url),
  "utf8",
);

const copy: AssistantPreviewCardCopy = {
  confirmationTitle: "Потрібне підтвердження",
  confirmLabel: "Підтвердити",
  confirmingLabel: "Підтверджую…",
  dismissLabel: "Скасувати",
  previewAlso: "Також",
  previewStrongLabel: "Незворотна дія",
  previewStrongWarning: "Перевір дані.",
  previewStrongConfirm: "Так, виконати",
};

const preview: AssistantPreview = {
  title: "Нове замовлення для «Ромашка»",
  lines: [
    { label: "Клієнт", value: "Ромашка" },
    { label: "Сума", value: "1 200,00 ₴" },
  ],
  notes: ["Ціну взято з прайсу «Опт»."],
};

const INTERACTION_ID = "6f1a3c2e-1f3b-4c5d-8e9f-0a1b2c3d4e5f";
const OTHER_INTERACTION_ID = "7a2b4d3f-2a4c-4d6e-9f0a-1b2c3d4e5f60";

function model(
  input: Partial<Parameters<typeof assistantPreviewCardModel>[0]> = {},
) {
  return assistantPreviewCardModel({
    interactionId: INTERACTION_ID,
    revision: 1,
    summary: "Створю замовлення",
    preview,
    also: [],
    level: "card",
    applying: false,
    armedKey: null,
    copy,
    ...input,
  });
}

function armedKeyFor(interactionId: string, revision: number): string {
  return assistantPreviewPresentationKey({ interactionId, revision });
}

function tapUntilAnswered(args: {
  readonly level: AssistantPreviewLevel;
  readonly taps: number;
}): { readonly answers: number; readonly armedKey: string | null } {
  let armedKey: string | null = null;
  let answers = 0;
  for (let tap = 0; tap < args.taps; tap += 1) {
    const view = model({ level: args.level, armedKey });
    if (view.primary === null) {
      continue;
    }
    if (view.primary.arms) {
      armedKey = view.presentationKey;
      continue;
    }
    answers += 1;
  }
  return { answers, armedKey };
}

describe("assistantPreviewCardModel", () => {
  it("renders the server preview verbatim under the confirmation eyebrow", () => {
    const view = model();

    expect(view.eyebrow).toBe(copy.confirmationTitle);
    expect(view.strong).toBe(false);
    expect(view.warning).toBeNull();
    expect(view.title).toBe(preview.title);
    expect(view.summary).toBe("Створю замовлення");
    expect(view.blocks).toHaveLength(1);
    expect(view.blocks[0]?.lines).toEqual(preview.lines);
    expect(view.blocks[0]?.notes).toEqual(preview.notes);
    expect(view.blocks[0]?.caption).toBeNull();
  });

  it("drops a summary that only repeats the preview title", () => {
    expect(model({ summary: preview.title }).summary).toBeNull();
    expect(model({ summary: "" }).summary).toBeNull();
  });

  it("puts every `also` preview on the same card, captioned once", () => {
    const second: AssistantPreview = {
      title: "Новий клієнт «Ромашка»",
      lines: [{ label: "Телефон", value: "+380991234567" }],
      notes: [],
    };
    const third: AssistantPreview = {
      title: "Нова адреса",
      lines: [],
      notes: ["Доставка Новою поштою."],
    };

    const view = model({ also: [second, third] });

    expect(view.blocks.map((block) => block.title)).toEqual([
      preview.title,
      second.title,
      third.title,
    ]);
    expect(view.blocks.map((block) => block.caption)).toEqual([
      null,
      copy.previewAlso,
      null,
    ]);
    expect(new Set(view.blocks.map((block) => block.key)).size).toBe(3);
  });

  it("asks a strong preview twice, with a warning and the first tap arming", () => {
    const unarmed = model({ level: "strong" });

    expect(unarmed.eyebrow).toBe(copy.previewStrongLabel);
    expect(unarmed.strong).toBe(true);
    expect(unarmed.warning).toBe(copy.previewStrongWarning);
    expect(unarmed.primary).toEqual({
      label: copy.confirmLabel,
      danger: false,
      arms: true,
    });

    const armed = model({
      level: "strong",
      armedKey: armedKeyFor(INTERACTION_ID, 1),
    });

    expect(armed.primary).toEqual({
      label: copy.previewStrongConfirm,
      danger: true,
      arms: false,
    });
  });

  it("confirms a card-level preview on the first tap", () => {
    expect(model().primary?.arms).toBe(false);
    expect(
      model({ armedKey: armedKeyFor(INTERACTION_ID, 1) }).primary?.label,
    ).toBe(copy.confirmLabel);
  });

  it("drops the arm when the same pause comes back revised", () => {
    const revised = model({
      level: "strong",
      revision: 2,
      armedKey: armedKeyFor(INTERACTION_ID, 1),
    });

    expect(revised.primary?.arms).toBe(true);
    expect(revised.primary?.danger).toBe(false);
    expect(revised.primary?.label).toBe(copy.confirmLabel);
  });

  it("starts a next pause unarmed when it lands on the same row", () => {
    const next = model({
      level: "strong",
      interactionId: OTHER_INTERACTION_ID,
      armedKey: armedKeyFor(INTERACTION_ID, 1),
    });

    expect(next.presentationKey).not.toBe(armedKeyFor(INTERACTION_ID, 1));
    expect(next.primary?.arms).toBe(true);
  });

  it("takes both buttons away while the answer is in flight", () => {
    const view = model({
      applying: true,
      level: "strong",
      armedKey: armedKeyFor(INTERACTION_ID, 1),
    });

    expect(view.primary).toBeNull();
    expect(view.dismissLabel).toBeNull();
    expect(view.applyingLabel).toBe(copy.confirmingLabel);
    expect(view.blocks[0]?.lines).toEqual(preview.lines);
  });

  it("spends the first tap on a strong preview arming, never answering", () => {
    expect(tapUntilAnswered({ level: "strong", taps: 1 })).toEqual({
      answers: 0,
      armedKey: armedKeyFor(INTERACTION_ID, 1),
    });
    expect(tapUntilAnswered({ level: "strong", taps: 2 }).answers).toBe(1);
    expect(tapUntilAnswered({ level: "card", taps: 1 }).answers).toBe(1);
  });
});

describe("preview chrome", () => {
  it("draws lines and notes from the one shared presenter in both cards", () => {
    expect(PREVIEW_CARD).toContain("<PreviewDetails");
    expect(SERVER_CARD).toContain("<PreviewDetails");
    expect(PREVIEW_CARD).not.toContain("lineLabel");
    expect(SERVER_CARD).not.toContain("lineLabel");
  });
});
