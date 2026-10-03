import { createAssistantKit } from "@showzy/assistant-kit";
import type { ModelMessage, ToolSet } from "@showzy/assistant-kit";
import { testDeps } from "@showzy/assistant-kit/testing";
import { toProviderToolName } from "@showzy/ai";
import { ConfirmationRequiredError } from "@showzy/core/errors";
import { shoCommandSchema, type ShoCommand } from "@showzy/sho-protocol";
import {
  assistantConfirmationPromptSchema,
  ASSISTANT_PREVIEW_LIST_MAX,
} from "@showzy/validation/assistant-chat";
import { describe, expect, it, vi } from "vitest";

import {
  assistantInteractions,
  confirmation,
  type assistantInteractionTypes,
  type ConfirmationAlsoSecret,
} from "./assistant-interactions.js";
import { AssistantConfirmationRequired } from "./assistant-kit-confirmation.js";
import { createResolveAnswer } from "./assistant-kit-resolve.js";
import { shoFocusFrom, shoPreviousFrom } from "./sho-focus.js";

import {
  runShoTurn,
  shoFreeBudgetHold,
  shoToolCallId,
  type ShoEngine,
  type ShoPlan,
  type ShoTurnAsk,
  type ShoTurnInput,
  type ShoTurnRequest,
} from "./sho-turn.js";

const NOW = new Date("2026-09-11T09:30:00.000Z");
const COMMAND = "0d1f4b2a-6c3e-4a1d-9f55-7b2c8e1a4d60";
const TOOL = "customers_list_customers";
const SESSION = "4f2d6c1b-88a3-4e59-9a07-3c5d2e8f1b44";
const CONVERSATION = "7c9a1e35-4b62-4d08-9f71-2a6b5c8d3e10";
const BIND = "owner-1:scope-1";

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

  const CARRIED: ConfirmationAlsoSecret = {
    actionName: "customers.updateCustomer",
    canonicalInput: { id: "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1" },
    idempotencyKey: "tool:carried",
    challengeId: "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1",
    preview: { title: "Змінити клієнта: Галина", lines: [], notes: [] },
    level: "card",
  };

  const ASKED = {
    actionName: "orders.create",
    input: { customerQuery: "оксани" },
    idempotencyKey: "tool:asked",
  };

  const DRIFTED = {
    challengeId: "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1",
    summary: "Створити замовлення?",
    expiresAt: "2026-09-11T09:35:00.000Z",
    preview: confirmationPrompt.preview,
  };

  async function rePauseDroppingTheCarried(): Promise<unknown> {
    const resolution = confirmation.resolve({
      answer: { approved: true },
      secret: {
        actionName: ASKED.actionName,
        canonicalInput: ASKED.input,
        idempotencyKey: ASKED.idempotencyKey,
        challengeId: "d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1",
        also: [CARRIED],
      },
    });
    if (resolution.kind !== "resolved") {
      throw new Error("a confirmation always resolves");
    }
    const outcome = await createResolveAnswer({
      runConfirmed: () =>
        Promise.reject(
          new AssistantConfirmationRequired(
            ASKED,
            new ConfirmationRequiredError(DRIFTED),
          ),
        ),
      reSummarize: () => Promise.resolve({ id: "already-committed" }),
      logger: { warn: () => undefined },
    })({
      toolName: TOOL,
      kind: "confirmation",
      value: resolution.value,
      tools: {},
      context: {
        userId: "user-1",
        companySelector: "company-1",
        conversationId: CONVERSATION,
        commandId: COMMAND,
        requestId: "request-answer",
      },
    });
    if (outcome.kind !== "pause") {
      throw new Error("a drifted confirmation pauses");
    }
    return outcome.prompt;
  }

  it("composes the plan's note and a dropped carried entry into one list", async () => {
    const outcome = await runShoTurn(
      turnWith(notedPlan, pauseWith(await rePauseDroppingTheCarried())),
    );

    expect(outcome.kind).toBe("ask");
    if (outcome.kind !== "ask") return;
    const prompt = assistantConfirmationPromptSchema.parse(outcome.prompt);
    expect(prompt.preview.notes).toEqual([
      "Прочитано як нове замовлення.",
      `Вже виконано: «${CARRIED.preview.title}»`,
      "Оксана",
    ]);
  });

  it("keeps both notes when the card's own list is already full", async () => {
    const prompt = assistantConfirmationPromptSchema.parse(
      await rePauseDroppingTheCarried(),
    );
    const full = Array.from(
      { length: ASSISTANT_PREVIEW_LIST_MAX - prompt.preview.notes.length },
      (_, at) => String(at),
    );
    const outcome = await runShoTurn(
      turnWith(
        notedPlan,
        pauseWith({
          ...prompt,
          preview: {
            ...prompt.preview,
            notes: [...prompt.preview.notes, ...full],
          },
        }),
      ),
    );

    expect(outcome.kind).toBe("ask");
    if (outcome.kind !== "ask") return;
    const asked = assistantConfirmationPromptSchema.parse(outcome.prompt);
    expect(asked.preview.notes).toHaveLength(ASSISTANT_PREVIEW_LIST_MAX);
    expect(asked.preview.notes.slice(0, 2)).toEqual([
      "Прочитано як нове замовлення.",
      `Вже виконано: «${CARRIED.preview.title}»`,
    ]);
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

describe("runShoTurn over the stored log", () => {
  const CREATED = "11111111-1111-4111-8111-111111111111";
  const CREATE_TOOL = toProviderToolName("customers.createCustomer");

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

  const createPlan: ShoPlan = {
    kind: "call",
    toolName: CREATE_TOOL,
    input: { name: "Катя" },
    reply: "Створив Катю.",
    writes: true,
    command: createKate,
  };

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

  const pausing = (): ToolSet => ({
    [CREATE_TOOL]: {
      execute: () =>
        Promise.resolve({
          kind: "pause",
          interaction: "confirmation",
          prompt: { summary: "Створити Катю?" },
          secret: null,
        }),
    } as ToolSet[string],
  });

  const askCard = async (
    history: readonly ModelMessage[] = [],
  ): Promise<ShoTurnAsk> => {
    const { engine } = recordingEngine(createPlan);
    const outcome = await runShoTurn({
      text: "створи клієнта Катя",
      commandId: COMMAND,
      sessionId: SESSION,
      now: NOW,
      history,
      tools: () => Promise.resolve(pausing()),
      engine,
    });
    if (outcome.kind !== "ask") {
      throw new Error("expected the write to pause on its card");
    }
    return outcome;
  };

  const openCard = async (): Promise<readonly ModelMessage[]> =>
    (await askCard()).continuation.messages;

  const scope = { conversationId: CONVERSATION, bind: BIND };

  const cardFor = async (
    kit: ReturnType<
      typeof createAssistantKit<typeof assistantInteractionTypes>
    >,
    ask: ShoTurnAsk,
  ): Promise<string> => {
    const opened = await kit.open({
      ...scope,
      kind: "confirmation",
      prompt: {
        summary: "Створити Катю?",
        preview: { title: "Новий клієнт", lines: [], notes: [] },
        also: [],
        level: "card",
      },
      secret: {
        actionName: "customers.createCustomer",
        canonicalInput: { name: "Катя" },
        idempotencyKey: "k",
        challengeId: "c",
        also: [],
      },
      continuation: ask.continuation,
    });
    if (opened.kind !== "opened") {
      throw new Error("expected an open card");
    }
    return opened.pause.interactionId;
  };

  const answered = async (
    ask: ShoTurnAsk,
    result: unknown,
  ): Promise<readonly ModelMessage[]> => {
    const kit = createAssistantKit(testDeps(assistantInteractions));
    const interactionId = await cardFor(kit, ask);
    const claimed = await kit.claim({
      ...scope,
      interactionId,
      revision: 1,
      answer: { approved: true },
    });
    if (claimed.kind !== "claimed") {
      throw new Error("expected the tap to claim the card");
    }
    return kit.resume(claimed, result).messages;
  };

  const walkedAwayFrom = async (ask: ShoTurnAsk): Promise<void> => {
    const kit = createAssistantKit(testDeps(assistantInteractions));
    const interactionId = await cardFor(kit, ask);
    const dropped = await kit.abandon({ ...scope, interactionId });
    if (dropped.kind !== "cancelled") {
      throw new Error("expected the card to be dropped");
    }
  };

  it("holds nothing of a write the person has not answered", async () => {
    const paused = await openCard();

    expect(shoFocusFrom(paused, SESSION)).toEqual([]);
    expect(shoPreviousFrom(paused)).toBeUndefined();
  });

  it("takes the created id and drops previous once the write settles", async () => {
    const settled = await answered(await askCard(), {
      id: CREATED,
      name: "Катя",
    });

    expect(shoFocusFrom(settled, SESSION)).toEqual([
      { type: "customer", id: CREATED, name: "Катя", how: "created", turns: 0 },
    ]);
    expect(shoPreviousFrom(settled)).toBeUndefined();
  });

  it("asks Шо with the focus the stored log holds, never with what a client sent", async () => {
    const settled = await answered(await askCard(), {
      id: CREATED,
      name: "Катя",
    });
    const { engine, asked } = recordingEngine(readPlan);

    await runShoTurn({
      ...turnWith(readPlan, () =>
        Promise.resolve({ kind: "ok", result: { items: [] } }),
      ),
      text: "створи для неї замовлення",
      history: settled,
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

  it("asks with nothing from a card the person walked away from", async () => {
    const ask = await askCard();
    await walkedAwayFrom(ask);
    const { engine, asked } = recordingEngine(readPlan);

    await runShoTurn({
      ...turnWith(readPlan, () =>
        Promise.resolve({ kind: "ok", result: { items: [] } }),
      ),
      history: ask.continuation.messages,
      engine,
    });

    expect(asked[0]?.focus).toEqual([]);
    expect(asked[0]?.previous).toBeUndefined();
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
