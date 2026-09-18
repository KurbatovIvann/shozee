import { describe, expect, it } from "vitest";

import { numberCandidates, spanCandidates } from "./candidates.js";
import { EXECUTOR_CASES, EXECUTOR_NONE, type ExecutorCase } from "./corpus.js";
import { HOLDOUT_CASES } from "./holdout.js";
import { PICK_CASES } from "./picks.js";
import { buildPlanQuestions, scorePlan, type PlanRow } from "./plan.js";

const orderCase: ExecutorCase = {
  id: "order",
  uk: "Створи замовлення для Олени: 2 капучино і круасан",
  jobs: ["create_order"],
  slots: { customerName: ["олени"] },
  items: [
    { product: ["капучино"], quantity: "2" },
    { product: ["круасан"], quantity: EXECUTOR_NONE },
  ],
};

const SPAN_AND_NUMBER_SLOTS = [
  "customerName",
  "groupName",
  "productName",
  "priceListName",
  "customerPhone",
  "orderNumber",
  "price",
] as const;

const pick = (choice: string, confidence = 0.9) => ({ choice, confidence });

const goodRow: PlanRow = {
  caseId: "order",
  latencyMs: 1,
  inputTokens: 1,
  jobs: { job_create_order: 0.97, job_confirm_order: 0.02 },
  picks: {
    slot_customerName: pick("олени"),
    item1_product: pick("капучино"),
    item1_quantity: pick("2"),
    item2_product: pick("круасан"),
    item2_quantity: pick(EXECUTOR_NONE),
    item3_product: pick("круасан", 0.4),
    item3_quantity: pick(EXECUTOR_NONE),
  },
};

describe("executor probe candidates", () => {
  it("offers clean spans up to three tokens and never a bare number", () => {
    const spans = spanCandidates(
      "Створи замовлення для Олени Петренко: 2 капучино",
    );
    expect(spans).toContain("олени петренко");
    expect(spans).toContain("капучино");
    expect(spans).not.toContain("2");
    expect(spans).not.toContain("петренко: 2");
  });

  it("offers digits and Ukrainian number words as numbers", () => {
    expect(numberCandidates("три лате по 65,50 і 1042")).toEqual([
      "65,50",
      "1042",
      "3",
    ]);
    expect(numberCandidates("Привіт")).toEqual([]);
  });

  it("asks no number question when the message has no number", () => {
    const questions = buildPlanQuestions("Створи групу Оптовики");
    expect(questions["slot_price"]).toBeUndefined();
    expect(questions["slot_groupName"]?.type).toBe("choice");
    expect(questions["job_create_group"]?.type).toBe("noul");
  });
});

describe("executor probe scoring", () => {
  it("accepts a whole plan and drops a repeated product pick", () => {
    const score = scorePlan(orderCase, goodRow);
    expect(score.detectedItems).toEqual(["2×капучино", "none×круасан"]);
    expect(score.planCorrect).toBe(true);
    expect(score.minConfidence).toBeCloseTo(0.9, 9);
  });

  it("fails the plan on an extra job, a wrong slot or a wrong item", () => {
    const extraJob = scorePlan(orderCase, {
      ...goodRow,
      jobs: { ...goodRow.jobs, job_confirm_order: 0.8 },
    });
    expect(extraJob.extraJobs).toEqual(["confirm_order"]);
    expect(extraJob.planCorrect).toBe(false);

    const wrongSlot = scorePlan(orderCase, {
      ...goodRow,
      picks: { ...goodRow.picks, slot_customerName: pick("для олени") },
    });
    expect(
      wrongSlot.slots.find((s) => s.slot === "customerName")?.correct,
    ).toBe(false);

    const wrongItem = scorePlan(orderCase, {
      ...goodRow,
      picks: { ...goodRow.picks, item1_quantity: pick(EXECUTOR_NONE) },
    });
    expect(wrongItem.itemsCorrect).toBe(false);
  });

  it("treats a refusal as a wrong plan", () => {
    const score = scorePlan(orderCase, {
      caseId: "order",
      latencyMs: 1,
      inputTokens: 0,
      refusal: "timeout",
      jobs: {},
      picks: {},
    });
    expect(score.planCorrect).toBe(false);
  });

  it("labels every span and number with a candidate the code really offers", () => {
    const uncovered = [...EXECUTOR_CASES, ...HOLDOUT_CASES].flatMap((c) => {
      const offered = new Set([
        EXECUTOR_NONE,
        ...spanCandidates(c.uk),
        ...numberCandidates(c.uk),
      ]);
      const accepted = [
        ...SPAN_AND_NUMBER_SLOTS.flatMap((slot) => {
          const values = c.slots?.[slot];
          return values === undefined ? [] : [values];
        }),
        ...(c.items ?? []).flatMap((i) => [i.product, [i.quantity]]),
      ];
      return accepted.every((values) => values.some((v) => offered.has(v)))
        ? []
        : [c.id];
    });
    expect(uncovered).toEqual(["h-quantity-not-a-candidate"]);
  });

  it("keeps case ids unique in every set", () => {
    for (const set of [EXECUTOR_CASES, HOLDOUT_CASES, PICK_CASES]) {
      expect(new Set(set.map((c) => c.id)).size).toBe(set.length);
    }
  });
});
