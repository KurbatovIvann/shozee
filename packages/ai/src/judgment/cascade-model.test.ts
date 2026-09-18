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

const isWrite = (spec: StaffJudgmentSpec) => spec.action === "orders.create";

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
  const reply = replyModel("Відповідь моделі.");
  const executed: unknown[] = [];
  const cascade = createStaffCascadeModel({
    reply,
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
          executed.push(input);
          return Promise.resolve(args.toolResult ?? { total: 12 });
        },
      }),
      orders_create: tool({
        inputSchema: z.object({ customerQuery: z.string().optional() }),
        execute: () => Promise.resolve({ number: 1 }),
      }),
    },
  });
  await result.consumeStream();
  return {
    text: await result.text,
    messages: (await result.steps).flatMap((step) => step.response.messages),
    executed,
    replyCalls: reply.doStreamCalls.length,
    report: cascade.report(),
  };
}

const COUNT_TODAY = {
  "job:orders_list_counts": yes,
  "slot:period": picked("today"),
};

describe("createStaffCascadeModel", () => {
  it("takes a confident read: calls the tool, says the fixed line, never calls the reply model", async () => {
    const turn = await run({
      message: "Скільки замовлень сьогодні?",
      answers: COUNT_TODAY,
    });
    expect(turn.executed).toEqual([{ period: "today" }]);
    expect(turn.text).toBe("Ось підсумок за замовленнями.");
    expect(turn.replyCalls).toBe(0);
    expect(turn.report).toMatchObject({
      taken: true,
      replyModelCalled: false,
      plan: { call: { tool: "orders_list_counts" } },
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

  it("delegates a write, a refusal and talk to the reply model untouched", async () => {
    const write = await run({
      message: "Створи замовлення для Олени",
      answers: {
        "job:orders_create": yes,
        "slot:customerName": picked("олени"),
      },
    });
    expect(write.executed).toEqual([]);
    expect(write.text).toBe("Відповідь моделі.");
    expect(write.report).toMatchObject({
      taken: false,
      replyModelCalled: true,
      plan: { declinedBecause: "write" },
    });

    const refused = await run({
      message: "Скільки замовлень сьогодні?",
      answers: {},
      provider: {
        id: "fake",
        model: "jev-test",
        ask: () => Promise.resolve({ ok: false, reason: "timeout" }),
      },
    });
    expect(refused.text).toBe("Відповідь моделі.");
    expect(refused.report.taken).toBe(false);

    const broken = await run({
      message: "Скільки замовлень сьогодні?",
      answers: {},
      provider: {
        id: "fake",
        model: "jev-test",
        ask: () => Promise.reject(new Error("judgment is down")),
      },
    });
    expect(broken.text).toBe("Відповідь моделі.");
    expect(broken.report.plan).toBeUndefined();
  });

  it("lets the reply model explain a read that failed", async () => {
    const turn = await run({
      message: "Скільки замовлень сьогодні?",
      answers: COUNT_TODAY,
      toolResult: { status: "error", code: "INTERNAL", message: "boom" },
    });
    expect(turn.executed).toHaveLength(1);
    expect(turn.text).toBe("Відповідь моделі.");
    expect(turn.report).toMatchObject({
      taken: true,
      replyModelCalled: true,
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
    expect(speaking).toEqual(["orders_list_counts", "orders_list_page"]);
    expect(speaking.filter((name) => !withCard.has(name))).toEqual([]);
  });
});
