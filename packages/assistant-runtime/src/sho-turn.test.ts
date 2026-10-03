import type { ModelMessage, ToolSet } from "@showzy/assistant-kit";
import {
  assistantConfirmationPromptSchema,
  ASSISTANT_PREVIEW_LIST_MAX,
} from "@showzy/validation/assistant-chat";
import { describe, expect, it, vi } from "vitest";

import {
  runShoTurn,
  shoFreeBudgetHold,
  shoToolCallId,
  type ShoEngine,
  type ShoPlan,
  type ShoTurnInput,
} from "./sho-turn.js";

const NOW = new Date("2026-09-11T09:30:00.000Z");
const COMMAND = "0d1f4b2a-6c3e-4a1d-9f55-7b2c8e1a4d60";
const TOOL = "customers_list_customers";

const engineOf = (plan: ShoPlan): ShoEngine => ({
  plan: () => Promise.resolve(plan),
});

const calls = (plan: ShoPlan): ShoPlan => plan;

function toolsWith(
  execute: ToolSet[string]["execute"],
): () => Promise<ToolSet> {
  const set: ToolSet = { [TOOL]: { execute } as ToolSet[string] };
  return () => Promise.resolve(set);
}

function turnWith(
  plan: ShoPlan,
  execute: ToolSet[string]["execute"],
  history: readonly ModelMessage[] = [],
): ShoTurnInput {
  return {
    text: "покажи клієнтів",
    commandId: COMMAND,
    now: NOW,
    history,
    tools: toolsWith(execute),
    engine: engineOf(plan),
  };
}

const readPlan = calls({
  kind: "call",
  writes: false,
  toolName: TOOL,
  input: { status: "active" },
  reply: "Ось клієнти.",
});

describe("shoToolCallId", () => {
  it("is a sendable id that names the sequence and the tool", () => {
    const id = shoToolCallId(COMMAND, 1, "customers.listCustomers");
    expect(id).toBe(`sho-1-customers_listCustomers-${COMMAND}`);
    expect(id).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(id.startsWith("sho-")).toBe(true);
  });
});

describe("shoFreeBudgetHold", () => {
  it("reserves nothing on the Kyiv day of the turn", () => {
    expect(shoFreeBudgetHold(NOW)).toEqual({
      companyReservedUsd: 0,
      globalReservedUsd: 0,
      kyivDate: "2026-09-11",
    });
  });
});

describe("runShoTurn", () => {
  it("settles a read into the card, the reply and a synthetic history", async () => {
    const outcome = await runShoTurn(
      turnWith(
        readPlan,
        () =>
          Promise.resolve({
            kind: "ok",
            result: { items: [{ id: "c1" }] },
            card: { cardId: "customers", type: "customers_list", payload: {} },
          }),
        [{ role: "user", content: "привіт" }],
      ),
    );

    expect(outcome.kind).toBe("settled");
    if (outcome.kind !== "settled") return;
    expect(outcome.parts).toEqual([
      {
        kind: "card",
        cardId: "customers",
        revision: 1,
        type: "customers_list",
        payload: {},
      },
      { kind: "text", text: "Ось клієнти.", status: "complete" },
    ]);

    const toolCallId = shoToolCallId(COMMAND, 1, TOOL);
    expect(outcome.appended).toEqual([
      { role: "user", content: "покажи клієнтів" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId,
            toolName: TOOL,
            input: { status: "active" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId,
            toolName: TOOL,
            output: { type: "json", value: { items: [{ id: "c1" }] } },
          },
        ],
      },
      { role: "assistant", content: "Ось клієнти." },
    ]);
  });

  it("carries a pause out as an ask whose continuation resumes the synthetic call", async () => {
    const outcome = await runShoTurn(
      turnWith(readPlan, () =>
        Promise.resolve({
          kind: "pause",
          interaction: "confirmation",
          prompt: { summary: "Створити?" },
          secret: { challengeId: "c" },
        }),
      ),
    );

    expect(outcome.kind).toBe("ask");
    if (outcome.kind !== "ask") return;
    expect(outcome.interaction).toBe("confirmation");
    expect(outcome.continuation.pausedToolCall).toEqual({
      id: shoToolCallId(COMMAND, 1, TOOL),
      name: TOOL,
    });
    expect(outcome.continuation.messages).toEqual(outcome.appended);
    expect(outcome.appended.at(-1)).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: shoToolCallId(COMMAND, 1, TOOL),
          toolName: TOOL,
          output: {
            type: "json",
            value: { status: "paused", reason: "confirmation" },
          },
        },
      ],
    });
  });

  it("falls back when the engine refuses to plan", async () => {
    const outcome = await runShoTurn(
      turnWith({ kind: "fallback", reason: "timeout" }, () =>
        Promise.resolve({ kind: "ok", result: {} }),
      ),
    );
    expect(outcome).toEqual({ kind: "fallback", reason: "timeout" });
  });

  it("falls back when the engine throws, and never runs a tool", async () => {
    const execute = vi.fn(() => Promise.resolve({ kind: "ok", result: {} }));
    const outcome = await runShoTurn({
      ...turnWith(readPlan, execute as never),
      engine: { plan: () => Promise.reject(new Error("sho is down")) },
    });
    expect(outcome).toEqual({ kind: "fallback", reason: "engine_failed" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("names the planned tool being absent and the tool set being unreadable apart", async () => {
    const absent = await runShoTurn({
      ...turnWith(readPlan, () => Promise.resolve({ kind: "ok", result: {} })),
      tools: () => Promise.resolve({} as ToolSet),
    });
    expect(absent).toEqual({ kind: "fallback", reason: "tool_unavailable" });

    const unreadable = await runShoTurn({
      ...turnWith(readPlan, () => Promise.resolve({ kind: "ok", result: {} })),
      tools: () => Promise.reject(new Error("the actor could not be read")),
    });
    expect(unreadable).toEqual({
      kind: "fallback",
      reason: "tools_unreadable",
    });
  });

  it("falls back when the tool refuses or throws", async () => {
    const refused = await runShoTurn(
      turnWith(readPlan, () =>
        Promise.resolve({
          kind: "error",
          code: "PERMISSION_DENIED",
          message: "no",
        }),
      ),
    );
    expect(refused).toEqual({ kind: "fallback", reason: "tool_failed" });

    const threw = await runShoTurn(
      turnWith(readPlan, () => Promise.reject(new Error("boom"))),
    );
    expect(threw).toEqual({ kind: "fallback", reason: "tool_failed" });
  });

  const notedPlan = calls({
    kind: "call",
    writes: true,
    toolName: TOOL,
    input: { customerQuery: "оксани" },
    reply: "Замовлення створено.",
    notes: ["Прочитано як нове замовлення."],
  });

  const pauseWith = (prompt: unknown) => () =>
    Promise.resolve({
      kind: "pause",
      interaction: "confirmation",
      prompt,
      secret: { challengeId: "c" },
    });

  const confirmationPrompt = {
    summary: "Створити замовлення?",
    preview: { title: "Нове замовлення", lines: [], notes: ["Оксана"] },
    also: [],
    level: "card",
  };

  it("falls back when a declared write comes back without a pause", async () => {
    const outcome = await runShoTurn(
      turnWith(notedPlan, () =>
        Promise.resolve({ kind: "ok", result: { orderId: "o" } }),
      ),
    );

    expect(outcome).toEqual({
      kind: "fallback",
      reason: "write_did_not_pause",
    });
  });

  it("adds the plan's notes to the preview the card shows", async () => {
    const outcome = await runShoTurn(
      turnWith(notedPlan, pauseWith(confirmationPrompt)),
    );

    expect(outcome.kind).toBe("ask");
    if (outcome.kind !== "ask") return;
    expect(outcome.prompt).toEqual({
      ...confirmationPrompt,
      preview: {
        ...confirmationPrompt.preview,
        notes: ["Прочитано як нове замовлення.", "Оксана"],
      },
    });
  });

  it("keeps the plan's note when the preview's own list is already full", async () => {
    const full = Array.from({ length: ASSISTANT_PREVIEW_LIST_MAX }, (_, at) =>
      String(at),
    );
    const outcome = await runShoTurn(
      turnWith(
        notedPlan,
        pauseWith({
          ...confirmationPrompt,
          preview: { ...confirmationPrompt.preview, notes: full },
        }),
      ),
    );

    expect(outcome.kind).toBe("ask");
    if (outcome.kind !== "ask") return;
    const prompt = assistantConfirmationPromptSchema.parse(outcome.prompt);
    expect(prompt.preview.notes).toHaveLength(ASSISTANT_PREVIEW_LIST_MAX);
    expect(prompt.preview.notes[0]).toBe("Прочитано як нове замовлення.");
  });

  it("leaves a pause that is not a preview card untouched", async () => {
    const outcome = await runShoTurn(
      turnWith(notedPlan, pauseWith({ summary: "Кого саме?" })),
    );

    expect(outcome.kind).toBe("ask");
    if (outcome.kind !== "ask") return;
    expect(outcome.prompt).toEqual({ summary: "Кого саме?" });
  });
});
