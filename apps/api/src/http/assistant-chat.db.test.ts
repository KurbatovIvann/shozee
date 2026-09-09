/**
 * Live staff AI JSON mount (SHO-524): session/company denial, budget,
 * audit channel, and `/rpc` remaining `ui`. Old SSE/gate/choice speaker
 * tests were deleted with the live speaker.
 */
import { randomBytes, randomUUID } from "node:crypto";

import {
  assistantHostInteractionResultSchema,
  assistantPendingPeekResultSchema,
  kyivCalendarDate,
  ORDERS_CREATE_TOOL_NAME,
  ORDERS_LIST_PAGE_TOOL_NAME,
  secondsUntilKyivMidnight,
  STAFF_ASSISTANT_MODEL_HISTORY_MAX,
  toProviderToolName,
  type LanguageModel,
} from "@showzy/ai";
import {
  MockLanguageModelV3,
  mockTextStream,
  mockToolCallStream,
} from "@showzy/ai/test";
import {
  appendUserMessage,
  createConversation,
  recordAssistantTurn,
} from "@showzy/assistant";
import {
  COMPANY_SELECTOR_HEADER,
  CONFIRMATION_CHALLENGE_HEADER,
  contractModules,
  createContractClient,
  createMutationAttempt,
} from "@showzy/contract";
import {
  createConfirmationHook,
  createInMemoryConfirmationStore,
  createInMemoryRateLimitStore,
  executeAction,
  type ImplementedAction,
} from "@showzy/core";
import {
  createCapturingLogger,
  createTestKit,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import { createProduct } from "@showzy/catalog";
import { archiveCustomer, createCustomer } from "@showzy/customers";
import { auditLog } from "@showzy/db";
import { assistantMessages } from "@showzy/db/schema/assistant";
import { session, user } from "@showzy/db/schema/auth";
import { companyMembers } from "@showzy/db/schema/companies";
import { companyCustomers } from "@showzy/db/schema/customers";
import {
  RedisContainer,
  type StartedRedisContainer,
} from "@testcontainers/redis";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { z } from "zod";

import { buildAuthOptions } from "../auth/options.js";
import { createAtomicOtpSendStore } from "../auth/otp-send-guard.js";
import { createActionRegistry } from "../composition.js";
import {
  AI_BUDGET_TTL_SEC,
  aiCompanyBudgetKey,
  aiGlobalBudgetKey,
} from "../stores/budget.js";
import {
  createMemoryAuthRateLimitStore,
  createMemorySecondaryStorage,
} from "../stores/memory.js";
import {
  createRedisAiBudgetStore,
  createRedisRateLimitStore,
} from "../stores/redis.js";
import {
  DEFAULT_STAFF_ASSISTANT_BUDGET_LIMITS,
  type StaffAssistantBudgetLimits,
} from "./assistant-budget-guard.js";
import {
  createApp,
  HTTP_INVOCATION_CHANNEL,
  type AuthInstance,
} from "./app.js";
import {
  ASSISTANT_CHAT_PATH,
  ASSISTANT_INVOCATION_CHANNEL,
} from "./assistant-chat.js";
import {
  ASSISTANT_CONFIRM_PATH,
  ASSISTANT_HOST_CHOICE_PATH,
  ASSISTANT_PENDING_PATH,
} from "./assistant-host.js";

const REAL_CLIENT = "203.0.113.50";

function toAuthInstance(auth: {
  handler: AuthInstance["handler"];
  api: {
    getSession: (args: {
      headers: Headers;
    }) => Promise<{ user: { id: string } } | null | undefined>;
  };
}): AuthInstance {
  return {
    handler: (request) => auth.handler(request),
    api: {
      async getSession({ headers }) {
        const result = await auth.api.getSession({ headers });
        if (result === null || result === undefined) {
          return null;
        }
        return { user: { id: result.user.id } };
      },
    },
  };
}

async function insertBearer(kit: TestKit, userId: string): Promise<string> {
  const token = randomBytes(32).toString("hex");
  const now = new Date();
  await kit.db.runtime.db.insert(session).values({
    id: randomUUID(),
    token,
    userId,
    expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    createdAt: now,
    updatedAt: now,
  });
  return token;
}

function userChatBody(
  conversationId: string,
  text: string,
  locale?: "uk" | "en",
) {
  return {
    conversationId,
    text,
    ...(locale === undefined ? {} : { locale }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function confirmationChallengeIdFromHostBody(
  body: unknown,
): string | undefined {
  if (!isRecord(body) || body["status"] !== "ok") {
    return undefined;
  }
  const pending = body["pending"];
  if (!isRecord(pending) || pending["kind"] !== "confirmation") {
    return undefined;
  }
  if (typeof pending["challengeId"] === "string") {
    return pending["challengeId"];
  }
  if (typeof pending["id"] === "string") {
    return pending["id"];
  }
  return undefined;
}

async function waitFor(
  predicate: () => Promise<boolean>,
  label: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 40);
    });
  }
  throw new Error(`timed out waiting for ${label}`);
}

let kit: TestKit;
let auth: AuthInstance;
let registry: ReturnType<typeof createActionRegistry>;
let pipeline: TestKit["pipeline"];

beforeAll(async () => {
  kit = await createTestKit();
  const secondary = createMemorySecondaryStorage();
  const better = betterAuth(
    buildAuthOptions({
      database: drizzleAdapter(kit.db.runtime.db, { provider: "pg" }),
      baseUrl: "http://localhost:3000",
      webOrigins: [],
      secret: "test-only-secret-0123456789abcdef-0000",
      sendPhoneOtp: () => Promise.resolve(),
      sendEmailOtp: () => Promise.resolve(),
      otpSendStore: createAtomicOtpSendStore(secondary),
      authRateLimitStore: createMemoryAuthRateLimitStore({
        ipHmacSecret: "test-ip-hmac-secret",
      }),
      secondaryStorage: secondary,
    }),
  );
  auth = toAuthInstance(better);
  registry = createActionRegistry();
  pipeline = {
    ...kit.pipeline,
    hooks: {
      ...kit.pipeline.hooks,
      confirmation: createConfirmationHook({
        store: createInMemoryConfirmationStore(),
      }),
    },
  };
});

afterAll(async () => {
  await kit.db.close();
});

async function customerRow(
  customerId: string,
): Promise<{ readonly id: string } | undefined> {
  const rows = (await kit.db.runtime.db.select().from(companyCustomers)).filter(
    (row) => row.id === customerId,
  );
  return rows[0];
}

function chatApp(model?: LanguageModel) {
  return createApp({
    auth,
    registry,
    contractModules,
    pipeline,
    trustedProxies: [],
    getPeerAddress: () => REAL_CLIENT,
    pkiProxy: {
      rateLimitStore: createInMemoryRateLimitStore(),
      ipHmacSecret: "test-pki-proxy-ip-hmac-secret!!",
    },
    assistant: {
      model: "mock",
      ...(model !== undefined ? { languageModel: model } : {}),
    },
  });
}

async function staffInvoke<
  TInput extends z.ZodType,
  TOutput extends z.ZodType,
  TTarget,
>(
  action: ImplementedAction<TInput, TOutput, TTarget>,
  input: unknown,
  actor: { userId: string; companyId: string } = {
    userId: kitIdentities.users.anna,
    companyId: kitIdentities.companies.a,
  },
): Promise<z.output<TOutput>> {
  return executeAction(pipeline, {
    action,
    input,
    request: {
      requestId: randomUUID(),
      correlationId: randomUUID(),
      channel: "ui",
      clientIp: REAL_CLIENT,
      idempotencyKey: randomUUID(),
    },
    principal: {
      mode: "staff",
      session: { userId: actor.userId },
      companySelector: actor.companyId,
    },
  });
}

async function postChat(
  app: ReturnType<typeof createApp>,
  options: {
    readonly token?: string;
    readonly companyId?: string | null;
    readonly body: unknown;
    readonly challengeId?: string;
    readonly extraHeaders?: Record<string, string>;
    readonly signal?: AbortSignal;
  },
): Promise<Response> {
  const headers = new Headers({
    "content-type": "application/json",
    origin: "http://localhost:3000",
  });
  if (options.token !== undefined) {
    headers.set("authorization", `Bearer ${options.token}`);
  }
  if (options.companyId !== undefined && options.companyId !== null) {
    headers.set(COMPANY_SELECTOR_HEADER, options.companyId);
  }
  if (options.challengeId !== undefined) {
    headers.set(CONFIRMATION_CHALLENGE_HEADER, options.challengeId);
  }
  if (options.extraHeaders !== undefined) {
    for (const [name, value] of Object.entries(options.extraHeaders)) {
      headers.set(name, value);
    }
  }
  return app.request(`http://localhost:3000${ASSISTANT_CHAT_PATH}`, {
    method: "POST",
    headers,
    body: JSON.stringify(options.body),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

describe("POST /assistant/chat authorization", () => {
  it("denies unauthenticated, missing company, and foreign company", async () => {
    const app = chatApp();
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "Auth",
    });
    const body = userChatBody(conversation.id, "List orders");

    const unauthenticated = await postChat(app, { body });
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.json()).toMatchObject({
      code: "UNAUTHENTICATED",
      status: 401,
    });

    const missingCompany = await postChat(app, { token, body });
    expect(missingCompany.status).toBe(403);
    expect(await missingCompany.json()).toMatchObject({
      code: "PERMISSION_DENIED",
      status: 403,
    });

    const foreign = await postChat(app, {
      token,
      companyId: kitIdentities.companies.b,
      body,
    });
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toMatchObject({
      code: "PERMISSION_DENIED",
      status: 403,
    });
  });

  it("isolates a foreign-company conversation as not-found", async () => {
    const app = chatApp(
      new MockLanguageModelV3({
        doStream: [mockTextStream("should not run")],
      }),
    );
    const anna = await insertBearer(kit, kitIdentities.users.anna);
    const borsConversation = await staffInvoke(
      createConversation,
      { title: "Boris" },
      {
        userId: kitIdentities.users.boris,
        companyId: kitIdentities.companies.b,
      },
    );
    const response = await postChat(app, {
      token: anna,
      companyId: kitIdentities.companies.a,
      body: userChatBody(borsConversation.id, "Hello from Anna"),
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
  });

  it("injects persisted catalog.listProducts ids into the next stream prompt", async () => {
    const productId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const model = new MockLanguageModelV3({
      doStream: [mockTextStream("Those products are already known.")],
    });
    const app = chatApp(model);
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "Working set",
    });
    await staffInvoke(recordAssistantTurn, {
      conversationId: conversation.id,
      body: "Listed products.",
      toolRuns: [
        {
          actionName: "catalog.listProducts",
          toolCallId: "call-list-products",
          resultIds: [productId],
          outcome: "success",
        },
      ],
    });
    const response = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(conversation.id, "What are those products?"),
    });
    expect(response.status).toBe(200);
    await response.json();
    const prompt = JSON.stringify(model.doStreamCalls[0]?.prompt ?? []);
    expect(prompt).toContain("catalog.listProducts");
    expect(prompt).toContain(productId);
    expect(prompt).toContain(
      "Do not call a list tool solely to recover these ids",
    );
    expect(prompt).toContain("Europe/Kyiv");
    expect(prompt).toContain("Konditerska Anna");
    expect(prompt).not.toContain(kitIdentities.companies.a);
    expect(prompt).not.toContain("konditerska-anna");
  });

  it("omits the working-set addendum when the conversation has no tool runs", async () => {
    const model = new MockLanguageModelV3({
      doStream: [mockTextStream("I only help with this company.")],
    });
    const app = chatApp(model);
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "Empty runs",
    });
    const response = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(conversation.id, "Hello"),
    });
    expect(response.status).toBe(200);
    await response.json();
    const prompt = JSON.stringify(model.doStreamCalls[0]?.prompt ?? []);
    expect(prompt).not.toContain("Working set from earlier tool runs");
    expect(prompt).toContain("Europe/Kyiv");
    expect(prompt).toContain("Konditerska Anna");
    expect(prompt).toContain("week starts on Monday");
    expect(prompt).not.toContain(kitIdentities.companies.a);
  });

  it("includes the trade name when companies:view is granted and documents:view is denied", async () => {
    const clerkId = randomUUID();
    await kit.db.runtime.db.insert(user).values({
      id: clerkId,
      name: "No Documents Clerk",
      email: `no-docs-${clerkId}@assistant-kit.test`,
    });
    await kit.db.runtime.db.insert(companyMembers).values({
      companyId: kitIdentities.companies.a,
      userId: clerkId,
      role: "employee",
      permissions: {
        granted: ["assistant:use", "companies:view"],
        denied: ["documents:view"],
      },
    });
    const model = new MockLanguageModelV3({
      doStream: [mockTextStream("Hello with a company name.")],
    });
    const app = chatApp(model);
    const token = await insertBearer(kit, clerkId);
    const conversation = await staffInvoke(
      createConversation,
      { title: "No documents:view" },
      { userId: clerkId, companyId: kitIdentities.companies.a },
    );
    const response = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(conversation.id, "Hello"),
    });
    expect(response.status).toBe(200);
    await response.json();
    expect(model.doStreamCalls).toHaveLength(1);
    const prompt = JSON.stringify(model.doStreamCalls[0]?.prompt ?? []);
    expect(prompt).toContain("Europe/Kyiv");
    expect(prompt).toContain("week starts on Monday");
    expect(prompt).toContain("Money is UAH.");
    expect(prompt).toContain("This company is called");
    expect(prompt).toContain("Konditerska Anna");
    expect(prompt).not.toContain(kitIdentities.companies.a);
    expect(prompt).not.toContain("konditerska-anna");
  });

  it("omits the trade name on companies:view denial and still returns the clock", async () => {
    const clerkId = randomUUID();
    await kit.db.runtime.db.insert(user).values({
      id: clerkId,
      name: "No Companies View Clerk",
      email: `no-companies-view-${clerkId}@assistant-kit.test`,
    });
    await kit.db.runtime.db.insert(companyMembers).values({
      companyId: kitIdentities.companies.a,
      userId: clerkId,
      role: "employee",
      permissions: {
        granted: ["assistant:use"],
        denied: ["companies:view"],
      },
    });
    const model = new MockLanguageModelV3({
      doStream: [mockTextStream("Hello without a company name.")],
    });
    const app = chatApp(model);
    const token = await insertBearer(kit, clerkId);
    const conversation = await staffInvoke(
      createConversation,
      { title: "No companies:view" },
      { userId: clerkId, companyId: kitIdentities.companies.a },
    );
    const response = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(conversation.id, "Hello"),
    });
    expect(response.status).toBe(200);
    await response.json();
    expect(model.doStreamCalls).toHaveLength(1);
    const prompt = JSON.stringify(model.doStreamCalls[0]?.prompt ?? []);
    expect(prompt).toContain("Europe/Kyiv");
    expect(prompt).toContain("week starts on Monday");
    expect(prompt).toContain("Money is UAH.");
    expect(prompt).not.toContain("This company is called");
    expect(prompt).not.toContain("Konditerska Anna");
    expect(prompt).not.toContain(kitIdentities.companies.a);
    expect(prompt).not.toContain("konditerska-anna");
  });

  it("windows persisted history to 8 and does not log dropped text", async () => {
    const dropped = "DROPPED_HISTORY_SENTINEL_sho349";
    const latest = "LATEST_USER_SENTINEL_sho349";
    const capturing = createCapturingLogger();
    const model = new MockLanguageModelV3({
      doStream: [mockTextStream("ASSISTANT_BODY_SENTINEL_never_log")],
    });
    const app = createApp({
      auth,
      registry,
      contractModules,
      pipeline: { ...pipeline, logger: capturing.logger },
      trustedProxies: [],
      getPeerAddress: () => REAL_CLIENT,
      pkiProxy: {
        rateLimitStore: createInMemoryRateLimitStore(),
        ipHmacSecret: "test-pki-proxy-ip-hmac-secret!!",
      },
      assistant: {
        model: "mock",
        languageModel: model,
      },
    });
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "History window",
    });
    for (let index = 0; index < 10; index += 1) {
      await staffInvoke(appendUserMessage, {
        conversationId: conversation.id,
        body: index === 0 ? dropped : `user-${String(index)}`,
      });
      await staffInvoke(recordAssistantTurn, {
        conversationId: conversation.id,
        body: `assistant-${String(index)}`,
        toolRuns: [],
      });
    }
    const response = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(conversation.id, latest),
    });
    expect(response.status).toBe(200);
    await response.json();
    const prompt = JSON.stringify(model.doStreamCalls[0]?.prompt ?? []);
    const conversationTurns = (model.doStreamCalls[0]?.prompt ?? []).filter(
      (part) => part.role === "user" || part.role === "assistant",
    );
    expect(conversationTurns).toHaveLength(STAFF_ASSISTANT_MODEL_HISTORY_MAX);
    expect(prompt).toContain(latest);
    expect(prompt).not.toContain(dropped);
    const blob = JSON.stringify(capturing.entries());
    expect(blob).not.toContain(dropped);
    expect(blob).not.toContain(latest);
    expect(blob).not.toContain("ASSISTANT_BODY_SENTINEL_never_log");
  });

  it("fails typed when Anthropic is not configured after auth", async () => {
    const app = chatApp();
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "No key",
    });
    const response = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(conversation.id, "List orders"),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "AI_NOT_CONFIGURED",
      status: 503,
    });
  });
});

describe("POST /assistant/chat logs and /rpc channel", () => {
  it("does not log prompts, API keys, cookies, or OTP", async () => {
    const capturing = createCapturingLogger();
    const app = createApp({
      auth,
      registry,
      contractModules,
      pipeline: { ...pipeline, logger: capturing.logger },
      trustedProxies: [],
      getPeerAddress: () => REAL_CLIENT,
      pkiProxy: {
        rateLimitStore: createInMemoryRateLimitStore(),
        ipHmacSecret: "test-pki-proxy-ip-hmac-secret!!",
      },
      assistant: {
        model: "mock",
        languageModel: new MockLanguageModelV3({
          doStream: [mockTextStream("ASSISTANT_BODY_SENTINEL_never_log")],
        }),
      },
    });
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "Logs",
    });
    const prompt = "PROMPT_SENTINEL_sho322_never_log OTP 111222";
    const response = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(conversation.id, prompt),
      extraHeaders: {
        cookie: "session=COOKIESECRET_sho322",
        "x-api-key": "sk-ant-TESTKEY-never-log",
      },
    });
    expect(response.status).toBe(200);
    await response.json();
    await waitFor(async () => {
      const rows = await kit.db.runtime.db.select().from(assistantMessages);
      return rows.some(
        (row) =>
          row.conversationId === conversation.id && row.role === "assistant",
      );
    }, "assistant persist");

    const blob = JSON.stringify(capturing.entries());
    expect(blob).not.toContain(prompt);
    expect(blob).not.toContain("ASSISTANT_BODY_SENTINEL_never_log");
    expect(blob).not.toContain("COOKIESECRET_sho322");
    expect(blob).not.toContain("sk-ant-TESTKEY-never-log");
    expect(blob).not.toContain("111222");
    expect(blob).not.toContain("ANTHROPIC_API_KEY");
  });

  it("keeps /rpc labeled ui while the AI mount uses ai", async () => {
    expect(HTTP_INVOCATION_CHANNEL).toBe("ui");
    expect(ASSISTANT_INVOCATION_CHANNEL).toBe("ai");
    const app = chatApp(
      new MockLanguageModelV3({
        doStream: [mockTextStream("ok")],
      }),
    );
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const { client } = createContractClient({
      baseUrl: "http://localhost:3000",
      getAccessToken: () => token,
      initialCompanyId: kitIdentities.companies.a,
      fetch: async (request) => app.request(request),
    });
    const attempt = createMutationAttempt();
    const created = await client.assistant.createConversation(
      { title: "rpc-ui" },
      attempt.options,
    );
    const rows = await kit.db.runtime.db.select().from(auditLog);
    const rpcRow = rows.find(
      (row) =>
        row.action === "assistant.createConversation" &&
        row.targetId === created.id,
    );
    expect(rpcRow?.channel).toBe("ui");
    expect(rpcRow?.aiTraceId).toBeNull();
    expect(rpcRow?.toolCallId).toBeNull();
  });
});

describe("staff assistant HTTP budget guard (SHO-505 / SHO-541)", () => {
  let redisContainer: StartedRedisContainer;
  let redis: Redis;

  beforeAll(async () => {
    redisContainer = await new RedisContainer("redis:8-alpine").start();
    redis = new Redis(redisContainer.getConnectionUrl());
  });

  afterAll(async () => {
    await redis.quit();
    await redisContainer.stop();
  });

  beforeEach(async () => {
    await redis.flushdb();
  });

  function budgetApp(options: {
    readonly streamModel?: LanguageModel;
    readonly logger?: ReturnType<typeof createCapturingLogger>["logger"];
    readonly limits?: StaffAssistantBudgetLimits;
  }) {
    const basePipeline =
      options.logger === undefined
        ? pipeline
        : { ...pipeline, logger: options.logger };
    return createApp({
      auth,
      registry,
      contractModules,
      pipeline: {
        ...basePipeline,
        hooks: {
          ...basePipeline.hooks,
          // Host checkpoints on choice/confirm would exhaust the kit
          // staff bucket. Chat-turn budget still uses Redis below.
          rateLimit: { enforce: () => Promise.resolve() },
        },
      },
      trustedProxies: [],
      getPeerAddress: () => REAL_CLIENT,
      pkiProxy: {
        rateLimitStore: createInMemoryRateLimitStore(),
        ipHmacSecret: "test-pki-proxy-ip-hmac-secret!!",
      },
      assistant: {
        model: "mock",
        ...(options.streamModel === undefined
          ? {}
          : { languageModel: options.streamModel }),
      },
      assistantBudget: {
        rateLimitStore: createRedisRateLimitStore(redis),
        budgetStore: createRedisAiBudgetStore(redis),
        limits: options.limits ?? DEFAULT_STAFF_ASSISTANT_BUDGET_LIMITS,
      },
    });
  }

  async function insertCompanyAMember(): Promise<{
    readonly userId: string;
    readonly token: string;
  }> {
    const userId = randomUUID();
    await kit.db.runtime.db.insert(user).values({
      id: userId,
      name: "Budget Clerk",
      email: `budget-clerk-${userId}@assistant-kit.test`,
    });
    await kit.db.runtime.db.insert(companyMembers).values({
      companyId: kitIdentities.companies.a,
      userId,
      role: "employee",
      permissions: { granted: ["assistant:use"], denied: [] },
    });
    return { userId, token: await insertBearer(kit, userId) };
  }

  it("returns 429 on the 21st turn in a minute without calling the model", async () => {
    const streamModel = new MockLanguageModelV3({
      doStream: () => Promise.resolve(mockTextStream("ok")),
    });
    const capturing = createCapturingLogger();
    const app = budgetApp({
      streamModel,
      logger: capturing.logger,
    });
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "Turn limit",
    });
    const sentinel = "BUDGET_DENIAL_SENTINEL_sho505";
    for (let i = 0; i < 20; i += 1) {
      const response = await postChat(app, {
        token,
        companyId: kitIdentities.companies.a,
        body: userChatBody(conversation.id, `turn ${String(i)}`),
      });
      expect(response.status).toBe(200);
      await response.json();
    }
    expect(streamModel.doStreamCalls.length).toBeGreaterThan(0);
    const streamCallsAfterAllowed = streamModel.doStreamCalls.length;
    const twentyFirst = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(conversation.id, sentinel),
    });
    expect(twentyFirst.status).toBe(429);
    const body = (await twentyFirst.json()) as {
      code: string;
      status: number;
      data?: { retryAfterSec?: number };
    };
    expect(body).toMatchObject({ code: "RATE_LIMITED", status: 429 });
    expect(body.data?.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(streamModel.doStreamCalls).toHaveLength(streamCallsAfterAllowed);
    const denial = capturing
      .entries()
      .find((entry) => entry["msg"] === "staff assistant budget denied");
    expect(denial?.["reason"]).toBe("turn_limit");
    expect(denial?.["company_id"]).toBe(kitIdentities.companies.a);
    expect(JSON.stringify(denial)).not.toContain(sentinel);

    const other = await insertCompanyAMember();
    const otherConversation = await staffInvoke(
      createConversation,
      { title: "Other user" },
      { userId: other.userId, companyId: kitIdentities.companies.a },
    );
    const otherTurn = await postChat(app, {
      token: other.token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(otherConversation.id, "hello from other user"),
    });
    expect(otherTurn.status).toBe(200);
    await otherTurn.json();
  });

  it("returns 429 when the company counter is at the limit and isolates tenants", async () => {
    const streamModel = new MockLanguageModelV3({
      doStream: [mockTextStream("ok")],
    });
    const limits: StaffAssistantBudgetLimits = {
      ...DEFAULT_STAFF_ASSISTANT_BUDGET_LIMITS,
      dailyBudgetUsdPerCompany: 1,
    };
    const app = budgetApp({ streamModel, limits });
    const kyivDate = kyivCalendarDate(new Date());
    const budgetStore = createRedisAiBudgetStore(redis);
    await budgetStore.add(
      aiCompanyBudgetKey(kitIdentities.companies.a, kyivDate),
      1,
      AI_BUDGET_TTL_SEC,
    );
    const anna = await insertBearer(kit, kitIdentities.users.anna);
    const annaConversation = await staffInvoke(createConversation, {
      title: "Company budget A",
    });
    const before = secondsUntilKyivMidnight(new Date());
    const denied = await postChat(app, {
      token: anna,
      companyId: kitIdentities.companies.a,
      body: userChatBody(annaConversation.id, "spend"),
    });
    const after = secondsUntilKyivMidnight(new Date());
    expect(denied.status).toBe(429);
    const body = (await denied.json()) as {
      data?: { retryAfterSec?: number };
    };
    const retryAfterSec = body.data?.retryAfterSec;
    expect(retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(retryAfterSec).toBeGreaterThanOrEqual(after);
    expect(retryAfterSec).toBeLessThanOrEqual(before);
    expect(streamModel.doStreamCalls).toHaveLength(0);

    const boris = await insertBearer(kit, kitIdentities.users.boris);
    const borsConversation = await staffInvoke(
      createConversation,
      { title: "Company budget B" },
      {
        userId: kitIdentities.users.boris,
        companyId: kitIdentities.companies.b,
      },
    );
    const otherCompany = await postChat(app, {
      token: boris,
      companyId: kitIdentities.companies.b,
      body: userChatBody(borsConversation.id, "hello from B"),
    });
    expect(otherCompany.status).toBe(200);
    await otherCompany.json();
  });

  it("treats uppercase x-company-id as the same company Redis budget key", async () => {
    const streamModel = new MockLanguageModelV3({
      doStream: [mockTextStream("ok")],
    });
    const limits: StaffAssistantBudgetLimits = {
      ...DEFAULT_STAFF_ASSISTANT_BUDGET_LIMITS,
      dailyBudgetUsdPerCompany: 0.1,
    };
    const app = budgetApp({
      streamModel,
      limits,
    });
    const anna = await insertBearer(kit, kitIdentities.users.anna);
    const annaConversation = await staffInvoke(createConversation, {
      title: "Company budget UUID case",
    });
    const lowercaseCompanyId = kitIdentities.companies.a.toLowerCase();
    const spent = await postChat(app, {
      token: anna,
      companyId: lowercaseCompanyId,
      body: userChatBody(annaConversation.id, "spend lowercase"),
    });
    expect(spent.status).toBe(200);
    await spent.json();
    expect(streamModel.doStreamCalls).toHaveLength(1);

    const uppercaseDenied = await postChat(app, {
      token: anna,
      companyId: kitIdentities.companies.a.toUpperCase(),
      body: userChatBody(annaConversation.id, "spend uppercase"),
    });
    expect(uppercaseDenied.status).toBe(429);
    expect(await uppercaseDenied.json()).toMatchObject({
      code: "RATE_LIMITED",
      status: 429,
    });
    expect(streamModel.doStreamCalls).toHaveLength(1);
  });

  it("returns 429 for every company when the global counter is at the limit", async () => {
    const streamModel = new MockLanguageModelV3({
      doStream: [mockTextStream("ok")],
    });
    const limits: StaffAssistantBudgetLimits = {
      ...DEFAULT_STAFF_ASSISTANT_BUDGET_LIMITS,
      dailyBudgetUsdGlobal: 2,
    };
    const app = budgetApp({ streamModel, limits });
    await createRedisAiBudgetStore(redis).add(
      aiGlobalBudgetKey(kyivCalendarDate(new Date())),
      2,
      AI_BUDGET_TTL_SEC,
    );
    const anna = await insertBearer(kit, kitIdentities.users.anna);
    const annaConversation = await staffInvoke(createConversation, {
      title: "Global A",
    });
    const annaDenied = await postChat(app, {
      token: anna,
      companyId: kitIdentities.companies.a,
      body: userChatBody(annaConversation.id, "global a"),
    });
    expect(annaDenied.status).toBe(429);
    const boris = await insertBearer(kit, kitIdentities.users.boris);
    const borsConversation = await staffInvoke(
      createConversation,
      { title: "Global B" },
      {
        userId: kitIdentities.users.boris,
        companyId: kitIdentities.companies.b,
      },
    );
    const borisDenied = await postChat(app, {
      token: boris,
      companyId: kitIdentities.companies.b,
      body: userChatBody(borsConversation.id, "global b"),
    });
    expect(borisDenied.status).toBe(429);
    expect(streamModel.doStreamCalls).toHaveLength(0);
  });

  it("increments company and global counters by the unknown-model ceiling", async () => {
    const streamModel = new MockLanguageModelV3({
      doStream: [mockTextStream("ok")],
    });
    const app = budgetApp({ streamModel });
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "Increment unknown-model ceiling",
    });
    const unknownTurn = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(conversation.id, "unknown model"),
    });
    expect(unknownTurn.status).toBe(200);
    await unknownTurn.json();
    const kyivDate = kyivCalendarDate(new Date());
    const budgetStore = createRedisAiBudgetStore(redis);
    expect(
      await budgetStore.read(
        aiCompanyBudgetKey(kitIdentities.companies.a, kyivDate),
      ),
    ).toBeCloseTo(0.1);
    expect(await budgetStore.read(aiGlobalBudgetKey(kyivDate))).toBeCloseTo(
      0.1,
    );
  });

  it("does not turn-limit a confirmation resume and still counts its cost", async () => {
    const customer = await staffInvoke(createCustomer, {
      name: "Budget Resume",
      phone: "+380671110505",
    });
    await staffInvoke(archiveCustomer, { id: customer.id });
    const deleteInput = JSON.stringify({ id: customer.id });
    const streamModel = new MockLanguageModelV3({
      doStream: [
        mockToolCallStream(
          "call-delete",
          toProviderToolName("customers.deleteCustomer"),
          deleteInput,
        ),
        mockToolCallStream("call-list", ORDERS_LIST_PAGE_TOOL_NAME, "{}"),
        mockTextStream("The customer was deleted."),
      ],
    });
    const app = budgetApp({
      streamModel,
      limits: {
        ...DEFAULT_STAFF_ASSISTANT_BUDGET_LIMITS,
        chatTurnsPerMinutePerUser: 1,
      },
    });
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "Budget confirmation resume",
    });
    const pause = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(conversation.id, "Delete the archived customer"),
    });
    expect(pause.status).toBe(200);
    const challengeId = confirmationChallengeIdFromHostBody(await pause.json());
    expect(challengeId).toBeDefined();
    if (challengeId === undefined) {
      expect.unreachable("expected confirmation pending");
    }
    const kyivDate = kyivCalendarDate(new Date());
    const budgetStore = createRedisAiBudgetStore(redis);
    expect(
      await budgetStore.read(
        aiCompanyBudgetKey(kitIdentities.companies.a, kyivDate),
      ),
    ).toBeCloseTo(0.1);
    expect(await customerRow(customer.id)).toBeDefined();

    const blocked = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(conversation.id, "another turn"),
    });
    expect(blocked.status).toBe(429);

    const resume = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(conversation.id, "так"),
      challengeId,
    });
    expect(resume.status).toBe(200);
    await resume.json();
    expect(await customerRow(customer.id)).toBeUndefined();
    const messages = (
      await kit.db.runtime.db.select().from(assistantMessages)
    ).filter((row) => row.conversationId === conversation.id);
    expect(
      messages.some((row) => row.role === "user" && row.body === "так"),
    ).toBe(false);
    expect(
      await budgetStore.read(
        aiCompanyBudgetKey(kitIdentities.companies.a, kyivDate),
      ),
    ).toBeCloseTo(0.2);
    expect(await budgetStore.read(aiGlobalBudgetKey(kyivDate))).toBeCloseTo(
      0.2,
    );
  });

  it("does not consume a turn when the company budget denies the request", async () => {
    const streamModel = new MockLanguageModelV3({
      doStream: [mockTextStream("ok"), mockTextStream("ok")],
    });
    const limits: StaffAssistantBudgetLimits = {
      ...DEFAULT_STAFF_ASSISTANT_BUDGET_LIMITS,
      chatTurnsPerMinutePerUser: 1,
      dailyBudgetUsdPerCompany: 1,
    };
    const app = budgetApp({ streamModel, limits });
    const kyivDate = kyivCalendarDate(new Date());
    const companyKey = aiCompanyBudgetKey(kitIdentities.companies.a, kyivDate);
    await createRedisAiBudgetStore(redis).add(companyKey, 1, AI_BUDGET_TTL_SEC);
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "Budget then turn",
    });
    const denied = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(conversation.id, "blocked by budget"),
    });
    expect(denied.status).toBe(429);
    expect(streamModel.doStreamCalls).toHaveLength(0);
    await redis.del(companyKey);
    const allowed = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(conversation.id, "second turn after budget 429"),
    });
    expect(allowed.status).toBe(200);
    await allowed.json();
  });

  it("does not consume a turn when Anthropic is not configured", async () => {
    const limits: StaffAssistantBudgetLimits = {
      ...DEFAULT_STAFF_ASSISTANT_BUDGET_LIMITS,
      chatTurnsPerMinutePerUser: 1,
    };
    const unconfigured = budgetApp({ limits });
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "Not configured then turn",
    });
    const missing = await postChat(unconfigured, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(conversation.id, "no anthropic"),
    });
    expect(missing.status).toBe(503);
    expect(await missing.json()).toMatchObject({
      code: "AI_NOT_CONFIGURED",
      status: 503,
    });
    const streamModel = new MockLanguageModelV3({
      doStream: [mockTextStream("ok")],
    });
    const configured = budgetApp({ streamModel, limits });
    const allowed = await postChat(configured, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(conversation.id, "configured after 503"),
    });
    expect(allowed.status).toBe(200);
    await allowed.json();
  });

  async function postAssistant(
    app: ReturnType<typeof createApp>,
    options: {
      readonly path: string;
      readonly token: string;
      readonly companyId?: string;
      readonly body: unknown;
    },
  ): Promise<Response> {
    const headers = new Headers({
      "content-type": "application/json",
      origin: "http://localhost:3000",
      authorization: `Bearer ${options.token}`,
      [COMPANY_SELECTOR_HEADER]: options.companyId ?? kitIdentities.companies.a,
    });
    return app.request(`http://localhost:3000${options.path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(options.body),
    });
  }

  async function peekPending(
    app: ReturnType<typeof createApp>,
    token: string,
    conversationId: string,
  ) {
    const headers = new Headers({
      origin: "http://localhost:3000",
      authorization: `Bearer ${token}`,
      [COMPANY_SELECTOR_HEADER]: kitIdentities.companies.a,
    });
    const response = await app.request(
      `http://localhost:3000${ASSISTANT_PENDING_PATH}?conversationId=${conversationId}`,
      { method: "GET", headers },
    );
    expect(response.status).toBe(200);
    return assistantPendingPeekResultSchema.parse(await response.json());
  }

  function choiceFromPauseBody(body: unknown): {
    readonly choiceId: string;
    readonly optionId: string;
  } {
    const parsed = assistantHostInteractionResultSchema.parse(body);
    if (parsed.status !== "ok" || parsed.pending?.kind !== "choice") {
      throw new Error(`expected choice pause, got ${JSON.stringify(body)}`);
    }
    const optionId = parsed.pending.envelope.options[0]?.id;
    if (optionId === undefined) {
      throw new Error("expected choice option id");
    }
    return { choiceId: parsed.pending.id, optionId };
  }

  it("returns the same company-budget 429 on /assistant/choice without claiming pending", async () => {
    const customer = await staffInvoke(createCustomer, {
      name: "Budget Choice Buyer",
      phone: `+38067${randomUUID().replace(/-/g, "").replace(/\D/g, "1").slice(0, 7)}`,
    });
    const product = await staffInvoke(createProduct, {
      name: `Budget Choice Cake ${randomUUID()}`,
      basePriceMinor: "1500",
      variants: [{ name: "Lemon" }, { name: "Vanilla" }],
    });
    const streamModel = new MockLanguageModelV3({
      doStream: [
        mockToolCallStream(
          "call-create",
          ORDERS_CREATE_TOOL_NAME,
          JSON.stringify({
            customerId: customer.id,
            items: [{ productId: product.productId, quantityMilli: "1000" }],
          }),
        ),
        mockTextStream("Pick a flavour."),
        mockTextStream("should not run"),
      ],
    });
    const app = budgetApp({
      streamModel,
      limits: {
        ...DEFAULT_STAFF_ASSISTANT_BUDGET_LIMITS,
        dailyBudgetUsdPerCompany: 0.1,
      },
    });
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "Budget choice 429",
    });
    const pause = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(conversation.id, "торт"),
    });
    expect(pause.status).toBe(200);
    const { choiceId, optionId } = choiceFromPauseBody(await pause.json());
    const streamCallsAfterPause = streamModel.doStreamCalls.length;
    expect(streamCallsAfterPause).toBeGreaterThan(0);

    const denied = await postAssistant(app, {
      path: ASSISTANT_HOST_CHOICE_PATH,
      token,
      body: {
        conversationId: conversation.id,
        choiceId,
        optionId,
      },
    });
    expect(denied.status).toBe(429);
    expect(await denied.json()).toMatchObject({
      code: "RATE_LIMITED",
      status: 429,
    });
    expect(streamModel.doStreamCalls).toHaveLength(streamCallsAfterPause);
    const peeked = await peekPending(app, token, conversation.id);
    expect(peeked.pending?.kind).toBe("choice");
    expect(peeked.pending?.status).toBe("open");
    expect(peeked.pending?.id).toBe(choiceId);
  });

  it("returns the same company-budget 429 on /assistant/confirm without claiming pending", async () => {
    const customer = await staffInvoke(createCustomer, {
      name: "Budget Confirm Target",
      phone: `+38067${randomUUID().replace(/-/g, "").replace(/\D/g, "1").slice(0, 7)}`,
    });
    await staffInvoke(archiveCustomer, { id: customer.id });
    const streamModel = new MockLanguageModelV3({
      doStream: [
        mockToolCallStream(
          "call-delete",
          toProviderToolName("customers.deleteCustomer"),
          JSON.stringify({ id: customer.id }),
        ),
        mockTextStream("should not run"),
      ],
    });
    const app = budgetApp({
      streamModel,
      limits: {
        ...DEFAULT_STAFF_ASSISTANT_BUDGET_LIMITS,
        dailyBudgetUsdPerCompany: 0.1,
      },
    });
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "Budget confirm 429",
    });
    const pause = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(conversation.id, "Delete the archived customer"),
    });
    expect(pause.status).toBe(200);
    const challengeId = confirmationChallengeIdFromHostBody(await pause.json());
    expect(challengeId).toBeDefined();
    if (challengeId === undefined) {
      expect.unreachable("expected confirmation pending");
    }
    const streamCallsAfterPause = streamModel.doStreamCalls.length;

    const denied = await postAssistant(app, {
      path: ASSISTANT_CONFIRM_PATH,
      token,
      body: { conversationId: conversation.id, challengeId },
    });
    expect(denied.status).toBe(429);
    expect(await denied.json()).toMatchObject({
      code: "RATE_LIMITED",
      status: 429,
    });
    expect(streamModel.doStreamCalls).toHaveLength(streamCallsAfterPause);
    expect(await customerRow(customer.id)).toBeDefined();
    const peeked = await peekPending(app, token, conversation.id);
    expect(peeked.pending?.kind).toBe("confirmation");
    expect(peeked.pending?.status).toBe("open");
    expect(peeked.pending?.id).toBe(challengeId);
  });

  it("returns the same global-budget 429 on choice and confirm without a model call", async () => {
    const streamModel = new MockLanguageModelV3({
      doStream: [mockTextStream("ok")],
    });
    const limits: StaffAssistantBudgetLimits = {
      ...DEFAULT_STAFF_ASSISTANT_BUDGET_LIMITS,
      dailyBudgetUsdGlobal: 2,
    };
    const app = budgetApp({ streamModel, limits });
    await createRedisAiBudgetStore(redis).add(
      aiGlobalBudgetKey(kyivCalendarDate(new Date())),
      2,
      AI_BUDGET_TTL_SEC,
    );
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "Global resume 429",
    });
    const choiceDenied = await postAssistant(app, {
      path: ASSISTANT_HOST_CHOICE_PATH,
      token,
      body: {
        conversationId: conversation.id,
        choiceId: randomUUID(),
        optionId: randomUUID(),
      },
    });
    const confirmDenied = await postAssistant(app, {
      path: ASSISTANT_CONFIRM_PATH,
      token,
      body: {
        conversationId: conversation.id,
        challengeId: randomUUID(),
      },
    });
    expect(choiceDenied.status).toBe(429);
    expect(await choiceDenied.json()).toMatchObject({
      code: "RATE_LIMITED",
      status: 429,
    });
    expect(confirmDenied.status).toBe(429);
    expect(await confirmDenied.json()).toMatchObject({
      code: "RATE_LIMITED",
      status: 429,
    });
    expect(streamModel.doStreamCalls).toHaveLength(0);
  });

  it("increments company and global USD after successful choice and confirm Phase B", async () => {
    const customer = await staffInvoke(createCustomer, {
      name: "Budget Phase B Buyer",
      phone: `+38067${randomUUID().replace(/-/g, "").replace(/\D/g, "1").slice(0, 7)}`,
    });
    const product = await staffInvoke(createProduct, {
      name: `Budget Phase B Cake ${randomUUID()}`,
      basePriceMinor: "1500",
      variants: [{ name: "Lemon" }, { name: "Vanilla" }],
    });
    const deleteTarget = await staffInvoke(createCustomer, {
      name: "Budget Phase B Delete",
      phone: `+38067${randomUUID().replace(/-/g, "").replace(/\D/g, "1").slice(0, 7)}`,
    });
    await staffInvoke(archiveCustomer, { id: deleteTarget.id });
    const streamModel = new MockLanguageModelV3({
      doStream: [
        mockToolCallStream(
          "call-create",
          ORDERS_CREATE_TOOL_NAME,
          JSON.stringify({
            customerId: customer.id,
            items: [{ productId: product.productId, quantityMilli: "1000" }],
          }),
        ),
        mockTextStream("Pick a flavour."),
        mockTextStream("Order created."),
        mockToolCallStream(
          "call-delete",
          toProviderToolName("customers.deleteCustomer"),
          JSON.stringify({ id: deleteTarget.id }),
        ),
        mockTextStream("The customer was deleted."),
      ],
    });
    const app = budgetApp({ streamModel });
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const choiceConversation = await staffInvoke(createConversation, {
      title: "Budget choice spend",
    });
    const choicePause = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(choiceConversation.id, "торт"),
    });
    expect(choicePause.status).toBe(200);
    const { choiceId, optionId } = choiceFromPauseBody(
      await choicePause.json(),
    );
    const kyivDate = kyivCalendarDate(new Date());
    const budgetStore = createRedisAiBudgetStore(redis);
    expect(
      await budgetStore.read(
        aiCompanyBudgetKey(kitIdentities.companies.a, kyivDate),
      ),
    ).toBeCloseTo(0.1);

    const choiceResume = await postAssistant(app, {
      path: ASSISTANT_HOST_CHOICE_PATH,
      token,
      body: {
        conversationId: choiceConversation.id,
        choiceId,
        optionId,
      },
    });
    expect(choiceResume.status).toBe(200);
    await choiceResume.json();
    expect(
      await budgetStore.read(
        aiCompanyBudgetKey(kitIdentities.companies.a, kyivDate),
      ),
    ).toBeCloseTo(0.2);
    expect(await budgetStore.read(aiGlobalBudgetKey(kyivDate))).toBeCloseTo(
      0.2,
    );
    expect(
      (await peekPending(app, token, choiceConversation.id)).pending,
    ).toBeNull();

    const confirmConversation = await staffInvoke(createConversation, {
      title: "Budget confirm spend",
    });
    const confirmPause = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(
        confirmConversation.id,
        "Delete the archived customer",
      ),
    });
    expect(confirmPause.status).toBe(200);
    const challengeId = confirmationChallengeIdFromHostBody(
      await confirmPause.json(),
    );
    expect(challengeId).toBeDefined();
    if (challengeId === undefined) {
      expect.unreachable("expected confirmation pending");
    }
    expect(
      await budgetStore.read(
        aiCompanyBudgetKey(kitIdentities.companies.a, kyivDate),
      ),
    ).toBeCloseTo(0.3);

    const confirmResume = await postAssistant(app, {
      path: ASSISTANT_CONFIRM_PATH,
      token,
      body: {
        conversationId: confirmConversation.id,
        challengeId,
      },
    });
    expect(confirmResume.status).toBe(200);
    await confirmResume.json();
    expect(await customerRow(deleteTarget.id)).toBeUndefined();
    expect(
      await budgetStore.read(
        aiCompanyBudgetKey(kitIdentities.companies.a, kyivDate),
      ),
    ).toBeCloseTo(0.4);
    expect(await budgetStore.read(aiGlobalBudgetKey(kyivDate))).toBeCloseTo(
      0.4,
    );
  });

  it("releases the USD hold when choice host fails after reserve", async () => {
    const streamModel = new MockLanguageModelV3({
      doStream: [mockTextStream("ok")],
    });
    const app = budgetApp({ streamModel });
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const failed = await postAssistant(app, {
      path: ASSISTANT_HOST_CHOICE_PATH,
      token,
      body: {},
    });
    expect(failed.status).toBe(400);
    expect(streamModel.doStreamCalls).toHaveLength(0);
    const kyivDate = kyivCalendarDate(new Date());
    const budgetStore = createRedisAiBudgetStore(redis);
    expect(
      await budgetStore.read(
        aiCompanyBudgetKey(kitIdentities.companies.a, kyivDate),
      ),
    ).toBe(0);
    expect(await budgetStore.read(aiGlobalBudgetKey(kyivDate))).toBe(0);
  });

  it("does not consume an extra chat-turn slot on choice or confirm", async () => {
    const customer = await staffInvoke(createCustomer, {
      name: "Budget Turn Skip Buyer",
      phone: `+38067${randomUUID().replace(/-/g, "").replace(/\D/g, "1").slice(0, 7)}`,
    });
    const product = await staffInvoke(createProduct, {
      name: `Budget Turn Skip Cake ${randomUUID()}`,
      basePriceMinor: "1500",
      variants: [{ name: "Lemon" }, { name: "Vanilla" }],
    });
    const deleteTarget = await staffInvoke(createCustomer, {
      name: "Budget Turn Skip Delete",
      phone: `+38067${randomUUID().replace(/-/g, "").replace(/\D/g, "1").slice(0, 7)}`,
    });
    await staffInvoke(archiveCustomer, { id: deleteTarget.id });
    const streamModel = new MockLanguageModelV3({
      doStream: [
        mockToolCallStream(
          "call-create",
          ORDERS_CREATE_TOOL_NAME,
          JSON.stringify({
            customerId: customer.id,
            items: [{ productId: product.productId, quantityMilli: "1000" }],
          }),
        ),
        mockTextStream("Pick a flavour."),
        mockTextStream("Order created."),
        mockToolCallStream(
          "call-delete",
          toProviderToolName("customers.deleteCustomer"),
          JSON.stringify({ id: deleteTarget.id }),
        ),
        mockTextStream("The customer was deleted."),
        mockTextStream("blocked"),
      ],
    });
    const app = budgetApp({
      streamModel,
      limits: {
        ...DEFAULT_STAFF_ASSISTANT_BUDGET_LIMITS,
        chatTurnsPerMinutePerUser: 1,
      },
    });
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const choiceConversation = await staffInvoke(createConversation, {
      title: "Budget turn skip choice",
    });
    const choicePause = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(choiceConversation.id, "торт"),
    });
    expect(choicePause.status).toBe(200);
    const { choiceId, optionId } = choiceFromPauseBody(
      await choicePause.json(),
    );
    const blockedChat = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(choiceConversation.id, "another turn"),
    });
    expect(blockedChat.status).toBe(429);

    const choiceResume = await postAssistant(app, {
      path: ASSISTANT_HOST_CHOICE_PATH,
      token,
      body: {
        conversationId: choiceConversation.id,
        choiceId,
        optionId,
      },
    });
    expect(choiceResume.status).toBe(200);
    await choiceResume.json();

    const secondUserId = randomUUID();
    await kit.db.runtime.db.insert(user).values({
      id: secondUserId,
      name: "Budget Confirm Clerk",
      email: `budget-confirm-clerk-${secondUserId}@assistant-kit.test`,
    });
    await kit.db.runtime.db.insert(companyMembers).values({
      companyId: kitIdentities.companies.a,
      userId: secondUserId,
      role: "employee",
      permissions: {
        granted: ["assistant:use", "customers:delete"],
        denied: [],
      },
    });
    const secondUser = {
      userId: secondUserId,
      token: await insertBearer(kit, secondUserId),
    };
    const secondConversation = await staffInvoke(
      createConversation,
      { title: "Budget turn skip other user confirm" },
      { userId: secondUser.userId, companyId: kitIdentities.companies.a },
    );
    const otherPause = await postChat(app, {
      token: secondUser.token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(secondConversation.id, "Delete the archived customer"),
    });
    expect(otherPause.status).toBe(200);
    const challengeId = confirmationChallengeIdFromHostBody(
      await otherPause.json(),
    );
    expect(challengeId).toBeDefined();
    if (challengeId === undefined) {
      expect.unreachable("expected confirmation pending");
    }
    const blockedOtherChat = await postChat(app, {
      token: secondUser.token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(secondConversation.id, "another turn"),
    });
    expect(blockedOtherChat.status).toBe(429);
    const confirmResume = await postAssistant(app, {
      path: ASSISTANT_CONFIRM_PATH,
      token: secondUser.token,
      body: {
        conversationId: secondConversation.id,
        challengeId,
      },
    });
    expect(confirmResume.status).toBe(200);
    await confirmResume.json();
    expect(await customerRow(deleteTarget.id)).toBeUndefined();
  });
});
