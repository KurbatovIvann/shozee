import { stepCountIs, streamText, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ASSISTANT_SURFACE_REGISTRY } from "@showzy/validation/assistant-surfaces";

import {
  STAFF_JUDGMENT_SPECS,
  type StaffJudgmentSpec,
} from "../tool-facades/judgment-specs.js";
import { createStaffCascadeModel } from "./cascade-model.js";
import type {
  JudgmentProvider,
  JudgmentQuestions,
  JudgmentRequest,
  JudgmentResult,
} from "./types.js";

const WRITES = new Set(["orders.create", "customers.createGroup"]);
const isWrite = (spec: StaffJudgmentSpec) => WRITES.has(spec.action);

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

function replyModel(text: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: () =>
      Promise.resolve({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "t1" });
            controller.enqueue({ type: "text-delta", id: "t1", delta: text });
            controller.enqueue({ type: "text-end", id: "t1" });
            controller.enqueue({
              type: "finish",
              finishReason: { unified: "stop", raw: "end_turn" },
              usage: USAGE,
            });
            controller.close();
          },
        }),
      }),
  });
}

function judgment(overrides: Record<string, unknown>): JudgmentProvider {
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
            ? { type: "noul", probability: 0.02 }
            : {
                type: "choice",
                choice: key === "kind" ? "request" : "none",
                confidence: 0.95,
                probabilities: {},
              });
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

const yes = { type: "noul", probability: 0.97 };
const picked = (value: string) => ({
  type: "choice",
  choice: value,
  confidence: 0.95,
  probabilities: {},
});

async function run(args: {
  readonly message: string;
  readonly answers: Record<string, unknown>;
  readonly toolResult?: unknown;
  readonly provider?: JudgmentProvider;
}) {
  const reply = replyModel("Відповідь Sonnet.");
  const gate = replyModel("Відповідь Haiku.");
  const executed: { tool: string; input: unknown }[] = [];
  const cascade = createStaffCascadeModel({
    reply,
    gate,
    provider: args.provider ?? judgment(args.answers),
    rewriteModel: undefined,
    specs: STAFF_JUDGMENT_SPECS,
    isWrite,
  });
  const listInput = z.object({
    period: z.string().optional(),
    statuses: z.array(z.string()).optional(),
  });
  const result = streamText({
    model: cascade.model,
    messages: [{ role: "user", content: args.message }],
    stopWhen: stepCountIs(4),
    tools: {
      orders_list_counts: tool({
        inputSchema: listInput,
        execute: (input) => {
          executed.push({ tool: "orders_list_counts", input });
          return Promise.resolve(args.toolResult ?? { total: 12 });
        },
      }),
      orders_list_page: tool({
        inputSchema: listInput,
        execute: () => Promise.resolve({ rows: [] }),
      }),
      orders_create: tool({
        inputSchema: z.object({
          customerQuery: z.string().optional(),
          items: z.array(
            z.object({ productQuery: z.string(), quantityDecimal: z.string() }),
          ),
        }),
        execute: (input) => {
          executed.push({ tool: "orders_create", input });
          return Promise.resolve({ number: 1042 });
        },
      }),
      customers_createGroup: tool({
        inputSchema: z.object({ name: z.string() }),
        execute: () => Promise.resolve({ name: "x" }),
      }),
    },
  });
  await result.consumeStream();
  return {
    text: await result.text,
    messages: (await result.steps).flatMap((step) => step.response.messages),
    executed,
    replyCalls: reply.doStreamCalls.length,
    gateCalls: gate.doStreamCalls.length,
    report: cascade.report(),
  };
}

const COUNT_TODAY = {
  "job:orders_list_counts": yes,
  "slot:period": picked("today"),
};
const ORDER_FOR_OLENA = {
  "job:orders_create": yes,
  "slot:customerName": picked("олени"),
  "item:1:product": picked("капучино"),
  "item:1:quantity": picked("2"),
};
const ORDER_MESSAGE = "Створи замовлення для Олени: 2 капучино";

describe("createStaffCascadeModel", () => {
  it("takes a confident read: calls the tool, says the fixed line, calls no model", async () => {
    const turn = await run({
      message: "Скільки замовлень сьогодні?",
      answers: COUNT_TODAY,
    });
    expect(turn.executed).toEqual([
      { tool: "orders_list_counts", input: { period: "today" } },
    ]);
    expect(turn.text).toBe("Ось підсумок за замовленнями.");
    expect([turn.replyCalls, turn.gateCalls]).toEqual([0, 0]);
    expect(turn.report).toMatchObject({
      taken: true,
      tier: "judgment",
      toolLoopModelCalled: false,
    });
    const first = turn.messages[0];
    const call =
      first?.role === "assistant" && typeof first.content !== "string"
        ? first.content.find((part) => part.type === "tool-call")
        : undefined;
    expect(call?.providerOptions).toEqual({
      showzy: { decidedBy: "judgment", model: "jev-test-1" },
    });
  });

  it("answers an English message in English", async () => {
    const turn = await run({
      message: "How many orders today?",
      answers: COUNT_TODAY,
    });
    expect(turn.text).toBe("Here is the orders summary.");
  });

  it("creates an order from references the module resolves", async () => {
    const turn = await run({
      message: ORDER_MESSAGE,
      answers: ORDER_FOR_OLENA,
    });
    expect(turn.executed).toEqual([
      {
        tool: "orders_create",
        input: {
          customerQuery: "олени",
          items: [{ productQuery: "капучино", quantityDecimal: "2" }],
        },
      },
    ]);
    expect(turn.text).toBe("Створив замовлення.");
    expect(turn.report).toMatchObject({ taken: true, tier: "judgment" });
  });

  it.each([
    [
      "no customer",
      "missing_argument",
      { ...ORDER_FOR_OLENA, "slot:customerName": picked("none") },
      "Створи замовлення: 2 капучино",
    ],
    [
      "a delivery note the plan cannot carry",
      "uncovered_value",
      {
        ...ORDER_FOR_OLENA,
        "extras:orders_create": { type: "noul", probability: 0.8 },
      },
    ],
    [
      "a fourth line",
      "uncovered_value",
      { ...ORDER_FOR_OLENA, "item:4:product": picked("еклер") },
    ],
  ])(
    "leaves an order with %s to the reply model",
    async (_, reason, answers, message = ORDER_MESSAGE) => {
      const turn = await run({ message, answers });
      expect(turn.executed).toEqual([]);
      expect(turn.text).toBe("Відповідь Sonnet.");
      expect(turn.report).toMatchObject({
        taken: false,
        tier: "reply",
        plan: { declinedBecause: reason },
      });
    },
  );

  it("never takes a write that would store a name as typed", async () => {
    const turn = await run({
      message: "Створи групу Оптовиків",
      answers: {
        "job:customers_createGroup": yes,
        "slot:groupName": picked("оптовиків"),
      },
    });
    expect(turn.text).toBe("Відповідь Sonnet.");
    expect(turn.report).toMatchObject({
      tier: "reply",
      plan: { declinedBecause: "write" },
    });
  });

  it("gives talk and a read it would not take itself to the gate model", async () => {
    const talk = await run({
      message: "Дякую!",
      answers: { kind: picked("small_talk") },
    });
    expect(talk.text).toBe("Відповідь Haiku.");
    expect(talk.report).toMatchObject({
      tier: "gate",
      toolLoopModelCalled: true,
    });
    expect(talk.replyCalls).toBe(0);

    const limited = await run({
      message: "Покажи три останні замовлення",
      answers: { "job:orders_list_page": yes },
    });
    expect(limited.text).toBe("Відповідь Haiku.");
    expect(limited.report).toMatchObject({
      tier: "gate",
      plan: { declinedBecause: "uncovered_value" },
    });
  });

  it("gives a refusal, a throw and a request with no job to the reply model", async () => {
    const refused = await run({
      message: "Скільки замовлень сьогодні?",
      answers: {},
      provider: {
        id: "fake",
        model: "jev-test",
        ask: () => Promise.resolve({ ok: false, reason: "timeout" }),
      },
    });
    expect(refused.text).toBe("Відповідь Sonnet.");
    expect(refused.report).toMatchObject({ taken: false, tier: "reply" });

    const broken = await run({
      message: "Скільки замовлень сьогодні?",
      answers: {},
      provider: {
        id: "fake",
        model: "jev-test",
        ask: () => Promise.reject(new Error("judgment is down")),
      },
    });
    expect(broken.text).toBe("Відповідь Sonnet.");
    expect(broken.report.plan).toBeUndefined();

    const noJob = await run({
      message: "Підтверди замовлення номер один",
      answers: {},
    });
    expect(noJob.text).toBe("Відповідь Sonnet.");
    expect(noJob.report.plan?.declinedBecause).toBe("no_job");
  });

  it("lets the reply model explain a step that failed", async () => {
    const turn = await run({
      message: "Скільки замовлень сьогодні?",
      answers: COUNT_TODAY,
      toolResult: { status: "error", code: "INTERNAL", message: "boom" },
    });
    expect(turn.executed).toHaveLength(1);
    expect(turn.text).toBe("Відповідь Sonnet.");
    expect(turn.report).toMatchObject({
      taken: true,
      tier: "reply",
      toolLoopModelCalled: true,
    });
  });
});

describe("judgment specs the cascade may take", () => {
  it("have a reply line only for a tool whose result has a card", () => {
    const withCard = new Set(
      ASSISTANT_SURFACE_REGISTRY.flatMap((surface) => surface.toolNames),
    );
    const speaking = STAFF_JUDGMENT_SPECS.filter(
      (spec) => spec.reply !== undefined,
    ).map((spec) => spec.tool);
    expect(speaking).toEqual([
      "orders_list_counts",
      "orders_list_page",
      "orders_create",
    ]);
    expect(speaking.filter((name) => !withCard.has(name))).toEqual([]);
  });
});
