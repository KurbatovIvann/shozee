import { randomUUID } from "node:crypto";

import { testStaffProvider } from "@showzy/ai/test";
import { createAssistantKit, type ModelMessage } from "@showzy/assistant-kit";
import { memoryPauseStore } from "@showzy/assistant-kit/testing";
import {
  assistantInteractions,
  ASSISTANT_CHAT_WINDOW_MESSAGES,
  AssistantKitConversationGoneError,
  createPostgresAssistantKitMessageLog,
  SHO_INVOCATION_CHANNEL,
  type AssistantHistoryPort,
  type AssistantKitCommandRef,
  type AssistantKitFor,
  type ShoEngineFor,
  type ShoEscalation,
  type ShoPlan,
  type ShoVerifiedMember,
} from "@showzy/assistant-runtime";
import {
  createConfirmationHook,
  createInMemoryConfirmationStore,
  type ActionPipelineDeps,
  type ActionTelemetry,
} from "@showzy/core";
import {
  createTestKit,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import {
  assistantChatMessages,
  assistantChatState,
  assistantConversations,
  assistantTurns,
} from "@showzy/db/schema/assistant";
import { companyCustomers } from "@showzy/db/schema/customers";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createActionRegistry } from "../registry.js";
import type { AssistantKitRuntime } from "./assistant-kit-http.js";
import { createAssistantKitRuntime } from "./assistant-kit-runtime.js";
import { shoChatTurn } from "./assistant-kit-sho.js";

const LIST_TOOL = "customers_list_customers";
const LIST_ACTION = "customers.listCustomers";
const UPDATE_TOOL = "customers_updateCustomer";

const READS_CUSTOMERS: ShoPlan = {
  kind: "call",
  writes: false,
  toolName: LIST_TOOL,
  input: {},
  reply: "Ось клієнти.",
};

let kit: TestKit;

function memoryRedis() {
  return {
    eval: () => Promise.resolve(null),
    get: () => Promise.resolve(null),
    set: () => Promise.resolve("OK"),
    del: () => Promise.resolve(1),
  } as never;
}

function withChallenges(): ActionPipelineDeps {
  return {
    ...kit.pipeline,
    hooks: {
      ...kit.pipeline.hooks,
      confirmation: createConfirmationHook({
        store: createInMemoryConfirmationStore(),
      }),
    },
  };
}

function channelRecorder(): {
  readonly telemetry: ActionTelemetry;
  readonly spans: { action: string; channel: string }[];
} {
  const spans: { action: string; channel: string }[] = [];
  return {
    spans,
    telemetry: {
      startSpan: (fields) => {
        spans.push({ action: fields.action, channel: fields.channel });
        return { recordError: () => undefined, end: () => undefined };
      },
    },
  };
}

function recordingCommands(): {
  readonly commands: AssistantKitRuntime["commands"];
  readonly released: AssistantKitCommandRef[];
} {
  const released: AssistantKitCommandRef[] = [];
  return {
    released,
    commands: {
      take: () => Promise.resolve(true),
      spent: () => Promise.resolve(false),
      release: (command) => {
        released.push(command);
        return Promise.resolve();
      },
    },
  };
}

function runtimeWith(
  pipeline: ActionPipelineDeps,
  sho: ShoEngineFor | undefined,
  commands?: AssistantKitRuntime["commands"],
): AssistantKitRuntime {
  const runtime = createAssistantKitRuntime({
    auth: { api: { getSession: () => Promise.resolve(null) } },
    registry: createActionRegistry(),
    pipeline,
    model: "mock",
    provider: testStaffProvider,
    redis: memoryRedis(),
    ...(sho === undefined ? {} : { sho }),
  });
  return commands === undefined ? runtime : { ...runtime, commands };
}

function kitWithMemoryPauses(
  pipeline: ActionPipelineDeps,
  caller: { userId: string; companySelector: string; requestId: string },
): AssistantKitFor {
  return createAssistantKit({
    pauses: memoryPauseStore(),
    messages: createPostgresAssistantKitMessageLog(
      { pipeline },
      caller,
      undefined,
    ),
    clock: { now: () => new Date() },
    ids: { uuid: () => randomUUID() },
    interactions: assistantInteractions,
    window: { messages: ASSISTANT_CHAT_WINDOW_MESSAGES },
  });
}

function enginePlanning(
  plan: () => Promise<ShoPlan>,
  seen?: (member: ShoVerifiedMember) => void,
): ShoEngineFor {
  return (member) => {
    seen?.(member);
    return { plan };
  };
}

async function newConversation(owner: {
  companyId: string;
  userId: string;
}): Promise<string> {
  const id = randomUUID();
  await kit.db.runtime.db
    .insert(assistantConversations)
    .values({ id, ...owner });
  return id;
}

async function seedCustomer(name = "Катя Самбука"): Promise<string> {
  const id = randomUUID();
  await kit.db.runtime.db.insert(companyCustomers).values({
    id,
    companyId: kitIdentities.companies.a,
    name,
    email: `katya-${randomUUID()}@example.com`,
    status: "active",
  });
  return id;
}

async function storedHistory(
  conversationId: string,
): Promise<readonly ModelMessage[]> {
  const row = (
    await kit.db.runtime.db
      .select({ history: assistantChatState.history })
      .from(assistantChatState)
      .where(eq(assistantChatState.conversationId, conversationId))
  )[0];
  return Array.isArray(row?.history) ? (row.history as ModelMessage[]) : [];
}

function who(
  userId: string,
  companySelector: string,
  bind = `${userId}:${companySelector}`,
): {
  readonly userId: string;
  readonly companySelector: string;
  readonly bind: string;
  readonly sessionId: string;
} {
  return { userId, companySelector, bind, sessionId: randomUUID() };
}

const anna = who(kitIdentities.users.anna, kitIdentities.companies.a);
const boris = who(kitIdentities.users.boris, kitIdentities.companies.b);

interface TurnRun {
  readonly response: Response | null;
  readonly escalation: ShoEscalation | undefined;
  readonly commandId: string;
  readonly kit: AssistantKitFor;
  readonly scope: { conversationId: string; bind: string };
}

async function runTurn(options: {
  readonly caller: ReturnType<typeof who>;
  readonly conversationId: string;
  readonly sho: ShoEngineFor | undefined;
  readonly pipeline?: ActionPipelineDeps;
  readonly runtime?: AssistantKitRuntime;
  readonly history?: AssistantHistoryPort;
}): Promise<TurnRun> {
  const pipeline = options.pipeline ?? kit.pipeline;
  const runtime = options.runtime ?? runtimeWith(pipeline, options.sho);
  const requestId = randomUUID();
  const commandId = randomUUID();
  const caller = {
    userId: options.caller.userId,
    companySelector: options.caller.companySelector,
    requestId,
    clientIp: "127.0.0.1",
  };
  const scoped = runtime.forCaller(caller);
  const scope = {
    conversationId: options.conversationId,
    bind: options.caller.bind,
  };
  const paused = kitWithMemoryPauses(pipeline, caller);
  const outcome = await shoChatTurn({
    runtime,
    caller: options.caller,
    verifiedCompanyId:
      options.caller === boris
        ? kitIdentities.companies.b
        : kitIdentities.companies.a,
    kit: paused,
    turns: scoped.turns,
    history: options.history ?? scoped.history,
    scope,
    command: {
      route: "chat",
      bind: options.caller.bind,
      conversationId: options.conversationId,
      commandId,
    },
    requestId,
    clientIp: "127.0.0.1",
    text: "покажи клієнтів",
  });
  return {
    response: outcome.kind === "answered" ? outcome.response : null,
    escalation: outcome.kind === "escalate" ? outcome.escalation : undefined,
    commandId,
    kit: paused,
    scope,
  };
}

async function turnRow(commandId: string) {
  return (
    await kit.db.runtime.db
      .select()
      .from(assistantTurns)
      .where(eq(assistantTurns.commandId, commandId))
  )[0];
}

beforeAll(async () => {
  kit = await createTestKit();
}, 180_000);

afterAll(async () => {
  await kit.db.close();
});

describe("Шо-first chat accept", () => {
  it("settles a read in the request: the card, the reply, a done turn and a $0 hold", async () => {
    const conversationId = await newConversation({
      companyId: kitIdentities.companies.a,
      userId: kitIdentities.users.anna,
    });
    const recorder = channelRecorder();
    const seen = vi.fn<(member: ShoVerifiedMember) => void>();
    kit.jobs.clear();
    const { response, commandId } = await runTurn({
      caller: anna,
      conversationId,
      sho: enginePlanning(() => Promise.resolve(READS_CUSTOMERS), seen),
      pipeline: { ...kit.pipeline, telemetry: recorder.telemetry },
    });

    expect(response?.status).toBe(200);
    expect(seen.mock.calls[0]?.[0]?.verifiedCompanyId).toBe(
      kitIdentities.companies.a,
    );
    expect(recorder.spans).toContainEqual({
      action: LIST_ACTION,
      channel: SHO_INVOCATION_CHANNEL,
    });
    expect(kit.jobs.sent).toEqual([]);

    const turn = await turnRow(commandId);
    expect(turn?.status).toBe("done");
    expect(turn?.sessionId).toBeNull();
    expect(turn?.finishedAt).not.toBeNull();
    expect(turn?.companyReservedMicroUsd).toBe(0);
    expect(turn?.globalReservedMicroUsd).toBe(0);

    const messages = await kit.db.runtime.db
      .select()
      .from(assistantChatMessages)
      .where(eq(assistantChatMessages.conversationId, conversationId));
    const placeholder = messages.find(
      (row) => row.messageId === turn?.placeholderMessageId,
    )?.message as { readonly parts: readonly { kind: string }[] } | undefined;
    expect(placeholder?.parts.map((part) => part.kind)).toEqual([
      "card",
      "text",
    ]);
    expect(placeholder?.parts.at(-1)).toEqual({
      kind: "text",
      text: "Ось клієнти.",
      status: "complete",
    });
  });

  it("leaves the LLM path to a fallback, a refusal to plan and a Шо that is down", async () => {
    const conversationId = await newConversation({
      companyId: kitIdentities.companies.a,
      userId: kitIdentities.users.anna,
    });

    for (const sho of [
      undefined,
      enginePlanning(() =>
        Promise.resolve({ kind: "fallback", reason: "timeout" }),
      ),
      enginePlanning(() => Promise.reject(new Error("sho is unreachable"))),
    ]) {
      const { response, commandId } = await runTurn({
        caller: anna,
        conversationId,
        sho,
      });
      expect(response).toBeNull();
      expect(await turnRow(commandId)).toBeUndefined();
    }
    expect(await storedHistory(conversationId)).toEqual([]);
  });

  it("cannot settle into another company's conversation", async () => {
    const annaConversation = await newConversation({
      companyId: kitIdentities.companies.a,
      userId: kitIdentities.users.anna,
    });

    await expect(
      runTurn({
        caller: boris,
        conversationId: annaConversation,
        sho: enginePlanning(() => Promise.resolve(READS_CUSTOMERS)),
      }),
    ).rejects.toBeInstanceOf(AssistantKitConversationGoneError);

    await expect(
      kit.db.runtime.db
        .select()
        .from(assistantChatMessages)
        .where(eq(assistantChatMessages.conversationId, annaConversation)),
    ).resolves.toEqual([]);
    await expect(
      kit.db.runtime.db
        .select()
        .from(assistantTurns)
        .where(eq(assistantTurns.conversationId, annaConversation)),
    ).resolves.toEqual([]);
  });

  it("hands a valid transcript to the next LLM turn", async () => {
    const conversationId = await newConversation({
      companyId: kitIdentities.companies.a,
      userId: kitIdentities.users.anna,
    });
    await runTurn({
      caller: anna,
      conversationId,
      sho: enginePlanning(() => Promise.resolve(READS_CUSTOMERS)),
    });

    const history = await storedHistory(conversationId);
    expect(history.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    const call = history[1]?.content;
    const toolCallId = Array.isArray(call)
      ? (call[0] as { readonly toolCallId: string; readonly toolName: string })
      : { toolCallId: "", toolName: "" };
    expect(toolCallId.toolName).toBe(LIST_TOOL);
    expect(toolCallId.toolCallId.startsWith("sho-")).toBe(true);
    expect(toolCallId.toolCallId).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(history.at(-1)).toEqual({
      role: "assistant",
      content: "Ось клієнти.",
    });
  });

  it("appends its exchange, so a turn planned from a stale snapshot loses nothing", async () => {
    const conversationId = await newConversation({
      companyId: kitIdentities.companies.a,
      userId: kitIdentities.users.anna,
    });
    const sho = enginePlanning(() => Promise.resolve(READS_CUSTOMERS));

    await runTurn({ caller: anna, conversationId, sho });
    const afterFirst = await storedHistory(conversationId);
    expect(afterFirst).toHaveLength(4);

    const stale: AssistantHistoryPort = {
      load: () => Promise.resolve([]),
      save: () => Promise.resolve(),
    };
    const { response } = await runTurn({
      caller: anna,
      conversationId,
      sho,
      history: stale,
    });

    expect(response?.status).toBe(200);
    const afterSecond = await storedHistory(conversationId);
    expect(afterSecond).toHaveLength(8);
    expect(afterSecond.slice(0, 4)).toEqual(afterFirst);
  });
});

describe("a Шо turn that has to ask", () => {
  it("stops a planned write at the preview pause and executes nothing", async () => {
    const conversationId = await newConversation({
      companyId: kitIdentities.companies.a,
      userId: kitIdentities.users.anna,
    });
    const customerId = await seedCustomer();
    const pipeline = withChallenges();
    const {
      response,
      commandId,
      kit: paused,
      scope,
    } = await runTurn({
      caller: anna,
      conversationId,
      pipeline,
      sho: enginePlanning(() =>
        Promise.resolve({
          kind: "call",
          writes: false,
          toolName: UPDATE_TOOL,
          input: { id: customerId, name: "Катерина Самбука" },
          reply: "Перейменувати?",
        }),
      ),
    });

    expect(response?.status).toBe(200);
    const turn = await turnRow(commandId);
    expect(turn?.status).toBe("done");

    const messages = await kit.db.runtime.db
      .select()
      .from(assistantChatMessages)
      .where(eq(assistantChatMessages.conversationId, conversationId));
    const placeholder = messages.find(
      (row) => row.messageId === turn?.placeholderMessageId,
    )?.message as { readonly parts: readonly { kind: string }[] } | undefined;
    expect(placeholder?.parts.map((part) => part.kind)).toEqual([
      "interaction",
    ]);
    expect(await paused.peek(scope)).not.toBeNull();

    const stored = (
      await kit.db.runtime.db
        .select({ name: companyCustomers.name })
        .from(companyCustomers)
        .where(eq(companyCustomers.id, customerId))
    )[0];
    expect(stored?.name).toBe("Катя Самбука");
  });

  it("pauses a notes-only update that names no name and keeps the stored one", async () => {
    const conversationId = await newConversation({
      companyId: kitIdentities.companies.a,
      userId: kitIdentities.users.anna,
    });
    const customerId = await seedCustomer("Віталій Гончар");
    const {
      response,
      kit: paused,
      scope,
    } = await runTurn({
      caller: anna,
      conversationId,
      pipeline: withChallenges(),
      sho: enginePlanning(() =>
        Promise.resolve({
          kind: "call",
          writes: false,
          toolName: UPDATE_TOOL,
          input: { id: customerId, notes: "бере тільки оптом" },
          reply: "Клієнта оновлено.",
        }),
      ),
    });

    expect(response?.status).toBe(200);
    expect(await paused.peek(scope)).not.toBeNull();

    const stored = (
      await kit.db.runtime.db
        .select({
          name: companyCustomers.name,
          notes: companyCustomers.notes,
        })
        .from(companyCustomers)
        .where(eq(companyCustomers.id, customerId))
    )[0];
    expect(stored).toMatchObject({ name: "Віталій Гончар", notes: null });
  });

  it("withdraws the question when another turn already holds the conversation", async () => {
    const conversationId = await newConversation({
      companyId: kitIdentities.companies.a,
      userId: kitIdentities.users.anna,
    });
    const customerId = await seedCustomer();
    const pipeline = withChallenges();
    const runtime = runtimeWith(pipeline, undefined);
    await runtime
      .forCaller({
        userId: anna.userId,
        companySelector: anna.companySelector,
        requestId: randomUUID(),
        clientIp: "127.0.0.1",
      })
      .turns.accept({
        kind: "chat",
        conversationId,
        commandId: randomUUID(),
        text: "перше питання",
        bind: anna.bind,
        sessionId: randomUUID(),
        budgetHold: {
          companyReservedUsd: 0,
          globalReservedUsd: 0,
          kyivDate: "2026-09-11",
        },
        releaseUnusedHold: () => Promise.resolve(),
      });

    const {
      response,
      commandId,
      kit: paused,
      scope,
    } = await runTurn({
      caller: anna,
      conversationId,
      pipeline,
      sho: enginePlanning(() =>
        Promise.resolve({
          kind: "call",
          writes: false,
          toolName: UPDATE_TOOL,
          input: { id: customerId, name: "Катерина Самбука" },
          reply: "Перейменувати?",
        }),
      ),
    });

    expect(response).toBeNull();
    expect(await turnRow(commandId)).toBeUndefined();
    expect(await paused.peek(scope)).toBeNull();
  });

  it("withdraws the question and gives the command back when the log has another owner", async () => {
    const conversationId = await newConversation({
      companyId: kitIdentities.companies.a,
      userId: kitIdentities.users.anna,
    });
    const customerId = await seedCustomer();
    await runTurn({
      caller: anna,
      conversationId,
      sho: enginePlanning(() => Promise.resolve(READS_CUSTOMERS)),
    });

    const pipeline = withChallenges();
    const recording = recordingCommands();
    const intruder = who(
      kitIdentities.users.anna,
      kitIdentities.companies.a,
      "another-owner-token",
    );
    const {
      response,
      commandId,
      kit: paused,
      scope,
    } = await runTurn({
      caller: intruder,
      conversationId,
      pipeline,
      sho: enginePlanning(() =>
        Promise.resolve({
          kind: "call",
          writes: false,
          toolName: UPDATE_TOOL,
          input: { id: customerId, name: "Катерина Самбука" },
          reply: "Перейменувати?",
        }),
      ),
      runtime: runtimeWith(
        pipeline,
        enginePlanning(() =>
          Promise.resolve({
            kind: "call",
            writes: false,
            toolName: UPDATE_TOOL,
            input: { id: customerId, name: "Катерина Самбука" },
            reply: "Перейменувати?",
          }),
        ),
        recording.commands,
      ),
    });

    expect(response?.status).toBe(410);
    expect(await turnRow(commandId)).toBeUndefined();
    expect(await paused.peek(scope)).toBeNull();
    expect(recording.released.map((command) => command.commandId)).toEqual([
      commandId,
    ]);
  });
});
