import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";

import { planWithLlm } from "./llm.js";
import { scorePlan } from "./plan.js";

const usage = {
  inputTokens: { total: 900, noCache: 900, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 80, text: 80, reasoning: 0 },
};

function modelCalling(input: unknown): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: {
      content: [
        {
          type: "tool-call",
          toolCallId: "call_1",
          toolName: "submit_plan",
          input: JSON.stringify(input),
        },
      ],
      finishReason: { unified: "tool-calls", raw: undefined },
      usage,
      warnings: [],
    },
  });
}

const emptyPlan = {
  jobs: [],
  customerName: null,
  customerPhone: null,
  groupName: null,
  productName: null,
  priceListName: null,
  orderNumber: null,
  price: null,
  documentType: null,
  period: null,
  statusFilter: null,
  inviteKind: null,
  items: [],
};

describe("planWithLlm", () => {
  it("maps a submitted plan onto the row the Jev scorer reads", async () => {
    const { row, usage: spent } = await planWithLlm(
      modelCalling({
        ...emptyPlan,
        jobs: ["create_order"],
        customerName: " Олени Петренко ",
        items: [
          { product: "Капучино", quantity: "2" },
          { product: "круасан", quantity: null },
        ],
      }),
      "order",
      "Створи замовлення для Олени Петренко: 2 капучино і круасан",
      () => 0,
    );

    expect(spent).toEqual({ inputTokens: 900, outputTokens: 80 });
    expect(
      scorePlan(
        {
          id: "order",
          uk: "",
          jobs: ["create_order"],
          slots: { customerName: ["олени петренко"] },
          items: [
            { product: ["капучино"], quantity: "2" },
            { product: ["круасан"], quantity: "none" },
          ],
        },
        row,
      ).planCorrect,
    ).toBe(true);
  });

  it("reports a plan that does not fit the schema as a refusal", async () => {
    const { row } = await planWithLlm(
      modelCalling({ jobs: ["fly_to_the_moon"] }),
      "bad",
      "x",
      () => 0,
    );
    expect(row.refusal).toBe("unavailable");
  });
});
