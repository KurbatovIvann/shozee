import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { AssistantChoiceOption } from "@showzy/validation/assistant-chat";

import { assistantCopy } from "../../../i18n/assistant";
import {
  assistantChoiceAnswer,
  assistantChoiceAnswerOptionId,
} from "../shared/choice-answer";
import { darkPalette, lightPalette } from "../../../theme/tokens";
import {
  ASSISTANT_CHOICE_CREATE_MARK,
  assistantChoiceCardModel,
} from "./choice-card-model";

const CARD = readFileSync(
  new URL("./choice-card.tsx", import.meta.url),
  "utf8",
);
const INTERACTION = readFileSync(
  new URL("./interaction-card.tsx", import.meta.url),
  "utf8",
);
const VIEW = readFileSync(
  new URL("./assistant-sheet-view.tsx", import.meta.url),
  "utf8",
);
const COMPOSER = readFileSync(
  new URL("./assistant-composer.tsx", import.meta.url),
  "utf8",
);
const SHEET = readFileSync(
  new URL("./use-assistant-sheet.ts", import.meta.url),
  "utf8",
);

function block(source: string, name: string): string {
  const start = source.indexOf(`  ${name}: {`);
  return source.slice(start, source.indexOf("\n  },", start));
}

function channels(hex: string): readonly number[] {
  return [1, 3, 5].map(
    (at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255,
  );
}

function relativeLuminance(hex: string): number {
  const [r = 0, g = 0, b = 0] = channels(hex).map((channel) =>
    channel <= 0.03928
      ? channel / 12.92
      : Math.pow((channel + 0.055) / 1.055, 2.4),
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const copy = assistantCopy("uk");

function record(
  optionId: string,
  label: string,
  detail?: string,
): AssistantChoiceOption {
  return detail === undefined
    ? { optionId, label, kind: "record" }
    : { optionId, label, detail, kind: "record" };
}

function model(
  overrides: Partial<Parameters<typeof assistantChoiceCardModel>[0]> = {},
) {
  return assistantChoiceCardModel({
    subject: "Який торт?",
    options: [
      record("a", "Медовик", "180 ₴"),
      record("b", "Наполеон", "210 ₴"),
    ],
    optionsTruncated: false,
    nearest: false,
    problem: undefined,
    applying: false,
    answeredOptionId: null,
    copy,
    ...overrides,
  });
}

describe("assistantChoiceCardModel", () => {
  it("numbers record options and keeps each sub-line", () => {
    const card = model();
    expect(card.title).toBe("Який торт?");
    expect(card.eyebrow).toBeNull();
    expect(card.problem).toBeNull();
    expect(card.footnotes).toEqual([]);
    expect(card.rows.map((row) => row.mark)).toEqual(["1", "2"]);
    expect(card.rows.map((row) => row.detail)).toEqual(["180 ₴", "210 ₴"]);
    expect(card.rows.every((row) => row.tappable)).toBe(true);
    expect(card.rows.some((row) => row.chosen)).toBe(false);
  });

  it("leaves an option without a sub-line null rather than inventing one", () => {
    expect(model({ options: [record("a", "Медовик")] }).rows[0]?.detail).toBe(
      null,
    );
  });

  it("marks a nearest picker with the «Можливо…» header", () => {
    expect(model({ nearest: true }).eyebrow).toBe(copy.choiceNearest);
    expect(copy.choiceNearest).toContain("Можливо");
  });

  it("marks a create option with + and does not spend a number on it", () => {
    const card = model({
      options: [
        record("a", "Медовик"),
        { optionId: "new", label: "Створити товар", kind: "create" },
        record("b", "Наполеон"),
      ],
    });
    expect(card.rows.map((row) => row.mark)).toEqual([
      "1",
      ASSISTANT_CHOICE_CREATE_MARK,
      "2",
    ]);
    expect(card.rows.map((row) => row.create)).toEqual([false, true, false]);
  });

  it("renders a picker whose only option is create", () => {
    const card = model({
      options: [{ optionId: "new", label: "Створити товар", kind: "create" }],
    });
    expect(card.rows).toHaveLength(1);
    expect(card.rows[0]?.create).toBe(true);
    expect(card.rows[0]?.mark).toBe(ASSISTANT_CHOICE_CREATE_MARK);
    expect(card.composeLabel).toBe(copy.choiceCompose);
  });

  it("shows the problem line above the options", () => {
    expect(model({ problem: "Такого смаку немає" }).problem).toBe(
      "Такого смаку немає",
    );
  });

  it("notes a truncated list as a footnote", () => {
    expect(model({ optionsTruncated: true }).footnotes).toEqual([
      copy.choiceTruncated,
    ]);
  });

  it("closes the card on the answered option and keeps its mark", () => {
    const card = model({ applying: true, answeredOptionId: "b" });
    expect(card.rows.map((row) => row.chosen)).toEqual([false, true]);
    expect(card.rows.every((row) => row.tappable)).toBe(false);
    expect(card.composeLabel).toBeNull();
    expect(card.dismissLabel).toBeNull();
    expect(card.chosenLabel).toBe(copy.choiceChosen);
  });

  it("marks the chosen option from the pending answer, not from the busy flag", () => {
    expect(
      model({ applying: false, answeredOptionId: "b" }).rows.map(
        (row) => row.chosen,
      ),
    ).toEqual([false, true]);
  });

  it("keeps the picker answerable later while an unrelated turn runs", () => {
    const card = model({ applying: true, answeredOptionId: null });
    expect(card.rows.some((row) => row.chosen)).toBe(false);
    expect(card.rows.every((row) => row.tappable)).toBe(false);
    expect(card.composeLabel).toBe(copy.choiceCompose);
    expect(card.dismissLabel).toBe(copy.dismissLabel);
  });

  it("falls back to the generic title when the subject is empty", () => {
    expect(model({ subject: "" }).title).toBe(copy.choiceTitle);
  });
});

describe("the answer the sheet reads back for its pending mark", () => {
  it("round-trips the option id the card answered with", () => {
    expect(assistantChoiceAnswerOptionId(assistantChoiceAnswer("b"))).toBe("b");
  });

  it("leaves no pending option for an answer of another kind", () => {
    expect(assistantChoiceAnswerOptionId({ approved: true })).toBeNull();
    expect(assistantChoiceAnswerOptionId({ optionId: 3 })).toBeNull();
    expect(assistantChoiceAnswerOptionId(null)).toBeNull();
  });
});

describe("choice card wiring", () => {
  it("answers with the option id and nothing else", () => {
    expect(INTERACTION).toContain(
      "props.onAnswer(assistantChoiceAnswer(optionId))",
    );
    expect(CARD).toContain("props.onPick(row.optionId)");
    expect(CARD).not.toContain("onAnswer");
    expect(CARD).not.toMatch(/onPick\([^)]*label/);
  });

  it("moves «Інше…» to the composer without touching the draft", () => {
    expect(CARD).toContain("onPress={props.onCompose}");
    expect(VIEW).toContain("composerRef.current?.focus()");
    expect(VIEW).toContain("onCompose={focusComposer}");
    expect(VIEW).toContain("inputRef={composerRef}");
    expect(COMPOSER).toContain("ref={props.inputRef}");
    const focus = VIEW.slice(
      VIEW.indexOf("const focusComposer"),
      VIEW.indexOf("const renderItem"),
    );
    expect(focus).not.toContain("changeInput");
    expect(focus).not.toContain("setInput");
  });

  it("renders the picker from the model instead of deciding in the view", () => {
    expect(CARD).toContain("assistantChoiceCardModel");
    expect(CARD).toContain("model.rows.map");
    expect(CARD).not.toContain("model.rows.length");
    expect(INTERACTION).toContain("<ChoiceCard");
    expect(INTERACTION).not.toContain("choiceSelecting");
  });

  it("takes the in-flight option from the sheet model, not a local echo", () => {
    expect(CARD).not.toContain("useState");
    expect(CARD).toContain("answeredOptionId,");
    expect(INTERACTION).toContain("answeredOptionId={props.pendingOptionId}");
    expect(VIEW).toContain("readonly pendingOptionId: string | null");
    expect(VIEW).toContain("pendingOptionId={model.pendingOptionId}");
    expect(SHEET).toContain("assistantChoiceAnswerOptionId");
    expect(SHEET).toContain("pendingOptionId");
  });

  it("writes both soft-background marks in a token that stays readable", () => {
    expect(CARD).not.toContain("accentForeground");
    expect(block(CARD, "eyebrow")).toContain("theme.colors.accentFg");
    expect(block(CARD, "markCreate")).toContain("theme.colors.accentSoft");
    expect(block(CARD, "markCreateText")).toContain("theme.colors.accentFg");
    for (const palette of [lightPalette, darkPalette]) {
      expect(contrastRatio(palette.accentFg, palette.card)).toBeGreaterThan(
        4.5,
      );
      expect(
        contrastRatio(palette.accentFg, palette.accentSoft),
      ).toBeGreaterThan(4.5);
      expect(
        contrastRatio(palette.accentForeground, palette.accentSoft),
      ).toBeLessThan(4.5);
    }
  });
});
