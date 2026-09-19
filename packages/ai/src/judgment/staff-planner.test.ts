import { describe, expect, it } from "vitest";

import {
  STAFF_JUDGMENT_SPECS,
  type StaffJudgmentSpec,
} from "../tool-facades/judgment-specs.js";
import { judgmentShadowOf } from "./shadow.js";
import {
  buildStaffPlanQuestions,
  decideStaffPlan,
  planStaffTurn,
} from "./staff-planner.js";
import type {
  JudgmentProvider,
  JudgmentQuestions,
  JudgmentRequest,
  JudgmentResult,
} from "./types.js";

const WRITES = new Set(["orders.create", "customers.createCustomer"]);
const isWrite = (spec: StaffJudgmentSpec) => WRITES.has(spec.action);

const choice = (value: string, confidence = 0.95) =>
  ({
    type: "choice",
    choice: value,
    confidence,
    probabilities: {},
  }) as const;
const yes = (probability: number) => ({ type: "noul", probability }) as const;

function provider(overrides: Record<string, unknown>): JudgmentProvider {
  return {
    id: "fake",
    model: "jev-test",
    ask<const Q extends JudgmentQuestions>(
      request: JudgmentRequest<Q>,
    ): Promise<JudgmentResult<Q>> {
      const answers: Record<string, unknown> = {};
      for (const [key, question] of Object.entries(request.questions)) {
        answers[key] =
          overrides[key] ??
          (question.type === "noul"
            ? yes(0.02)
            : choice(key === "kind" ? "request" : "none"));
      }
      return Promise.resolve({
        ok: true,
        model: "jev-test-1",
        answers,
        usage: { inputTokens: 1, outputTokens: 1 },
      } as JudgmentResult<Q>);
    },
  };
}

const plan = (message: string, overrides: Record<string, unknown>) =>
  planStaffTurn({
    provider: provider(overrides),
    message,
    specs: STAFF_JUDGMENT_SPECS,
    isWrite,
    now: () => 0,
  });

describe("buildStaffPlanQuestions", () => {
  it("asks the kind, one job per spec and each slot once", () => {
    const questions = buildStaffPlanQuestions(
      "Скільки замовлень сьогодні?",
      STAFF_JUDGMENT_SPECS,
    );
    expect(questions["kind"]?.type).toBe("choice");
    expect(
      Object.keys(questions).filter((key) => key.startsWith("job:")),
    ).toHaveLength(STAFF_JUDGMENT_SPECS.length);
    expect(questions["slot:customerName"]?.type).toBe("choice");
    expect(questions["slot:price"]).toBeUndefined();
  });
});

describe("planStaffTurn", () => {
  it("would take a single confident read and shapes its arguments", async () => {
    const result = await plan("Скільки нових замовлень сьогодні?", {
      "job:orders_list_counts": yes(0.97),
      "slot:period": choice("today"),
      "slot:orderStatus": choice("new"),
    });
    expect(result.declinedBecause).toBeUndefined();
    expect(result.call).toMatchObject({
      tool: "orders_list_counts",
      args: { period: "today", statuses: ["new"] },
    });
    expect(result.model).toBe("jev-test-1");
  });

  it("takes an order, whose references a module resolves", async () => {
    const result = await plan("Створи замовлення для Олени: 2 капучино", {
      "job:orders_create": yes(0.98),
      "slot:customerName": choice("олени"),
      "item:1:product": choice("капучино"),
      "item:1:quantity": choice("2"),
      "item:2:product": choice("капучино", 0.9),
    });
    expect(result.declinedBecause).toBeUndefined();
    expect(result.call?.args).toEqual({
      customerQuery: "олени",
      items: ["2×капучино"],
    });
    expect(result.call?.input).toEqual({
      customerQuery: "олени",
      items: [{ productQuery: "капучино", quantityDecimal: "2" }],
    });
  });

  it("acts on an order at the spec's own lower job threshold", async () => {
    const answers = {
      "job:orders_create": yes(0.78),
      "slot:customerName": choice("наталії гук"),
      "item:1:product": choice("тірамісу"),
      "item:1:quantity": choice("2"),
    };
    expect(
      (await plan("Наталії Гук 2 тірамісу", answers)).declinedBecause,
    ).toBeUndefined();
    expect(
      (
        await plan("Наталії Гук 2 тірамісу", {
          ...answers,
          "job:orders_create": yes(0.72),
        })
      ).declinedBecause,
    ).toBe("low_argument_confidence");
  });

  it("plans a write that stores a new name but declines to take it", async () => {
    const result = await plan("Додай клієнта Андрія Коваля", {
      "job:customers_createCustomer": yes(0.98),
      "slot:customerName": choice("андрія коваля"),
    });
    expect(result.declinedBecause).toBe("write");
    expect(result.call?.args).toEqual({ name: "андрія коваля" });
  });

  it("turns a price into minor units", async () => {
    const result = await plan("Додай товар Лате за 65,50", {
      "job:catalog_createProduct": yes(0.97),
      "slot:productName": choice("лате"),
      "slot:price": choice("65,50"),
    });
    expect(result.call?.args).toEqual({
      name: "лате",
      basePriceMinor: "6550",
    });
  });

  it.each([
    ["not_a_request", "Що ти вмієш?", { kind: choice("capability_question") }],
    ["no_job", "Зроби щось", {}],
    [
      "several_jobs",
      "Покажи замовлення і клієнтів",
      {
        "job:orders_list_page": yes(0.9),
        "job:customers_list_customers": yes(0.5),
      },
    ],
    [
      "low_argument_confidence",
      "Знайди клієнта Марія",
      {
        "job:customers_list_customers": yes(0.95),
        "slot:customerName": choice("марія", 0.4),
      },
    ],
    [
      "uncovered_value",
      "Скільки замовлень було вчора?",
      {
        "job:orders_list_counts": yes(0.95),
        "slot:period": choice("other_period"),
      },
    ],
    [
      "uncovered_value",
      "Покажи три останні замовлення",
      { "job:orders_list_page": yes(0.95) },
    ],
    [
      "uncovered_value",
      "Для Олени 2 великих капучино",
      {
        "job:orders_create": yes(0.98),
        "slot:customerName": choice("олени"),
        "item:1:product": choice("капучино"),
        "item:1:quantity": choice("2"),
      },
    ],
    [
      "uncovered_value",
      "Покажи 5 замовлень за сьогодні",
      { "job:orders_list_page": yes(0.95), "slot:period": choice("today") },
    ],
    [
      "uncovered_value",
      "Покажи замовлення на тисячу гривень",
      { "job:orders_list_page": yes(0.95) },
    ],
  ] as const)("declines with %s", async (reason, message, overrides) => {
    expect((await plan(message, overrides)).declinedBecause).toBe(reason);
  });

  it("holds a job it is not sure enough of to act on, by the spec's own thresholds", () => {
    const answers = {
      kind: choice("request"),
      "job:orders_list_counts": yes(0.8),
      "slot:period": choice("today", 0.65),
    };
    const decide = (thresholds: StaffJudgmentSpec["thresholds"]) =>
      decideStaffPlan({
        message: "Скільки замовлень сьогодні?",
        answers,
        specs: STAFF_JUDGMENT_SPECS.map((spec) =>
          spec.tool === "orders_list_counts" && thresholds !== undefined
            ? { ...spec, thresholds }
            : spec,
        ),
        isWrite,
      });
    expect(decide(undefined).declinedBecause).toBe("low_argument_confidence");
    expect(decide({ act: 0.75 }).declinedBecause).toBe(
      "low_argument_confidence",
    );
    expect(
      decide({ act: 0.75, argument: 0.6 }).declinedBecause,
    ).toBeUndefined();
    expect(decide({ take: 0.9 }).declinedBecause).toBe("no_job");
    expect(decide(undefined).call?.minConfidence).toBeCloseTo(0.6, 9);
  });

  it("reports a refusal without a plan", async () => {
    const refused: JudgmentProvider = {
      id: "fake",
      model: "jev-test",
      ask: () => Promise.resolve({ ok: false, reason: "timeout" }),
    };
    const result = await planStaffTurn({
      provider: refused,
      message: "x",
      specs: STAFF_JUDGMENT_SPECS,
      isWrite,
      now: () => 0,
    });
    expect(result).toEqual({
      model: "jev-test",
      latencyMs: 0,
      refusal: "timeout",
      declinedBecause: "refused",
    });
  });
});

describe("judgmentShadowOf", () => {
  it("agrees on the same tool and the same arguments in another case", async () => {
    const planned = await plan("Знайди клієнта Олени Петренко", {
      "job:customers_list_customers": yes(0.97),
      "slot:customerName": choice("олени петренко"),
    });
    const shadow = judgmentShadowOf(
      { ...planned, rewriteUsed: false, rewriteAttempted: false },
      {
        toolName: "customers_list_customers",
        input: { search: "Олена Петренко", limit: 5, notes: { a: 1 } },
      },
      STAFF_JUDGMENT_SPECS,
      isWrite,
    );
    expect(shadow).toMatchObject({
      wouldTake: true,
      plan: { tool: "customers_list_customers", risk: "read" },
      modelFirstCall: {
        tool: "customers_list_customers",
        args: { search: "Олена Петренко" },
      },
      toolAgrees: true,
      argsAgree: true,
    });
  });

  it("compares order lines and reports a different tool", async () => {
    const planned = await plan("Створи замовлення для Олени: 2 капучино", {
      "job:orders_create": yes(0.98),
      "slot:customerName": choice("олени"),
      "item:1:product": choice("капучино"),
      "item:1:quantity": choice("2"),
    });
    const same = judgmentShadowOf(
      { ...planned, rewriteUsed: false, rewriteAttempted: false },
      {
        toolName: "orders_create",
        input: {
          customerQuery: "Олена",
          items: [{ productQuery: "Капучино", quantityDecimal: "2" }],
        },
      },
      STAFF_JUDGMENT_SPECS,
      isWrite,
    );
    expect(same.argsAgree).toBe(true);
    expect(same.wouldTake).toBe(true);

    const inMilli = judgmentShadowOf(
      { ...planned, rewriteUsed: false, rewriteAttempted: false },
      {
        toolName: "orders_create",
        input: {
          customerQuery: "Олена",
          items: [{ productQuery: "Капучино", quantityMilli: "2000" }],
        },
      },
      STAFF_JUDGMENT_SPECS,
      isWrite,
    );
    expect(inMilli.modelFirstCall?.args["items"]).toEqual(["2×Капучино"]);
    expect(inMilli.argsAgree).toBe(true);

    const other = judgmentShadowOf(
      { ...planned, rewriteUsed: false, rewriteAttempted: false },
      { toolName: "search_query", input: { query: "Олена" } },
      STAFF_JUDGMENT_SPECS,
      isWrite,
    );
    expect(other.toolAgrees).toBe(false);
    expect(other.argsAgree).toBeNull();
    expect(other.modelFirstCall).toEqual({ tool: "search_query", args: {} });
  });

  it("agrees that nothing was to be called", async () => {
    const planned = await plan("Привіт", { kind: choice("small_talk") });
    const shadow = judgmentShadowOf(
      { ...planned, rewriteUsed: false, rewriteAttempted: false },
      undefined,
      STAFF_JUDGMENT_SPECS,
      isWrite,
    );
    expect(shadow.toolAgrees).toBe(true);
    expect(shadow.modelFirstCall).toBeNull();
  });
});
