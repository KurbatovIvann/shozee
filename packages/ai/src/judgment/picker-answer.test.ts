import { describe, expect, it } from "vitest";

import type { CatalogPickerConflictExtras } from "../choice.js";
import { answerPickerFromMessage } from "./picker-answer.js";
import type {
  JudgmentProvider,
  JudgmentQuestions,
  JudgmentRequest,
  JudgmentResult,
} from "./types.js";

const LEMON = "0b6f1c1e-5a53-4a0e-9d2c-1f2e3a4b5c6d";
const VANILLA = "7c2d9e4f-8b1a-4c3d-a5e6-9f8e7d6c5b4a";

const variantPicker: CatalogPickerConflictExtras = {
  reason: "variant_required",
  target: {
    kind: "order_line_variant",
    lineIndex: 0,
    productId: "3d0f4f5e-1111-4a0e-9d2c-1f2e3a4b5c6d",
    productName: "Макаронси",
  },
  options: [
    { id: LEMON, label: "Лимон" },
    { id: VANILLA, label: "Ваніль" },
  ],
  optionsTruncated: false,
};

function provider(choice: string, confidence: number) {
  const seen: JudgmentRequest<JudgmentQuestions>[] = [];
  const fake: JudgmentProvider = {
    id: "fake",
    model: "jev-test",
    ask<const Q extends JudgmentQuestions>(
      request: JudgmentRequest<Q>,
    ): Promise<JudgmentResult<Q>> {
      seen.push(request);
      return Promise.resolve({
        ok: true,
        model: "jev-test-1",
        answers: {
          pick: { type: "choice", choice, confidence, probabilities: {} },
        },
        usage: { inputTokens: 1, outputTokens: 1 },
      } as JudgmentResult<Q>);
    },
  };
  return { fake, seen };
}

const ask = (choice: string, confidence: number, picker = variantPicker) => {
  const { fake, seen } = provider(choice, confidence);
  return answerPickerFromMessage({
    provider: fake,
    message: "Олені Петренко 6 макаронсів лимон",
    picker,
    line: "6 × макаронсів лимон",
  }).then((id) => ({ id, seen }));
};

describe("answerPickerFromMessage", () => {
  it("returns the option the message names, asked with the message, the product and the line", async () => {
    const { id, seen } = await ask("Лимон", 0.97);
    expect(id).toBe(LEMON);
    expect(seen[0]?.state).toEqual({
      message: "Олені Петренко 6 макаронсів лимон",
      product: "Макаронси",
      line: "6 × макаронсів лимон",
    });
    expect(Object.keys(seen[0]?.questions["pick"]?.criteria ?? {})).toEqual([
      "Лимон",
      "Ваніль",
      "unclear",
      "none",
    ]);
  });

  it.each([
    ["a pick it is not sure of", "Лимон", 0.89],
    ["unclear", "unclear", 0.99],
    ["none of them", "none", 0.99],
  ])("leaves the picker to the person on %s", async (_, choice, confidence) => {
    expect((await ask(choice, confidence)).id).toBeUndefined();
  });

  it("does not ask when two options read the same", async () => {
    const { id, seen } = await ask("Олена Петренко", 0.99, {
      reason: "ambiguous",
      target: { kind: "customer", query: "олени петренко" },
      options: [
        { id: LEMON, label: "Олена Петренко" },
        { id: VANILLA, label: "Олена Петренко" },
      ],
      optionsTruncated: false,
    });
    expect(id).toBeUndefined();
    expect(seen).toEqual([]);
  });

  it("leaves the picker to the person when the judgment refuses", async () => {
    const refused: JudgmentProvider = {
      id: "fake",
      model: "jev-test",
      ask: () => Promise.resolve({ ok: false, reason: "timeout" }),
    };
    expect(
      await answerPickerFromMessage({
        provider: refused,
        message: "x",
        picker: variantPicker,
      }),
    ).toBeUndefined();
  });
});
