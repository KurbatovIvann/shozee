import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { AssistantPreview } from "@showzy/validation/assistant-chat";

import {
  assistantPreviewCardModel,
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

function model(
  input: Partial<Parameters<typeof assistantPreviewCardModel>[0]> = {},
) {
  return assistantPreviewCardModel({
    summary: "Створю замовлення",
    preview,
    also: [],
    level: "card",
    applying: false,
    armed: false,
    copy,
    ...input,
  });
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

    const armed = model({ level: "strong", armed: true });

    expect(armed.primary).toEqual({
      label: copy.previewStrongConfirm,
      danger: true,
      arms: false,
    });
  });

  it("confirms a card-level preview on the first tap", () => {
    expect(model().primary?.arms).toBe(false);
    expect(model({ armed: true }).primary?.label).toBe(copy.confirmLabel);
  });

  it("takes both buttons away while the answer is in flight", () => {
    const view = model({ applying: true, level: "strong", armed: true });

    expect(view.primary).toBeNull();
    expect(view.dismissLabel).toBeNull();
    expect(view.applyingLabel).toBe(copy.confirmingLabel);
    expect(view.blocks[0]?.lines).toEqual(preview.lines);
  });
});

describe("preview chrome", () => {
  it("draws lines and notes from the one shared presenter in both cards", () => {
    expect(PREVIEW_CARD).toContain("<PreviewDetails");
    expect(SERVER_CARD).toContain("<PreviewDetails");
    expect(PREVIEW_CARD).not.toContain("lineLabel");
    expect(SERVER_CARD).not.toContain("lineLabel");
  });

  it("sends the answer only from the primary press, never from arming", () => {
    expect(PREVIEW_CARD).toContain("setArmed(true)");
    expect(PREVIEW_CARD).toContain("props.onConfirm()");
    expect(PREVIEW_CARD.indexOf("setArmed(true)")).toBeLessThan(
      PREVIEW_CARD.indexOf("props.onConfirm()"),
    );
  });
});
