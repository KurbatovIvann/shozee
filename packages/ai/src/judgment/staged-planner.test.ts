import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";

import {
  STAFF_JUDGMENT_SPECS,
  type StaffJudgmentSpec,
} from "../tool-facades/judgment-specs.js";
import { contextRewriteTranscript } from "./context-rewrite.js";
import { planStaffTurnInContext } from "./staged-planner.js";
import type {
  JudgmentProvider,
  JudgmentQuestions,
  JudgmentRequest,
  JudgmentResult,
} from "./types.js";

const isWrite = (spec: StaffJudgmentSpec) => spec.action === "orders.create";

const choice = (value: string, confidence = 0.95) => ({
  type: "choice",
  choice: value,
  confidence,
  probabilities: {},
});
const yes = (probability: number) => ({ type: "noul", probability });

type Overrides = Record<string, unknown>;

function provider(byMessage: Record<string, Overrides>): {
  readonly provider: JudgmentProvider;
  readonly asked: string[];
} {
  const asked: string[] = [];
  return {
    asked,
    provider: {
      id: "fake",
      model: "jev-test",
      ask<const Q extends JudgmentQuestions>(
        request: JudgmentRequest<Q>,
      ): Promise<JudgmentResult<Q>> {
        const state = request.state as { readonly message: string };
        asked.push(state.message);
        const overrides = byMessage[state.message] ?? {};
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
    },
  };
}

function rewriter(text: string): {
  readonly model: MockLanguageModelV3;
  readonly calls: () => number;
} {
  const model = new MockLanguageModelV3({
    doGenerate: {
      content: [{ type: "text", text }],
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    },
  });
  return { model, calls: () => model.doGenerateCalls.length };
}

const COUNTED = [
  {
    user: "Скільки замовлень сьогодні?",
    assistant: "Сьогодні 12 замовлень.",
  },
];
const FOLLOW_UP = "А за цей тиждень?";
const REWRITTEN = "Скільки замовлень за цей тиждень?";

const plan = (args: {
  readonly answers: Record<string, Overrides>;
  readonly rewrite: string | undefined;
  readonly message?: string;
  readonly exchanges?: typeof COUNTED;
}) => {
  const fake = provider(args.answers);
  const model = args.rewrite === undefined ? undefined : rewriter(args.rewrite);
  return planStaffTurnInContext({
    provider: fake.provider,
    rewriteModel: model?.model,
    message: args.message ?? FOLLOW_UP,
    exchanges: args.exchanges ?? COUNTED,
    specs: STAFF_JUDGMENT_SPECS,
    isWrite,
    now: () => 0,
  }).then((result) => ({ result, asked: fake.asked, model }));
};

describe("planStaffTurnInContext", () => {
  it("plans a follow-up from its rewrite", async () => {
    const { result, asked } = await plan({
      rewrite: REWRITTEN,
      answers: {
        [FOLLOW_UP]: { needsHistory: yes(0.93) },
        [REWRITTEN]: {
          "job:orders_list_counts": yes(0.97),
          "slot:period": choice("this_week"),
        },
      },
    });
    expect(asked).toEqual([FOLLOW_UP, REWRITTEN]);
    expect(result).toMatchObject({
      rewriteUsed: true,
      needsHistory: 0.93,
      call: { tool: "orders_list_counts", args: { period: "this_week" } },
    });
    expect(result.declinedBecause).toBeUndefined();
  });

  it("keeps the customer as typed when the rewrite only extends it from the conversation", async () => {
    const typed = "Каті 2 макаронси";
    const extended = "Створи замовлення для Каті Самбуки: 2 макаронси";
    const order = (customer: string) => ({
      "job:orders_create": yes(0.95),
      "slot:customerName": choice(customer),
      "item:1:product": choice("макаронси"),
      "item:1:quantity": choice("2"),
    });
    const { result } = await plan({
      message: typed,
      rewrite: extended,
      exchanges: [
        {
          user: "Каті Самбуці 6 макаронсів лимон",
          assistant: "Створив замовлення для Каті Самбуки.",
        },
      ],
      answers: {
        [typed]: { needsHistory: yes(0.53), ...order("каті") },
        [extended]: order("каті самбуки"),
      },
    });
    expect(result.rewriteUsed).toBe(true);
    expect(result.call?.input["customerQuery"]).toBe("каті");
    expect(result.call?.args["customerQuery"]).toBe("каті");
    expect(result.declinedBecause).toBeUndefined();
  });

  it("lets the rewrite name the customer a pronoun stood for", async () => {
    const typed = "Їй ще 2 лате";
    const resolved = "Створи замовлення для Олени Петренко: 2 лате";
    const { result } = await plan({
      message: typed,
      rewrite: resolved,
      exchanges: [
        { user: "Знайди Олену Петренко", assistant: "Ось Олена Петренко." },
      ],
      answers: {
        [typed]: {
          needsHistory: yes(0.9),
          "job:orders_create": yes(0.9),
          "slot:customerName": choice("їй"),
          "item:1:product": choice("лате"),
          "item:1:quantity": choice("2"),
        },
        [resolved]: {
          "job:orders_create": yes(0.95),
          "slot:customerName": choice("олени петренко"),
          "item:1:product": choice("лате"),
          "item:1:quantity": choice("2"),
        },
      },
    });
    expect(result.call?.input["customerQuery"]).toBe("олени петренко");
  });

  it("keeps the original plan for a message that stands alone", async () => {
    const message = "Скільки нових замовлень сьогодні?";
    const { result, asked } = await plan({
      rewrite: "Скільки замовлень?",
      message,
      answers: {
        [message]: {
          needsHistory: yes(0.1),
          "job:orders_list_counts": yes(0.97),
          "slot:period": choice("today"),
        },
      },
    });
    expect(asked).toEqual([message]);
    expect(result.rewriteUsed).toBe(false);
    expect(result.call?.args).toEqual({ period: "today" });
  });

  it("never rewrites talk, however much it leans on the conversation", async () => {
    const message = "клас, швидко ти";
    const { result, asked } = await plan({
      rewrite: "Додай клієнта Остап Вдовенко 0509998877",
      message,
      answers: {
        [message]: { kind: choice("small_talk"), needsHistory: yes(0.57) },
      },
    });
    expect(asked).toEqual([message]);
    expect(result).toMatchObject({
      rewriteUsed: false,
      declinedBecause: "not_a_request",
    });
  });

  it("asks nothing about history and calls no rewriter when the conversation is empty", async () => {
    const message = "Скільки замовлень сьогодні?";
    const { result, model } = await plan({
      rewrite: "unused",
      message,
      exchanges: [],
      answers: { [message]: { "job:orders_list_counts": yes(0.97) } },
    });
    expect(model?.calls()).toBe(0);
    expect(result.needsHistory).toBeUndefined();
    expect(result.rewriteUsed).toBe(false);
  });

  it("delegates a follow-up when there is no rewrite to plan from", async () => {
    const { result } = await plan({
      rewrite: undefined,
      answers: {
        [FOLLOW_UP]: {
          needsHistory: yes(0.93),
          "job:orders_list_counts": yes(0.97),
        },
      },
    });
    expect(result).toMatchObject({
      rewriteUsed: false,
      declinedBecause: "needs_history",
    });
  });

  it("delegates when the rewrite names someone the conversation never did", async () => {
    const invented = "Знайди клієнта Остап Вдовенко";
    const { result } = await plan({
      rewrite: invented,
      answers: {
        [FOLLOW_UP]: { needsHistory: yes(0.93) },
        [invented]: {
          "job:customers_list_customers": yes(0.97),
          "slot:customerName": choice("остап вдовенко"),
        },
      },
    });
    expect(result).toMatchObject({
      rewriteUsed: true,
      declinedBecause: "ungrounded_value",
    });
  });

  it("accepts a name in another case and rejects a number nobody typed", async () => {
    const exchanges = [
      {
        user: "Знайди клієнта Олена Петренко",
        assistant: "Знайшов: Олена Петренко, +380 67 123 45 67.",
      },
    ];
    const message = "покажи її ще раз";
    const grounded = "Знайди клієнта Олену Петренко";
    const first = await plan({
      rewrite: grounded,
      message,
      exchanges,
      answers: {
        [message]: { needsHistory: yes(0.9) },
        [grounded]: {
          "job:customers_list_customers": yes(0.97),
          "slot:customerName": choice("олену петренко"),
        },
      },
    });
    expect(first.result.declinedBecause).toBeUndefined();

    const invented = "Знайди клієнта Олену Петренко 0509998877";
    const second = await plan({
      rewrite: invented,
      message,
      exchanges,
      answers: {
        [message]: { needsHistory: yes(0.9) },
        [invented]: {
          "job:customers_list_customers": yes(0.97),
          "slot:customerName": choice("олену петренко"),
        },
      },
    });
    expect(second.result.declinedBecause).toBe("ungrounded_value");
  });
});

describe("contextRewriteTranscript", () => {
  it("shows the last three exchanges and the latest message", () => {
    const exchanges = [1, 2, 3, 4].map((n) => ({
      user: `питання ${String(n)}`,
      assistant: `відповідь ${String(n)}`,
    }));
    const transcript = contextRewriteTranscript(exchanges, "а тепер?");
    expect(transcript).not.toContain("питання 1");
    expect(transcript).toContain("Staff: питання 2");
    expect(transcript).toContain("Assistant: відповідь 4");
    expect(transcript.endsWith("Latest message:\nа тепер?")).toBe(true);
  });
});

describe("the speculative rewrite", () => {
  it("starts beside the first request and is dropped when the message stands alone", async () => {
    const message = "Скільки нових замовлень сьогодні?";
    const { result, asked } = await plan({
      rewrite: "Скільки замовлень?",
      message,
      answers: { [message]: { needsHistory: yes(0.1) } },
    });
    expect(asked).toEqual([message]);
    expect(result).toMatchObject({
      rewriteUsed: false,
      rewriteAttempted: true,
    });
  });
});
