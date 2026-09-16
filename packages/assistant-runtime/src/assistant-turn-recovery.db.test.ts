import { randomUUID } from "node:crypto";

import { acceptTurn, finishTurn, startTurn } from "@showzy/assistant";
import {
  createCapturingLogger,
  createTestKit,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import { assistantConversations } from "@showzy/db/schema/assistant";
import {
  RedisContainer,
  type StartedRedisContainer,
} from "@testcontainers/redis";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAssistantCallerKits } from "./assistant-runtime.js";
import {
  createAssistantTurnRecovery,
  type AssistantRecoveredTurn,
  type AssistantRecoveryAuthor,
} from "./assistant-turn-recovery.js";
import type { AssistantEventPublisher } from "./stores/assistant-events-redis.js";
import { assistantBudgetHoldFromStored } from "./stores/assistant-turn-store.js";
import {
  AI_BUDGET_TTL_SEC,
  aiBudgetHoldKey,
  aiCompanyBudgetKey,
  aiGlobalBudgetKey,
  createMemoryAiBudgetStore,
} from "./stores/budget.js";

const COMPANY = kitIdentities.companies.a;
const BIND = "anna:company-a";
const KYIV_DATE = "2026-09-15";
const HOLD = {
  companyReservedMicroUsd: 100_000,
  globalReservedMicroUsd: 50_000,
  kyivDate: KYIV_DATE,
};

let kit: TestKit;
let container: StartedRedisContainer;
let redis: Redis;

beforeAll(async () => {
  kit = await createTestKit();
  container = await new RedisContainer("redis:8-alpine").start();
  redis = new Redis(container.getConnectionUrl());
}, 180_000);

afterAll(async () => {
  await redis.quit();
  await container.stop();
  await kit.db.close();
});

function message(messageId: string, role: "user" | "assistant") {
  return {
    messageId,
    role,
    createdAt: "2026-09-15T10:00:00.000Z",
    parts: [
      {
        kind: "text",
        text: "",
        status: role === "user" ? "complete" : "streaming",
      },
    ],
  };
}

async function endedTurn(from: "queued" | "running") {
  const conversationId = randomUUID();
  const commandId = randomUUID();
  const userMessageId = randomUUID();
  const placeholderMessageId = randomUUID();
  await kit.db.runtime.db.insert(assistantConversations).values({
    id: conversationId,
    companyId: COMPANY,
    userId: kitIdentities.users.anna,
  });
  await kit.invoke(
    acceptTurn,
    {
      conversationId,
      kind: "chat",
      commandId,
      sessionId: "session-anna",
      userMessage: {
        messageId: userMessageId,
        bind: BIND,
        message: message(userMessageId, "user"),
      },
      placeholder: {
        messageId: placeholderMessageId,
        bind: BIND,
        message: message(placeholderMessageId, "assistant"),
      },
      budgetHold: HOLD,
      history: { kind: "append", message: { role: "user", content: "hi" } },
    },
    {},
  );
  const turn = { conversationId, kind: "chat" as const, commandId };
  if (from === "running") {
    await kit.invoke(startTurn, { ...turn, timeoutMs: 180_000 }, {});
  }
  const ended = await kit.invoke(
    finishTurn,
    { ...turn, status: "interrupted" },
    {},
  );
  if (ended.outcome !== "finished") {
    throw new Error("expected the turn to be interrupted");
  }
  return {
    placeholderMessageId,
    recovered: {
      companyId: COMPANY,
      turn,
      from,
      endReason: from === "queued" ? "not_started" : "timeout",
      releasedHold: assistantBudgetHoldFromStored(ended.releasedHold),
    } satisfies AssistantRecoveredTurn,
  };
}

interface Written {
  readonly conversationId: string;
  readonly messageId: string;
  readonly status: string;
  readonly userId: string;
}

function harness(refuse = false) {
  const budgetStore = createMemoryAiBudgetStore();
  const written: Written[] = [];
  const published: unknown[] = [];
  const publisher: AssistantEventPublisher = {
    publish: (address, event) => {
      published.push({ address, event });
      return Promise.resolve();
    },
  };
  const forCaller = (caller: {
    readonly userId: string;
  }): AssistantRecoveryAuthor => ({
    kit: {
      messages: {
        write: (scope, action) => {
          if (refuse) {
            return Promise.reject(new Error("membership is gone"));
          }
          written.push({
            conversationId: scope.conversationId,
            messageId: action.messageId,
            status: action.kind === "end_text" ? action.status : action.kind,
            userId: caller.userId,
          });
          return Promise.resolve({ kind: "written" });
        },
      },
    },
  });
  const recover = createAssistantTurnRecovery({
    pipeline: kit.pipeline,
    logger: createCapturingLogger().logger,
    forCaller,
    publisher,
    budgetStore,
  });
  return { recover, budgetStore, written, published };
}

async function counters(
  store: ReturnType<typeof createMemoryAiBudgetStore>,
): Promise<[number, number]> {
  return [
    await store.read(aiCompanyBudgetKey(COMPANY, KYIV_DATE)),
    await store.read(aiGlobalBudgetKey(KYIV_DATE)),
  ];
}

async function reserve(
  store: ReturnType<typeof createMemoryAiBudgetStore>,
  recovered: AssistantRecoveredTurn,
): Promise<void> {
  await store.add(
    aiCompanyBudgetKey(COMPANY, KYIV_DATE),
    0.2,
    AI_BUDGET_TTL_SEC,
  );
  await store.add(aiGlobalBudgetKey(KYIV_DATE), 0.1, AI_BUDGET_TTL_SEC);
  await store.claimHold(
    aiBudgetHoldKey({
      companyId: COMPANY,
      kyivDate: KYIV_DATE,
      kind: recovered.turn.kind,
      conversationId: recovered.turn.conversationId,
      commandId: recovered.turn.commandId,
    }),
    "held",
    AI_BUDGET_TTL_SEC,
  );
}

describe("the post-terminal recovery of a turn nobody is running", () => {
  it("gives a never-started turn's hold back once, settles its placeholder as its author and publishes the end", async () => {
    const { recovered, placeholderMessageId } = await endedTurn("queued");
    const { recover, budgetStore, written, published } = harness();
    await reserve(budgetStore, recovered);

    await recover(recovered, randomUUID());

    expect(recovered.from).toBe("queued");
    expect(recovered.endReason).toBe("not_started");
    expect(await counters(budgetStore)).toEqual([0.1, 0.05]);
    expect(written).toEqual([
      {
        conversationId: recovered.turn.conversationId,
        messageId: placeholderMessageId,
        status: "interrupted",
        userId: kitIdentities.users.anna,
      },
    ]);
    expect(published).toEqual([
      {
        address: {
          companyId: COMPANY,
          conversationId: recovered.turn.conversationId,
        },
        event: {
          type: "turn.finished",
          kind: "chat",
          commandId: recovered.turn.commandId,
          status: "interrupted",
          endReason: "not_started",
        },
      },
    ]);

    await recover(recovered, randomUUID());

    expect(await counters(budgetStore)).toEqual([0.1, 0.05]);
  });

  it("keeps a started turn's reservation as the charge, and still ends its text and publishes", async () => {
    const { recovered } = await endedTurn("running");
    const { recover, budgetStore, written, published } = harness();
    await reserve(budgetStore, recovered);

    await recover(recovered, randomUUID());

    expect(recovered.from).toBe("running");
    expect(recovered.endReason).toBe("timeout");
    expect(await counters(budgetStore)).toEqual([0.2, 0.1]);
    expect(written).toHaveLength(1);
    expect(published).toHaveLength(1);
  });

  it("settles the placeholder through the package's own caller kits, with no model mounted", async () => {
    const { recovered, placeholderMessageId } = await endedTurn("queued");
    const published: unknown[] = [];
    const forCaller = createAssistantCallerKits({
      pipeline: kit.pipeline,
      redis,
    });
    const recover = createAssistantTurnRecovery({
      pipeline: kit.pipeline,
      logger: createCapturingLogger().logger,
      forCaller,
      publisher: {
        publish: (_address, event) => {
          published.push(event);
          return Promise.resolve();
        },
      },
    });

    await recover(recovered, randomUUID());

    const read = await forCaller({
      userId: kitIdentities.users.anna,
      companySelector: COMPANY,
      requestId: randomUUID(),
    }).kit.messages.read({
      conversationId: recovered.turn.conversationId,
      bind: BIND,
    });
    const settled = read.messages.find(
      (message) => message.messageId === placeholderMessageId,
    );
    expect(settled?.parts).toEqual([
      { kind: "text", text: "", status: "interrupted" },
    ]);
    expect(published).toHaveLength(1);
  });

  it("still ends the turn's budget and publishes its status when the author write is refused", async () => {
    const { recovered } = await endedTurn("queued");
    const { recover, budgetStore, written, published } = harness(true);
    await reserve(budgetStore, recovered);

    await recover(recovered, randomUUID());

    expect(written).toEqual([]);
    expect(await counters(budgetStore)).toEqual([0.1, 0.05]);
    expect(published).toHaveLength(1);
  });
});
