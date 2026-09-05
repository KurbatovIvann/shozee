/**
 * SHO-409: choice resume seeds the store directly (no user-turn façade).
 * No assistant runtime — if this path constructed the chat loop it would
 * 503 AI_NOT_CONFIGURED. No live LLM.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as ShowzyAi from "@showzy/ai";
import {
  applyChoiceOptionToCanonicalInput,
  assistantChoiceInteractionResultSchema,
  attemptKey,
  CHOICE_OPTIONS_MAX,
  CHOICE_TRUNCATED_COPY,
  presentCatalogDomainError,
  presentChoiceStaffAssistantNeedsChoice,
  presentChoiceStaffAssistantTurn,
  staffAssistantChoiceCardEnvelopeSchema,
  successorChoiceId,
  type ChoiceCanonicalCreateInput,
  type ChoiceRecord,
} from "@showzy/ai";
import { createConversation, recordAssistantTurn } from "@showzy/assistant";
import { archiveProduct, archiveVariant, createProduct } from "@showzy/catalog";
import { COMPANY_SELECTOR_HEADER, contractModules } from "@showzy/contract";
import * as ShowzyCore from "@showzy/core";
import {
  createConfirmationHook,
  createInMemoryConfirmationStore,
  createInMemoryRateLimitStore,
  executeAction,
  type ImplementedAction,
} from "@showzy/core";
import { CoreInvariantError } from "@showzy/core/errors";
import {
  createTestKit,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import { createCustomer } from "@showzy/customers";
import { auditLog, idempotencyKeys } from "@showzy/db";
import { session, user } from "@showzy/db/schema/auth";
import {
  assistantMessages,
  assistantToolRuns,
} from "@showzy/db/schema/assistant";
import { companyMembers } from "@showzy/db/schema/companies";
import { orders } from "@showzy/db/schema/orders";
import { createOrder } from "@showzy/orders";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { z } from "zod";

import { buildAuthOptions } from "../auth/options.js";
import { createAtomicOtpSendStore } from "../auth/otp-send-guard.js";
import { createActionRegistry } from "../composition.js";
import {
  createMemoryAuthRateLimitStore,
  createMemorySecondaryStorage,
} from "../stores/memory.js";
import { createMemoryChoiceStore } from "../stores/choice.js";
import { createApp, type AuthInstance } from "./app.js";
import {
  ASSISTANT_CHAT_PATH,
  ASSISTANT_INVOCATION_CHANNEL,
} from "./assistant-chat.js";
import { ASSISTANT_CHOICE_PATH } from "./assistant-choice.js";
import { REQUEST_ID_HEADER } from "./request-id.js";

const REAL_CLIENT = "203.0.113.51";
const here = dirname(fileURLToPath(import.meta.url));

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

let kit: TestKit;
let auth: AuthInstance;
let registry: ReturnType<typeof createActionRegistry>;
let pipeline: TestKit["pipeline"];
let phoneSeq = 0;

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

function choiceApp(store = createMemoryChoiceStore()) {
  return {
    store,
    app: createApp({
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
      choiceStore: store,
    }),
  };
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

function nextPhone(): string {
  phoneSeq += 1;
  return `+3806794${String(phoneSeq).padStart(5, "0")}`;
}

async function postChoice(
  app: ReturnType<typeof createApp>,
  options: {
    readonly token: string;
    readonly companyId: string;
    readonly body: unknown;
    readonly requestId?: string;
  },
): Promise<Response> {
  const headers = new Headers({
    "content-type": "application/json",
    origin: "http://localhost:3000",
    authorization: `Bearer ${options.token}`,
    [COMPANY_SELECTOR_HEADER]: options.companyId,
  });
  if (options.requestId !== undefined) {
    headers.set(REQUEST_ID_HEADER, options.requestId);
  }
  return app.request(ASSISTANT_CHOICE_PATH, {
    method: "POST",
    headers,
    body: JSON.stringify(options.body),
  });
}

async function peekChoice(
  app: ReturnType<typeof createApp>,
  options: {
    readonly token: string;
    readonly companyId: string;
    readonly conversationId: string;
    readonly choiceId: string;
  },
): Promise<Response> {
  const headers = new Headers({
    origin: "http://localhost:3000",
    authorization: `Bearer ${options.token}`,
    [COMPANY_SELECTOR_HEADER]: options.companyId,
  });
  const url = `${ASSISTANT_CHOICE_PATH}/${options.choiceId}?conversationId=${options.conversationId}`;
  return app.request(url, { method: "GET", headers });
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

async function seedSimpleProduct(name: string) {
  return staffInvoke(createProduct, {
    name,
    basePriceMinor: "1500",
  });
}

function canonicalFor(
  customerId: string,
  products: readonly (
    { readonly productId: string } | { readonly query: string }
  )[],
): ChoiceCanonicalCreateInput {
  return {
    customer: { by: "id", id: customerId },
    items: products.map((product) => ({
      product:
        "query" in product
          ? { by: "query" as const, value: product.query }
          : { by: "id" as const, id: product.productId },
      variantSelection: { kind: "unspecified" as const },
      quantity: { milli: "1000" },
    })),
  };
}

async function openChoice(options: {
  readonly store: ReturnType<typeof createMemoryChoiceStore>;
  readonly conversationId: string;
  readonly customerId: string;
  readonly product: {
    readonly productId: string;
    readonly name: string;
    readonly variants: readonly {
      readonly variantId: string;
      readonly name: string;
    }[];
  };
  readonly extraProducts?: readonly (
    { readonly productId: string } | { readonly query: string }
  )[];
  readonly extraLineItems?: ChoiceCanonicalCreateInput["items"];
  readonly lineIndex?: number;
  readonly actorId?: string;
  readonly companyId?: string;
  readonly locale?: "uk" | "en";
}): Promise<{
  record: ChoiceRecord;
  optionByLabel: Map<string, string>;
}> {
  const choiceId = randomUUID();
  const lineIndex = options.lineIndex ?? 0;
  const optionByLabel = new Map<string, string>();
  const optionMap: Record<string, string> = {};
  const envelopeOptions = options.product.variants.map((variant) => {
    const optionId = randomUUID();
    optionByLabel.set(variant.name, optionId);
    optionMap[optionId] = variant.variantId;
    return { id: optionId, label: variant.name };
  });
  const extras = options.extraProducts ?? [];
  const products: Array<{ productId: string } | { query: string }> = [
    ...extras.slice(0, lineIndex),
    { productId: options.product.productId },
    ...extras.slice(lineIndex),
  ];
  const pickerItem: ChoiceCanonicalCreateInput["items"][number] = {
    product: { by: "id", id: options.product.productId },
    variantSelection: { kind: "unspecified" },
    quantity: { milli: "1000" },
  };
  const canonicalInput =
    options.extraLineItems !== undefined
      ? {
          customer: { by: "id" as const, id: options.customerId },
          items: [
            ...options.extraLineItems.slice(0, lineIndex),
            pickerItem,
            ...options.extraLineItems.slice(lineIndex),
          ],
        }
      : canonicalFor(options.customerId, products);
  const record: ChoiceRecord = {
    status: "open",
    choiceId,
    actorId: options.actorId ?? kitIdentities.users.anna,
    companyId: options.companyId ?? kitIdentities.companies.a,
    conversationId: options.conversationId,
    canonicalInput,
    target: {
      lineIndex,
      productId: options.product.productId,
      productName: options.product.name,
    },
    optionMap,
    envelope: {
      status: "needs_choice",
      challengeId: choiceId,
      reason: "variant_required",
      productName: options.product.name,
      options: envelopeOptions,
      optionsTruncated: false,
    },
    locale: options.locale ?? "uk",
  };
  expect(await options.store.open(record)).toBe(true);
  return { record, optionByLabel };
}

async function openProductChoice(options: {
  readonly store: ReturnType<typeof createMemoryChoiceStore>;
  readonly conversationId: string;
  readonly customerId: string;
  readonly query: string;
  readonly catalogOptions: readonly {
    readonly productId: string;
    readonly label: string;
  }[];
  readonly locale?: "uk" | "en";
}): Promise<{
  record: ChoiceRecord;
  optionByLabel: Map<string, string>;
}> {
  const choiceId = randomUUID();
  const optionByLabel = new Map<string, string>();
  const optionMap: Record<string, string> = {};
  const envelopeOptions = options.catalogOptions.map((option) => {
    const optionId = randomUUID();
    optionByLabel.set(option.label, optionId);
    optionMap[optionId] = option.productId;
    return { id: optionId, label: option.label };
  });
  const record: ChoiceRecord = {
    status: "open",
    choiceId,
    actorId: kitIdentities.users.anna,
    companyId: kitIdentities.companies.a,
    conversationId: options.conversationId,
    canonicalInput: {
      customer: { by: "id", id: options.customerId },
      items: [
        {
          product: { by: "query", value: options.query },
          variantSelection: { kind: "unspecified" },
          quantity: { milli: "1000" },
        },
      ],
    },
    target: {
      kind: "order_line_product",
      lineIndex: 0,
      query: options.query,
    },
    optionMap,
    envelope: {
      status: "needs_choice",
      challengeId: choiceId,
      reason: "ambiguous",
      choiceKind: "product",
      productName: options.query,
      options: envelopeOptions,
      optionsTruncated: false,
    },
    locale: options.locale ?? "uk",
  };
  expect(await options.store.open(record)).toBe(true);
  return { record, optionByLabel };
}

async function openCustomerChoice(options: {
  readonly store: ReturnType<typeof createMemoryChoiceStore>;
  readonly conversationId: string;
  readonly query: string;
  readonly productId: string;
  readonly catalogOptions: readonly {
    readonly customerId: string;
    readonly label: string;
  }[];
  readonly locale?: "uk" | "en";
}): Promise<{
  record: ChoiceRecord;
  optionByLabel: Map<string, string>;
}> {
  const choiceId = randomUUID();
  const optionByLabel = new Map<string, string>();
  const optionMap: Record<string, string> = {};
  const envelopeOptions = options.catalogOptions.map((option) => {
    const optionId = randomUUID();
    optionByLabel.set(option.label, optionId);
    optionMap[optionId] = option.customerId;
    return { id: optionId, label: option.label };
  });
  const record: ChoiceRecord = {
    status: "open",
    choiceId,
    actorId: kitIdentities.users.anna,
    companyId: kitIdentities.companies.a,
    conversationId: options.conversationId,
    canonicalInput: {
      customer: { by: "query", value: options.query },
      items: [
        {
          product: { by: "id", id: options.productId },
          variantSelection: { kind: "unspecified" },
          quantity: { milli: "1000" },
        },
      ],
    },
    target: { kind: "customer", query: options.query },
    optionMap,
    envelope: {
      status: "needs_choice",
      challengeId: choiceId,
      reason: "ambiguous",
      choiceKind: "customer",
      productName: options.query,
      options: envelopeOptions,
      optionsTruncated: false,
    },
    locale: options.locale ?? "uk",
  };
  expect(await options.store.open(record)).toBe(true);
  return { record, optionByLabel };
}

describe("POST /assistant/choice (seeded store)", () => {
  it("completes without constructing the gate or reply models", async () => {
    const classify = vi.spyOn(ShowzyAi, "classifyStaffAssistantTurn");
    const stream = vi.spyOn(ShowzyAi, "streamStaffAssistantChat");
    const { app, store } = choiceApp();
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "Choice complete",
    });
    const customer = await staffInvoke(createCustomer, {
      name: "Choice Buyer",
      phone: nextPhone(),
    });
    const product = await seedVariableProduct("Macarons Choice", [
      "Lemon",
      "Vanilla",
    ]);
    const lemon = product.variants.find((variant) => variant.name === "Lemon");
    expect(lemon).toBeDefined();
    const { record, optionByLabel } = await openChoice({
      store,
      conversationId: conversation.id,
      customerId: customer.id,
      product,
    });
    const optionId = optionByLabel.get("Lemon");
    expect(optionId).toBeDefined();
    const requestId = randomUUID();
    const response = await postChoice(app, {
      token,
      companyId: kitIdentities.companies.a,
      requestId,
      body: {
        conversationId: conversation.id,
        choiceId: record.choiceId,
        optionId,
      },
    });
    expect(response.status).toBe(200);
    const body = assistantChoiceInteractionResultSchema.parse(
      await response.json(),
    );
    expect(body.status).toBe("completed");
    if (body.status !== "completed") {
      return;
    }
    expect(body.text.length).toBeGreaterThan(0);
    expect(body.entity.orderNumber.length).toBeGreaterThan(0);
    expect(body.text).toContain(body.entity.orderNumber);
    expect(body.text.startsWith("Замовлення")).toBe(true);

    const chatProbe = await app.request(ASSISTANT_CHAT_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        [COMPANY_SELECTOR_HEADER]: kitIdentities.companies.a,
      },
      body: JSON.stringify({
        conversationId: conversation.id,
        messages: [
          {
            id: randomUUID(),
            role: "user",
            parts: [{ type: "text", text: "hi" }],
          },
        ],
      }),
    });
    expect(chatProbe.status).toBe(503);
    expect(await chatProbe.json()).toMatchObject({ code: "AI_NOT_CONFIGURED" });

    expect(classify).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
    classify.mockRestore();
    stream.mockRestore();

    const messages = (
      await kit.db.runtime.db.select().from(assistantMessages)
    ).filter((row) => row.conversationId === conversation.id);
    const assistant = messages.find((row) => row.role === "assistant");
    expect(assistant?.body).toBe(body.text);
    const runs = (
      await kit.db.runtime.db.select().from(assistantToolRuns)
    ).filter((row) => row.conversationId === conversation.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      actionName: "orders.create",
      toolCallId: `choice:${record.choiceId}`,
      challengeId: record.choiceId,
      outcome: "success",
    });
    expect(runs[0]?.resultIds).toContain(body.entity.orderId);

    const keys = (
      await kit.db.runtime.db.select().from(idempotencyKeys)
    ).filter((row) => row.action === "orders.create");
    const choiceKey = attemptKey("choice", conversation.id, record.choiceId);
    expect(keys.some((row) => row.key === choiceKey)).toBe(true);
    expect(
      keys.some(
        (row) =>
          row.key === attemptKey("tool", conversation.id, record.choiceId),
      ),
    ).toBe(false);

    const audit = await kit.db.runtime.db.select().from(auditLog);
    const createAudit = audit.find(
      (row) => row.action === "orders.create" && row.requestId === requestId,
    );
    expect(createAudit).toMatchObject({
      channel: ASSISTANT_INVOCATION_CHANNEL,
      actorId: kitIdentities.users.anna,
      companyId: kitIdentities.companies.a,
      outcome: "ok",
    });

    const replay = await postChoice(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: {
        conversationId: conversation.id,
        choiceId: record.choiceId,
        optionId,
      },
    });
    expect(replay.status).toBe(200);
    const replayBody = assistantChoiceInteractionResultSchema.parse(
      await replay.json(),
    );
    expect(replayBody).toEqual(body);
    const companyOrders = (
      await kit.db.runtime.db.select().from(orders)
    ).filter((row) => row.customerId === customer.id);
    expect(companyOrders).toHaveLength(1);

    const different = await postChoice(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: {
        conversationId: conversation.id,
        choiceId: record.choiceId,
        optionId: optionByLabel.get("Vanilla"),
      },
    });
    expect(different.status).toBe(200);
    expect(await different.json()).toMatchObject({
      status: "error",
      code: "CHOICE_OPTION_CONFLICT",
    });
  });

  it("rejects extra client fields and never honours a variant id as optionId", async () => {
    const { app, store } = choiceApp();
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "Choice tamper",
    });
    const customer = await staffInvoke(createCustomer, {
      name: "Tamper Buyer",
      phone: nextPhone(),
    });
    const product = await seedVariableProduct("Tamper Cake", ["A", "B"]);
    const { record } = await openChoice({
      store,
      conversationId: conversation.id,
      customerId: customer.id,
      product,
    });
    const extra = await postChoice(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: {
        conversationId: conversation.id,
        choiceId: record.choiceId,
        optionId: product.variants[0]?.variantId,
        target: { lineIndex: 9, productId: product.productId },
        variantId: product.variants[0]?.variantId,
      },
    });
    expect(extra.status).toBe(400);
    expect(await extra.json()).toMatchObject({ code: "VALIDATION" });
    const asVariant = await postChoice(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: {
        conversationId: conversation.id,
        choiceId: record.choiceId,
        optionId: product.variants[0]?.variantId,
      },
    });
    expect(asVariant.status).toBe(200);
    expect(await asVariant.json()).toMatchObject({
      status: "error",
      code: "CHOICE_INVALID_OPTION",
    });
    const companyOrders = (
      await kit.db.runtime.db.select().from(orders)
    ).filter((row) => row.customerId === customer.id);
    expect(companyOrders).toHaveLength(0);
  });

  it("rejects wrong tenant, actor, and conversation without writing", async () => {
    const { app, store } = choiceApp();
    const annaToken = await insertBearer(kit, kitIdentities.users.anna);
    const borisToken = await insertBearer(kit, kitIdentities.users.boris);
    const conversation = await staffInvoke(createConversation, {
      title: "Choice isolation A",
    });
    const otherConversation = await staffInvoke(createConversation, {
      title: "Choice isolation A2",
    });
    const borisConversation = await staffInvoke(
      createConversation,
      { title: "Choice isolation B" },
      {
        userId: kitIdentities.users.boris,
        companyId: kitIdentities.companies.b,
      },
    );
    const customer = await staffInvoke(createCustomer, {
      name: "Isolation Buyer",
      phone: nextPhone(),
    });
    const product = await seedVariableProduct("Isolation Cake", ["X", "Y"]);
    const { record, optionByLabel } = await openChoice({
      store,
      conversationId: conversation.id,
      customerId: customer.id,
      product,
    });
    const optionId = optionByLabel.get("X");
    const clerkId = randomUUID();
    await kit.db.runtime.db.insert(user).values({
      id: clerkId,
      name: "Choice Clerk",
      email: `choice-clerk-${clerkId}@assistant-kit.test`,
    });
    await kit.db.runtime.db.insert(companyMembers).values({
      companyId: kitIdentities.companies.a,
      userId: clerkId,
      role: "employee",
      permissions: { granted: ["assistant:use"], denied: [] },
    });
    const clerkToken = await insertBearer(kit, clerkId);

    const wrongActor = await postChoice(app, {
      token: clerkToken,
      companyId: kitIdentities.companies.a,
      body: {
        conversationId: conversation.id,
        choiceId: record.choiceId,
        optionId,
      },
    });
    expect(wrongActor.status).toBe(200);
    expect(await wrongActor.json()).toEqual({ status: "expired" });

    const wrongConversation = await postChoice(app, {
      token: annaToken,
      companyId: kitIdentities.companies.a,
      body: {
        conversationId: otherConversation.id,
        choiceId: record.choiceId,
        optionId,
      },
    });
    expect(wrongConversation.status).toBe(200);
    expect(await wrongConversation.json()).toEqual({ status: "expired" });

    const wrongTenant = await postChoice(app, {
      token: borisToken,
      companyId: kitIdentities.companies.b,
      body: {
        conversationId: borisConversation.id,
        choiceId: record.choiceId,
        optionId,
      },
    });
    expect(wrongTenant.status).toBe(200);
    expect(await wrongTenant.json()).toEqual({ status: "expired" });

    const peek = await store.peek({
      choiceId: record.choiceId,
      bind: {
        actorId: kitIdentities.users.anna,
        companyId: kitIdentities.companies.a,
        conversationId: conversation.id,
      },
    });
    expect(peek.kind).toBe("found");
    if (peek.kind === "found") {
      expect(peek.record.status).toBe("open");
    }
  });

  it("restores a claimed peek after claim-before-create and retries the same option once", async () => {
    const classify = vi.spyOn(ShowzyAi, "classifyStaffAssistantTurn");
    const stream = vi.spyOn(ShowzyAi, "streamStaffAssistantChat");
    const { app, store } = choiceApp();
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "Choice claimed recover",
    });
    const customer = await staffInvoke(createCustomer, {
      name: "Claim Crash Buyer",
      phone: nextPhone(),
    });
    const product = await seedVariableProduct("Claim Cake", [
      "Lemon",
      "Vanilla",
    ]);
    const { record, optionByLabel } = await openChoice({
      store,
      conversationId: conversation.id,
      customerId: customer.id,
      product,
    });
    const lemonId = optionByLabel.get("Lemon");
    const vanillaId = optionByLabel.get("Vanilla");
    expect(lemonId).toBeDefined();
    expect(vanillaId).toBeDefined();
    if (lemonId === undefined || vanillaId === undefined) {
      classify.mockRestore();
      stream.mockRestore();
      return;
    }
    await staffInvoke(recordAssistantTurn, {
      conversationId: conversation.id,
      body: "Select a variant.",
      toolRuns: [
        {
          actionName: "orders.create",
          toolCallId: "call_choice",
          challengeId: record.choiceId,
          resultIds: [],
          outcome: "choice_required",
        },
      ],
    });
    const claimed = await store.claim({
      choiceId: record.choiceId,
      bind: {
        actorId: kitIdentities.users.anna,
        companyId: kitIdentities.companies.a,
        conversationId: conversation.id,
      },
      optionId: lemonId,
    });
    expect(claimed.kind).toBe("claimed");
    const claimedPeek = await peekChoice(app, {
      token,
      companyId: kitIdentities.companies.a,
      conversationId: conversation.id,
      choiceId: record.choiceId,
    });
    expect(claimedPeek.status).toBe(200);
    const claimedEnvelope = staffAssistantChoiceCardEnvelopeSchema.parse(
      await claimedPeek.json(),
    );
    expect(claimedEnvelope).toMatchObject({
      status: "claimed",
      challengeId: record.choiceId,
      claimedOptionId: lemonId,
    });
    const serialized = JSON.stringify(claimedEnvelope);
    expect(serialized).not.toContain("canonicalInput");
    expect(serialized).not.toContain("optionMap");
    expect(serialized).not.toContain("lineIndex");
    expect(serialized).not.toContain("actorId");
    expect(serialized).not.toContain(product.productId);
    expect(serialized).not.toContain(kitIdentities.companies.a);
    expect(serialized).not.toContain(kitIdentities.users.anna);
    for (const variant of product.variants) {
      expect(serialized).not.toContain(variant.variantId);
    }
    const different = await postChoice(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: {
        conversationId: conversation.id,
        choiceId: record.choiceId,
        optionId: vanillaId,
      },
    });
    expect(different.status).toBe(200);
    expect(await different.json()).toMatchObject({
      status: "error",
      code: "CHOICE_OPTION_CONFLICT",
    });
    const retry = await postChoice(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: {
        conversationId: conversation.id,
        choiceId: record.choiceId,
        optionId: lemonId,
      },
    });
    expect(retry.status).toBe(200);
    const body = assistantChoiceInteractionResultSchema.parse(
      await retry.json(),
    );
    expect(body.status).toBe("completed");
    const companyOrders = (
      await kit.db.runtime.db.select().from(orders)
    ).filter((row) => row.customerId === customer.id);
    expect(companyOrders).toHaveLength(1);
    const runs = (
      await kit.db.runtime.db.select().from(assistantToolRuns)
    ).filter((row) => row.conversationId === conversation.id);
    expect(
      runs.filter((row) => row.outcome === "choice_required"),
    ).toHaveLength(1);
    expect(runs.filter((row) => row.outcome === "success")).toHaveLength(1);
    expect(classify).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
    classify.mockRestore();
    stream.mockRestore();
  });

  it("replays a claimed-after-create crash instead of inserting a second order", async () => {
    const { app, store } = choiceApp();
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "Choice crash",
    });
    const customer = await staffInvoke(createCustomer, {
      name: "Crash Buyer",
      phone: nextPhone(),
    });
    const product = await seedVariableProduct("Crash Cake", ["One", "Two"]);
    const { record, optionByLabel } = await openChoice({
      store,
      conversationId: conversation.id,
      customerId: customer.id,
      product,
    });
    const optionId = optionByLabel.get("One");
    expect(optionId).toBeDefined();
    if (optionId === undefined) {
      return;
    }
    const claimed = await store.claim({
      choiceId: record.choiceId,
      bind: {
        actorId: kitIdentities.users.anna,
        companyId: kitIdentities.companies.a,
        conversationId: conversation.id,
      },
      optionId,
    });
    expect(claimed.kind).toBe("claimed");
    const variantId = record.optionMap[optionId];
    expect(variantId).toBeDefined();
    if (variantId === undefined) {
      return;
    }
    const patched = applyChoiceOptionToCanonicalInput(
      record.canonicalInput,
      record.target,
      variantId,
    );
    await executeAction(pipeline, {
      action: createOrder,
      input: patched,
      request: {
        requestId: randomUUID(),
        correlationId: randomUUID(),
        channel: ASSISTANT_INVOCATION_CHANNEL,
        clientIp: REAL_CLIENT,
        toolCallId: `choice:${record.choiceId}`,
        idempotencyKey: attemptKey("choice", conversation.id, record.choiceId),
      },
      principal: {
        mode: "staff",
        session: { userId: kitIdentities.users.anna },
        companySelector: kitIdentities.companies.a,
      },
    });
    const afterCreate = await store.peek({
      choiceId: record.choiceId,
      bind: {
        actorId: kitIdentities.users.anna,
        companyId: kitIdentities.companies.a,
        conversationId: conversation.id,
      },
    });
    expect(afterCreate.kind).toBe("found");
    if (afterCreate.kind === "found") {
      expect(afterCreate.record.status).toBe("claimed");
    }
    const claimedPeek = await peekChoice(app, {
      token,
      companyId: kitIdentities.companies.a,
      conversationId: conversation.id,
      choiceId: record.choiceId,
    });
    expect(claimedPeek.status).toBe(200);
    const claimedEnvelope = staffAssistantChoiceCardEnvelopeSchema.parse(
      await claimedPeek.json(),
    );
    expect(claimedEnvelope.status).toBe("claimed");
    expect(claimedEnvelope.claimedOptionId).toBe(optionId);
    expect(JSON.stringify(claimedEnvelope)).not.toContain("canonicalInput");
    expect(claimedEnvelope.claimedOptionId).not.toBe(variantId);
    const classify = vi.spyOn(ShowzyAi, "classifyStaffAssistantTurn");
    const stream = vi.spyOn(ShowzyAi, "streamStaffAssistantChat");
    const response = await postChoice(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: {
        conversationId: conversation.id,
        choiceId: record.choiceId,
        optionId,
      },
    });
    expect(response.status).toBe(200);
    const body = assistantChoiceInteractionResultSchema.parse(
      await response.json(),
    );
    expect(body.status).toBe("completed");
    const companyOrders = (
      await kit.db.runtime.db.select().from(orders)
    ).filter((row) => row.customerId === customer.id);
    expect(companyOrders).toHaveLength(1);
    const completed = await store.peek({
      choiceId: record.choiceId,
      bind: {
        actorId: kitIdentities.users.anna,
        companyId: kitIdentities.companies.a,
        conversationId: conversation.id,
      },
    });
    expect(completed.kind).toBe("found");
    if (completed.kind === "found") {
      expect(completed.record.status).toBe("completed");
    }
    expect(classify).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
    classify.mockRestore();
    stream.mockRestore();
    const assistantTurns = (
      await kit.db.runtime.db.select().from(assistantMessages)
    ).filter(
      (row) =>
        row.conversationId === conversation.id && row.role === "assistant",
    );
    expect(assistantTurns).toHaveLength(1);
    const runs = (
      await kit.db.runtime.db.select().from(assistantToolRuns)
    ).filter((row) => row.conversationId === conversation.id);
    const successRuns = runs.filter((row) => row.outcome === "success");
    expect(successRuns).toHaveLength(1);
    expect(successRuns[0]?.resultIds).toEqual([companyOrders[0]?.id]);
  });

  it("replays a post-commit history persist failure as the completed result with one order", async () => {
    const classify = vi.spyOn(ShowzyAi, "classifyStaffAssistantTurn");
    const stream = vi.spyOn(ShowzyAi, "streamStaffAssistantChat");
    const { app, store } = choiceApp();
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "Choice persist crash",
    });
    const customer = await staffInvoke(createCustomer, {
      name: "Persist Crash Buyer",
      phone: nextPhone(),
    });
    const product = await seedVariableProduct("Persist Cake", [
      "Lemon",
      "Vanilla",
    ]);
    const { record, optionByLabel } = await openChoice({
      store,
      conversationId: conversation.id,
      customerId: customer.id,
      product,
    });
    const optionId = optionByLabel.get("Lemon");
    expect(optionId).toBeDefined();
    if (optionId === undefined) {
      classify.mockRestore();
      stream.mockRestore();
      return;
    }

    const realExecuteAction = ShowzyCore.executeAction;
    const executeSpy = vi
      .spyOn(ShowzyCore, "executeAction")
      .mockImplementation(async (deps, invocation) => {
        if (
          invocation.action.contract.name === "assistant.recordAssistantTurn"
        ) {
          throw new CoreInvariantError(
            "simulated assistant.recordAssistantTurn persist failure",
          );
        }
        return realExecuteAction(deps, invocation);
      });

    try {
      const failed = await postChoice(app, {
        token,
        companyId: kitIdentities.companies.a,
        body: {
          conversationId: conversation.id,
          choiceId: record.choiceId,
          optionId,
        },
      });
      expect(failed.status).toBe(500);
      const failedBody = await failed.json();
      expect(failedBody).toEqual({
        code: "INTERNAL",
        status: 500,
        message: "Internal error.",
      });
      expect(JSON.stringify(failedBody)).not.toContain(
        "simulated assistant.recordAssistantTurn persist failure",
      );
      expect(JSON.stringify(failedBody)).not.toContain("canonicalInput");

      const claimedPeek = await peekChoice(app, {
        token,
        companyId: kitIdentities.companies.a,
        conversationId: conversation.id,
        choiceId: record.choiceId,
      });
      expect(claimedPeek.status).toBe(200);
      const claimedEnvelope = staffAssistantChoiceCardEnvelopeSchema.parse(
        await claimedPeek.json(),
      );
      expect(claimedEnvelope.status).toBe("claimed");
      expect(claimedEnvelope.claimedOptionId).toBe(optionId);

      const ordersAfterFail = (
        await kit.db.runtime.db.select().from(orders)
      ).filter((row) => row.customerId === customer.id);
      expect(ordersAfterFail).toHaveLength(1);
    } finally {
      executeSpy.mockRestore();
    }

    const replay = await postChoice(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: {
        conversationId: conversation.id,
        choiceId: record.choiceId,
        optionId,
      },
    });
    expect(replay.status).toBe(200);
    const replayBody = assistantChoiceInteractionResultSchema.parse(
      await replay.json(),
    );
    expect(replayBody.status).toBe("completed");
    if (replayBody.status !== "completed") {
      classify.mockRestore();
      stream.mockRestore();
      return;
    }

    const companyOrders = (
      await kit.db.runtime.db.select().from(orders)
    ).filter((row) => row.customerId === customer.id);
    expect(companyOrders).toHaveLength(1);
    expect(replayBody.entity.orderId).toBe(companyOrders[0]?.id);

    const completed = await store.peek({
      choiceId: record.choiceId,
      bind: {
        actorId: kitIdentities.users.anna,
        companyId: kitIdentities.companies.a,
        conversationId: conversation.id,
      },
    });
    expect(completed.kind).toBe("found");
    if (completed.kind === "found") {
      expect(completed.record.status).toBe("completed");
    }

    expect(classify).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
    classify.mockRestore();
    stream.mockRestore();

    const assistantTurns = (
      await kit.db.runtime.db.select().from(assistantMessages)
    ).filter(
      (row) =>
        row.conversationId === conversation.id && row.role === "assistant",
    );
    expect(assistantTurns).toHaveLength(1);
    const runs = (
      await kit.db.runtime.db.select().from(assistantToolRuns)
    ).filter((row) => row.conversationId === conversation.id);
    const successRuns = runs.filter((row) => row.outcome === "success");
    expect(successRuns).toHaveLength(1);
    expect(successRuns[0]?.resultIds).toEqual([companyOrders[0]?.id]);
  });

  it("returns the next needs_choice in deterministic line order from a seeded store", async () => {
    const classify = vi.spyOn(ShowzyAi, "classifyStaffAssistantTurn");
    const stream = vi.spyOn(ShowzyAi, "streamStaffAssistantChat");
    const { app, store } = choiceApp();
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "Choice sequential",
    });
    const customer = await staffInvoke(createCustomer, {
      name: "Sequential Buyer",
      phone: nextPhone(),
    });
    const first = await seedVariableProduct("Macarons Seq", [
      "Lemon",
      "Vanilla",
    ]);
    const second = await seedVariableProduct("Eclairs Seq", [
      "Coffee",
      "Chocolate",
    ]);
    const { record, optionByLabel } = await openChoice({
      store,
      conversationId: conversation.id,
      customerId: customer.id,
      product: first,
      extraProducts: [{ productId: second.productId }],
      lineIndex: 0,
    });
    const bind = {
      actorId: kitIdentities.users.anna,
      companyId: kitIdentities.companies.a,
      conversationId: conversation.id,
    };
    const firstOption = optionByLabel.get("Lemon");
    const firstTap = await postChoice(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: {
        conversationId: conversation.id,
        choiceId: record.choiceId,
        optionId: firstOption,
      },
    });
    expect(firstTap.status).toBe(200);
    const firstBody = assistantChoiceInteractionResultSchema.parse(
      await firstTap.json(),
    );
    expect(firstBody.status).toBe("needs_choice");
    if (firstBody.status !== "needs_choice") {
      classify.mockRestore();
      stream.mockRestore();
      return;
    }
    expect(firstBody.challengeId).toBe(successorChoiceId(record.choiceId));
    expect(firstBody.productName).toBe(second.name);
    expect(firstBody.options.length).toBeGreaterThan(0);
    const successor = await store.peek({
      choiceId: firstBody.challengeId,
      bind,
    });
    expect(successor.kind).toBe("found");
    if (successor.kind !== "found") {
      classify.mockRestore();
      stream.mockRestore();
      return;
    }
    const presented = presentChoiceStaffAssistantNeedsChoice({
      locale: "uk",
      record: successor.record,
    });
    expect(firstBody).toEqual(presented);
    expect(firstBody.text).toBe(
      presentChoiceStaffAssistantTurn({
        locale: "uk",
        toolResults: [
          {
            toolName: "orders.create",
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
    expect(firstBody.text).toContain(second.name);
    expect(firstBody.text).toContain("Coffee");
    expect(firstBody.text).toContain("Chocolate");
    expect(firstBody.text).not.toBe(`Select a variant for "${second.name}".`);
    const assistantAfterFirst = (
      await kit.db.runtime.db.select().from(assistantMessages)
    ).filter(
      (row) =>
        row.conversationId === conversation.id && row.role === "assistant",
    );
    expect(assistantAfterFirst).toHaveLength(1);
    expect(assistantAfterFirst[0]?.body).toBe(firstBody.text);
    expect(assistantAfterFirst[0]?.body).toBe(presented.text);
    const runsAfterFirst = (
      await kit.db.runtime.db.select().from(assistantToolRuns)
    ).filter((row) => row.conversationId === conversation.id);
    expect(runsAfterFirst).toHaveLength(1);
    expect(runsAfterFirst[0]).toMatchObject({
      outcome: "choice_required",
      challengeId: firstBody.challengeId,
    });
    const retry = await postChoice(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: {
        conversationId: conversation.id,
        choiceId: record.choiceId,
        optionId: firstOption,
      },
    });
    expect(retry.status).toBe(200);
    const retryBody = assistantChoiceInteractionResultSchema.parse(
      await retry.json(),
    );
    expect(retryBody).toEqual(firstBody);
    const assistantAfterRetry = (
      await kit.db.runtime.db.select().from(assistantMessages)
    ).filter(
      (row) =>
        row.conversationId === conversation.id && row.role === "assistant",
    );
    expect(assistantAfterRetry).toHaveLength(1);
    expect(assistantAfterRetry[0]?.body).toBe(firstBody.text);
    const runsAfterRetry = (
      await kit.db.runtime.db.select().from(assistantToolRuns)
    ).filter((row) => row.conversationId === conversation.id);
    expect(runsAfterRetry).toHaveLength(1);
    expect(classify).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
    const coffee = firstBody.options.find(
      (option) => option.label === "Coffee",
    );
    expect(coffee).toBeDefined();
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
    if (secondBody.status !== "completed") {
      classify.mockRestore();
      stream.mockRestore();
      return;
    }
    expect(secondBody.text.startsWith("Замовлення")).toBe(true);
    const completedTurns = (
      await kit.db.runtime.db.select().from(assistantMessages)
    ).filter(
      (row) =>
        row.conversationId === conversation.id && row.role === "assistant",
    );
    expect(completedTurns).toHaveLength(2);
    expect(completedTurns[1]?.body).toBe(secondBody.text);
    const companyOrders = (
      await kit.db.runtime.db.select().from(orders)
    ).filter((row) => row.customerId === customer.id);
    expect(companyOrders).toHaveLength(1);
    const runs = (
      await kit.db.runtime.db.select().from(assistantToolRuns)
    ).filter((row) => row.conversationId === conversation.id);
    expect(runs.some((row) => row.outcome === "success")).toBe(true);
    expect(runs.some((row) => row.outcome === "choice_required")).toBe(true);
    const success = runs.find((row) => row.outcome === "success");
    expect(success?.resultIds).toContain(secondBody.entity.orderId);
    expect(classify).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
    classify.mockRestore();
    stream.mockRestore();
  });

  it("persists sequential English presenter text, not catalog clientMessage", async () => {
    const classify = vi.spyOn(ShowzyAi, "classifyStaffAssistantTurn");
    const stream = vi.spyOn(ShowzyAi, "streamStaffAssistantChat");
    const { app, store } = choiceApp();
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "Choice sequential en",
    });
    const customer = await staffInvoke(createCustomer, {
      name: "Sequential EN Buyer",
      phone: nextPhone(),
    });
    const first = await seedVariableProduct("Macarons EN Seq", [
      "Lemon",
      "Vanilla",
    ]);
    const second = await seedVariableProduct("Eclairs EN Seq", [
      "Coffee",
      "Chocolate",
    ]);
    const { record, optionByLabel } = await openChoice({
      store,
      conversationId: conversation.id,
      customerId: customer.id,
      product: first,
      extraProducts: [{ productId: second.productId }],
      lineIndex: 0,
      locale: "en",
    });
    const bind = {
      actorId: kitIdentities.users.anna,
      companyId: kitIdentities.companies.a,
      conversationId: conversation.id,
    };
    const firstTap = await postChoice(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: {
        conversationId: conversation.id,
        choiceId: record.choiceId,
        optionId: optionByLabel.get("Lemon"),
      },
    });
    expect(firstTap.status).toBe(200);
    const firstBody = assistantChoiceInteractionResultSchema.parse(
      await firstTap.json(),
    );
    expect(firstBody.status).toBe("needs_choice");
    if (firstBody.status !== "needs_choice") {
      classify.mockRestore();
      stream.mockRestore();
      return;
    }
    const successor = await store.peek({
      choiceId: firstBody.challengeId,
      bind,
    });
    expect(successor.kind).toBe("found");
    if (successor.kind !== "found") {
      classify.mockRestore();
      stream.mockRestore();
      return;
    }
    const presented = presentChoiceStaffAssistantNeedsChoice({
      locale: "en",
      record: successor.record,
    });
    expect(firstBody.text).toBe(presented.text);
    expect(firstBody.text).toBe(
      `Select a variant for ${second.name}: ${firstBody.options
        .map((option) => option.label)
        .join(", ")}.`,
    );
    const persisted = (
      await kit.db.runtime.db.select().from(assistantMessages)
    ).filter(
      (row) =>
        row.conversationId === conversation.id && row.role === "assistant",
    );
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.body).toBe(firstBody.text);
    expect(persisted[0]?.body).not.toBe(
      `Select a variant for "${second.name}".`,
    );
    expect(classify).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
    classify.mockRestore();
    stream.mockRestore();
  });

  it("persists truncated sequential presenter copy live and after reload", async () => {
    const classify = vi.spyOn(ShowzyAi, "classifyStaffAssistantTurn");
    const stream = vi.spyOn(ShowzyAi, "streamStaffAssistantChat");
    const { app, store } = choiceApp();
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "Choice sequential truncated",
    });
    const customer = await staffInvoke(createCustomer, {
      name: "Sequential Trunc Buyer",
      phone: nextPhone(),
    });
    const first = await seedVariableProduct("Macarons Trunc Seq", [
      "Lemon",
      "Vanilla",
    ]);
    const overflowNames = Array.from(
      { length: CHOICE_OPTIONS_MAX + 1 },
      (_, index) => `Flavour ${String(index).padStart(2, "0")}`,
    );
    const second = await seedVariableProduct(
      "Eclairs Trunc Seq",
      overflowNames,
    );
    const { record, optionByLabel } = await openChoice({
      store,
      conversationId: conversation.id,
      customerId: customer.id,
      product: first,
      extraProducts: [{ productId: second.productId }],
      lineIndex: 0,
    });
    const bind = {
      actorId: kitIdentities.users.anna,
      companyId: kitIdentities.companies.a,
      conversationId: conversation.id,
    };
    const firstTap = await postChoice(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: {
        conversationId: conversation.id,
        choiceId: record.choiceId,
        optionId: optionByLabel.get("Lemon"),
      },
    });
    expect(firstTap.status).toBe(200);
    const firstBody = assistantChoiceInteractionResultSchema.parse(
      await firstTap.json(),
    );
    expect(firstBody.status).toBe("needs_choice");
    if (firstBody.status !== "needs_choice") {
      classify.mockRestore();
      stream.mockRestore();
      return;
    }
    expect(firstBody.optionsTruncated).toBe(true);
    expect(firstBody.options).toHaveLength(CHOICE_OPTIONS_MAX);
    const successor = await store.peek({
      choiceId: firstBody.challengeId,
      bind,
    });
    expect(successor.kind).toBe("found");
    if (successor.kind !== "found") {
      classify.mockRestore();
      stream.mockRestore();
      return;
    }
    const presented = presentChoiceStaffAssistantNeedsChoice({
      locale: "uk",
      record: successor.record,
    });
    expect(firstBody.text).toBe(presented.text);
    expect(firstBody.text).toContain(CHOICE_TRUNCATED_COPY.uk);
    for (const option of firstBody.options) {
      expect(firstBody.text).toContain(option.label);
    }
    const persisted = (
      await kit.db.runtime.db.select().from(assistantMessages)
    ).filter(
      (row) =>
        row.conversationId === conversation.id && row.role === "assistant",
    );
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.body).toBe(firstBody.text);
    expect(classify).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
    classify.mockRestore();
    stream.mockRestore();
  });

  it("returns a typed error when the next line is archived-only, without opening a successor", async () => {
    const { app, store } = choiceApp();
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "Choice T9 archived-only",
    });
    const customer = await staffInvoke(createCustomer, {
      name: "T9 Archived Buyer",
      phone: nextPhone(),
    });
    const first = await seedVariableProduct("T9 Macarons Picker", [
      "Lemon",
      "Vanilla",
    ]);
    const archived = await seedVariableProduct("T9 Archived Only Cake", [
      "One",
    ]);
    const archivedVariantId = archived.variants[0]?.variantId;
    expect(archivedVariantId).toBeDefined();
    if (archivedVariantId !== undefined) {
      await staffInvoke(archiveVariant, { variantId: archivedVariantId });
    }
    const { record, optionByLabel } = await openChoice({
      store,
      conversationId: conversation.id,
      customerId: customer.id,
      product: first,
      extraProducts: [{ productId: archived.productId }],
      lineIndex: 0,
    });
    const firstOption = optionByLabel.get("Lemon");
    const bind = {
      actorId: kitIdentities.users.anna,
      companyId: kitIdentities.companies.a,
      conversationId: conversation.id,
    };
    const response = await postChoice(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: {
        conversationId: conversation.id,
        choiceId: record.choiceId,
        optionId: firstOption,
      },
    });
    expect(response.status).toBe(200);
    const body = assistantChoiceInteractionResultSchema.parse(
      await response.json(),
    );
    expect(body.status).toBe("error");
    if (body.status !== "error") {
      return;
    }
    expect(body.code).toBe("CONFLICT");
    const expected = presentCatalogDomainError({
      locale: "uk",
      extras: {
        reason: "no_active_variants",
        subject: { kind: "product_name", name: archived.name },
      },
    });
    expect(body.message).toBe(expected);
    expect(body.message).not.toContain(
      '"T9 Archived Only Cake" has no active variants.',
    );
    const successor = await store.peek({
      choiceId: successorChoiceId(record.choiceId),
      bind,
    });
    expect(successor.kind).toBe("expired");
    const parent = await store.peek({
      choiceId: record.choiceId,
      bind,
    });
    expect(parent.kind).toBe("found");
    if (parent.kind === "found") {
      expect(parent.record.status).toBe("completed");
    }
    const runs = (
      await kit.db.runtime.db.select().from(assistantToolRuns)
    ).filter((row) => row.conversationId === conversation.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      actionName: "orders.create",
      outcome: "error",
    });
    expect(runs[0]?.challengeId).toBeNull();
    expect(runs.some((row) => row.outcome === "choice_required")).toBe(false);
    const persisted = (
      await kit.db.runtime.db.select().from(assistantMessages)
    ).filter(
      (row) =>
        row.conversationId === conversation.id && row.role === "assistant",
    );
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.body).toBe(body.message);
    expect(persisted[0]?.body).toBe(expected);
    expect(persisted[0]?.body).not.toContain("Оберіть варіант");
    expect(persisted[0]?.body).not.toContain(CHOICE_TRUNCATED_COPY.uk);
    expect(persisted[0]?.body).not.toContain(CHOICE_TRUNCATED_COPY.en);
    const companyOrders = (
      await kit.db.runtime.db.select().from(orders)
    ).filter((row) => row.customerId === customer.id);
    expect(companyOrders).toHaveLength(0);
  });

  it("errors on an archived-only third line before chaining any successor picker", async () => {
    const { app, store } = choiceApp();
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "Choice T9 three-line terminal",
    });
    const customer = await staffInvoke(createCustomer, {
      name: "T9 Three Line Buyer",
      phone: nextPhone(),
    });
    const first = await seedVariableProduct("T9 Three Macarons", [
      "Lemon",
      "Vanilla",
    ]);
    const second = await seedVariableProduct("T9 Three Eclairs", [
      "Coffee",
      "Chocolate",
    ]);
    const archived = await seedVariableProduct("T9 Three Archived", ["One"]);
    const archivedVariantId = archived.variants[0]?.variantId;
    expect(archivedVariantId).toBeDefined();
    if (archivedVariantId !== undefined) {
      await staffInvoke(archiveVariant, { variantId: archivedVariantId });
    }
    const { record, optionByLabel } = await openChoice({
      store,
      conversationId: conversation.id,
      customerId: customer.id,
      product: first,
      extraProducts: [
        { productId: second.productId },
        { productId: archived.productId },
      ],
      lineIndex: 0,
    });
    const bind = {
      actorId: kitIdentities.users.anna,
      companyId: kitIdentities.companies.a,
      conversationId: conversation.id,
    };
    const firstTap = await postChoice(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: {
        conversationId: conversation.id,
        choiceId: record.choiceId,
        optionId: optionByLabel.get("Lemon"),
      },
    });
    expect(firstTap.status).toBe(200);
    const firstBody = assistantChoiceInteractionResultSchema.parse(
      await firstTap.json(),
    );
    expect(firstBody.status).toBe("error");
    if (firstBody.status !== "error") {
      return;
    }
    expect(firstBody.code).toBe("CONFLICT");
    const expected = presentCatalogDomainError({
      locale: "uk",
      extras: {
        reason: "no_active_variants",
        subject: { kind: "product_name", name: archived.name },
      },
    });
    expect(firstBody.message).toBe(expected);
    expect(firstBody.message).not.toContain(second.name);
    const successor = await store.peek({
      choiceId: successorChoiceId(record.choiceId),
      bind,
    });
    expect(successor.kind).toBe("expired");
    const parent = await store.peek({
      choiceId: record.choiceId,
      bind,
    });
    expect(parent.kind).toBe("found");
    if (parent.kind === "found") {
      expect(parent.record.status).toBe("completed");
    }
    const runs = (
      await kit.db.runtime.db.select().from(assistantToolRuns)
    ).filter((row) => row.conversationId === conversation.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      actionName: "orders.create",
      outcome: "error",
    });
    expect(runs[0]?.challengeId).toBeNull();
    expect(runs.some((row) => row.outcome === "choice_required")).toBe(false);
    expect(runs.some((row) => row.outcome === "success")).toBe(false);
    const persisted = (
      await kit.db.runtime.db.select().from(assistantMessages)
    ).filter(
      (row) =>
        row.conversationId === conversation.id && row.role === "assistant",
    );
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.body).toBe(firstBody.message);
    expect(persisted[0]?.body).toBe(expected);
    expect(persisted[0]?.body).not.toContain("Оберіть варіант");
    const companyOrders = (
      await kit.db.runtime.db.select().from(orders)
    ).filter((row) => row.customerId === customer.id);
    expect(companyOrders).toHaveLength(0);
  });

  it("chains two pickers when a third line is sellable and no terminal exists", async () => {
    const { app, store } = choiceApp();
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "Choice T9 three-line pickers",
    });
    const customer = await staffInvoke(createCustomer, {
      name: "T9 Three Picker Buyer",
      phone: nextPhone(),
    });
    const first = await seedVariableProduct("T9 Chain Macarons", [
      "Lemon",
      "Vanilla",
    ]);
    const second = await seedVariableProduct("T9 Chain Eclairs", [
      "Coffee",
      "Chocolate",
    ]);
    const third = await seedSimpleProduct("T9 Chain Cookie");
    const { record, optionByLabel } = await openChoice({
      store,
      conversationId: conversation.id,
      customerId: customer.id,
      product: first,
      extraProducts: [
        { productId: second.productId },
        { productId: third.productId },
      ],
      lineIndex: 0,
    });
    const bind = {
      actorId: kitIdentities.users.anna,
      companyId: kitIdentities.companies.a,
      conversationId: conversation.id,
    };
    const firstTap = await postChoice(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: {
        conversationId: conversation.id,
        choiceId: record.choiceId,
        optionId: optionByLabel.get("Lemon"),
      },
    });
    expect(firstTap.status).toBe(200);
    const firstBody = assistantChoiceInteractionResultSchema.parse(
      await firstTap.json(),
    );
    expect(firstBody.status).toBe("needs_choice");
    if (firstBody.status !== "needs_choice") {
      return;
    }
    expect(firstBody.challengeId).toBe(successorChoiceId(record.choiceId));
    expect(firstBody.productName).toBe(second.name);
    const coffee = firstBody.options.find(
      (option) => option.label === "Coffee",
    );
    expect(coffee).toBeDefined();
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
    if (secondBody.status !== "completed") {
      return;
    }
    const thirdChoice = await store.peek({
      choiceId: successorChoiceId(firstBody.challengeId),
      bind,
    });
    expect(thirdChoice.kind).toBe("expired");
    const secondRecord = await store.peek({
      choiceId: firstBody.challengeId,
      bind,
    });
    expect(secondRecord.kind).toBe("found");
    if (secondRecord.kind === "found") {
      expect(secondRecord.record.status).toBe("completed");
    }
    const runs = (
      await kit.db.runtime.db.select().from(assistantToolRuns)
    ).filter((row) => row.conversationId === conversation.id);
    expect(runs.some((row) => row.outcome === "choice_required")).toBe(true);
    expect(runs.some((row) => row.outcome === "success")).toBe(true);
    expect(runs.some((row) => row.outcome === "error")).toBe(false);
    const companyOrders = (
      await kit.db.runtime.db.select().from(orders)
    ).filter((row) => row.customerId === customer.id);
    expect(companyOrders).toHaveLength(1);
  });

  it("safe peek returns the envelope only and does not consume the record", async () => {
    const { app, store } = choiceApp();
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "Choice peek",
    });
    const customer = await staffInvoke(createCustomer, {
      name: "Peek Buyer",
      phone: nextPhone(),
    });
    const product = await seedVariableProduct("Peek Cake", ["Red", "Blue"]);
    const { record, optionByLabel } = await openChoice({
      store,
      conversationId: conversation.id,
      customerId: customer.id,
      product,
    });
    const response = await peekChoice(app, {
      token,
      companyId: kitIdentities.companies.a,
      conversationId: conversation.id,
      choiceId: record.choiceId,
    });
    expect(response.status).toBe(200);
    const envelope = staffAssistantChoiceCardEnvelopeSchema.parse(
      await response.json(),
    );
    expect(envelope.status).toBe("needs_choice");
    expect(envelope.challengeId).toBe(record.choiceId);
    const serialized = JSON.stringify(envelope);
    expect(serialized).not.toContain("canonicalInput");
    expect(serialized).not.toContain("optionMap");
    expect(serialized).not.toContain("lineIndex");
    expect(serialized).not.toContain("actorId");
    expect(serialized).not.toContain(product.productId);
    expect(serialized).not.toContain(kitIdentities.companies.a);
    expect(serialized).not.toContain(kitIdentities.users.anna);
    for (const variant of product.variants) {
      expect(serialized).not.toContain(variant.variantId);
    }
    const again = await peekChoice(app, {
      token,
      companyId: kitIdentities.companies.a,
      conversationId: conversation.id,
      choiceId: record.choiceId,
    });
    expect(again.status).toBe(200);
    const claimed = await store.claim({
      choiceId: record.choiceId,
      bind: {
        actorId: kitIdentities.users.anna,
        companyId: kitIdentities.companies.a,
        conversationId: conversation.id,
      },
      optionId: optionByLabel.get("Red") ?? "",
    });
    expect(claimed.kind).toBe("claimed");
    const claimedPeek = await peekChoice(app, {
      token,
      companyId: kitIdentities.companies.a,
      conversationId: conversation.id,
      choiceId: record.choiceId,
    });
    expect(claimedPeek.status).toBe(200);
    const claimedEnvelope = staffAssistantChoiceCardEnvelopeSchema.parse(
      await claimedPeek.json(),
    );
    expect(claimedEnvelope.status).toBe("claimed");
    expect(claimedEnvelope.claimedOptionId).toBe(optionByLabel.get("Red"));
    const claimedSerialized = JSON.stringify(claimedEnvelope);
    expect(claimedSerialized).not.toContain("canonicalInput");
    expect(claimedSerialized).not.toContain("optionMap");
    expect(claimedSerialized).not.toContain("lineIndex");
    expect(claimedSerialized).not.toContain("actorId");
    expect(claimedSerialized).not.toContain(product.productId);
    expect(claimedSerialized).not.toContain(kitIdentities.companies.a);
    expect(claimedSerialized).not.toContain(kitIdentities.users.anna);
    for (const variant of product.variants) {
      expect(claimedSerialized).not.toContain(variant.variantId);
    }
    const missing = await peekChoice(app, {
      token,
      companyId: kitIdentities.companies.a,
      conversationId: conversation.id,
      choiceId: randomUUID(),
    });
    expect(missing.status).toBe(200);
    expect(await missing.json()).toEqual({ status: "expired" });
  });

  it("resumes a product picker then a variant picker sequentially without an LLM", async () => {
    const classify = vi.spyOn(ShowzyAi, "classifyStaffAssistantTurn");
    const stream = vi.spyOn(ShowzyAi, "streamStaffAssistantChat");
    const { app, store } = choiceApp();
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "Choice product then variant",
    });
    const customer = await staffInvoke(createCustomer, {
      name: "Macaron Buyer",
      phone: nextPhone(),
    });
    const product = await seedVariableProduct("Макаронси Seq", [
      "Lemon",
      "Vanilla",
    ]);
    const { record, optionByLabel } = await openProductChoice({
      store,
      conversationId: conversation.id,
      customerId: customer.id,
      query: "макаронс",
      catalogOptions: [
        { productId: product.productId, label: "Макаронси Seq" },
      ],
    });
    const productOption = optionByLabel.get("Макаронси Seq");
    expect(productOption).toBeDefined();
    const forged = await postChoice(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: {
        conversationId: conversation.id,
        choiceId: record.choiceId,
        optionId: product.productId,
      },
    });
    expect(forged.status).toBe(200);
    expect(await forged.json()).toMatchObject({
      status: "error",
      code: "CHOICE_INVALID_OPTION",
    });
    const firstTap = await postChoice(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: {
        conversationId: conversation.id,
        choiceId: record.choiceId,
        optionId: productOption,
      },
    });
    expect(firstTap.status).toBe(200);
    const firstBody = assistantChoiceInteractionResultSchema.parse(
      await firstTap.json(),
    );
    expect(firstBody.status).toBe("needs_choice");
    if (firstBody.status !== "needs_choice") {
      return;
    }
    expect(firstBody.choiceKind).toBe("variant");
    expect(firstBody.productName).toBe("Макаронси Seq");
    expect(firstBody.options.map((option) => option.label).toSorted()).toEqual([
      "Lemon",
      "Vanilla",
    ]);
    expect(JSON.stringify(firstBody)).not.toContain("Multiple matches");
    expect(JSON.stringify(firstBody)).not.toContain("canonicalInput");
    const lemon = firstBody.options.find((option) => option.label === "Lemon");
    expect(lemon).toBeDefined();
    const secondTap = await postChoice(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: {
        conversationId: conversation.id,
        choiceId: firstBody.challengeId,
        optionId: lemon?.id,
      },
    });
    expect(secondTap.status).toBe(200);
    const secondBody = assistantChoiceInteractionResultSchema.parse(
      await secondTap.json(),
    );
    expect(secondBody.status).toBe("completed");
    const companyOrders = (
      await kit.db.runtime.db.select().from(orders)
    ).filter((row) => row.customerId === customer.id);
    expect(companyOrders).toHaveLength(1);
    expect(classify).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
    classify.mockRestore();
    stream.mockRestore();
  });

  it("resumes a customer picker without an LLM and replays the same option", async () => {
    const classify = vi.spyOn(ShowzyAi, "classifyStaffAssistantTurn");
    const stream = vi.spyOn(ShowzyAi, "streamStaffAssistantChat");
    const { app, store } = choiceApp();
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "Choice customer picker",
    });
    const firstCustomer = await staffInvoke(createCustomer, {
      name: "Twin Katya Choice",
      phone: nextPhone(),
    });
    const secondCustomer = await staffInvoke(createCustomer, {
      name: "Twin Katya Choice",
      phone: nextPhone(),
    });
    const product = await seedSimpleProduct("Simple Choice Cake");
    const { record, optionByLabel } = await openCustomerChoice({
      store,
      conversationId: conversation.id,
      query: "Twin Katya Choice",
      productId: product.productId,
      catalogOptions: [
        {
          customerId: firstCustomer.id,
          label: "Twin Katya Choice (first)",
        },
        {
          customerId: secondCustomer.id,
          label: "Twin Katya Choice (second)",
        },
      ],
    });
    const optionId = optionByLabel.get("Twin Katya Choice (first)");
    expect(optionId).toBeDefined();
    const firstTap = await postChoice(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: {
        conversationId: conversation.id,
        choiceId: record.choiceId,
        optionId,
      },
    });
    expect(firstTap.status).toBe(200);
    const firstBody = assistantChoiceInteractionResultSchema.parse(
      await firstTap.json(),
    );
    expect(firstBody.status).toBe("completed");
    if (firstBody.status !== "completed") {
      return;
    }
    const replay = await postChoice(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: {
        conversationId: conversation.id,
        choiceId: record.choiceId,
        optionId,
      },
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(firstBody);
    const otherOption = optionByLabel.get("Twin Katya Choice (second)");
    const different = await postChoice(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: {
        conversationId: conversation.id,
        choiceId: record.choiceId,
        optionId: otherOption,
      },
    });
    expect(different.status).toBe(200);
    expect(await different.json()).toMatchObject({
      status: "error",
      code: "CHOICE_OPTION_CONFLICT",
    });
    const companyOrders = (
      await kit.db.runtime.db.select().from(orders)
    ).filter((row) => row.customerId === firstCustomer.id);
    expect(companyOrders).toHaveLength(1);
    expect(classify).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
    classify.mockRestore();
    stream.mockRestore();
  });

  it("returns presenter copy when another query-based cart product is archived before resume", async () => {
    const classify = vi.spyOn(ShowzyAi, "classifyStaffAssistantTurn");
    const stream = vi.spyOn(ShowzyAi, "streamStaffAssistantChat");
    const { app, store } = choiceApp();
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "Choice query archived after open",
    });
    const customer = await staffInvoke(createCustomer, {
      name: "T442 Query Archive Buyer",
      phone: nextPhone(),
    });
    const first = await seedVariableProduct("T442 Query Macarons", [
      "Lemon",
      "Vanilla",
    ]);
    const extra = await seedSimpleProduct("T442 Query Cupcake");
    const { record, optionByLabel } = await openChoice({
      store,
      conversationId: conversation.id,
      customerId: customer.id,
      product: first,
      extraProducts: [{ query: extra.name }],
      locale: "uk",
    });
    await staffInvoke(archiveProduct, { productId: extra.productId });
    const bind = {
      actorId: kitIdentities.users.anna,
      companyId: kitIdentities.companies.a,
      conversationId: conversation.id,
    };
    const response = await postChoice(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: {
        conversationId: conversation.id,
        choiceId: record.choiceId,
        optionId: optionByLabel.get("Lemon"),
      },
    });
    expect(response.status).toBe(200);
    const body = assistantChoiceInteractionResultSchema.parse(
      await response.json(),
    );
    expect(body.status).toBe("error");
    if (body.status !== "error") {
      classify.mockRestore();
      stream.mockRestore();
      return;
    }
    const expected = presentCatalogDomainError({
      locale: "uk",
      extras: {
        reason: "archived",
        subject: { kind: "product_name", name: extra.name },
      },
    });
    expect(body.code).toBe("CONFLICT");
    expect(body.message).toBe(expected);
    expect(body.message).not.toBe(`"${extra.name}" is archived.`);
    const successor = await store.peek({
      choiceId: successorChoiceId(record.choiceId),
      bind,
    });
    expect(successor.kind).toBe("expired");
    const parent = await store.peek({
      choiceId: record.choiceId,
      bind,
    });
    expect(parent.kind).toBe("found");
    if (parent.kind === "found") {
      expect(parent.record.status).toBe("completed");
    }
    const persisted = (
      await kit.db.runtime.db.select().from(assistantMessages)
    ).filter(
      (row) =>
        row.conversationId === conversation.id && row.role === "assistant",
    );
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.body).toBe(expected);
    const companyOrders = (
      await kit.db.runtime.db.select().from(orders)
    ).filter((row) => row.customerId === customer.id);
    expect(companyOrders).toHaveLength(0);
    expect(classify).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
    classify.mockRestore();
    stream.mockRestore();
  });

  it("returns English presenter copy on resume when locale is en", async () => {
    const { app, store } = choiceApp();
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "Choice query archived en",
    });
    const customer = await staffInvoke(createCustomer, {
      name: "T442 Query Archive En Buyer",
      phone: nextPhone(),
    });
    const first = await seedVariableProduct("T442 En Macarons", [
      "Lemon",
      "Vanilla",
    ]);
    const extra = await seedSimpleProduct("T442 En Cupcake");
    const { record, optionByLabel } = await openChoice({
      store,
      conversationId: conversation.id,
      customerId: customer.id,
      product: first,
      extraProducts: [{ query: extra.name }],
      locale: "en",
    });
    await staffInvoke(archiveProduct, { productId: extra.productId });
    const response = await postChoice(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: {
        conversationId: conversation.id,
        choiceId: record.choiceId,
        optionId: optionByLabel.get("Lemon"),
      },
    });
    expect(response.status).toBe(200);
    const body = assistantChoiceInteractionResultSchema.parse(
      await response.json(),
    );
    expect(body.status).toBe("error");
    if (body.status !== "error") {
      return;
    }
    expect(body.message).toBe(
      presentCatalogDomainError({
        locale: "en",
        extras: {
          reason: "archived",
          subject: { kind: "product_name", name: extra.name },
        },
      }),
    );
  });

  it("returns presenter copy when a later variable line loses all active variants before resume", async () => {
    const classify = vi.spyOn(ShowzyAi, "classifyStaffAssistantTurn");
    const stream = vi.spyOn(ShowzyAi, "streamStaffAssistantChat");
    const { app, store } = choiceApp();
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "Choice later variants archived after open",
    });
    const customer = await staffInvoke(createCustomer, {
      name: "T442 Later Variants Buyer",
      phone: nextPhone(),
    });
    const first = await seedVariableProduct("T442 Later First", [
      "Lemon",
      "Vanilla",
    ]);
    const later = await seedVariableProduct("T442 Later Eclairs", [
      "Coffee",
      "Chocolate",
    ]);
    const { record, optionByLabel } = await openChoice({
      store,
      conversationId: conversation.id,
      customerId: customer.id,
      product: first,
      extraProducts: [{ productId: later.productId }],
      locale: "uk",
    });
    for (const variant of later.variants) {
      await staffInvoke(archiveVariant, { variantId: variant.variantId });
    }
    const bind = {
      actorId: kitIdentities.users.anna,
      companyId: kitIdentities.companies.a,
      conversationId: conversation.id,
    };
    const response = await postChoice(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: {
        conversationId: conversation.id,
        choiceId: record.choiceId,
        optionId: optionByLabel.get("Lemon"),
      },
    });
    expect(response.status).toBe(200);
    const body = assistantChoiceInteractionResultSchema.parse(
      await response.json(),
    );
    expect(body.status).toBe("error");
    if (body.status !== "error") {
      classify.mockRestore();
      stream.mockRestore();
      return;
    }
    const expected = presentCatalogDomainError({
      locale: "uk",
      extras: {
        reason: "no_active_variants",
        subject: { kind: "product_name", name: later.name },
      },
    });
    expect(body.message).toBe(expected);
    const successor = await store.peek({
      choiceId: successorChoiceId(record.choiceId),
      bind,
    });
    expect(successor.kind).toBe("expired");
    const persisted = (
      await kit.db.runtime.db.select().from(assistantMessages)
    ).filter(
      (row) =>
        row.conversationId === conversation.id && row.role === "assistant",
    );
    expect(persisted[0]?.body).toBe(expected);
    const companyOrders = (
      await kit.db.runtime.db.select().from(orders)
    ).filter((row) => row.customerId === customer.id);
    expect(companyOrders).toHaveLength(0);
    expect(classify).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
    classify.mockRestore();
    stream.mockRestore();
  });

  it("keeps archived product ids on the generic NOT_FOUND path", async () => {
    const { app, store } = choiceApp();
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "Choice archived product id",
    });
    const customer = await staffInvoke(createCustomer, {
      name: "T442 Id Archive Buyer",
      phone: nextPhone(),
    });
    const first = await seedVariableProduct("T442 Id Macarons", [
      "Lemon",
      "Vanilla",
    ]);
    const extra = await seedSimpleProduct("T442 Id Cupcake");
    const { record, optionByLabel } = await openChoice({
      store,
      conversationId: conversation.id,
      customerId: customer.id,
      product: first,
      extraProducts: [{ productId: extra.productId }],
    });
    await staffInvoke(archiveProduct, { productId: extra.productId });
    const bind = {
      actorId: kitIdentities.users.anna,
      companyId: kitIdentities.companies.a,
      conversationId: conversation.id,
    };
    const response = await postChoice(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: {
        conversationId: conversation.id,
        choiceId: record.choiceId,
        optionId: optionByLabel.get("Lemon"),
      },
    });
    expect(response.status).toBe(404);
    const body = (await response.json()) as {
      readonly code?: string;
      readonly message?: string;
    };
    expect(body.code).toBe("NOT_FOUND");
    expect(body.message).not.toContain("в архіві");
    expect(body.message).not.toContain("is archived and cannot be added");
    const persisted = (
      await kit.db.runtime.db.select().from(assistantMessages)
    ).filter(
      (row) =>
        row.conversationId === conversation.id && row.role === "assistant",
    );
    expect(persisted).toHaveLength(0);
    const parent = await store.peek({
      choiceId: record.choiceId,
      bind,
    });
    expect(parent.kind).toBe("found");
    if (parent.kind === "found") {
      expect(parent.record.status).toBe("claimed");
    }
    const companyOrders = (
      await kit.db.runtime.db.select().from(orders)
    ).filter((row) => row.customerId === customer.id);
    expect(companyOrders).toHaveLength(0);
  });

  it("keeps archived variant ids on the generic NOT_FOUND path", async () => {
    const { app, store } = choiceApp();
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await staffInvoke(createConversation, {
      title: "Choice archived variant id",
    });
    const customer = await staffInvoke(createCustomer, {
      name: "T442 Variant Id Buyer",
      phone: nextPhone(),
    });
    const first = await seedVariableProduct("T442 Variant First", [
      "Lemon",
      "Vanilla",
    ]);
    const extra = await seedVariableProduct("T442 Variant Extra", ["One"]);
    const extraVariantId = extra.variants[0]?.variantId;
    expect(extraVariantId).toBeDefined();
    if (extraVariantId === undefined) {
      return;
    }
    const { record, optionByLabel } = await openChoice({
      store,
      conversationId: conversation.id,
      customerId: customer.id,
      product: first,
      extraLineItems: [
        {
          product: { by: "id", id: extra.productId },
          variantSelection: {
            kind: "reference",
            ref: { by: "id", id: extraVariantId },
          },
          quantity: { milli: "1000" },
        },
      ],
    });
    await staffInvoke(archiveVariant, { variantId: extraVariantId });
    const response = await postChoice(app, {
      token,
      companyId: kitIdentities.companies.a,
      body: {
        conversationId: conversation.id,
        choiceId: record.choiceId,
        optionId: optionByLabel.get("Lemon"),
      },
    });
    expect(response.status).toBe(404);
    const body = (await response.json()) as {
      readonly code?: string;
      readonly message?: string;
    };
    expect(body.code).toBe("NOT_FOUND");
    expect(body.message).not.toContain("не має активних варіантів");
    expect(body.message).not.toContain("has no active variants");
    const companyOrders = (
      await kit.db.runtime.db.select().from(orders)
    ).filter((row) => row.customerId === customer.id);
    expect(companyOrders).toHaveLength(0);
  });

  it("keeps the confirmation resume path in assistant-chat.ts", () => {
    const chat = readFileSync(join(here, "assistant-chat.ts"), "utf8");
    expect(chat).toContain("CONFIRMATION_CHALLENGE_HEADER");
    expect(chat).toContain("confirmationResume");
    expect(chat).not.toContain("executeStaffAssistantChoiceResume");
  });
});
