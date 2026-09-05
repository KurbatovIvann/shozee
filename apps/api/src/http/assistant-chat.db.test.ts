/**
 * Staff AI SSE mount (SHO-322): session/company denial, mock-model parity,
 * audit channel, confirmation resume, and `/rpc` remaining `ui`.
 */
import { randomBytes, randomUUID } from "node:crypto";

import {
  attemptKey,
  assistantChoiceInteractionResultSchema,
  catalogDomainErrorExtrasFromError,
  isStaffAssistantConfirmationOutput,
  isStaffAssistantNeedsChoiceOutput,
  ORDERS_CREATE_TOOL_NAME,
  ORDERS_LIST_COUNTS_TOOL_NAME,
  ORDERS_LIST_PAGE_TOOL_NAME,
  presentCatalogDomainError,
  presentChoiceStaffAssistantTurn,
  PRICING_LIST_PRICE_LISTS_TOOL_NAME,
  STAFF_ASSISTANT_MODEL_HISTORY_MAX,
  STAFF_ASSISTANT_TOOL_SEARCH_NAME,
  toProviderToolName,
  type LanguageModel,
  type StaffAssistantConfirmationOutput,
} from "@showzy/ai";
import * as ShowzyAi from "@showzy/ai";
import {
  MockLanguageModelV3,
  mockOperationalGateGenerate,
  mockSpokenStream,
  mockStaffAssistantGateGenerate,
  mockTextStream,
  mockToolCallStream,
  readUiMessageSsePayloads,
  sseVisibleTextFromPayloads,
} from "@showzy/ai/test";
import { createConversation, recordAssistantTurn } from "@showzy/assistant";
import {
  archiveProduct,
  archiveVariant,
  createProduct,
  ReferenceResolutionConflictError,
} from "@showzy/catalog";
import { createOrder } from "@showzy/orders";
import { createPriceList } from "@showzy/pricing";
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
import { NotFoundError } from "@showzy/core/errors";
import {
  createCapturingLogger,
  createTestKit,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import {
  archiveCustomer,
  createCustomer,
  createGroup,
  getCustomer,
} from "@showzy/customers";
import { auditLog, idempotencyKeys } from "@showzy/db";
import { session, user } from "@showzy/db/schema/auth";
import { companyMembers } from "@showzy/db/schema/companies";
import {
  assistantMessages,
  assistantToolRuns,
} from "@showzy/db/schema/assistant";
import { companyCustomers, customerGroups } from "@showzy/db/schema/customers";
import { orders } from "@showzy/db/schema/orders";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { z } from "zod";

import { buildAuthOptions } from "../auth/options.js";
import { createAtomicOtpSendStore } from "../auth/otp-send-guard.js";
import { createActionRegistry } from "../composition.js";
import { createMemoryChoiceStore } from "../stores/choice.js";
import {
  createMemoryAuthRateLimitStore,
  createMemorySecondaryStorage,
} from "../stores/memory.js";
import {
  createApp,
  HTTP_INVOCATION_CHANNEL,
  type AuthInstance,
} from "./app.js";
import {
  ASSISTANT_CHAT_PATH,
  ASSISTANT_INVOCATION_CHANNEL,
  executeStaffAssistantChat,
} from "./assistant-chat.js";
import { ASSISTANT_CHOICE_PATH } from "./assistant-choice.js";
import { REQUEST_ID_HEADER } from "./request-id.js";

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
  messageId: string = randomUUID(),
  locale?: "uk" | "en",
) {
  return {
    conversationId,
    messages: [
      {
        id: messageId,
        role: "user" as const,
        parts: [{ type: "text" as const, text }],
      },
    ],
    ...(locale === undefined ? {} : { locale }),
  };
}

function confirmationFromSsePayloads(
  payloads: unknown[],
): StaffAssistantConfirmationOutput | undefined {
  for (const payload of payloads) {
    if (
      typeof payload !== "object" ||
      payload === null ||
      !("type" in payload) ||
      payload.type !== "data-confirmation" ||
      !("data" in payload)
    ) {
      continue;
    }
    if (isStaffAssistantConfirmationOutput(payload.data)) {
      return payload.data;
    }
  }
  return undefined;
}

function choiceFromSsePayloads(payloads: unknown[]) {
  for (const payload of payloads) {
    if (
      typeof payload !== "object" ||
      payload === null ||
      !("type" in payload) ||
      payload.type !== "data-choice" ||
      !("data" in payload)
    ) {
      continue;
    }
    if (isStaffAssistantNeedsChoiceOutput(payload.data)) {
      return payload.data;
    }
  }
  return undefined;
}

function resumeBodyWithConfirmation(
  conversationId: string,
  text: string,
  confirmation: StaffAssistantConfirmationOutput,
) {
  return {
    conversationId,
    messages: [
      {
        id: randomUUID(),
        role: "user" as const,
        parts: [{ type: "text" as const, text }],
      },
      {
        id: randomUUID(),
        role: "assistant" as const,
        parts: [
          {
            type: "data-confirmation" as const,
            data: confirmation,
          },
        ],
      },
    ],
  };
}

async function userMessageCount(conversationId: string): Promise<number> {
  const rows = await kit.db.runtime.db.select().from(assistantMessages);
  return rows.filter(
    (row) => row.conversationId === conversationId && row.role === "user",
  ).length;
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

async function waitForAssistantBody(conversationId: string): Promise<string> {
  let body: string | undefined;
  await waitFor(async () => {
    const rows = await kit.db.runtime.db.select().from(assistantMessages);
    const assistant = rows.find(
      (row) =>
        row.conversationId === conversationId && row.role === "assistant",
    );
    if (assistant === undefined) {
      return false;
    }
    body = assistant.body;
    return true;
  }, "assistant persist");
  if (body === undefined) {
    throw new Error("missing assistant persist body");
  }
  return body;
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

function chatApp(
  model?: LanguageModel,
  gateLanguageModel?: LanguageModel,
  choiceStore?: ReturnType<typeof createMemoryChoiceStore>,
) {
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
    ...(choiceStore !== undefined ? { choiceStore } : {}),
    assistant: {
      model: "mock",
      gateModel: "mock-gate",
      ...(model !== undefined ? { languageModel: model } : {}),
      ...(gateLanguageModel !== undefined ? { gateLanguageModel } : {}),
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
  });
}

async function sessionFromAuth(
  headers: Headers,
): Promise<{ userId: string } | null> {
  const result = await auth.api.getSession({ headers });
  if (result === null) {
    return null;
  }
  return { userId: result.user.id };
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
    await readUiMessageSsePayloads(response);
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
    await readUiMessageSsePayloads(response);
    const prompt = JSON.stringify(model.doStreamCalls[0]?.prompt ?? []);
    expect(prompt).not.toContain("Working set from earlier tool runs");
    expect(prompt).toContain("Europe/Kyiv");
    expect(prompt).toContain("Konditerska Anna");
    expect(prompt).toContain("week starts on Monday");
    expect(prompt).not.toContain(kitIdentities.companies.a);
  });

  it("omits the trade name on documents:view denial and still returns the clock", async () => {
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
      permissions: { granted: ["assistant:use"], denied: ["documents:view"] },
    });
    const model = new MockLanguageModelV3({
      doStream: [mockTextStream("Hello without a company name.")],
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
    await readUiMessageSsePayloads(response);
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

  it("windows 20 client messages to 8 and does not log dropped text", async () => {
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
        gateModel: "mock-gate",
        languageModel: model,
      },
    });
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "History window",
    });
    const messages = Array.from({ length: 20 }, (_, index) => {
      const id = `m${String(index)}`;
      if (index % 2 === 0) {
        return {
          id,
          role: "assistant" as const,
          parts: [
            {
              type: "text" as const,
              text: index === 0 ? dropped : `assistant-${String(index)}`,
            },
          ],
        };
      }
      return {
        id,
        role: "user" as const,
        parts: [
          {
            type: "text" as const,
            text: index === 19 ? latest : `user-${String(index)}`,
          },
        ],
      };
    });
    const response = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: { conversationId: conversation.id, messages },
    });
    expect(response.status).toBe(200);
    await readUiMessageSsePayloads(response);
    const prompt = JSON.stringify(model.doStreamCalls[0]?.prompt ?? []);
    const conversationTurns = (model.doStreamCalls[0]?.prompt ?? []).filter(
      (part) => part.role === "user" || part.role === "assistant",
    );
    expect(conversationTurns).toHaveLength(STAFF_ASSISTANT_MODEL_HISTORY_MAX);
    expect(prompt).toContain(latest);
    expect(prompt).not.toContain(dropped);
    const usage = capturing
      .entries()
      .find((entry) => entry["msg"] === "staff assistant turn usage");
    expect(usage?.["history_message_count"]).toBe(
      STAFF_ASSISTANT_MODEL_HISTORY_MAX,
    );
    expect(JSON.stringify(usage)).not.toContain(dropped);
    expect(JSON.stringify(usage)).not.toContain(latest);
    expect(JSON.stringify(usage)).not.toContain(
      "ASSISTANT_BODY_SENTINEL_never_log",
    );
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

describe("POST /assistant/chat mock-model parity", () => {
  it("runs orders.list as a read tool", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("network must not run"));
    const app = chatApp(
      new MockLanguageModelV3({
        doStream: [
          mockToolCallStream("call-list", ORDERS_LIST_PAGE_TOOL_NAME, "{}"),
          mockTextStream("You have no orders."),
        ],
      }),
    );
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "List",
    });
    const response = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(conversation.id, "List orders"),
    });
    expect(response.status).toBe(200);
    const payloads = await readUiMessageSsePayloads(response);
    const visible = sseVisibleTextFromPayloads(payloads);
    expect(visible).not.toContain("You have no orders.");
    expect(
      visible === "Немає замовлень." ||
        visible.startsWith("Останні замовлення:"),
    ).toBe(true);
    await waitFor(async () => {
      const runs = await kit.db.runtime.db.select().from(assistantToolRuns);
      return runs.some(
        (run) =>
          run.conversationId === conversation.id &&
          run.actionName === "orders.list" &&
          run.outcome === "success",
      );
    }, "orders.list tool run");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("persists presenter list spoken in assistant_messages.body, not mock model spoken", async () => {
    const modelSpoken = "MODEL_SPOKEN_SHOULD_NOT_PERSIST";
    const app = chatApp(
      new MockLanguageModelV3({
        doStream: [
          mockToolCallStream("call-list", ORDERS_LIST_PAGE_TOOL_NAME, "{}"),
          mockSpokenStream(modelSpoken),
        ],
      }),
    );
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "Presenter persist uk",
    });
    const response = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(conversation.id, "List orders", randomUUID(), "uk"),
    });
    expect(response.status).toBe(200);
    await readUiMessageSsePayloads(response);
    const body = await waitForAssistantBody(conversation.id);
    expect(body).not.toBe(modelSpoken);
    expect(
      body === "Немає замовлень." || body.startsWith("Останні замовлення:"),
    ).toBe(true);
  });

  it("persists English presenter text when locale is en", async () => {
    const modelSpoken = "MODEL_SPOKEN_SHOULD_NOT_PERSIST";
    const app = chatApp(
      new MockLanguageModelV3({
        doStream: [
          mockToolCallStream("call-list", ORDERS_LIST_PAGE_TOOL_NAME, "{}"),
          mockSpokenStream(modelSpoken),
        ],
      }),
    );
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "Presenter persist en",
    });
    const response = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(conversation.id, "List orders", randomUUID(), "en"),
    });
    expect(response.status).toBe(200);
    await readUiMessageSsePayloads(response);
    const body = await waitForAssistantBody(conversation.id);
    expect(body).not.toBe(modelSpoken);
    expect(body === "No orders." || body.startsWith("Latest orders:")).toBe(
      true,
    );
  });

  it("defaults persisted presenter locale to uk when locale is omitted", async () => {
    const modelSpoken = "MODEL_SPOKEN_SHOULD_NOT_PERSIST";
    const app = chatApp(
      new MockLanguageModelV3({
        doStream: [
          mockToolCallStream("call-list", ORDERS_LIST_PAGE_TOOL_NAME, "{}"),
          mockSpokenStream(modelSpoken),
        ],
      }),
    );
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "Presenter persist default locale",
    });
    const response = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(conversation.id, "List orders"),
    });
    expect(response.status).toBe(200);
    await readUiMessageSsePayloads(response);
    const body = await waitForAssistantBody(conversation.id);
    expect(body).not.toBe(modelSpoken);
    expect(
      body === "Немає замовлень." || body.startsWith("Останні замовлення:"),
    ).toBe(true);
  });

  it("persists model spoken when the turn has no registered surface", async () => {
    const spoken = "I can look up orders when you ask.";
    const app = chatApp(
      new MockLanguageModelV3({
        doStream: [mockSpokenStream(spoken)],
      }),
    );
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "Spoken-only persist",
    });
    const response = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(conversation.id, "Hello"),
    });
    expect(response.status).toBe(200);
    await readUiMessageSsePayloads(response);
    expect(await waitForAssistantBody(conversation.id)).toBe(spoken);
  });

  it("rejects an invalid locale before the model runs", async () => {
    const model = new MockLanguageModelV3({
      doStream: [mockTextStream("should not run")],
    });
    const app = chatApp(model);
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "Invalid locale",
    });
    const response = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: {
        ...userChatBody(conversation.id, "List orders"),
        locale: "fr",
      },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "VALIDATION",
      status: 400,
    });
    expect(model.doStreamCalls).toHaveLength(0);
  });

  it("eval 1: active-order product quantities use one orders_list_counts", async () => {
    const customer = await staffInvoke(createCustomer, {
      name: "AI Eval Counts Buyer",
      phone: "+380671110021",
    });
    const product = await staffInvoke(createProduct, {
      name: "AI Eval Widget",
      basePriceMinor: "1000",
    });
    await staffInvoke(createOrder, {
      customer: { by: "id", id: customer.id },
      items: [
        {
          product: { by: "id", id: product.productId },
          quantity: { milli: "1000" },
        },
      ],
    });
    await staffInvoke(createOrder, {
      customer: { by: "id", id: customer.id },
      items: [
        {
          product: { by: "id", id: product.productId },
          quantity: { milli: "3000" },
        },
      ],
    });
    const streamModel = new MockLanguageModelV3({
      doStream: [
        mockToolCallStream(
          "call-counts",
          ORDERS_LIST_COUNTS_TOOL_NAME,
          JSON.stringify({
            groupBy: "product",
            statuses: ["new", "confirmed"],
          }),
        ),
        mockTextStream("Active orders include 4000 milli of the widget."),
      ],
    });
    const app = chatApp(streamModel);
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "Eval 1 counts",
    });
    const response = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(
        conversation.id,
        "Which products are in active orders?",
      ),
    });
    expect(response.status).toBe(200);
    await readUiMessageSsePayloads(response);
    await waitFor(async () => {
      const runs = await kit.db.runtime.db.select().from(assistantToolRuns);
      return runs.some(
        (run) =>
          run.conversationId === conversation.id &&
          run.actionName === "orders.list" &&
          run.outcome === "success",
      );
    }, "orders.list aggregate via orders_list_counts");
    const listRuns = (
      await kit.db.runtime.db.select().from(assistantToolRuns)
    ).filter(
      (run) =>
        run.conversationId === conversation.id &&
        run.actionName === "orders.list",
    );
    expect(listRuns).toHaveLength(1);
    expect(streamModel.doStreamCalls.length).toBe(2);
    const toolNames = (streamModel.doStreamCalls[0]?.tools ?? []).map(
      (tool) => tool.name,
    );
    expect(toolNames).toContain(ORDERS_LIST_COUNTS_TOOL_NAME);
    expect(toolNames).not.toContain(toProviderToolName("orders.list"));
    const secondStep = JSON.stringify(streamModel.doStreamCalls[1]);
    expect(secondStep).toContain("quantityMilli");
    expect(secondStep).toContain("4000");
  });

  it("eval 2: gross in a date range uses one orders_list_counts groupBy none", async () => {
    const createdFrom = "2026-08-30T21:00:00.000Z";
    const createdTo = "2026-09-06T20:59:59.999Z";
    const streamModel = new MockLanguageModelV3({
      doStream: [
        mockToolCallStream(
          "call-gross",
          ORDERS_LIST_COUNTS_TOOL_NAME,
          JSON.stringify({
            groupBy: "none",
            createdFrom,
            createdTo,
          }),
        ),
        mockTextStream("Here is this week's bounded gross rollup."),
      ],
    });
    const app = chatApp(streamModel);
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "Eval 2 counts",
    });
    const response = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(conversation.id, "What is the order gross this week?"),
    });
    expect(response.status).toBe(200);
    await readUiMessageSsePayloads(response);
    await waitFor(async () => {
      const runs = await kit.db.runtime.db.select().from(assistantToolRuns);
      return runs.some(
        (run) =>
          run.conversationId === conversation.id &&
          run.actionName === "orders.list" &&
          run.outcome === "success",
      );
    }, "orders.list aggregate groupBy none with date interval");
    const listRuns = (
      await kit.db.runtime.db.select().from(assistantToolRuns)
    ).filter(
      (run) =>
        run.conversationId === conversation.id &&
        run.actionName === "orders.list",
    );
    expect(listRuns).toHaveLength(1);
    expect(streamModel.doStreamCalls.length).toBe(2);
    const toolNames = (streamModel.doStreamCalls[0]?.tools ?? []).map(
      (tool) => tool.name,
    );
    expect(toolNames).toContain(ORDERS_LIST_COUNTS_TOOL_NAME);
    expect(toolNames).not.toContain(toProviderToolName("orders.list"));
    const secondStep = JSON.stringify(streamModel.doStreamCalls[1]);
    expect(secondStep).toContain('"kind":"aggregate"');
  });

  it("eval: find price list named Opt uses one pricing.listPriceLists façade call", async () => {
    const created = await staffInvoke(createPriceList, { name: "Opt" });
    const streamModel = new MockLanguageModelV3({
      doStream: [
        mockToolCallStream(
          "call-pricing",
          PRICING_LIST_PRICE_LISTS_TOOL_NAME,
          JSON.stringify({ query: "Opt" }),
        ),
        mockTextStream("Found price list Opt."),
      ],
    });
    const app = chatApp(streamModel);
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "Eval find Opt",
    });
    const response = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(conversation.id, "find price list named Opt"),
    });
    expect(response.status).toBe(200);
    const payloads = await readUiMessageSsePayloads(response);
    await waitFor(async () => {
      const runs = await kit.db.runtime.db.select().from(assistantToolRuns);
      return runs.some(
        (run) =>
          run.conversationId === conversation.id &&
          run.actionName === "pricing.listPriceLists" &&
          run.outcome === "success",
      );
    }, "pricing.listPriceLists via pricing_list_price_lists");
    const listRuns = (
      await kit.db.runtime.db.select().from(assistantToolRuns)
    ).filter(
      (run) =>
        run.conversationId === conversation.id &&
        run.actionName === "pricing.listPriceLists",
    );
    expect(listRuns).toHaveLength(1);
    expect(streamModel.doStreamCalls.length).toBe(2);
    const toolNames = (streamModel.doStreamCalls[0]?.tools ?? []).map(
      (tool) => tool.name,
    );
    expect(toolNames).toContain(PRICING_LIST_PRICE_LISTS_TOOL_NAME);
    expect(toolNames).not.toContain(
      toProviderToolName("pricing.listPriceLists"),
    );
    expect(toolNames).toContain(toProviderToolName("pricing.createPriceList"));
    expect(toolNames).toContain(
      toProviderToolName("pricing.setPriceListEntries"),
    );
    const secondStep = JSON.stringify(streamModel.doStreamCalls[1]);
    expect(secondStep).toContain("Opt");
    expect(secondStep).toContain(created.id);
    expect(secondStep).toContain("entryCount");
    expect(JSON.stringify(payloads)).not.toMatch(
      /cannot find a tool|missing tool/i,
    );
  });

  it("executes orders.create without confirmation", async () => {
    const customer = await staffInvoke(createCustomer, {
      name: "AI Order Buyer",
      phone: "+380671110001",
    });
    const product = await staffInvoke(createProduct, {
      name: "AI Cake",
      basePriceMinor: "15000",
    });
    const createInput = JSON.stringify({
      customerId: customer.id,
      items: [
        {
          productId: product.productId,
          quantityMilli: "1000",
        },
      ],
    });
    const app = chatApp(
      new MockLanguageModelV3({
        doStream: [
          mockToolCallStream(
            "call-create",
            ORDERS_CREATE_TOOL_NAME,
            createInput,
          ),
          mockTextStream("Order created."),
        ],
      }),
    );
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "Create",
    });
    const requestId = randomUUID();
    const response = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(conversation.id, "Create an order"),
      extraHeaders: { [REQUEST_ID_HEADER]: requestId },
    });
    expect(response.status).toBe(200);
    await readUiMessageSsePayloads(response);
    await waitFor(async () => {
      const rows = await kit.db.runtime.db.select().from(orders);
      return rows.some(
        (row) =>
          row.companyId === kitIdentities.companies.a &&
          row.customerId === customer.id,
      );
    }, "created order row");

    const audit = await kit.db.runtime.db.select().from(auditLog);
    const aiRow = audit.find(
      (row) => row.action === "orders.create" && row.requestId === requestId,
    );
    expect(aiRow).toMatchObject({
      channel: ASSISTANT_INVOCATION_CHANNEL,
      aiTraceId: requestId,
      toolCallId: "call-create",
      actorType: "user",
      actorId: kitIdentities.users.anna,
      companyId: kitIdentities.companies.a,
      outcome: "ok",
    });
    expect(JSON.stringify(aiRow)).not.toContain("Create an order");
  });

  it("eval 3: unique names via orders_create execute orders.create", async () => {
    const customer = await staffInvoke(createCustomer, {
      name: "T9 Query Buyer",
      phone: "+380671110031",
    });
    await staffInvoke(createProduct, {
      name: "T9 Query Cake",
      basePriceMinor: "15000",
    });
    const streamModel = new MockLanguageModelV3({
      doStream: [
        mockToolCallStream(
          "call-create-query",
          ORDERS_CREATE_TOOL_NAME,
          JSON.stringify({
            customerQuery: "T9 Query Buyer",
            items: [{ productQuery: "T9 Query Cake", quantityDecimal: "1.5" }],
          }),
        ),
        mockTextStream("Order created from unique names."),
      ],
    });
    const app = chatApp(streamModel);
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "Eval 3 create",
    });
    const response = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(
        conversation.id,
        "Create an order for T9 Query Buyer with T9 Query Cake",
      ),
    });
    expect(response.status).toBe(200);
    const payloads = await readUiMessageSsePayloads(response);
    await waitFor(async () => {
      const rows = await kit.db.runtime.db.select().from(orders);
      return rows.some(
        (row) =>
          row.companyId === kitIdentities.companies.a &&
          row.customerId === customer.id,
      );
    }, "created order via orders_create query locators");
    const createRuns = (
      await kit.db.runtime.db.select().from(assistantToolRuns)
    ).filter(
      (run) =>
        run.conversationId === conversation.id &&
        run.actionName === "orders.create",
    );
    expect(createRuns).toHaveLength(1);
    expect(createRuns[0]?.outcome).toBe("success");
    expect(streamModel.doStreamCalls.length).toBe(2);
    const toolNames = (streamModel.doStreamCalls[0]?.tools ?? []).map(
      (tool) => tool.name,
    );
    expect(toolNames).toContain(ORDERS_CREATE_TOOL_NAME);
    expect(toolNames).toContain(toProviderToolName("orders.create"));
    expect(JSON.stringify(payloads)).not.toMatch(
      /cannot find a tool|missing tool/i,
    );
  });

  it("pauses customers.deleteCustomer and resumes with the Redis challenge", async () => {
    const customer = await staffInvoke(createCustomer, {
      name: "AI Delete Me",
      phone: "+380671110002",
    });
    await staffInvoke(archiveCustomer, { id: customer.id });
    const deleteInput = JSON.stringify({ id: customer.id });
    const app = chatApp(
      new MockLanguageModelV3({
        doStream: [
          mockToolCallStream(
            "call-delete",
            toProviderToolName("customers.deleteCustomer"),
            deleteInput,
          ),
          mockToolCallStream(
            "call-delete-resume",
            toProviderToolName("customers.deleteCustomer"),
            deleteInput,
          ),
          mockTextStream("The customer was deleted."),
        ],
      }),
    );
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "Delete",
    });
    const pause = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(conversation.id, "Delete the archived customer"),
    });
    expect(pause.status).toBe(200);
    const pausePayloads = await readUiMessageSsePayloads(pause);
    const confirmation = confirmationFromSsePayloads(pausePayloads);
    expect(confirmation).toBeDefined();
    if (!isStaffAssistantConfirmationOutput(confirmation)) {
      expect.unreachable("expected confirmation part");
    }
    expect(confirmation.summary).toContain("Delete this archived customer");
    expect(confirmation.toolCallId).toBe("call-delete");
    expect(JSON.stringify(pausePayloads)).not.toContain(
      "The customer was deleted.",
    );

    const stillThere = (
      await kit.db.runtime.db.select().from(companyCustomers)
    ).filter((row) => row.id === customer.id);
    expect(stillThere).toHaveLength(1);

    const resumeRequestId = randomUUID();
    const resumeBody = userChatBody(
      conversation.id,
      "Delete the archived customer",
    );
    expect(
      JSON.stringify(resumeBody.messages).includes("data-confirmation"),
    ).toBe(false);
    const resume = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: resumeBody,
      challengeId: confirmation.challengeId,
      extraHeaders: { [REQUEST_ID_HEADER]: resumeRequestId },
    });
    expect(resume.status).toBe(200);
    await readUiMessageSsePayloads(resume);

    await waitFor(async () => {
      const rows = await kit.db.runtime.db.select().from(companyCustomers);
      return !rows.some((row) => row.id === customer.id);
    }, "deleted customer");

    await expect(
      staffInvoke(getCustomer, { id: customer.id }),
    ).rejects.toBeInstanceOf(NotFoundError);

    const audit = await kit.db.runtime.db.select().from(auditLog);
    const resumeAudit = audit.find(
      (row) =>
        row.action === "customers.deleteCustomer" &&
        row.requestId === resumeRequestId &&
        row.outcome === "ok",
    );
    expect(resumeAudit).toMatchObject({
      channel: ASSISTANT_INVOCATION_CHANNEL,
      toolCallId: "call-delete-resume",
    });
    const keys = await kit.db.runtime.db.select().from(idempotencyKeys);
    const pausedKey = keys.find(
      (row) =>
        row.action === "customers.deleteCustomer" &&
        row.key === attemptKey("tool", conversation.id, "call-delete"),
    );
    expect(pausedKey?.status).toBe("completed");
  });

  it("does not bind a resume challenge to a different high-risk tool", async () => {
    const customer = await staffInvoke(createCustomer, {
      name: "AI Challenge Scope",
      phone: "+380671110003",
    });
    await staffInvoke(archiveCustomer, { id: customer.id });
    const group = await staffInvoke(createGroup, {
      name: "AI Challenge Group",
    });
    const deleteCustomerInput = JSON.stringify({ id: customer.id });
    const deleteGroupInput = JSON.stringify({ id: group.id });
    const app = chatApp(
      new MockLanguageModelV3({
        doStream: [
          mockToolCallStream(
            "call-delete",
            toProviderToolName("customers.deleteCustomer"),
            deleteCustomerInput,
          ),
          mockToolCallStream(
            "call-wrong",
            toProviderToolName("customers.deleteGroup"),
            deleteGroupInput,
          ),
          mockToolCallStream(
            "call-delete-resume",
            toProviderToolName("customers.deleteCustomer"),
            deleteCustomerInput,
          ),
          mockTextStream("The customer was deleted."),
        ],
      }),
    );
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "Challenge scope",
    });
    const pause = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(conversation.id, "Delete the archived customer"),
    });
    expect(pause.status).toBe(200);
    const pausePayloads = await readUiMessageSsePayloads(pause);
    const confirmation = confirmationFromSsePayloads(pausePayloads);
    expect(confirmation).toBeDefined();
    if (!isStaffAssistantConfirmationOutput(confirmation)) {
      expect.unreachable("expected confirmation part");
    }
    expect(confirmation.actionName).toBe("customers.deleteCustomer");

    const mismatched = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(conversation.id, "Delete the archived customer"),
      challengeId: confirmation.challengeId,
    });
    expect(mismatched.status).toBe(200);
    const mismatchedPayloads = await readUiMessageSsePayloads(mismatched);
    const mismatchedConfirmation =
      confirmationFromSsePayloads(mismatchedPayloads);
    expect(mismatchedConfirmation).toBeDefined();
    if (!isStaffAssistantConfirmationOutput(mismatchedConfirmation)) {
      expect.unreachable("expected a new confirmation for the other tool");
    }
    expect(mismatchedConfirmation.actionName).toBe("customers.deleteGroup");
    expect(mismatchedConfirmation.challengeId).not.toBe(
      confirmation.challengeId,
    );

    const stillCustomer = (
      await kit.db.runtime.db.select().from(companyCustomers)
    ).filter((row) => row.id === customer.id);
    expect(stillCustomer).toHaveLength(1);
    const stillGroup = (
      await kit.db.runtime.db.select().from(customerGroups)
    ).filter((row) => row.id === group.id);
    expect(stillGroup).toHaveLength(1);

    const resume = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(conversation.id, "Delete the archived customer"),
      challengeId: confirmation.challengeId,
    });
    expect(resume.status).toBe(200);
    await readUiMessageSsePayloads(resume);

    await waitFor(async () => {
      const rows = await kit.db.runtime.db.select().from(companyCustomers);
      return !rows.some((row) => row.id === customer.id);
    }, "deleted customer after scoped resume");

    const groupAfter = (
      await kit.db.runtime.db.select().from(customerGroups)
    ).filter((row) => row.id === group.id);
    expect(groupAfter).toHaveLength(1);
  });
});

describe("POST /assistant/chat attempt identity", () => {
  it("inserts two user rows for the same text with different message ids, and replays the same id", async () => {
    const app = chatApp(
      new MockLanguageModelV3({
        doStream: [
          mockTextStream("ok"),
          mockTextStream("ok"),
          mockTextStream("ok"),
        ],
      }),
    );
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "Так",
    });
    const firstId = randomUUID();
    const secondId = randomUUID();
    const first = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(conversation.id, "так", firstId),
    });
    expect(first.status).toBe(200);
    await readUiMessageSsePayloads(first);
    expect(await userMessageCount(conversation.id)).toBe(1);

    const second = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(conversation.id, "так", secondId),
    });
    expect(second.status).toBe(200);
    await readUiMessageSsePayloads(second);
    expect(await userMessageCount(conversation.id)).toBe(2);

    const replay = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(conversation.id, "так", firstId),
    });
    expect(replay.status).toBe(200);
    await readUiMessageSsePayloads(replay);
    expect(await userMessageCount(conversation.id)).toBe(2);
  });

  it("conflicts when the same message id is retried with different text", async () => {
    const app = chatApp(
      new MockLanguageModelV3({
        doStream: [mockTextStream("ok")],
      }),
    );
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "Conflict",
    });
    const messageId = randomUUID();
    const first = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(conversation.id, "так", messageId),
    });
    expect(first.status).toBe(200);
    await readUiMessageSsePayloads(first);
    expect(await userMessageCount(conversation.id)).toBe(1);

    const conflict = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(conversation.id, "ні", messageId),
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
      status: 409,
    });
    expect(await userMessageCount(conversation.id)).toBe(1);
  });

  it("creates two orders for the same input with different tool ids, and replays the same tool id", async () => {
    const customer = await staffInvoke(createCustomer, {
      name: "AI Attempt Buyer",
      phone: "+380671110004",
    });
    const product = await staffInvoke(createProduct, {
      name: "AI Attempt Cake",
      basePriceMinor: "15000",
    });
    const createInput = JSON.stringify({
      customerId: customer.id,
      items: [
        {
          productId: product.productId,
          quantityMilli: "1000",
        },
      ],
    });
    const app = chatApp(
      new MockLanguageModelV3({
        doStream: [
          mockToolCallStream(
            "call-create-a",
            ORDERS_CREATE_TOOL_NAME,
            createInput,
          ),
          mockTextStream("Order A."),
          mockToolCallStream(
            "call-create-b",
            ORDERS_CREATE_TOOL_NAME,
            createInput,
          ),
          mockTextStream("Order B."),
          mockToolCallStream(
            "call-create-a",
            ORDERS_CREATE_TOOL_NAME,
            createInput,
          ),
          mockTextStream("Order A again."),
        ],
      }),
    );
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "Two creates",
    });

    async function createViaChat(text: string): Promise<void> {
      const response = await postChat(app, {
        token,
        companyId: kitIdentities.companies.a,
        body: userChatBody(conversation.id, text),
      });
      expect(response.status).toBe(200);
      await readUiMessageSsePayloads(response);
    }

    await createViaChat("Create order A");
    await createViaChat("Create order B");
    await waitFor(async () => {
      const rows = await kit.db.runtime.db.select().from(orders);
      return (
        rows.filter(
          (row) =>
            row.companyId === kitIdentities.companies.a &&
            row.customerId === customer.id,
        ).length === 2
      );
    }, "two orders");

    await createViaChat("Create order A again");
    const afterReplay = (await kit.db.runtime.db.select().from(orders)).filter(
      (row) =>
        row.companyId === kitIdentities.companies.a &&
        row.customerId === customer.id,
    );
    expect(afterReplay).toHaveLength(2);

    const keys = await kit.db.runtime.db.select().from(idempotencyKeys);
    expect(
      keys.some(
        (row) =>
          row.action === "orders.create" &&
          row.key === attemptKey("tool", conversation.id, "call-create-a") &&
          row.status === "completed",
      ),
    ).toBe(true);
    expect(
      keys.some(
        (row) =>
          row.action === "orders.create" &&
          row.key === attemptKey("tool", conversation.id, "call-create-b") &&
          row.status === "completed",
      ),
    ).toBe(true);
  });

  it("uses only the first matching resume call as the paused attempt", async () => {
    const customer = await staffInvoke(createCustomer, {
      name: "AI One Shot",
      phone: "+380671110005",
    });
    await staffInvoke(archiveCustomer, { id: customer.id });
    const deleteInput = JSON.stringify({ id: customer.id });
    const app = chatApp(
      new MockLanguageModelV3({
        doStream: [
          mockToolCallStream(
            "call-delete",
            toProviderToolName("customers.deleteCustomer"),
            deleteInput,
          ),
          mockToolCallStream(
            "call-resume-b",
            toProviderToolName("customers.deleteCustomer"),
            deleteInput,
          ),
          mockToolCallStream(
            "call-resume-c",
            toProviderToolName("customers.deleteCustomer"),
            deleteInput,
          ),
        ],
      }),
    );
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "One-shot claim",
    });
    const pause = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(conversation.id, "Delete the archived customer"),
    });
    expect(pause.status).toBe(200);
    const confirmation = confirmationFromSsePayloads(
      await readUiMessageSsePayloads(pause),
    );
    expect(confirmation).toBeDefined();
    if (!isStaffAssistantConfirmationOutput(confirmation)) {
      expect.unreachable("expected confirmation part");
    }

    const resume = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(conversation.id, "Delete the archived customer"),
      challengeId: confirmation.challengeId,
    });
    expect(resume.status).toBe(200);
    const resumePayloads = await readUiMessageSsePayloads(resume);
    const secondConfirmation = confirmationFromSsePayloads(resumePayloads);
    expect(secondConfirmation).toBeDefined();
    if (!isStaffAssistantConfirmationOutput(secondConfirmation)) {
      expect.unreachable("expected a new confirmation for the second call");
    }
    expect(secondConfirmation.actionName).toBe("customers.deleteCustomer");
    expect(secondConfirmation.toolCallId).toBe("call-resume-c");
    expect(secondConfirmation.challengeId).not.toBe(confirmation.challengeId);

    await waitFor(async () => {
      const rows = await kit.db.runtime.db.select().from(companyCustomers);
      return !rows.some((row) => row.id === customer.id);
    }, "deleted customer after first matching resume");

    const keys = await kit.db.runtime.db.select().from(idempotencyKeys);
    expect(
      keys.some(
        (row) =>
          row.action === "customers.deleteCustomer" &&
          row.key === attemptKey("tool", conversation.id, "call-delete") &&
          row.status === "completed",
      ),
    ).toBe(true);
    expect(
      keys.some(
        (row) =>
          row.action === "customers.deleteCustomer" &&
          row.key === attemptKey("tool", conversation.id, "call-resume-c"),
      ),
    ).toBe(false);
  });

  it("rejects a persisted vs client confirmation mismatch before consuming the challenge", async () => {
    const customer = await staffInvoke(createCustomer, {
      name: "AI Mismatch",
      phone: "+380671110006",
    });
    await staffInvoke(archiveCustomer, { id: customer.id });
    const deleteInput = JSON.stringify({ id: customer.id });
    const app = chatApp(
      new MockLanguageModelV3({
        doStream: [
          mockToolCallStream(
            "call-delete",
            toProviderToolName("customers.deleteCustomer"),
            deleteInput,
          ),
          mockToolCallStream(
            "call-delete-resume",
            toProviderToolName("customers.deleteCustomer"),
            deleteInput,
          ),
          mockTextStream("The customer was deleted."),
        ],
      }),
    );
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "Mismatch",
    });
    const pause = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(conversation.id, "Delete the archived customer"),
    });
    expect(pause.status).toBe(200);
    const confirmation = confirmationFromSsePayloads(
      await readUiMessageSsePayloads(pause),
    );
    expect(confirmation).toBeDefined();
    if (!isStaffAssistantConfirmationOutput(confirmation)) {
      expect.unreachable("expected confirmation part");
    }

    const forged = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: resumeBodyWithConfirmation(
        conversation.id,
        "Delete the archived customer",
        { ...confirmation, toolCallId: "forged-tool-call" },
      ),
      challengeId: confirmation.challengeId,
    });
    expect(forged.status).toBe(400);
    expect(await forged.json()).toMatchObject({
      code: "VALIDATION",
      status: 400,
    });
    const stillThere = (
      await kit.db.runtime.db.select().from(companyCustomers)
    ).filter((row) => row.id === customer.id);
    expect(stillThere).toHaveLength(1);

    const resume = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(conversation.id, "Delete the archived customer"),
      challengeId: confirmation.challengeId,
    });
    expect(resume.status).toBe(200);
    await readUiMessageSsePayloads(resume);
    await waitFor(async () => {
      const rows = await kit.db.runtime.db.select().from(companyCustomers);
      return !rows.some((row) => row.id === customer.id);
    }, "deleted customer after mismatch reject");
  });

  it("rejects a confirmation resume with no paused attempt before starting the model", async () => {
    const app = chatApp(
      new MockLanguageModelV3({
        doStream: [mockTextStream("should not run")],
      }),
    );
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "Missing pause",
    });
    const response = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(conversation.id, "так"),
      challengeId: randomUUID(),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "VALIDATION",
      status: 400,
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
    await readUiMessageSsePayloads(response);
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

    const usage = capturing
      .entries()
      .find((entry) => entry["msg"] === "staff assistant turn usage");
    expect(usage).toBeDefined();
    expect(typeof usage?.["request_id"]).toBe("string");
    expect(usage?.["conversation_id"]).toBe(conversation.id);
    expect(usage?.["company_id"]).toBe(kitIdentities.companies.a);
    expect(usage?.["actor_id"]).toBe(kitIdentities.users.anna);
    expect(usage?.["model"]).toBe("mock");
    expect(usage?.["thinking"]).toBe("disabled");
    expect(usage?.["tools_attached"]).toBe(true);
    expect(typeof usage?.["input_tokens"]).toBe("number");
    expect(typeof usage?.["output_tokens"]).toBe("number");
    expect(typeof usage?.["cache_read_tokens"]).toBe("number");
    expect(typeof usage?.["cache_write_tokens"]).toBe("number");
    expect(usage?.["gate_input_tokens"]).toBe(0);
    expect(usage?.["gate_output_tokens"]).toBe(0);
    expect(typeof usage?.["model_steps"]).toBe("number");
    expect(usage?.["tool_count"]).toBe(0);
    expect(usage?.["tool_names"]).toEqual([]);
    expect(typeof usage?.["uncached_input_tokens"]).toBe("number");
    expect(typeof usage?.["cache_hit_ratio"]).toBe("number");
    expect(typeof usage?.["history_message_count"]).toBe("number");
    expect(typeof usage?.["history_chars"]).toBe("number");
    expect(typeof usage?.["tool_result_bytes_in"]).toBe("number");
    expect(typeof usage?.["tool_result_bytes_out"]).toBe("number");
    expect(typeof usage?.["toolset_hash"]).toBe("string");
    expect(typeof usage?.["estimated_cost_usd"]).toBe("number");
    expect(Number.isFinite(usage?.["estimated_cost_usd"])).toBe(true);
    expect(JSON.stringify(usage)).not.toContain(prompt);
    expect(JSON.stringify(usage)).not.toContain(
      "ASSISTANT_BODY_SENTINEL_never_log",
    );
    expect(usage).not.toHaveProperty("text");
    expect(usage).not.toHaveProperty("body");
    expect(usage).not.toHaveProperty("prompt");
    expect(usage).not.toHaveProperty("messages");
  });

  it("maps gate generateText usage onto the turn usage line", async () => {
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
        gateModel: "mock-gate",
        languageModel: new MockLanguageModelV3({
          doStream: [mockTextStream("You have no orders.")],
        }),
        gateLanguageModel: new MockLanguageModelV3({
          doGenerate: mockOperationalGateGenerate(true),
        }),
      },
    });
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "Gate usage",
    });
    const response = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(conversation.id, "List orders"),
    });
    expect(response.status).toBe(200);
    await readUiMessageSsePayloads(response);
    const usage = capturing
      .entries()
      .find((entry) => entry["msg"] === "staff assistant turn usage");
    expect(usage?.["gate_model"]).toBe("mock-gate");
    expect(usage?.["gate_input_tokens"]).toBe(1);
    expect(usage?.["gate_output_tokens"]).toBe(1);
    expect(typeof usage?.["estimated_cost_usd"]).toBe("number");
    expect(JSON.stringify(usage)).not.toContain("List orders");
    const gateLog = capturing
      .entries()
      .find((entry) => entry["msg"] === "staff assistant turn gate");
    expect(gateLog?.["gate_model"]).toBe("mock-gate");
    expect(gateLog?.["gate_mode"]).toBe("job");
    expect(gateLog?.["gate_intent"]).toBe("other");
    expect(gateLog?.["gate_confidence"]).toBe("high");
    expect(gateLog).not.toHaveProperty("gate_skip");
  });

  it("logs zero gate tokens when classify throws and still fail-opens", async () => {
    const capturing = createCapturingLogger();
    const streamModel = new MockLanguageModelV3({
      doStream: [mockTextStream("You have no orders.")],
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
        gateModel: "mock-gate",
        languageModel: streamModel,
        gateLanguageModel: new MockLanguageModelV3({
          doGenerate: () => Promise.reject(new Error("gate down")),
        }),
      },
    });
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "Gate throw",
    });
    const response = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(conversation.id, "List orders"),
    });
    expect(response.status).toBe(200);
    await readUiMessageSsePayloads(response);
    expect(streamModel.doStreamCalls.length).toBeGreaterThan(0);
    const usage = capturing
      .entries()
      .find((entry) => entry["msg"] === "staff assistant turn usage");
    expect(usage?.["gate_model"]).toBe("mock-gate");
    expect(usage?.["gate_input_tokens"]).toBe(0);
    expect(usage?.["gate_output_tokens"]).toBe(0);
    expect(usage?.["tools_attached"]).toBe(true);
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

describe("POST /assistant/chat intent gate", () => {
  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  function streamTools(model: MockLanguageModelV3) {
    return model.doStreamCalls.at(-1)?.tools ?? [];
  }

  function streamToolsLength(model: MockLanguageModelV3): number {
    return streamTools(model).length;
  }

  function streamToolNames(model: MockLanguageModelV3): string[] {
    return streamTools(model).map((tool) => tool.name);
  }

  function streamToolProviderOptions(tool: unknown): unknown {
    return isRecord(tool) ? tool["providerOptions"] : undefined;
  }

  it("does not attach tools or execute domain actions when the gate is false", async () => {
    const streamModel = new MockLanguageModelV3({
      doStream: [
        mockToolCallStream("call-list", ORDERS_LIST_PAGE_TOOL_NAME, "{}"),
        mockTextStream("should not run"),
      ],
    });
    const gateModel = new MockLanguageModelV3({
      doGenerate: mockOperationalGateGenerate(false),
      doStream: [mockTextStream("I only help with this company.")],
    });
    const app = chatApp(streamModel, gateModel);
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "Weather",
    });
    const response = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(conversation.id, "What's the weather in Kyiv?"),
    });
    expect(response.status).toBe(200);
    const payloads = await readUiMessageSsePayloads(response);
    expect(JSON.stringify(payloads)).toContain(
      "I only help with this company.",
    );
    expect(JSON.stringify(payloads)).not.toContain("should not run");
    expect(streamModel.doStreamCalls).toHaveLength(0);
    expect(streamToolsLength(gateModel)).toBe(0);
    expect(gateModel.doGenerateCalls).toHaveLength(1);
    const runs = await kit.db.runtime.db.select().from(assistantToolRuns);
    expect(
      runs.some(
        (run) =>
          run.conversationId === conversation.id &&
          run.actionName === "orders.list",
      ),
    ).toBe(false);
  });

  it("attaches tools when the gate is true", async () => {
    const streamModel = new MockLanguageModelV3({
      doStream: [
        mockToolCallStream("call-list", ORDERS_LIST_PAGE_TOOL_NAME, "{}"),
        mockTextStream("You have no orders."),
      ],
    });
    const gateModel = new MockLanguageModelV3({
      doGenerate: mockOperationalGateGenerate(true),
      doStream: [mockTextStream("should not reply as gate")],
    });
    const app = chatApp(streamModel, gateModel);
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "List gated",
    });
    const response = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(conversation.id, "List orders"),
    });
    expect(response.status).toBe(200);
    await readUiMessageSsePayloads(response);
    await waitFor(async () => {
      const runs = await kit.db.runtime.db.select().from(assistantToolRuns);
      return runs.some(
        (run) =>
          run.conversationId === conversation.id &&
          run.actionName === "orders.list" &&
          run.outcome === "success",
      );
    }, "orders.list through operational gate");
    expect(streamToolsLength(streamModel)).toBeGreaterThan(0);
    expect(gateModel.doStreamCalls).toHaveLength(0);
    const names = streamToolNames(streamModel);
    expect(names).toContain(STAFF_ASSISTANT_TOOL_SEARCH_NAME);
    expect(names).toContain(ORDERS_LIST_PAGE_TOOL_NAME);
    expect(names).toContain(ORDERS_LIST_COUNTS_TOOL_NAME);
    expect(names).not.toContain(toProviderToolName("orders.list"));
    const deferred = streamTools(streamModel).find(
      (tool) => tool.name === toProviderToolName("customers.deleteCustomer"),
    );
    expect(deferred).toBeDefined();
    expect(streamToolProviderOptions(deferred)).toMatchObject({
      anthropic: { deferLoading: true },
    });
  });

  it("forces a single terminal job tool with toolChoice required", async () => {
    const streamModel = new MockLanguageModelV3({
      doStream: [
        mockToolCallStream("call-list", ORDERS_LIST_PAGE_TOOL_NAME, "{}"),
        mockTextStream("You have no orders."),
      ],
    });
    const gateModel = new MockLanguageModelV3({
      doGenerate: mockStaffAssistantGateGenerate({
        mode: "job",
        intent: "orders_page",
        confidence: "high",
      }),
      doStream: [mockTextStream("should not reply as gate")],
    });
    const app = chatApp(streamModel, gateModel);
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "Forced page",
    });
    const response = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(conversation.id, "show last 3 orders"),
    });
    expect(response.status).toBe(200);
    await readUiMessageSsePayloads(response);
    expect(streamToolNames(streamModel)).toEqual([ORDERS_LIST_PAGE_TOOL_NAME]);
    expect(streamModel.doStreamCalls[0]?.toolChoice).toEqual({
      type: "required",
    });
    expect(gateModel.doStreamCalls).toHaveLength(0);
  });

  it("does not narrow when job confidence is low", async () => {
    const streamModel = new MockLanguageModelV3({
      doStream: [
        mockToolCallStream("call-list", ORDERS_LIST_PAGE_TOOL_NAME, "{}"),
        mockTextStream("You have no orders."),
      ],
    });
    const gateModel = new MockLanguageModelV3({
      doGenerate: mockStaffAssistantGateGenerate({
        mode: "job",
        intent: "orders_page",
        confidence: "low",
      }),
      doStream: [mockTextStream("should not reply as gate")],
    });
    const app = chatApp(streamModel, gateModel);
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "Low confidence",
    });
    const response = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(conversation.id, "maybe show orders?"),
    });
    expect(response.status).toBe(200);
    await readUiMessageSsePayloads(response);
    const names = streamToolNames(streamModel);
    expect(names).toContain(STAFF_ASSISTANT_TOOL_SEARCH_NAME);
    expect(names).toContain(ORDERS_LIST_PAGE_TOOL_NAME);
    expect(names).toContain(ORDERS_LIST_COUNTS_TOOL_NAME);
    expect(names.length).toBeGreaterThan(1);
  });

  it("fail-opens and attaches tools when classify throws", async () => {
    const streamModel = new MockLanguageModelV3({
      doStream: [
        mockToolCallStream("call-list", ORDERS_LIST_PAGE_TOOL_NAME, "{}"),
        mockTextStream("You have no orders."),
      ],
    });
    const gateModel = new MockLanguageModelV3({
      doGenerate: () => Promise.reject(new Error("gate down")),
      doStream: [mockTextStream("should not reply as gate")],
    });
    const app = chatApp(streamModel, gateModel);
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "Fail open",
    });
    const response = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(conversation.id, "List orders"),
    });
    expect(response.status).toBe(200);
    await readUiMessageSsePayloads(response);
    await waitFor(async () => {
      const runs = await kit.db.runtime.db.select().from(assistantToolRuns);
      return runs.some(
        (run) =>
          run.conversationId === conversation.id &&
          run.actionName === "orders.list",
      );
    }, "fail-open still lists orders");
    expect(streamToolsLength(streamModel)).toBeGreaterThan(0);
  });

  it("skips the gate on confirmation resume and still attaches tools", async () => {
    const capturing = createCapturingLogger();
    const customer = await staffInvoke(createCustomer, {
      name: "AI Gate Resume",
      phone: "+380671110009",
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
        mockToolCallStream(
          "call-delete-resume",
          toProviderToolName("customers.deleteCustomer"),
          deleteInput,
        ),
        mockTextStream("The customer was deleted."),
      ],
    });
    const gateModel = new MockLanguageModelV3({
      doGenerate: mockOperationalGateGenerate(true),
      doStream: [mockTextStream("should not chitchat")],
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
        gateModel: "mock-gate",
        languageModel: streamModel,
        gateLanguageModel: gateModel,
      },
    });
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "Gate resume",
    });
    const pause = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(conversation.id, "Delete the archived customer"),
    });
    expect(pause.status).toBe(200);
    const confirmation = confirmationFromSsePayloads(
      await readUiMessageSsePayloads(pause),
    );
    expect(confirmation).toBeDefined();
    if (!isStaffAssistantConfirmationOutput(confirmation)) {
      expect.unreachable("expected confirmation part");
    }
    expect(gateModel.doGenerateCalls).toHaveLength(1);
    const classifiedGate = capturing
      .entries()
      .find((entry) => entry["msg"] === "staff assistant turn gate");
    expect(classifiedGate?.["gate_model"]).toBe("mock-gate");
    expect(classifiedGate?.["gate_mode"]).toBe("job");
    expect(classifiedGate?.["gate_intent"]).toBe("other");
    expect(classifiedGate?.["gate_confidence"]).toBe("high");
    expect(classifiedGate).not.toHaveProperty("gate_skip");

    const resume = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(conversation.id, "так"),
      challengeId: confirmation.challengeId,
    });
    expect(resume.status).toBe(200);
    await readUiMessageSsePayloads(resume);
    expect(gateModel.doGenerateCalls).toHaveLength(1);
    expect(streamToolsLength(streamModel)).toBeGreaterThan(0);
    const resumeNames = streamToolNames(streamModel);
    expect(resumeNames).toContain(STAFF_ASSISTANT_TOOL_SEARCH_NAME);
    expect(resumeNames).toContain(
      toProviderToolName("customers.deleteCustomer"),
    );
    const resumeGate = capturing
      .entries()
      .filter((entry) => entry["msg"] === "staff assistant turn gate")
      .at(-1);
    expect(resumeGate?.["gate_skip"]).toBe("confirmation_resume");
    expect(resumeGate?.["gate_model"]).toBe("mock-gate");
    expect(resumeGate).not.toHaveProperty("gate_mode");
    expect(resumeGate).not.toHaveProperty("gate_intent");
    expect(resumeGate).not.toHaveProperty("gate_confidence");
  });

  it("skips the gate on choice resume and still attaches tools", async () => {
    const capturing = createCapturingLogger();
    const streamModel = new MockLanguageModelV3({
      doStream: [
        mockToolCallStream("call-list", ORDERS_LIST_PAGE_TOOL_NAME, "{}"),
        mockTextStream("You have no orders."),
      ],
    });
    const gateModel = new MockLanguageModelV3({
      doGenerate: mockStaffAssistantGateGenerate({
        mode: "job",
        intent: "orders_page",
        confidence: "high",
      }),
      doStream: [mockTextStream("should not reply as gate")],
    });
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "Choice resume skip",
    });
    const headers = new Headers({
      "content-type": "application/json",
      origin: "http://localhost:3000",
      authorization: `Bearer ${token}`,
      [COMPANY_SELECTOR_HEADER]: kitIdentities.companies.a,
    });
    const request = new Request(`http://localhost:3000${ASSISTANT_CHAT_PATH}`, {
      method: "POST",
      headers,
      body: JSON.stringify(userChatBody(conversation.id, "show last 3 orders")),
    });
    const response = await executeStaffAssistantChat({
      request,
      requestId: randomUUID(),
      clientIp: REAL_CLIENT,
      registry,
      pipeline: { ...pipeline, logger: capturing.logger },
      getSession: sessionFromAuth,
      assistant: {
        model: "mock",
        gateModel: "mock-gate",
        languageModel: streamModel,
        gateLanguageModel: gateModel,
      },
      choiceResume: true,
    });
    expect(response.status).toBe(200);
    await readUiMessageSsePayloads(response);
    expect(gateModel.doGenerateCalls).toHaveLength(0);
    expect(gateModel.doStreamCalls).toHaveLength(0);
    expect(streamToolsLength(streamModel)).toBeGreaterThan(1);
    const names = streamToolNames(streamModel);
    expect(names).toContain(STAFF_ASSISTANT_TOOL_SEARCH_NAME);
    expect(names).toContain(ORDERS_LIST_PAGE_TOOL_NAME);
    expect(names).toContain(ORDERS_LIST_COUNTS_TOOL_NAME);
    expect(names).not.toEqual([ORDERS_LIST_PAGE_TOOL_NAME]);
    expect(streamModel.doStreamCalls[0]?.toolChoice).not.toEqual({
      type: "required",
    });
    const gateLog = capturing
      .entries()
      .find((entry) => entry["msg"] === "staff assistant turn gate");
    expect(gateLog?.["gate_skip"]).toBe("choice_resume");
    expect(gateLog?.["gate_model"]).toBe("mock-gate");
    expect(gateLog).not.toHaveProperty("gate_mode");
    expect(gateLog).not.toHaveProperty("gate_intent");
    expect(gateLog).not.toHaveProperty("gate_confidence");
    const usage = capturing
      .entries()
      .find((entry) => entry["msg"] === "staff assistant turn usage");
    expect(usage?.["gate_skip"]).toBe("choice_resume");
    expect(usage?.["tools_attached"]).toBe(true);
  });

  it("still routes a second normal user turn after prior tool runs", async () => {
    const capturing = createCapturingLogger();
    const streamModel = new MockLanguageModelV3({
      doStream: [
        mockToolCallStream("call-list", ORDERS_LIST_PAGE_TOOL_NAME, "{}"),
        mockTextStream("Creating the price list."),
      ],
    });
    let gateCalls = 0;
    const gateModel = new MockLanguageModelV3({
      doGenerate: () => {
        gateCalls += 1;
        return Promise.resolve(
          mockStaffAssistantGateGenerate({
            mode: "job",
            intent: gateCalls === 1 ? "orders_page" : "other",
            confidence: "high",
          }),
        );
      },
      doStream: [mockTextStream("should not reply as gate")],
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
        gateModel: "mock-gate",
        languageModel: streamModel,
        gateLanguageModel: gateModel,
      },
    });
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "Second turn still routes",
    });
    const first = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(conversation.id, "show last 3 orders"),
    });
    expect(first.status).toBe(200);
    await readUiMessageSsePayloads(first);
    await waitFor(async () => {
      const runs = await kit.db.runtime.db.select().from(assistantToolRuns);
      return runs.some(
        (run) =>
          run.conversationId === conversation.id &&
          run.actionName === "orders.list" &&
          run.outcome === "success",
      );
    }, "orders.list before second-turn routing");
    expect(gateModel.doGenerateCalls).toHaveLength(1);
    expect(streamToolNames(streamModel)).toEqual([ORDERS_LIST_PAGE_TOOL_NAME]);

    const followUp = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(conversation.id, "Продовжуй"),
    });
    expect(followUp.status).toBe(200);
    const payloads = await readUiMessageSsePayloads(followUp);
    expect(JSON.stringify(payloads)).toContain("Creating the price list.");
    expect(gateModel.doGenerateCalls).toHaveLength(2);
    expect(gateModel.doStreamCalls).toHaveLength(0);
    expect(streamToolNames(streamModel)).toContain(
      STAFF_ASSISTANT_TOOL_SEARCH_NAME,
    );
    expect(
      capturing
        .entries()
        .some((entry) => entry["gate_skip"] === "sticky_session"),
    ).toBe(false);
    const followUpUsage = capturing
      .entries()
      .filter((entry) => entry["msg"] === "staff assistant turn usage")
      .at(-1);
    expect(followUpUsage?.["gate_skip"]).toBeUndefined();
    expect(followUpUsage?.["tools_attached"]).toBe(true);
    expect(JSON.stringify(followUpUsage)).not.toContain("Продовжуй");
  });

  it("routes weather as chitchat after a tool-using turn", async () => {
    const streamModel = new MockLanguageModelV3({
      doStream: [
        mockToolCallStream("call-list", ORDERS_LIST_PAGE_TOOL_NAME, "{}"),
        mockTextStream("You have no orders."),
      ],
    });
    let gateCalls = 0;
    const gateModel = new MockLanguageModelV3({
      doGenerate: () => {
        gateCalls += 1;
        return Promise.resolve(
          mockStaffAssistantGateGenerate(
            gateCalls === 1
              ? {
                  mode: "job",
                  intent: "orders_page",
                  confidence: "high",
                }
              : { mode: "chitchat", confidence: "high" },
          ),
        );
      },
      doStream: [mockTextStream("I only help with this company.")],
    });
    const app = chatApp(streamModel, gateModel);
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "Weather after tools",
    });
    const first = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(conversation.id, "show last 3 orders"),
    });
    expect(first.status).toBe(200);
    await readUiMessageSsePayloads(first);
    await waitFor(async () => {
      const runs = await kit.db.runtime.db.select().from(assistantToolRuns);
      return runs.some(
        (run) =>
          run.conversationId === conversation.id &&
          run.actionName === "orders.list" &&
          run.outcome === "success",
      );
    }, "orders.list before weather");

    const weather = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(conversation.id, "What's the weather in Kyiv?"),
    });
    expect(weather.status).toBe(200);
    const payloads = await readUiMessageSsePayloads(weather);
    expect(JSON.stringify(payloads)).toContain(
      "I only help with this company.",
    );
    expect(gateModel.doGenerateCalls).toHaveLength(2);
    expect(gateModel.doStreamCalls).toHaveLength(1);
    expect(streamToolsLength(gateModel)).toBe(0);
    expect(streamModel.doStreamCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("still classifies a short ack when the conversation has no tool runs", async () => {
    const streamModel = new MockLanguageModelV3({
      doStream: [mockTextStream("should not run")],
    });
    const gateModel = new MockLanguageModelV3({
      doGenerate: mockOperationalGateGenerate(false),
      doStream: [mockTextStream("I only help with this company.")],
    });
    const app = chatApp(streamModel, gateModel);
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "Ack without tools",
    });
    const response = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(conversation.id, "так"),
    });
    expect(response.status).toBe(200);
    const payloads = await readUiMessageSsePayloads(response);
    expect(JSON.stringify(payloads)).toContain(
      "I only help with this company.",
    );
    expect(streamModel.doStreamCalls).toHaveLength(0);
    expect(gateModel.doGenerateCalls).toHaveLength(1);
    expect(streamToolsLength(gateModel)).toBe(0);
  });
});

describe("SHO-418 orders_create choice activation", () => {
  async function postChoice(
    app: ReturnType<typeof createApp>,
    options: {
      readonly token: string;
      readonly companyId: string;
      readonly body: unknown;
    },
  ): Promise<Response> {
    const headers = new Headers({
      "content-type": "application/json",
      origin: "http://localhost:3000",
      authorization: `Bearer ${options.token}`,
      [COMPANY_SELECTOR_HEADER]: options.companyId,
    });
    return app.request(ASSISTANT_CHOICE_PATH, {
      method: "POST",
      headers,
      body: JSON.stringify(options.body),
    });
  }

  async function seedVariableProduct(
    name: string,
    variantNames: readonly string[],
  ) {
    return staffInvoke(createProduct, {
      name,
      basePriceMinor: "1500",
      variants: variantNames.map((variantName) => ({ name: variantName })),
    });
  }

  const sixFlavours = [
    "Lemon",
    "Vanilla",
    "Raspberry",
    "Pistachio",
    "Chocolate",
    "Rose",
  ] as const;

  it("omits variantQuery → needs_choice with six active options and no parent", async () => {
    const store = createMemoryChoiceStore();
    const open = vi.spyOn(store, "open");
    await staffInvoke(createCustomer, {
      name: "T8b Six Buyer",
      phone: "+380671110041",
    });
    await seedVariableProduct("T8b Six Flavours", sixFlavours);
    const streamModel = new MockLanguageModelV3({
      doStream: [
        mockToolCallStream(
          "call-create-six",
          ORDERS_CREATE_TOOL_NAME,
          JSON.stringify({
            customerQuery: "T8b Six Buyer",
            items: [{ productQuery: "T8b Six Flavours", quantityDecimal: "1" }],
          }),
        ),
        mockSpokenStream("MODEL_SHOULD_NOT_PERSIST"),
      ],
    });
    const app = chatApp(streamModel, undefined, store);
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "T8b six",
    });
    const response = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(
        conversation.id,
        "Create an order of T8b Six Flavours",
        randomUUID(),
        "en",
      ),
    });
    expect(response.status).toBe(200);
    const payloads = await readUiMessageSsePayloads(response);
    const choice = choiceFromSsePayloads(payloads);
    expect(choice).toBeDefined();
    expect(choice?.options).toHaveLength(6);
    expect(choice?.options.map((option) => option.label)).toEqual(
      expect.arrayContaining([...sixFlavours]),
    );
    expect(
      choice?.options.some((option) => option.label === "T8b Six Flavours"),
    ).toBe(false);
    expect(JSON.stringify(choice)).not.toContain("canonicalInput");
    expect(open).toHaveBeenCalledOnce();
    const body = await waitForAssistantBody(conversation.id);
    expect(body).toContain("T8b Six Flavours");
    for (const flavour of sixFlavours) {
      expect(body).toContain(flavour);
    }
    const runs = (
      await kit.db.runtime.db.select().from(assistantToolRuns)
    ).filter((run) => run.conversationId === conversation.id);
    expect(runs[0]?.outcome).toBe("choice_required");
    expect(runs[0]?.challengeId).toBe(choice?.challengeId);
  });

  it("unique variantQuery Lemon creates without writing a choice record", async () => {
    const store = createMemoryChoiceStore();
    const open = vi.spyOn(store, "open");
    const customer = await staffInvoke(createCustomer, {
      name: "T8b Lemon Buyer",
      phone: "+380671110042",
    });
    await seedVariableProduct("T8b Lemon Unique", ["Lemon", "Vanilla"]);
    const streamModel = new MockLanguageModelV3({
      doStream: [
        mockToolCallStream(
          "call-create-lemon",
          ORDERS_CREATE_TOOL_NAME,
          JSON.stringify({
            customerQuery: "T8b Lemon Buyer",
            items: [
              {
                productQuery: "T8b Lemon Unique",
                variantQuery: "Lemon",
                quantityDecimal: "1",
              },
            ],
          }),
        ),
        mockSpokenStream("Order created."),
      ],
    });
    const app = chatApp(streamModel, undefined, store);
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "T8b lemon",
    });
    const response = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(conversation.id, "Create lemon macarons"),
    });
    expect(response.status).toBe(200);
    const payloads = await readUiMessageSsePayloads(response);
    expect(choiceFromSsePayloads(payloads)).toBeUndefined();
    expect(open).not.toHaveBeenCalled();
    await waitFor(async () => {
      const rows = await kit.db.runtime.db.select().from(orders);
      return rows.some((row) => row.customerId === customer.id);
    }, "unique lemon create");
  });

  it("no_active_variants is an unavailable error, not a ChoiceCard", async () => {
    const store = createMemoryChoiceStore();
    const customer = await staffInvoke(createCustomer, {
      name: "T8b Archived Buyer",
      phone: "+380671110043",
    });
    const product = await seedVariableProduct("T8b Archived Only", ["One"]);
    const variantId = product.variants[0]?.variantId;
    expect(variantId).toBeDefined();
    if (variantId !== undefined) {
      await staffInvoke(archiveVariant, { variantId });
    }
    const streamModel = new MockLanguageModelV3({
      doStream: [
        mockToolCallStream(
          "call-create-archived",
          ORDERS_CREATE_TOOL_NAME,
          JSON.stringify({
            customerQuery: "T8b Archived Buyer",
            items: [
              { productQuery: "T8b Archived Only", quantityDecimal: "1" },
            ],
          }),
        ),
        mockSpokenStream("should not present a card"),
      ],
    });
    const app = chatApp(streamModel, undefined, store);
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "T8b archived",
    });
    const response = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(conversation.id, "Create archived only"),
    });
    expect(response.status).toBe(200);
    const payloads = await readUiMessageSsePayloads(response);
    expect(choiceFromSsePayloads(payloads)).toBeUndefined();
    expect(JSON.stringify(payloads)).not.toContain("needs_choice");
    expect(JSON.stringify(payloads)).not.toContain("data-choice");
    const expected = presentCatalogDomainError({
      locale: "uk",
      extras: {
        reason: "no_active_variants",
        subject: { kind: "product_name", name: product.name },
      },
    });
    expect(sseVisibleTextFromPayloads(payloads)).toBe(expected);
    expect(JSON.stringify(payloads)).not.toContain("should not present a card");
    expect(await waitForAssistantBody(conversation.id)).toBe(expected);
    const companyOrders = (
      await kit.db.runtime.db.select().from(orders)
    ).filter((row) => row.customerId === customer.id);
    expect(companyOrders).toHaveLength(0);
  });

  it("unmatched_query and ambiguous return needs_choice with catalog options", async () => {
    const cases = [
      {
        phone: "+380671110044",
        name: "T8b Unmatched Buyer",
        product: "T8b Unmatched Coat",
        query: "Pistachio",
        variants: ["Blue", "Red"] as const,
      },
      {
        phone: "+380671110045",
        name: "T8b Ambiguous Buyer",
        product: "T8b Ambiguous Coat",
        query: "e",
        variants: ["Blue", "Red"] as const,
      },
    ];
    for (const fixture of cases) {
      const customer = await staffInvoke(createCustomer, {
        name: fixture.name,
        phone: fixture.phone,
      });
      await seedVariableProduct(fixture.product, fixture.variants);
      const streamModel = new MockLanguageModelV3({
        doStream: [
          mockToolCallStream(
            `call-create-${fixture.query}`,
            ORDERS_CREATE_TOOL_NAME,
            JSON.stringify({
              customerQuery: fixture.name,
              items: [
                {
                  productQuery: fixture.product,
                  variantQuery: fixture.query,
                  quantityDecimal: "1",
                },
              ],
            }),
          ),
        ],
      });
      const store = createMemoryChoiceStore();
      const app = chatApp(streamModel, undefined, store);
      const token = await insertBearer(kit, kitIdentities.users.anna);
      const conversation = await staffInvoke(createConversation, {
        title: fixture.name,
      });
      const response = await postChat(app, {
        token,
        companyId: kitIdentities.companies.a,
        body: userChatBody(conversation.id, `Create ${fixture.product}`),
      });
      expect(response.status).toBe(200);
      const payloads = await readUiMessageSsePayloads(response);
      const choice = choiceFromSsePayloads(payloads);
      expect(choice?.options.map((option) => option.label)).toEqual(
        expect.arrayContaining(["Blue", "Red"]),
      );
      expect(choice?.options).toHaveLength(2);
      const companyOrders = (
        await kit.db.runtime.db.select().from(orders)
      ).filter((row) => row.customerId === customer.id);
      expect(companyOrders).toHaveLength(0);
    }
  });

  it("two unresolved lines produce sequential choices and create only after both taps without an LLM", async () => {
    const store = createMemoryChoiceStore();
    const customer = await staffInvoke(createCustomer, {
      name: "T8b Seq Buyer",
      phone: "+380671110046",
    });
    await seedVariableProduct("T8b Seq Macarons", ["Lemon", "Vanilla"]);
    await seedVariableProduct("T8b Seq Eclairs", ["Coffee", "Chocolate"]);
    const streamModel = new MockLanguageModelV3({
      doStream: [
        mockToolCallStream(
          "call-create-seq",
          ORDERS_CREATE_TOOL_NAME,
          JSON.stringify({
            customerQuery: "T8b Seq Buyer",
            items: [
              { productQuery: "T8b Seq Macarons", quantityDecimal: "1" },
              { productQuery: "T8b Seq Eclairs", quantityDecimal: "1" },
            ],
          }),
        ),
      ],
    });
    const app = chatApp(streamModel, undefined, store);
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "T8b sequential",
    });
    const streamSpy = vi.spyOn(ShowzyAi, "streamStaffAssistantChat");
    const chatResponse = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(conversation.id, "Create both lines"),
    });
    expect(chatResponse.status).toBe(200);
    const firstChoice = choiceFromSsePayloads(
      await readUiMessageSsePayloads(chatResponse),
    );
    expect(firstChoice?.productName).toBe("T8b Seq Macarons");
    const streamCallsAfterChat = streamSpy.mock.calls.length;
    const lemon = firstChoice?.options.find(
      (option) => option.label === "Lemon",
    );
    expect(lemon).toBeDefined();
    const firstTap = await postChoice(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: {
        conversationId: conversation.id,
        choiceId: firstChoice?.challengeId,
        optionId: lemon?.id,
      },
    });
    expect(firstTap.status).toBe(200);
    const firstBody = assistantChoiceInteractionResultSchema.parse(
      await firstTap.json(),
    );
    expect(firstBody.status).toBe("needs_choice");
    expect(streamSpy.mock.calls.length).toBe(streamCallsAfterChat);
    const afterFirst = (await kit.db.runtime.db.select().from(orders)).filter(
      (row) => row.customerId === customer.id,
    );
    expect(afterFirst).toHaveLength(0);
    if (firstBody.status !== "needs_choice") {
      return;
    }
    expect(firstBody.text).toBe(
      presentChoiceStaffAssistantTurn({
        locale: "uk",
        toolResults: [
          {
            toolName: ORDERS_CREATE_TOOL_NAME,
            output: {
              status: "needs_choice",
              challengeId: firstBody.challengeId,
              reason: firstBody.reason,
              productName: firstBody.productName,
              options: firstBody.options,
              optionsTruncated: firstBody.optionsTruncated,
            },
          },
        ],
      }),
    );
    expect(firstBody.text).toContain("T8b Seq Eclairs");
    const sequentialPersisted = (
      await kit.db.runtime.db.select().from(assistantMessages)
    ).filter(
      (row) =>
        row.conversationId === conversation.id && row.role === "assistant",
    );
    const successorTurn = sequentialPersisted.find(
      (row) => row.body === firstBody.text,
    );
    expect(successorTurn?.body).toBe(firstBody.text);
    const coffee = firstBody.options.find(
      (option) => option.label === "Coffee",
    );
    const secondTap = await postChoice(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: {
        conversationId: conversation.id,
        choiceId: firstBody.challengeId,
        optionId: coffee?.id,
      },
    });
    expect(secondTap.status).toBe(200);
    const secondBody = assistantChoiceInteractionResultSchema.parse(
      await secondTap.json(),
    );
    expect(secondBody.status).toBe("completed");
    expect(streamSpy.mock.calls.length).toBe(streamCallsAfterChat);
    const created = (await kit.db.runtime.db.select().from(orders)).filter(
      (row) => row.customerId === customer.id,
    );
    expect(created).toHaveLength(1);
    streamSpy.mockRestore();
  });
});

describe("SHO-442 presenter-owned archived / no_active_variants chat turns", () => {
  async function seedSimpleProduct(name: string) {
    return staffInvoke(createProduct, {
      name,
      basePriceMinor: "1500",
    });
  }

  it("preserves catalog archived extras through orders.create into the presenter", async () => {
    const customer = await staffInvoke(createCustomer, {
      name: "T442 Adapter Buyer",
      phone: "+380671442001",
    });
    const product = await seedSimpleProduct("T442 Adapter Cupcake");
    await staffInvoke(archiveProduct, { productId: product.productId });
    const caught = await staffInvoke(createOrder, {
      customer: { by: "id", id: customer.id },
      items: [
        {
          product: { by: "query", value: "T442 Adapter Cupcake" },
          variantSelection: { kind: "unspecified" },
          quantity: { milli: "1000" },
        },
      ],
    }).then(
      () => {
        throw new Error("expected ReferenceResolutionConflictError");
      },
      (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(ReferenceResolutionConflictError);
    const extras = catalogDomainErrorExtrasFromError(caught);
    expect(extras).toEqual({
      reason: "archived",
      subject: { kind: "product_name", name: "T442 Adapter Cupcake" },
    });
    if (extras === undefined) {
      return;
    }
    expect(
      presentCatalogDomainError({
        locale: "en",
        extras,
      }),
    ).not.toBe(
      caught instanceof ReferenceResolutionConflictError
        ? caught.clientMessage
        : "",
    );
  });

  it("persists and streams presenter copy for a unique archived product in uk and en", async () => {
    const spoken = "MODEL_SPOKEN_SHOULD_NOT_FLASH";
    for (const locale of ["uk", "en"] as const) {
      const customer = await staffInvoke(createCustomer, {
        name: `T442 Unique Buyer ${locale}`,
        phone: locale === "uk" ? "+380671442002" : "+380671442003",
      });
      const product = await seedSimpleProduct(`T442 Unique Cake ${locale}`);
      await staffInvoke(archiveProduct, { productId: product.productId });
      const streamModel = new MockLanguageModelV3({
        doStream: [
          mockToolCallStream(
            `call-create-archived-${locale}`,
            ORDERS_CREATE_TOOL_NAME,
            JSON.stringify({
              customerQuery: customer.name,
              items: [
                {
                  productQuery: product.name,
                  quantityDecimal: "1",
                },
              ],
            }),
          ),
          mockSpokenStream(spoken),
        ],
      });
      const app = chatApp(streamModel, undefined, createMemoryChoiceStore());
      const token = await insertBearer(kit, kitIdentities.users.anna);
      const conversation = await staffInvoke(createConversation, {
        title: `T442 unique ${locale}`,
      });
      const response = await postChat(app, {
        token,
        companyId: kitIdentities.companies.a,
        body: userChatBody(
          conversation.id,
          `Create ${product.name}`,
          randomUUID(),
          locale,
        ),
      });
      expect(response.status).toBe(200);
      const payloads = await readUiMessageSsePayloads(response);
      const expected = presentCatalogDomainError({
        locale,
        extras: {
          reason: "archived",
          subject: { kind: "product_name", name: product.name },
        },
      });
      expect(choiceFromSsePayloads(payloads)).toBeUndefined();
      expect(JSON.stringify(payloads)).not.toContain("data-choice");
      expect(JSON.stringify(payloads)).not.toContain("needs_choice");
      expect(JSON.stringify(payloads)).not.toContain(spoken);
      expect(sseVisibleTextFromPayloads(payloads)).toBe(expected);
      expect(await waitForAssistantBody(conversation.id)).toBe(expected);
      const companyOrders = (
        await kit.db.runtime.db.select().from(orders)
      ).filter((row) => row.customerId === customer.id);
      expect(companyOrders).toHaveLength(0);
    }
  });

  it("uses query wording when several archived products match", async () => {
    const spoken = "MODEL_SPOKEN_SHOULD_NOT_FLASH";
    const query = "T442 TwinArchive";
    const customer = await staffInvoke(createCustomer, {
      name: "T442 Twin Buyer",
      phone: "+380671442004",
    });
    const first = await seedSimpleProduct(`${query} One`);
    const second = await seedSimpleProduct(`${query} Two`);
    await staffInvoke(archiveProduct, { productId: first.productId });
    await staffInvoke(archiveProduct, { productId: second.productId });
    for (const locale of ["uk", "en"] as const) {
      const streamModel = new MockLanguageModelV3({
        doStream: [
          mockToolCallStream(
            `call-create-twins-${locale}`,
            ORDERS_CREATE_TOOL_NAME,
            JSON.stringify({
              customerQuery: "T442 Twin Buyer",
              items: [{ productQuery: query, quantityDecimal: "1" }],
            }),
          ),
          mockSpokenStream(spoken),
        ],
      });
      const app = chatApp(streamModel, undefined, createMemoryChoiceStore());
      const token = await insertBearer(kit, kitIdentities.users.anna);
      const conversation = await staffInvoke(createConversation, {
        title: `T442 twins ${locale}`,
      });
      const response = await postChat(app, {
        token,
        companyId: kitIdentities.companies.a,
        body: userChatBody(
          conversation.id,
          `Create ${query}`,
          randomUUID(),
          locale,
        ),
      });
      expect(response.status).toBe(200);
      const payloads = await readUiMessageSsePayloads(response);
      const expected = presentCatalogDomainError({
        locale,
        extras: {
          reason: "archived",
          subject: { kind: "query", query },
        },
      });
      expect(sseVisibleTextFromPayloads(payloads)).toBe(expected);
      expect(expected).toContain(query);
      expect(expected).not.toContain(`${query} One`);
      expect(await waitForAssistantBody(conversation.id)).toBe(expected);
      expect(JSON.stringify(payloads)).not.toContain(spoken);
      expect(JSON.stringify(payloads)).not.toContain("data-choice");
    }
  });

  it("persists and streams presenter copy for no_active_variants in uk and en", async () => {
    const spoken = "MODEL_SPOKEN_SHOULD_NOT_FLASH";
    for (const locale of ["uk", "en"] as const) {
      const customer = await staffInvoke(createCustomer, {
        name: `T442 Variants Buyer ${locale}`,
        phone: locale === "uk" ? "+380671442006" : "+380671442007",
      });
      const product = await staffInvoke(createProduct, {
        name: `T442 Variants Cake ${locale}`,
        basePriceMinor: "1500",
        variants: [{ name: "One" }],
      });
      const variantId = product.variants[0]?.variantId;
      expect(variantId).toBeDefined();
      if (variantId !== undefined) {
        await staffInvoke(archiveVariant, { variantId });
      }
      const streamModel = new MockLanguageModelV3({
        doStream: [
          mockToolCallStream(
            `call-create-variants-${locale}`,
            ORDERS_CREATE_TOOL_NAME,
            JSON.stringify({
              customerQuery: customer.name,
              items: [
                {
                  productQuery: product.name,
                  quantityDecimal: "1",
                },
              ],
            }),
          ),
          mockSpokenStream(spoken),
        ],
      });
      const app = chatApp(streamModel, undefined, createMemoryChoiceStore());
      const token = await insertBearer(kit, kitIdentities.users.anna);
      const conversation = await staffInvoke(createConversation, {
        title: `T442 variants ${locale}`,
      });
      const response = await postChat(app, {
        token,
        companyId: kitIdentities.companies.a,
        body: userChatBody(
          conversation.id,
          `Create ${product.name}`,
          randomUUID(),
          locale,
        ),
      });
      expect(response.status).toBe(200);
      const payloads = await readUiMessageSsePayloads(response);
      const expected = presentCatalogDomainError({
        locale,
        extras: {
          reason: "no_active_variants",
          subject: { kind: "product_name", name: product.name },
        },
      });
      expect(choiceFromSsePayloads(payloads)).toBeUndefined();
      expect(JSON.stringify(payloads)).not.toContain("data-choice");
      expect(JSON.stringify(payloads)).not.toContain("needs_choice");
      expect(JSON.stringify(payloads)).not.toContain(spoken);
      expect(sseVisibleTextFromPayloads(payloads)).toBe(expected);
      expect(await waitForAssistantBody(conversation.id)).toBe(expected);
      const companyOrders = (
        await kit.db.runtime.db.select().from(orders)
      ).filter((row) => row.customerId === customer.id);
      expect(companyOrders).toHaveLength(0);
    }
  });

  it("keeps SHO-429 model spoken for unrelated CONFLICT and NOT_FOUND", async () => {
    const spoken = "That name is not a product in this company.";
    const customer = await staffInvoke(createCustomer, {
      name: "T442 Generic Buyer",
      phone: "+380671442005",
    });
    const streamModel = new MockLanguageModelV3({
      doStream: [
        mockToolCallStream(
          "call-create-missing",
          ORDERS_CREATE_TOOL_NAME,
          JSON.stringify({
            customerQuery: "T442 Generic Buyer",
            items: [
              { productQuery: "xyzzy-t442-missing", quantityDecimal: "1" },
            ],
          }),
        ),
        mockSpokenStream(spoken),
      ],
    });
    const app = chatApp(streamModel);
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "T442 generic not found",
    });
    const response = await postChat(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: userChatBody(conversation.id, "Create xyzzy", randomUUID(), "en"),
    });
    expect(response.status).toBe(200);
    const payloads = await readUiMessageSsePayloads(response);
    expect(sseVisibleTextFromPayloads(payloads)).toBe(spoken);
    expect(await waitForAssistantBody(conversation.id)).toBe(spoken);
    const companyOrders = (
      await kit.db.runtime.db.select().from(orders)
    ).filter((row) => row.customerId === customer.id);
    expect(companyOrders).toHaveLength(0);
  });
});
