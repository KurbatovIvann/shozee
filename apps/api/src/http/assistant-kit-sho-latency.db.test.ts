import { randomUUID } from "node:crypto";

import {
  RedisContainer,
  type StartedRedisContainer,
} from "@testcontainers/redis";
import {
  createMemoryAiBudgetStore,
  DEFAULT_STAFF_ASSISTANT_BUDGET_LIMITS,
  type ShoEngine,
} from "@showzy/assistant-runtime";
import { createInMemoryRateLimitStore } from "@showzy/core";
import { COMPANY_SELECTOR_HEADER } from "@showzy/contract";
import {
  createTestKit,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import { assistantConversations } from "@showzy/db/schema/assistant";
import { products } from "@showzy/db/schema/catalog";
import { companyCustomers } from "@showzy/db/schema/customers";
import { compileContext, loadSho, type Sho } from "@showzy/sho";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createActionRegistry } from "../registry.js";
import { ASSISTANT_KIT_CHAT_PATH } from "./assistant-kit-chat.js";
import { createAssistantKitApp } from "./assistant-kit.js";
import { createAssistantKitRuntime } from "./assistant-kit-runtime.js";

const COMPANY = kitIdentities.companies.a;
const ANNA = kitIdentities.users.anna;
const WARM_UP = 3;
const MEASURED = 20;

let kit: TestKit;
let container: StartedRedisContainer;
let redis: Redis;
let sho: Sho;
let app: ReturnType<typeof createAssistantKitApp>;

beforeAll(async () => {
  kit = await createTestKit();
  container = await new RedisContainer("redis:8-alpine").start();
  redis = new Redis(container.getConnectionUrl());

  const customerId = randomUUID();
  await kit.db.runtime.db.insert(companyCustomers).values({
    id: customerId,
    companyId: COMPANY,
    name: "Олена Коваль",
    email: `${customerId}@example.com`,
  });
  const productId = randomUUID();
  await kit.db.runtime.db.insert(products).values({
    id: productId,
    companyId: COMPANY,
    name: "Медовий торт",
    basePriceMinor: 45000n,
  });

  sho = await loadSho();
  const context = compileContext({
    version: 2,
    revision: "sho-733-latency",
    products: [{ id: productId, name: "Медовий торт" }],
    customers: [{ id: customerId, name: "Олена Коваль" }],
  });
  const engine: ShoEngine = {
    parse: ({ text }) => sho.run({ text }, { context }),
  };

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
    sho: engine,
  });
  app = createAssistantKitApp(runtime, {
    logger: kit.pipeline.logger,
    limits: {
      ...DEFAULT_STAFF_ASSISTANT_BUDGET_LIMITS,
      chatTurnsPerMinutePerUser: 1000,
    },
    rateLimitStore: createInMemoryRateLimitStore(),
    budgetStore: createMemoryAiBudgetStore(),
  });
}, 600_000);

const registry = createActionRegistry();

afterAll(async () => {
  await sho.dispose();
  await redis.quit();
  await container.stop();
  await kit.db.close();
});

async function ask(text: string): Promise<{ ms: number; status: number }> {
  const conversationId = randomUUID();
  await kit.db.runtime.db
    .insert(assistantConversations)
    .values({ id: conversationId, companyId: COMPANY, userId: ANNA });
  const started = performance.now();
  const response = await app.request(ASSISTANT_KIT_CHAT_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [COMPANY_SELECTOR_HEADER]: COMPANY,
    },
    body: JSON.stringify({
      commandId: randomUUID(),
      conversationId,
      text,
    }),
  });
  const ms = performance.now() - started;
  await response.json();
  return { ms, status: response.status };
}

function percentile(samples: readonly number[], share: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const at = Math.min(sorted.length - 1, Math.ceil(share * sorted.length) - 1);
  return sorted[at] ?? 0;
}

describe("the real vendored Шо on the accept", () => {
  it("answers a read inside the request, warm", async () => {
    const first = await ask("покажи замовлення за вчора");
    expect(first.status).toBe(200);

    for (let warm = 1; warm < WARM_UP; warm += 1) {
      await ask("покажи замовлення за вчора");
    }
    const samples: number[] = [];
    for (let run = 0; run < MEASURED; run += 1) {
      const measured = await ask("покажи замовлення за вчора");
      expect(measured.status).toBe(200);
      samples.push(measured.ms);
    }
    const p50 = percentile(samples, 0.5);
    const p95 = percentile(samples, 0.95);
    process.stdout.write(
      `sho-733 warm latency p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms\n`,
    );
    expect(p95).toBeLessThanOrEqual(300);
  }, 300_000);
});
