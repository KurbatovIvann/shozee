import { randomUUID } from "node:crypto";

import { testStaffProvider } from "@showzy/ai/test";
import {
  createPostgresAssistantTurnStore,
  SHO_INVOCATION_CHANNEL,
  type ShoEngineFor,
  type ShoPlan,
  type ShoVerifiedMember,
} from "@showzy/assistant-runtime";
import type { ActionPipelineDeps, ActionTelemetry } from "@showzy/core";
import { AssistantKitConversationGoneError } from "@showzy/assistant-runtime";
import {
  createTestKit,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import {
  assistantChatMessages,
  assistantConversations,
  assistantTurns,
} from "@showzy/db/schema/assistant";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createActionRegistry } from "../registry.js";
import type { AssistantKitRuntime } from "./assistant-kit-http.js";
import { createAssistantKitRuntime } from "./assistant-kit-runtime.js";
import { shoChatTurn } from "./assistant-kit-sho.js";

const LIST_TOOL = "customers_list_customers";
const LIST_ACTION = "customers.listCustomers";

const READS_CUSTOMERS: ShoPlan = {
  kind: "call",
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

function runtimeWith(
  pipeline: ActionPipelineDeps,
  sho: ShoEngineFor | undefined,
): AssistantKitRuntime {
  return createAssistantKitRuntime({
    auth: { api: { getSession: () => Promise.resolve(null) } },
    registry: createActionRegistry(),
    pipeline,
    model: "mock",
    provider: testStaffProvider,
    redis: memoryRedis(),
    ...(sho === undefined ? {} : { sho }),
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

function who(
  userId: string,
  companySelector: string,
): {
  readonly userId: string;
  readonly companySelector: string;
  readonly bind: string;
  readonly sessionId: string;
} {
  return {
    userId,
    companySelector,
    bind: `${userId}:${companySelector}`,
    sessionId: randomUUID(),
  };
}

const anna = who(kitIdentities.users.anna, kitIdentities.companies.a);
const boris = who(kitIdentities.users.boris, kitIdentities.companies.b);

async function runTurn(
  caller: ReturnType<typeof who>,
  conversationId: string,
  sho: ShoEngineFor | undefined,
  pipeline: ActionPipelineDeps = kit.pipeline,
): Promise<{
  readonly response: Response | null;
  readonly requestId: string;
  readonly commandId: string;
  readonly runtime: AssistantKitRuntime;
}> {
  const runtime = runtimeWith(pipeline, sho);
  const requestId = randomUUID();
  const commandId = randomUUID();
  const scoped = runtime.forCaller({
    userId: caller.userId,
    companySelector: caller.companySelector,
    requestId,
    clientIp: "127.0.0.1",
  });
  const response = await shoChatTurn({
    runtime,
    caller,
    kit: scoped.kit,
    turns: createPostgresAssistantTurnStore(
      { pipeline },
      {
        userId: caller.userId,
        companySelector: caller.companySelector,
        requestId,
        clientIp: "127.0.0.1",
      },
    ),
    history: scoped.history,
    scope: { conversationId, bind: caller.bind },
    requestId,
    clientIp: "127.0.0.1",
    text: "покажи клієнтів",
    commandId,
  });
  return { response, requestId, commandId, runtime };
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
    const { response, commandId } = await runTurn(
      anna,
      conversationId,
      enginePlanning(() => Promise.resolve(READS_CUSTOMERS), seen),
      { ...kit.pipeline, telemetry: recorder.telemetry },
    );

    expect(response?.status).toBe(200);
    expect(seen.mock.calls[0]?.[0]?.verifiedCompanyId).toBe(
      kitIdentities.companies.a,
    );
    expect(recorder.spans).toContainEqual({
      action: LIST_ACTION,
      channel: SHO_INVOCATION_CHANNEL,
    });
    expect(kit.jobs.sent).toEqual([]);

    const rows = await kit.db.runtime.db
      .select()
      .from(assistantTurns)
      .where(eq(assistantTurns.commandId, commandId));
    const turn = rows[0];
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
      const { response, commandId } = await runTurn(anna, conversationId, sho);
      expect(response).toBeNull();
      await expect(
        kit.db.runtime.db
          .select()
          .from(assistantTurns)
          .where(eq(assistantTurns.commandId, commandId)),
      ).resolves.toEqual([]);
    }
  });

  it("cannot settle into another company's conversation", async () => {
    const annaConversation = await newConversation({
      companyId: kitIdentities.companies.a,
      userId: kitIdentities.users.anna,
    });

    await expect(
      runTurn(
        boris,
        annaConversation,
        enginePlanning(() => Promise.resolve(READS_CUSTOMERS)),
      ),
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
    const { runtime } = await runTurn(
      anna,
      conversationId,
      enginePlanning(() => Promise.resolve(READS_CUSTOMERS)),
    );

    const history = await runtime
      .forCaller({
        userId: anna.userId,
        companySelector: anna.companySelector,
        requestId: randomUUID(),
        clientIp: "127.0.0.1",
      })
      .history.load({ conversationId, bind: anna.bind });

    expect(history.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    const call = history[1]?.content;
    expect(Array.isArray(call) && call[0]).toMatchObject({
      type: "tool-call",
      toolName: LIST_TOOL,
    });
    const toolCallId = Array.isArray(call)
      ? (call[0] as { readonly toolCallId: string }).toolCallId
      : "";
    expect(toolCallId.startsWith("sho-")).toBe(true);
    expect(toolCallId).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(history.at(-1)).toEqual({
      role: "assistant",
      content: "Ось клієнти.",
    });
  });
});
