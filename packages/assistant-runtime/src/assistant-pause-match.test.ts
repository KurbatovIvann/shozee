import type { AssistantPause } from "@showzy/validation/assistant-chat";
import { describe, expect, it } from "vitest";

import {
  matchAssistantPauseAnswer,
  type AssistantPauseMatch,
} from "./assistant-pause-match.js";

const INTERACTION = "11111111-1111-4111-8111-111111111111";

function pauseOf(kind: string, prompt: unknown): AssistantPause {
  return {
    kind,
    interactionId: INTERACTION,
    revision: 1,
    status: "open",
    prompt,
    expiresAt: "2026-10-02T10:00:00.000Z",
  };
}

function confirmation(level: "card" | "strong" = "card"): AssistantPause {
  return pauseOf("confirmation", {
    summary: "Оновити клієнта?",
    preview: { title: "Оновити клієнта", lines: [], notes: [] },
    also: [],
    level,
  });
}

function hintOf(matched: AssistantPauseMatch): string {
  if (matched.kind !== "hint") {
    throw new Error(`expected a hint, got ${matched.kind}`);
  }
  return matched.hint;
}

function choice(labels: readonly string[]): AssistantPause {
  return pauseOf("choice", {
    subject: "кілька збігів",
    options: labels.map((label, index) => ({
      optionId: `opt-${String(index + 1)}`,
      label,
    })),
    optionsTruncated: false,
  });
}

const PEOPLE = ["Савчук Іван", "Петренко Марія", "Коваленко Олег"];

describe("a typed answer to an open preview", () => {
  it("approves on yes", () => {
    for (const text of ["так", "Так", "ок", "так, давай"]) {
      expect(matchAssistantPauseAnswer(confirmation(), text)).toEqual({
        kind: "answer",
        answer: { approved: true },
      });
    }
  });

  it("declines on no", () => {
    for (const text of ["ні", "Ні!", "скасуй", "ні, скасуй"]) {
      expect(matchAssistantPauseAnswer(confirmation(), text)).toEqual({
        kind: "decline",
      });
    }
  });

  it("leaves anything else unmatched, including a yes with a condition", () => {
    for (const text of ["так, але зміни ціну", "другий", "створи замовлення"]) {
      expect(matchAssistantPauseAnswer(confirmation(), text).kind).toBe(
        "supersede",
      );
    }
  });

  it("never approves a strong preview from typed text", () => {
    for (const text of ["так", "ок", "підтверджую"]) {
      expect(
        hintOf(matchAssistantPauseAnswer(confirmation("strong"), text)),
      ).toContain("кнопкою");
    }
  });

  it("still declines a strong preview from typed text", () => {
    expect(matchAssistantPauseAnswer(confirmation("strong"), "ні")).toEqual({
      kind: "decline",
    });
  });
});

describe("a typed answer to an open choice", () => {
  it("picks the option the card numbered, by digit or by ordinal", () => {
    for (const text of ["2", "2.", "№2", "другий", "друга"]) {
      expect(matchAssistantPauseAnswer(choice(PEOPLE), text)).toEqual({
        kind: "answer",
        answer: { optionId: "opt-2" },
      });
    }
  });

  it("numbers the options in the order the stored prompt holds them", () => {
    const reordered = choice([...PEOPLE].reverse());
    expect(matchAssistantPauseAnswer(reordered, "1")).toEqual({
      kind: "answer",
      answer: { optionId: "opt-1" },
    });
    expect(matchAssistantPauseAnswer(reordered, "перший")).toEqual({
      kind: "answer",
      answer: { optionId: "opt-1" },
    });
  });

  it("keeps the card for a number outside it, with the range in the hint", () => {
    expect(hintOf(matchAssistantPauseAnswer(choice(PEOPLE), "9"))).toContain(
      "до 3",
    );
  });

  it("never lets a control word pick a name that starts like one", () => {
    const named = choice(["Ніна Сергіївна", "Оксана Петрівна"]);
    expect(matchAssistantPauseAnswer(named, "ні")).toEqual({ kind: "decline" });
    expect(matchAssistantPauseAnswer(named, "не")).toEqual({ kind: "decline" });
    expect(hintOf(matchAssistantPauseAnswer(named, "ок"))).toContain("номер");
  });

  it("picks the unique name match", () => {
    expect(matchAssistantPauseAnswer(choice(PEOPLE), "Савчук")).toEqual({
      kind: "answer",
      answer: { optionId: "opt-1" },
    });
  });

  it("picks an exact label over nothing else", () => {
    expect(matchAssistantPauseAnswer(choice(PEOPLE), "коваленко олег")).toEqual(
      { kind: "answer", answer: { optionId: "opt-3" } },
    );
  });

  it("keeps the card open with a hint when several names match", () => {
    const hint = hintOf(
      matchAssistantPauseAnswer(
        choice(["Савчук Іван", "Савчук Олена"]),
        "Савчук",
      ),
    );
    expect(hint).toContain("Савчук Іван");
    expect(hint).toContain("Савчук Олена");
  });

  it("leaves unrelated text unmatched", () => {
    expect(
      matchAssistantPauseAnswer(choice(PEOPLE), "покажи замовлення за тиждень")
        .kind,
    ).toBe("supersede");
  });
});

describe("a pause this build cannot read", () => {
  it("matches nothing for an unknown kind or an unparsable prompt", () => {
    expect(matchAssistantPauseAnswer(pauseOf("mystery", {}), "так").kind).toBe(
      "supersede",
    );
    expect(
      matchAssistantPauseAnswer(pauseOf("confirmation", {}), "так").kind,
    ).toBe("supersede");
  });
});
