import type { ModelMessage, ToolSet } from "@showzy/assistant-kit";
import { shoCommandSchema, type ShoCommand } from "@showzy/sho-protocol";
import { describe, expect, it, vi } from "vitest";

import { shoFocusFrom, shoPreviousFrom } from "./sho-focus.js";

import {
  runShoTurn,
  shoFreeBudgetHold,
  shoToolCallId,
  type ShoEngine,
  type ShoPlan,
  type ShoTurnInput,
  type ShoTurnRequest,
} from "./sho-turn.js";

const NOW = new Date("2026-09-11T09:30:00.000Z");
const COMMAND = "0d1f4b2a-6c3e-4a1d-9f55-7b2c8e1a4d60";
const TOOL = "customers_list_customers";
const SESSION = "4f2d6c1b-88a3-4e59-9a07-3c5d2e8f1b44";

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
    sessionId: SESSION,
    now: NOW,
    history,
    tools: toolsWith(execute),
    engine: engineOf(plan),
  };
}

const readPlan = calls({
  kind: "call",
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
});

describe("runShoTurn over the stored log", () => {
  const CREATED = "11111111-1111-4111-8111-111111111111";

  const createKate: ShoCommand = shoCommandSchema.parse({
    text: "створи клієнта Катя",
    action: "customers.createCustomer",
    kind: "write",
    effect: "write",
    confirm: "card",
    params: { new_name: { text: "Катя" } },
    needs: [],
    ready: true,
    catalogued: true,
    confidence: { action: 0.99, margin: 0.5, certainty: 0.9, spans: 0.9 },
    refPrevious: {},
    creates: { type: "customer", name: "Катя" },
  });

  const recordingEngine = (
    plan: ShoPlan,
  ): { readonly engine: ShoEngine; readonly asked: ShoTurnRequest[] } => {
    const asked: ShoTurnRequest[] = [];
    return {
      asked,
      engine: {
        plan: (request) => {
          asked.push(request);
          return Promise.resolve(plan);
        },
      },
    };
  };

  const createPlan: ShoPlan = {
    kind: "call",
    toolName: TOOL,
    input: { name: "Катя" },
    reply: "Створив Катю.",
    command: createKate,
  };

  const created = async (): Promise<readonly ModelMessage[]> => {
    const { engine } = recordingEngine(createPlan);
    const outcome = await runShoTurn({
      ...turnWith(readPlan, () =>
        Promise.resolve({ kind: "ok", result: { id: CREATED, name: "Катя" } }),
      ),
      text: "створи клієнта Катя",
      engine,
    });
    return outcome.kind === "settled" ? outcome.appended : [];
  };

  it("stores the Шо turn beside the tool call it ran", async () => {
    const appended = await created();

    expect(shoFocusFrom(appended, SESSION)).toEqual([
      { type: "customer", id: CREATED, name: "Катя", how: "created", turns: 0 },
    ]);
    expect(shoPreviousFrom(appended)).toBeUndefined();
  });

  it("asks Шо with the focus the stored log holds, never with what a client sent", async () => {
    const appended = await created();
    const { engine, asked } = recordingEngine(readPlan);

    await runShoTurn({
      ...turnWith(readPlan, () =>
        Promise.resolve({ kind: "ok", result: { items: [] } }),
      ),
      text: "створи для неї замовлення",
      history: appended,
      engine,
    });

    expect(asked).toEqual([
      {
        text: "створи для неї замовлення",
        now: NOW,
        focus: [
          {
            type: "customer",
            id: CREATED,
            name: "Катя",
            how: "created",
            turns: 0,
          },
        ],
      },
    ]);
  });

  it("asks with an empty focus when the conversation holds no Шо turn", async () => {
    const { engine, asked } = recordingEngine(readPlan);

    await runShoTurn({
      ...turnWith(readPlan, () =>
        Promise.resolve({ kind: "ok", result: { items: [] } }),
      ),
      engine,
    });

    expect(asked[0]?.focus).toEqual([]);
  });

  it("stores nothing when the engine named no command", async () => {
    const outcome = await runShoTurn(
      turnWith(readPlan, () =>
        Promise.resolve({ kind: "ok", result: { items: [] } }),
      ),
    );

    expect(outcome.kind).toBe("settled");
    if (outcome.kind !== "settled") return;
    expect(shoFocusFrom(outcome.appended, SESSION)).toEqual([]);
  });
});
