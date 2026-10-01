import { randomUUID } from "node:crypto";

import {
  RedisContainer,
  type StartedRedisContainer,
} from "@testcontainers/redis";
import type { ToolOutcome } from "@showzy/assistant-kit";
import {
  type AssistantToolContext,
  type ShoEngine,
  type ShoResult,
} from "@showzy/assistant-runtime";
import { COMPANY_SELECTOR_HEADER } from "@showzy/contract";
import {
  createTestKit,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import {
  assistantConversations,
  assistantTurns,
} from "@showzy/db/schema/assistant";
import { products } from "@showzy/db/schema/catalog";
import { companyCustomers } from "@showzy/db/schema/customers";
import { orders } from "@showzy/db/schema/orders";
import type { ModelMessage } from "@showzy/assistant-kit";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createActionRegistry } from "../registry.js";
import { ASSISTANT_KIT_ANSWER_PATH } from "./assistant-kit-answer.js";
import { ASSISTANT_KIT_CHAT_PATH } from "./assistant-kit-chat.js";
import { createAssistantKitApp } from "./assistant-kit.js";
import { createAssistantKitRuntime } from "./assistant-kit-runtime.js";

const COMPANY = kitIdentities.companies.a;
const ANNA = kitIdentities.users.anna;
const SURE = { action: 0.99, margin: 0.9, spans: 0.95 };

let kit: TestKit;
let container: StartedRedisContainer;
let redis: Redis;
const registry = createActionRegistry();

let customerKoval = "";
let customerShevchenko = "";
let cakeProduct = "";

beforeAll(async () => {
  kit = await createTestKit();
  container = await new RedisContainer("redis:8-alpine").start();
  redis = new Redis(container.getConnectionUrl());
  customerKoval = await seedCustomer("Олена Коваль");
  customerShevchenko = await seedCustomer("Олена Шевченко");
  cakeProduct = await seedProduct("Медовий торт");
}, 300_000);

afterAll(async () => {
  await redis.quit();
  await container.stop();
  await kit.db.close();
});

beforeEach(async () => {
  await redis.flushall();
});

async function seedCustomer(name: string): Promise<string> {
  const id = randomUUID();
  await kit.db.runtime.db
    .insert(companyCustomers)
    .values({ id, companyId: COMPANY, name, email: `${id}@example.com` });
  return id;
}

async function seedProduct(name: string): Promise<string> {
  const id = randomUUID();
  await kit.db.runtime.db
    .insert(products)
    .values({ id, companyId: COMPANY, name, basePriceMinor: 45000n });
  return id;
}

async function newConversation(): Promise<string> {
  const id = randomUUID();
  await kit.db.runtime.db
    .insert(assistantConversations)
    .values({ id, companyId: COMPANY, userId: ANNA });
  return id;
}

function headers(): Record<string, string> {
  return {
    "content-type": "application/json",
    [COMPANY_SELECTOR_HEADER]: COMPANY,
  };
}

function engineOf(next: () => ShoResult | Promise<ShoResult>): ShoEngine {
  return { parse: async () => await next() };
}

function harness(sho?: ShoEngine) {
  const runtime = createAssistantKitRuntime({
    auth: {
      api: {
        getSession: () =>
          Promise.resolve({ user: { id: ANNA }, session: { id: "s-1" } }),
      },
    },
    registry,
    pipeline: kit.pipeline,
    model: "mock",
    redis,
    ...(sho === undefined ? {} : { sho }),
  });
  return { runtime, app: createAssistantKitApp(runtime) };
}

async function post(
  app: ReturnType<typeof createAssistantKitApp>,
  path: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await app.request(path, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

interface Window {
  messages: {
    role: string;
    parts: { kind: string; type?: string; text?: string }[];
  }[];
  openPause: { kind: string; interactionId: string; revision: number } | null;
  turn: unknown;
}

function windowOf(body: Record<string, unknown>): Window {
  return body["window"] as Window;
}

function toolContextOf(conversationId: string): AssistantToolContext {
  return {
    userId: ANNA,
    companySelector: COMPANY,
    conversationId,
    commandId: randomUUID(),
    requestId: randomUUID(),
    clientIp: "127.0.0.1",
  };
}

async function seedYesterdaysOrders(
  runtime: ReturnType<typeof harness>["runtime"],
): Promise<void> {
  const conversationId = await newConversation();
  for (let made = 0; made < 2; made += 1) {
    const tools = await runtime.tools(toolContextOf(conversationId));
    const execute = tools["orders_create"]?.execute;
    if (execute === undefined) {
      throw new Error("orders_create is not offered");
    }
    const outcome = (await execute(
      {
        customerId: customerKoval,
        items: [{ productId: cakeProduct, quantityDecimal: "1.000" }],
      },
      { toolCallId: `seed_${String(made)}`, messages: [] } as never,
    )) as ToolOutcome;
    expect(outcome.kind).toBe("ok");
  }
  await kit.db.runtime.db
    .update(orders)
    .set({ createdAt: sql`now() - interval '1 day'` })
    .where(eq(orders.companyId, COMPANY));
}

function listYesterday(): ShoResult {
  return {
    tooMany: false,
    commands: [
      {
        action: "orders.list",
        params: {
          period: { value: "yesterday" },
        },
        needs: [],
        confidence: SURE,
      },
    ],
  };
}

function createForKoval(): ShoResult {
  return {
    tooMany: false,
    commands: [
      {
        action: "orders.create",
        params: {
          customer: { text: "Олени", status: "resolved", id: customerKoval },
          items: [
            {
              product: {
                text: "медових торти",
                status: "resolved",
                id: cakeProduct,
              },
              variant: { status: "none" },
              quantity: { value: 2 },
            },
          ],
        },
        needs: [],
        confidence: SURE,
      },
    ],
  };
}

function createForAmbiguousOlena(): ShoResult {
  return {
    tooMany: false,
    commands: [
      {
        action: "orders.create",
        params: {
          customer: {
            text: "Олена",
            status: "ambiguous",
            candidates: [
              { id: customerKoval, name: "Олена Коваль" },
              { id: customerShevchenko, name: "Олена Шевченко" },
            ],
          },
          items: [
            {
              product: {
                text: "медових торти",
                status: "resolved",
                id: cakeProduct,
              },
              variant: { status: "none" },
              quantity: { value: 2 },
            },
          ],
        },
        needs: [{ path: "customer", reason: "ambiguous", blocking: true }],
        confidence: SURE,
      },
    ],
  };
}

async function turnRow(conversationId: string, commandId: string) {
  return (
    await kit.db.runtime.db
      .select({
        status: assistantTurns.status,
        finishedAt: assistantTurns.finishedAt,
        sessionId: assistantTurns.sessionId,
        reserved: assistantTurns.companyReservedMicroUsd,
      })
      .from(assistantTurns)
      .where(
        and(
          eq(assistantTurns.conversationId, conversationId),
          eq(assistantTurns.commandId, commandId),
        ),
      )
  )[0];
}

async function ordersOf(customerId: string): Promise<number> {
  const rows = await kit.db.runtime.db
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        eq(orders.companyId, COMPANY),
        inArray(orders.customerId, [customerId]),
      ),
    );
  return rows.length;
}

async function storedHistory(
  runtime: ReturnType<typeof harness>["runtime"],
  conversationId: string,
): Promise<ModelMessage[]> {
  const { history } = runtime.forCaller({
    userId: ANNA,
    companySelector: COMPANY,
    requestId: randomUUID(),
  });
  return await history.load({
    conversationId,
    bind: `${ANNA}:${COMPANY}`,
  });
}

describe("a synchronous Шо turn", () => {
  it("answers a read in the request, settled, with the card", async () => {
    const { app, runtime } = harness(engineOf(listYesterday));
    await seedYesterdaysOrders(runtime);
    const conversationId = await newConversation();
    const commandId = randomUUID();

    const answer = await post(app, ASSISTANT_KIT_CHAT_PATH, {
      commandId,
      conversationId,
      text: "покажи замовлення за вчора",
    });

    expect(answer.status).toBe(200);
    expect(answer.body["status"]).toBe("ok");
    const window = windowOf(answer.body);
    expect(window.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    const parts = window.messages[1]?.parts ?? [];
    expect(parts.map((part) => part.kind)).toEqual(["card", "text"]);
    expect(parts[0]?.type).toBe("orders-list");
    expect(parts[1]?.text).toContain("2");
    expect(window.turn).toBeNull();

    const row = await turnRow(conversationId, commandId);
    expect(row?.status).toBe("done");
    expect(row?.finishedAt).not.toBeNull();
    expect(row?.sessionId).toBeNull();
    expect(row?.reserved).toBe(0);
  });

  it("opens a confirmation and writes only after the tap", async () => {
    const { app } = harness(engineOf(createForKoval));
    const conversationId = await newConversation();
    const before = await ordersOf(customerKoval);
    const asked = await post(app, ASSISTANT_KIT_CHAT_PATH, {
      commandId: randomUUID(),
      conversationId,
      text: "створи замовлення для Олени два медових торти",
    });

    expect(asked.status).toBe(200);
    const paused = windowOf(asked.body);
    expect(paused.openPause?.kind).toBe("confirmation");
    expect(paused.messages[1]?.parts[0]?.kind).toBe("interaction");
    expect(await ordersOf(customerKoval)).toBe(before);

    const answered = await post(app, ASSISTANT_KIT_ANSWER_PATH, {
      commandId: randomUUID(),
      conversationId,
      interactionId: paused.openPause?.interactionId,
      revision: paused.openPause?.revision,
      answer: { approved: true },
    });

    expect(answered.status).toBe(200);
    const done = windowOf(answered.body);
    expect(done.openPause).toBeNull();
    expect(done.messages.at(-1)?.parts.at(-1)?.text).toContain("замовлення");
    expect(await ordersOf(customerKoval)).toBe(before + 1);
  });

  it("asks which Олена with Шо's candidates and resumes on the chosen id", async () => {
    const { app } = harness(engineOf(createForAmbiguousOlena));
    const conversationId = await newConversation();
    const asked = await post(app, ASSISTANT_KIT_CHAT_PATH, {
      commandId: randomUUID(),
      conversationId,
      text: "створи замовлення для Олени два медових торти",
    });

    const pause = windowOf(asked.body).openPause;
    expect(pause?.kind).toBe("choice");
    expect(await ordersOf(customerShevchenko)).toBe(0);

    const answered = await post(app, ASSISTANT_KIT_ANSWER_PATH, {
      commandId: randomUUID(),
      conversationId,
      interactionId: pause?.interactionId,
      revision: pause?.revision,
      answer: { optionId: customerShevchenko },
    });

    expect(answered.status).toBe(200);
    expect(await ordersOf(customerShevchenko)).toBe(1);
  });

  it("leaves a history a later LLM turn reads, with the tool call paired", async () => {
    const { app, runtime } = harness(engineOf(listYesterday));
    const conversationId = await newConversation();
    await post(app, ASSISTANT_KIT_CHAT_PATH, {
      commandId: randomUUID(),
      conversationId,
      text: "покажи замовлення за вчора",
    });

    const history = await storedHistory(runtime, conversationId);
    const calls = history.flatMap((message) =>
      message.role === "assistant" && Array.isArray(message.content)
        ? message.content.filter(
            (part: { type: string }) => part.type === "tool-call",
          )
        : [],
    );
    const results = history.flatMap((message) =>
      message.role === "tool"
        ? message.content.filter((part) => part.type === "tool-result")
        : [],
    );
    expect(calls).toHaveLength(1);
    expect(results).toHaveLength(1);
    const resultId =
      results[0]?.type === "tool-result" ? results[0].toolCallId : "";
    expect(resultId).toBe((calls[0] as { toolCallId: string }).toolCallId);
    expect(resultId).toContain("sho-");
    expect(history.at(-1)).toMatchObject({ role: "assistant" });

    const next = await post(app, ASSISTANT_KIT_CHAT_PATH, {
      commandId: randomUUID(),
      conversationId,
      text: "а перше з них?",
    });
    expect(next.status).toBe(200);
  });

  it("falls back to the queued LLM turn when Шо is not sure", async () => {
    const { app } = harness(
      engineOf(() => ({
        tooMany: false,
        commands: [
          {
            action: "orders.list",
            params: {},
            needs: [],
            confidence: { action: 0.3, margin: 0.05, spans: 0.4 },
          },
        ],
      })),
    );
    const conversationId = await newConversation();
    const commandId = randomUUID();
    const answer = await post(app, ASSISTANT_KIT_CHAT_PATH, {
      commandId,
      conversationId,
      text: "що там взагалі відбувається",
    });

    expect(answer.status).toBe(202);
    expect(answer.body["status"]).toBe("accepted");
    expect((await turnRow(conversationId, commandId))?.status).toBe("queued");
  });

  it("falls back when the engine throws", async () => {
    const { app } = harness({
      parse: () => Promise.reject(new Error("engine is down")),
    });
    const conversationId = await newConversation();
    const answer = await post(app, ASSISTANT_KIT_CHAT_PATH, {
      commandId: randomUUID(),
      conversationId,
      text: "покажи замовлення за вчора",
    });
    expect(answer.status).toBe(202);
  });

  it("stores nothing on another company's conversation", async () => {
    const { app } = harness(engineOf(listYesterday));
    const foreign = randomUUID();
    await kit.db.runtime.db.insert(assistantConversations).values({
      id: foreign,
      companyId: kitIdentities.companies.b,
      userId: kitIdentities.users.boris,
    });
    const answer = await post(app, ASSISTANT_KIT_CHAT_PATH, {
      commandId: randomUUID(),
      conversationId: foreign,
      text: "покажи замовлення за вчора",
    });
    expect(answer.status).toBe(410);
    expect(
      await kit.db.runtime.db
        .select({ id: assistantTurns.conversationId })
        .from(assistantTurns)
        .where(eq(assistantTurns.conversationId, foreign)),
    ).toEqual([]);
  });
});
