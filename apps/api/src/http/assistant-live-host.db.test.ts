/**
 * SHO-524 live staff assistant host HTTP goldens. Production `createApp`
 * routes only (`/assistant/chat`, `/choice`, `/confirm`, pending
 * abandon/peek). T3 unpublished `/assistant/host/chat` tests stay in
 * `assistant-host.db.test.ts`.
 */
import { randomBytes, randomUUID } from "node:crypto";

import {
  assistantHostInteractionResultSchema,
  assistantPendingPeekResultSchema,
  attemptKey,
  confirmationPendingRecord,
  executionAttemptKey,
  ORDERS_CREATE_TOOL_NAME,
  ORDERS_LIST_PAGE_TOOL_NAME,
  PENDING_REPLACE_TOOL_NAME,
  pendingChoiceRecordFromChoiceRecord,
  STAFF_ASSISTANT_SUCCESS_SPEECH_FALLBACK,
  toProviderToolName,
  type PendingInteractionRecord,
} from "@showzy/ai";
import {
  MockLanguageModelV3,
  mockTextStream,
  mockToolCallStream,
} from "@showzy/ai/test";
import {
  appendUserMessage,
  checkpointAssistantTurn,
  createConversation,
  getModelHistory,
} from "@showzy/assistant";
import { archiveProduct, createProduct } from "@showzy/catalog";
import { COMPANY_SELECTOR_HEADER, contractModules } from "@showzy/contract";
import {
  createConfirmationHook,
  createInMemoryConfirmationStore,
  createInMemoryRateLimitStore,
  executeAction,
  type ConfirmationStore,
  type ImplementedAction,
} from "@showzy/core";
import { ConfirmationRequiredError } from "@showzy/core/errors";
import {
  createTestKit,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import {
  archiveCustomer,
  createCustomer,
  deleteCustomer,
} from "@showzy/customers";
import { createOrder } from "@showzy/orders";
import { session } from "@showzy/db/schema/auth";
import {
  assistantMessages,
  assistantToolRuns,
} from "@showzy/db/schema/assistant";
import { companyCustomers } from "@showzy/db/schema/customers";
import { orders } from "@showzy/db/schema/orders";
import { ASSISTANT_SURFACE_REGISTRY } from "@showzy/validation/assistant-surfaces";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";

import { buildAuthOptions } from "../auth/options.js";
import { createAtomicOtpSendStore } from "../auth/otp-send-guard.js";
import { createActionRegistry } from "../composition.js";
import {
  createMemoryAuthRateLimitStore,
  createMemorySecondaryStorage,
} from "../stores/memory.js";
import {
  createMemoryConversationLock,
  type ConversationLock,
} from "../stores/conversation-lock.js";
import {
  createMemoryPendingStore,
  type StaffAssistantPendingStore,
} from "../stores/pending.js";
import { createApp, type AuthInstance } from "./app.js";
import {
  ASSISTANT_CHAT_PATH,
  ASSISTANT_INVOCATION_CHANNEL,
} from "./assistant-chat.js";
import {
  ASSISTANT_CONFIRM_PATH,
  ASSISTANT_HOST_CHOICE_PATH,
  ASSISTANT_PENDING_ABANDON_PATH,
  ASSISTANT_PENDING_PATH,
} from "./assistant-host.js";
import { REQUEST_ID_HEADER } from "./request-id.js";

const REAL_CLIENT = "203.0.113.52";
const DELETE_CUSTOMER_TOOL = toProviderToolName("customers.deleteCustomer");

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
});

afterAll(async () => {
  await kit.db.close();
});

function nextPhone(): string {
  phoneSeq += 1;
  return `+3806796${String(phoneSeq).padStart(5, "0")}`;
}

function countingConfirmationStore(): {
  readonly store: ConfirmationStore;
  readonly consumeCount: () => number;
} {
  const inner = createInMemoryConfirmationStore();
  let consumes = 0;
  return {
    store: {
      set(key, value, ttlMs) {
        return inner.set(key, value, ttlMs);
      },
      getAndDelete(key) {
        consumes += 1;
        return inner.getAndDelete(key);
      },
    },
    consumeCount: () => consumes,
  };
}

function silentModel(text = "Okay."): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: () => Promise.resolve(mockTextStream(text)),
  });
}

function failingGenerationModel(): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: () => Promise.reject(new Error("generation failed")),
  });
}

function ordersCreateUnlessRecoveredModel(options: {
  readonly recoveredToolCallId: string;
  readonly facadeInput: unknown;
  readonly speech: string;
  readonly reissueToolCallId?: string;
}): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: (call) => {
      const serialized = JSON.stringify(call.prompt);
      if (serialized.includes(options.recoveredToolCallId)) {
        return Promise.resolve(mockTextStream(options.speech));
      }
      return Promise.resolve(
        mockToolCallStream(
          options.reissueToolCallId ?? "call-reissue-create",
          ORDERS_CREATE_TOOL_NAME,
          JSON.stringify(options.facadeInput),
        ),
      );
    },
  });
}

function listThenSpeakModel(): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: [
      mockToolCallStream("call-list", ORDERS_LIST_PAGE_TOOL_NAME, "{}"),
      mockTextStream("Here is the list."),
    ],
  });
}

type Harness = {
  readonly app: ReturnType<typeof createApp>;
  readonly pendingStore: StaffAssistantPendingStore;
  readonly consumeCount: () => number;
  invoke: <TInput extends z.ZodType, TOutput extends z.ZodType, TTarget>(
    action: ImplementedAction<TInput, TOutput, TTarget>,
    input: unknown,
    request?: {
      readonly idempotencyKey?: string;
      readonly confirmationChallengeId?: string;
    },
  ) => Promise<z.output<TOutput>>;
};

function pendingBindFor(conversationId: string): {
  readonly actorId: string;
  readonly companyId: string;
  readonly conversationId: string;
} {
  return {
    actorId: kitIdentities.users.anna,
    companyId: kitIdentities.companies.a,
    conversationId,
  };
}

function liveApp(options?: {
  readonly model?: MockLanguageModelV3;
  readonly pendingStore?: StaffAssistantPendingStore;
  readonly conversationLock?: ConversationLock;
  readonly confirmation?: ReturnType<typeof countingConfirmationStore>;
}): Harness {
  const pendingStore = options?.pendingStore ?? createMemoryPendingStore();
  const confirmation = options?.confirmation ?? countingConfirmationStore();
  const pipeline = {
    ...kit.pipeline,
    hooks: {
      ...kit.pipeline.hooks,
      confirmation: createConfirmationHook({ store: confirmation.store }),
      // HITL seed finishRun plus host checkpoints would exhaust the
      // shared kit-wide staff bucket (120/min) across this file.
      rateLimit: { enforce: () => Promise.resolve() },
    },
  };
  const app = createApp({
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
      languageModel: options?.model ?? silentModel(),
    },
    pendingStore,
    conversationLock:
      options?.conversationLock ?? createMemoryConversationLock(),
  });
  return {
    app,
    pendingStore,
    consumeCount: confirmation.consumeCount,
    invoke(action, input, request) {
      return executeAction(pipeline, {
        action,
        input,
        request: {
          requestId: randomUUID(),
          correlationId: randomUUID(),
          channel: ASSISTANT_INVOCATION_CHANNEL,
          clientIp: REAL_CLIENT,
          idempotencyKey: request?.idempotencyKey ?? randomUUID(),
          ...(request?.confirmationChallengeId !== undefined
            ? { confirmationChallengeId: request.confirmationChallengeId }
            : {}),
        },
        principal: {
          mode: "staff",
          session: { userId: kitIdentities.users.anna },
          companySelector: kitIdentities.companies.a,
        },
      });
    },
  };
}

async function liveRequest(
  app: ReturnType<typeof createApp>,
  options: {
    readonly method: "GET" | "POST";
    readonly path: string;
    readonly token: string;
    readonly body?: unknown;
  },
): Promise<Response> {
  const headers = new Headers({
    origin: "http://localhost:3000",
    authorization: `Bearer ${options.token}`,
    [COMPANY_SELECTOR_HEADER]: kitIdentities.companies.a,
  });
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  headers.set(REQUEST_ID_HEADER, randomUUID());
  return app.request(options.path, {
    method: options.method,
    headers,
    ...(options.body !== undefined
      ? { body: JSON.stringify(options.body) }
      : {}),
  });
}

async function parseOk(response: Response) {
  expect(response.status).toBe(200);
  const body = assistantHostInteractionResultSchema.parse(
    await response.json(),
  );
  if (body.status !== "ok") {
    expect.fail(JSON.stringify(body));
  }
  return body;
}

async function peekPending(
  app: ReturnType<typeof createApp>,
  token: string,
  conversationId: string,
) {
  const peek = await liveRequest(app, {
    method: "GET",
    path: `${ASSISTANT_PENDING_PATH}?conversationId=${conversationId}`,
    token,
  });
  return assistantPendingPeekResultSchema.parse(await peek.json());
}

function uniqueCreateInput(
  customerId: string,
  product: {
    readonly productId: string;
    readonly variants: readonly { readonly variantId: string }[];
  },
): string {
  const variantId = product.variants[0]?.variantId;
  return JSON.stringify({
    customerId,
    items: [
      {
        productId: product.productId,
        ...(variantId === undefined ? {} : { variantId }),
        quantityMilli: "1000",
      },
    ],
  });
}

function pickerCreateInput(customerId: string, productId: string): string {
  return JSON.stringify({
    customerId,
    items: [{ productId, quantityMilli: "1000" }],
  });
}

function uniqueCreateModel(
  customerId: string,
  product: {
    readonly productId: string;
    readonly variants: readonly { readonly variantId: string }[];
  },
): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: [
      mockToolCallStream(
        "call-create",
        ORDERS_CREATE_TOOL_NAME,
        uniqueCreateInput(customerId, product),
      ),
      mockTextStream("Order created."),
    ],
  });
}

function pickerCreateModel(
  customerId: string,
  productId: string,
): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: [
      mockToolCallStream(
        "call-create",
        ORDERS_CREATE_TOOL_NAME,
        pickerCreateInput(customerId, productId),
      ),
      mockTextStream("Pick a flavour."),
    ],
  });
}

async function orderCount(): Promise<number> {
  return (await kit.db.runtime.db.select({ id: orders.id }).from(orders))
    .length;
}

async function conversationToolRuns(conversationId: string) {
  return (await kit.db.runtime.db.select().from(assistantToolRuns)).filter(
    (row) => row.conversationId === conversationId,
  );
}

const KNOWN_RESUME_SURFACE_KINDS = new Set<string>(
  ASSISTANT_SURFACE_REGISTRY.map((descriptor) => descriptor.kind),
);

type OkResumeEnvelope = Extract<
  z.output<typeof assistantHostInteractionResultSchema>,
  { status: "ok" }
>;

function expectKnownResumeCardKinds(cards: OkResumeEnvelope["cards"]): void {
  for (const card of cards) {
    if (card.kind !== "surface") {
      continue;
    }
    expect(KNOWN_RESUME_SURFACE_KINDS.has(card.surface)).toBe(true);
  }
}

function surfaceCard(
  cards: OkResumeEnvelope["cards"],
  surface: string,
): Extract<OkResumeEnvelope["cards"][number], { kind: "surface" }> | undefined {
  const card = cards.find(
    (item) => item.kind === "surface" && item.surface === surface,
  );
  if (card === undefined || card.kind !== "surface") {
    return undefined;
  }
  return card;
}

function orderIdFromEntityCard(cards: OkResumeEnvelope["cards"]): string {
  const card = surfaceCard(cards, "order-entity");
  expect(card).toBeDefined();
  if (card === undefined) {
    throw new Error("expected order-entity surface card");
  }
  if (
    typeof card.data !== "object" ||
    card.data === null ||
    !("kind" in card.data) ||
    !("orderId" in card.data) ||
    card.data.kind !== "order-entity" ||
    typeof card.data.orderId !== "string"
  ) {
    throw new Error("order-entity card missing orderId");
  }
  return card.data.orderId;
}

async function customerRow(
  customerId: string,
): Promise<{ readonly id: string } | undefined> {
  const rows = (await kit.db.runtime.db.select().from(companyCustomers)).filter(
    (row) => row.id === customerId,
  );
  return rows[0];
}

async function stageExecution(
  h: Harness,
  conversationId: string,
  actionName: string,
  toolInput: unknown,
): Promise<string> {
  const beginKey = `begin:seed:${randomUUID()}`;
  const begun = await h.invoke(
    checkpointAssistantTurn,
    { kind: "begin", conversationId, turnKey: beginKey },
    {
      idempotencyKey: attemptKey("turn", conversationId, beginKey),
    },
  );
  const staged = await h.invoke(
    checkpointAssistantTurn,
    {
      kind: "stageRun",
      conversationId,
      messageId: begun.messageId,
      seq: 0,
      actionName,
      toolName: actionName.replace(".", "_"),
      toolCallId: `seed:${randomUUID()}`,
      toolInput,
    },
    {
      idempotencyKey: attemptKey(
        "turn",
        conversationId,
        `stage:${begun.messageId}:0`,
      ),
    },
  );
  if (staged.executionId === null) {
    throw new Error("stageRun returned no executionId");
  }
  return staged.executionId;
}

async function stageNamedStartedRun(
  h: Harness,
  options: {
    readonly conversationId: string;
    readonly beginKey: string;
    readonly actionName: string;
    readonly toolName: string;
    readonly toolCallId: string;
    readonly toolInput: unknown;
  },
): Promise<{ readonly messageId: string; readonly executionId: string }> {
  const begun = await h.invoke(
    checkpointAssistantTurn,
    {
      kind: "begin",
      conversationId: options.conversationId,
      turnKey: options.beginKey,
    },
    {
      idempotencyKey: attemptKey(
        "turn",
        options.conversationId,
        options.beginKey,
      ),
    },
  );
  const staged = await h.invoke(
    checkpointAssistantTurn,
    {
      kind: "stageRun",
      conversationId: options.conversationId,
      messageId: begun.messageId,
      seq: 0,
      actionName: options.actionName,
      toolName: options.toolName,
      toolCallId: options.toolCallId,
      toolInput: options.toolInput,
    },
    {
      idempotencyKey: attemptKey(
        "turn",
        options.conversationId,
        `stage:${begun.messageId}:0`,
      ),
    },
  );
  if (staged.executionId === null) {
    throw new Error("stageRun returned no executionId");
  }
  return { messageId: begun.messageId, executionId: staged.executionId };
}

async function cakeCreateInputs(
  h: Harness,
  label: string,
): Promise<{
  readonly facadeInput: {
    readonly customerId: string;
    readonly items: readonly {
      readonly productId: string;
      readonly variantId: string;
      readonly quantityMilli: string;
    }[];
  };
  readonly canonicalInput: {
    readonly customer: { readonly by: "id"; readonly id: string };
    readonly items: readonly {
      readonly product: { readonly by: "id"; readonly id: string };
      readonly variantSelection: {
        readonly kind: "reference";
        readonly ref: { readonly by: "id"; readonly id: string };
      };
      readonly quantity: { readonly milli: string };
    }[];
  };
}> {
  const customer = await h.invoke(createCustomer, {
    name: `${label} Buyer`,
    phone: nextPhone(),
  });
  const product = await h.invoke(createProduct, {
    name: `${label} Cake`,
    basePriceMinor: "1800",
    variants: [{ name: "Solo" }],
  });
  const variant = product.variants[0];
  if (variant === undefined) {
    throw new Error(`${label} product missing variant`);
  }
  return {
    facadeInput: {
      customerId: customer.id,
      items: [
        {
          productId: product.productId,
          variantId: variant.variantId,
          quantityMilli: "1000",
        },
      ],
    },
    canonicalInput: {
      customer: { by: "id", id: customer.id },
      items: [
        {
          product: { by: "id", id: product.productId },
          variantSelection: {
            kind: "reference",
            ref: { by: "id", id: variant.variantId },
          },
          quantity: { milli: "1000" },
        },
      ],
    },
  };
}

async function padUserMessages(
  h: Harness,
  conversationId: string,
  count: number,
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await h.invoke(
      appendUserMessage,
      {
        conversationId,
        body: `pad-user-${String(index)}`,
      },
      { idempotencyKey: attemptKey("message", conversationId, randomUUID()) },
    );
  }
}

async function finishSeededHitlRun(
  h: Harness,
  options: {
    readonly conversationId: string;
    readonly executionId: string;
    readonly outcome: "choice_required" | "confirmation_required";
    readonly challengeId: string;
    readonly modelTrace: unknown;
  },
): Promise<void> {
  await h.invoke(
    checkpointAssistantTurn,
    {
      kind: "finishRun",
      conversationId: options.conversationId,
      executionId: options.executionId,
      outcome: options.outcome,
      resultIds: [],
      modelTrace: options.modelTrace,
      challengeId: options.challengeId,
    },
    {
      idempotencyKey: attemptKey(
        "turn",
        options.conversationId,
        `finish:${options.executionId}:${options.outcome}`,
      ),
    },
  );
}

async function seedChoicePending(
  h: Harness,
  options: {
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
    readonly extraProductId?: string;
  },
): Promise<{
  readonly record: Extract<PendingInteractionRecord, { kind: "choice" }>;
}> {
  const choiceId = randomUUID();
  const optionMap: Record<string, string> = {};
  const envelopeOptions = options.product.variants.map((variant) => {
    const optionId = randomUUID();
    optionMap[optionId] = variant.variantId;
    return { id: optionId, label: variant.name };
  });
  const items: Array<{
    product: { by: "id"; id: string };
    variantSelection: { kind: "unspecified" };
    quantity: { milli: string };
  }> = [
    {
      product: { by: "id", id: options.product.productId },
      variantSelection: { kind: "unspecified" },
      quantity: { milli: "1000" },
    },
  ];
  if (options.extraProductId !== undefined) {
    items.push({
      product: { by: "id", id: options.extraProductId },
      variantSelection: { kind: "unspecified" },
      quantity: { milli: "1000" },
    });
  }
  const canonicalInput = {
    customer: { by: "id" as const, id: options.customerId },
    items,
  };
  const productIds = [
    options.product.productId,
    ...(options.extraProductId !== undefined ? [options.extraProductId] : []),
  ];
  const facadeInput = {
    customerId: options.customerId,
    items: productIds.map((productId) => ({
      productId,
      quantityMilli: "1000",
    })),
  };
  const executionId = await stageExecution(
    h,
    options.conversationId,
    "orders.create",
    facadeInput,
  );
  const record = pendingChoiceRecordFromChoiceRecord(
    {
      status: "open",
      choiceId,
      actorId: kitIdentities.users.anna,
      companyId: kitIdentities.companies.a,
      conversationId: options.conversationId,
      canonicalInput,
      target: {
        lineIndex: 0,
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
      locale: "uk",
    },
    {
      actionName: "orders.create",
      toolCallId: `choice:${choiceId}`,
      executionId,
    },
  );
  expect(await h.pendingStore.open(record)).toBe(true);
  await finishSeededHitlRun(h, {
    conversationId: options.conversationId,
    executionId,
    outcome: "choice_required",
    challengeId: choiceId,
    modelTrace: record.envelope,
  });
  return { record };
}

async function seedConfirmationPending(
  h: Harness,
  conversationId: string,
): Promise<{
  readonly customerId: string;
  readonly challengeId: string;
  readonly executionId: string;
}> {
  const customer = await h.invoke(createCustomer, {
    name: "Live Delete Target",
    phone: nextPhone(),
  });
  await h.invoke(archiveCustomer, { id: customer.id });
  const canonicalInput = { id: customer.id };
  const executionId = await stageExecution(
    h,
    conversationId,
    "customers.deleteCustomer",
    canonicalInput,
  );
  const unconfirmed = await h
    .invoke(deleteCustomer, canonicalInput, {
      idempotencyKey: executionAttemptKey(conversationId, executionId),
    })
    .then(
      () => {
        throw new Error("expected ConfirmationRequiredError");
      },
      (error: unknown) => error,
    );
  expect(unconfirmed).toBeInstanceOf(ConfirmationRequiredError);
  if (!(unconfirmed instanceof ConfirmationRequiredError)) {
    throw new Error("expected ConfirmationRequiredError");
  }
  const record = confirmationPendingRecord({
    challengeId: unconfirmed.challenge.challengeId,
    bind: pendingBindFor(conversationId),
    actionName: "customers.deleteCustomer",
    toolCallId: `call-delete:${customer.id}`,
    canonicalInput,
    summary: unconfirmed.challenge.summary,
    challengeExpiresAt: unconfirmed.challenge.expiresAt,
    executionId,
    locale: "uk",
  });
  expect(await h.pendingStore.open(record)).toBe(true);
  await finishSeededHitlRun(h, {
    conversationId,
    executionId,
    outcome: "confirmation_required",
    challengeId: unconfirmed.challenge.challengeId,
    modelTrace: {
      status: "confirmation_required",
      challengeId: unconfirmed.challenge.challengeId,
      summary: unconfirmed.challenge.summary,
    },
  });
  return {
    customerId: customer.id,
    challengeId: unconfirmed.challenge.challengeId,
    executionId,
  };
}

describe("live staff assistant host HTTP (SHO-524)", () => {
  it("creates a unique orders.create through POST /assistant/chat", async () => {
    const h = liveApp();
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await h.invoke(createConversation, {
      title: "Live unique create",
    });
    const customer = await h.invoke(createCustomer, {
      name: "Live Unique Buyer",
      phone: nextPhone(),
    });
    const product = await h.invoke(createProduct, {
      name: "Live Unique Cake",
      basePriceMinor: "1500",
      variants: [{ name: "Default" }],
    });
    const before = await orderCount();
    const chat = liveApp({
      pendingStore: h.pendingStore,
      model: uniqueCreateModel(customer.id, product),
    });
    const body = await parseOk(
      await liveRequest(chat.app, {
        method: "POST",
        path: ASSISTANT_CHAT_PATH,
        token,
        body: {
          conversationId: conversation.id,
          text: "створи замовлення",
          locale: "uk",
        },
      }),
    );
    expect(body.pending).toBeNull();
    expect(body.speech).toBe("Order created.");
    expect(await orderCount()).toBe(before + 1);
    expect(
      (await peekPending(chat.app, token, conversation.id)).pending,
    ).toBeNull();
  });

  it("sequential clarify uses pending_replace, not a second orders.create", async () => {
    const pendingStore = createMemoryPendingStore();
    const h = liveApp({ pendingStore });
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await h.invoke(createConversation, {
      title: "Live sequential replace",
    });
    const firstCustomer = await h.invoke(createCustomer, {
      name: "Clarify First",
      phone: nextPhone(),
    });
    const secondCustomer = await h.invoke(createCustomer, {
      name: "Clarify Second",
      phone: nextPhone(),
    });
    const product = await h.invoke(createProduct, {
      name: "Clarify Cake",
      basePriceMinor: "1500",
      variants: [{ name: "A" }, { name: "B" }],
    });
    const opened = await parseOk(
      await liveRequest(
        liveApp({
          pendingStore,
          model: pickerCreateModel(firstCustomer.id, product.productId),
        }).app,
        {
          method: "POST",
          path: ASSISTANT_CHAT_PATH,
          token,
          body: {
            conversationId: conversation.id,
            text: "замовлення торт",
            locale: "uk",
          },
        },
      ),
    );
    expect(opened.pending?.kind).toBe("choice");
    expect(opened.pending?.actionName).toBe("orders.create");
    const before = await orderCount();
    const replaced = await parseOk(
      await liveRequest(
        liveApp({
          pendingStore,
          model: new MockLanguageModelV3({
            doStream: [
              mockToolCallStream(
                "call-replace",
                PENDING_REPLACE_TOOL_NAME,
                JSON.stringify({
                  customerId: secondCustomer.id,
                  items: [
                    {
                      productId: product.productId,
                      quantityMilli: "1000",
                    },
                  ],
                }),
              ),
              mockTextStream("Clarified the customer."),
            ],
          }),
        }).app,
        {
          method: "POST",
          path: ASSISTANT_CHAT_PATH,
          token,
          body: {
            conversationId: conversation.id,
            text: "насправді іншому клієнту",
            locale: "uk",
          },
        },
      ),
    );
    expect(replaced.pending?.kind).toBe("choice");
    expect(replaced.pending?.id).not.toBe(opened.pending?.id);
    expect(await orderCount()).toBe(before);
    const peeked = await pendingStore.peekOpen({
      conversationId: conversation.id,
      bind: pendingBindFor(conversation.id),
    });
    expect(peeked.kind).toBe("found");
    if (peeked.kind !== "found" || peeked.record.kind !== "choice") {
      throw new Error("expected replaced choice pending");
    }
    expect(peeked.record.canonicalInput.customer).toEqual({
      by: "id",
      id: secondCustomer.id,
    });
  });

  it("quantity change via pending_replace rebuilds the picker", async () => {
    const pendingStore = createMemoryPendingStore();
    const h = liveApp({ pendingStore });
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await h.invoke(createConversation, {
      title: "Live qty replace",
    });
    const customer = await h.invoke(createCustomer, {
      name: "Qty Live Buyer",
      phone: nextPhone(),
    });
    const product = await h.invoke(createProduct, {
      name: "Qty Live Cake",
      basePriceMinor: "1500",
      variants: [{ name: "A" }, { name: "B" }],
    });
    const opened = await parseOk(
      await liveRequest(
        liveApp({
          pendingStore,
          model: pickerCreateModel(customer.id, product.productId),
        }).app,
        {
          method: "POST",
          path: ASSISTANT_CHAT_PATH,
          token,
          body: {
            conversationId: conversation.id,
            text: "торт",
            locale: "uk",
          },
        },
      ),
    );
    const staleOptionId =
      opened.pending?.kind === "choice"
        ? opened.pending.envelope.options[0]?.id
        : undefined;
    expect(staleOptionId).toEqual(expect.any(String));
    const before = await orderCount();
    const replaced = await parseOk(
      await liveRequest(
        liveApp({
          pendingStore,
          model: new MockLanguageModelV3({
            doStream: [
              mockToolCallStream(
                "call-replace",
                PENDING_REPLACE_TOOL_NAME,
                JSON.stringify({
                  customerId: customer.id,
                  items: [
                    {
                      productId: product.productId,
                      quantityMilli: "3000",
                    },
                  ],
                }),
              ),
              mockTextStream("Quantity is now three."),
            ],
          }),
        }).app,
        {
          method: "POST",
          path: ASSISTANT_CHAT_PATH,
          token,
          body: {
            conversationId: conversation.id,
            text: "зроби три",
            locale: "uk",
          },
        },
      ),
    );
    expect(replaced.pending?.kind).toBe("choice");
    expect(replaced.pending?.id).not.toBe(opened.pending?.id);
    const peeked = await pendingStore.peekOpen({
      conversationId: conversation.id,
      bind: pendingBindFor(conversation.id),
    });
    expect(peeked.kind).toBe("found");
    if (peeked.kind !== "found" || peeked.record.kind !== "choice") {
      throw new Error("expected qty-replaced choice pending");
    }
    expect(peeked.record.canonicalInput.items[0]?.quantity).toEqual({
      milli: "3000",
    });
    const stale = await liveRequest(h.app, {
      method: "POST",
      path: ASSISTANT_HOST_CHOICE_PATH,
      token,
      body: {
        conversationId: conversation.id,
        choiceId: opened.pending?.id,
        optionId: staleOptionId,
      },
    });
    expect(
      assistantHostInteractionResultSchema.parse(await stale.json()),
    ).toEqual({ status: "expired" });
    expect(await orderCount()).toBe(before);
  });

  it("ще одне замовлення іншому клієнту does not overwrite the open pending", async () => {
    const pendingStore = createMemoryPendingStore();
    const h = liveApp({ pendingStore });
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await h.invoke(createConversation, {
      title: "Live refuse second create",
    });
    const katia = await h.invoke(createCustomer, {
      name: "Katia Live",
      phone: nextPhone(),
    });
    const olena = await h.invoke(createCustomer, {
      name: "Olena Live",
      phone: nextPhone(),
    });
    const product = await h.invoke(createProduct, {
      name: "Refuse Cake",
      basePriceMinor: "1500",
      variants: [{ name: "Lemon" }, { name: "Vanilla" }],
    });
    const opened = await parseOk(
      await liveRequest(
        liveApp({
          pendingStore,
          model: pickerCreateModel(katia.id, product.productId),
        }).app,
        {
          method: "POST",
          path: ASSISTANT_CHAT_PATH,
          token,
          body: {
            conversationId: conversation.id,
            text: "замовлення Каті",
            locale: "uk",
          },
        },
      ),
    );
    const before = await orderCount();
    const refused = await parseOk(
      await liveRequest(
        liveApp({
          pendingStore,
          model: new MockLanguageModelV3({
            doStream: [
              mockToolCallStream(
                "call-create-2",
                ORDERS_CREATE_TOOL_NAME,
                pickerCreateInput(olena.id, product.productId),
              ),
              mockTextStream("Finish the current picker first."),
            ],
          }),
        }).app,
        {
          method: "POST",
          path: ASSISTANT_CHAT_PATH,
          token,
          body: {
            conversationId: conversation.id,
            text: "ще одне замовлення іншому клієнту",
            locale: "uk",
          },
        },
      ),
    );
    expect(refused.pending?.id).toBe(opened.pending?.id);
    expect(refused.pending?.actionName).toBe("orders.create");
    expect(await orderCount()).toBe(before);
    expect((await peekPending(h.app, token, conversation.id)).pending?.id).toBe(
      opened.pending?.id,
    );
  });

  it("pending_replace drops an archived extra line without creating an order", async () => {
    const h = liveApp();
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await h.invoke(createConversation, {
      title: "Live drop archived",
    });
    const customer = await h.invoke(createCustomer, {
      name: "Drop Archived Buyer",
      phone: nextPhone(),
    });
    const cake = await h.invoke(createProduct, {
      name: "Drop Cake",
      basePriceMinor: "1500",
      variants: [{ name: "A" }, { name: "B" }],
    });
    const archived = await h.invoke(createProduct, {
      name: "Drop Archived Macarons",
      basePriceMinor: "800",
      variants: [],
    });
    await h.invoke(archiveProduct, { productId: archived.productId });
    const { record } = await seedChoicePending(h, {
      conversationId: conversation.id,
      customerId: customer.id,
      product: cake,
      extraProductId: archived.productId,
    });
    expect(record.canonicalInput.items).toHaveLength(2);
    const before = await orderCount();
    const replaced = await parseOk(
      await liveRequest(
        liveApp({
          pendingStore: h.pendingStore,
          model: new MockLanguageModelV3({
            doStream: [
              mockToolCallStream(
                "call-replace",
                PENDING_REPLACE_TOOL_NAME,
                JSON.stringify({
                  customerId: customer.id,
                  items: [
                    {
                      productId: cake.productId,
                      quantityMilli: "1000",
                    },
                  ],
                }),
              ),
              mockTextStream("Dropped the archived line."),
            ],
          }),
        }).app,
        {
          method: "POST",
          path: ASSISTANT_CHAT_PATH,
          token,
          body: {
            conversationId: conversation.id,
            text: "без макаронсів, вони в архіві",
            locale: "uk",
          },
        },
      ),
    );
    expect(replaced.pending?.kind).toBe("choice");
    const peeked = await h.pendingStore.peekOpen({
      conversationId: conversation.id,
      bind: pendingBindFor(conversation.id),
    });
    expect(peeked.kind).toBe("found");
    if (peeked.kind !== "found" || peeked.record.kind !== "choice") {
      throw new Error("expected choice pending after dropping archived line");
    }
    expect(peeked.record.canonicalInput.items).toHaveLength(1);
    expect(peeked.record.canonicalInput.items[0]?.product).toEqual({
      by: "id",
      id: cake.productId,
    });
    expect(await orderCount()).toBe(before);
  });

  it("discuss-while-pending keeps the card; Так does not confirm", async () => {
    const confirmation = countingConfirmationStore();
    const pendingStore = createMemoryPendingStore();
    const h = liveApp({ pendingStore, confirmation });
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await h.invoke(createConversation, {
      title: "Live why confirm",
    });
    const customer = await h.invoke(createCustomer, {
      name: "Why Confirm Target",
      phone: nextPhone(),
    });
    await h.invoke(archiveCustomer, { id: customer.id });
    const paused = await parseOk(
      await liveRequest(
        liveApp({
          pendingStore,
          confirmation,
          model: new MockLanguageModelV3({
            doStream: [
              mockToolCallStream(
                "call-delete",
                DELETE_CUSTOMER_TOOL,
                JSON.stringify({ id: customer.id }),
              ),
              mockTextStream("Confirm the delete."),
            ],
          }),
        }).app,
        {
          method: "POST",
          path: ASSISTANT_CHAT_PATH,
          token,
          body: {
            conversationId: conversation.id,
            text: "видали цього клієнта",
            locale: "uk",
          },
        },
      ),
    );
    expect(paused.pending?.kind).toBe("confirmation");
    expect(paused.pending?.actionName).toBe("customers.deleteCustomer");
    const discussApp = liveApp({
      pendingStore,
      confirmation,
      model: silentModel("The confirmation is still open."),
    });
    const why = await parseOk(
      await liveRequest(discussApp.app, {
        method: "POST",
        path: ASSISTANT_CHAT_PATH,
        token,
        body: {
          conversationId: conversation.id,
          text: "чому потрібне підтвердження?",
          locale: "uk",
        },
      }),
    );
    expect(why.pending?.id).toBe(paused.pending?.id);
    const tak = await parseOk(
      await liveRequest(discussApp.app, {
        method: "POST",
        path: ASSISTANT_CHAT_PATH,
        token,
        body: {
          conversationId: conversation.id,
          text: "Так",
          locale: "uk",
        },
      }),
    );
    expect(tak.pending?.id).toBe(paused.pending?.id);
    expect(await customerRow(customer.id)).toBeDefined();
    expect(
      (await peekPending(discussApp.app, token, conversation.id)).pending?.id,
    ).toBe(paused.pending?.id);
  });

  it("abandon clears server pending so reload hydrate shows no card", async () => {
    const pendingStore = createMemoryPendingStore();
    const h = liveApp({ pendingStore });
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await h.invoke(createConversation, {
      title: "Live abandon",
    });
    const seeded = await seedConfirmationPending(h, conversation.id);
    const abandoned = await parseOk(
      await liveRequest(h.app, {
        method: "POST",
        path: ASSISTANT_PENDING_ABANDON_PATH,
        token,
        body: {
          conversationId: conversation.id,
          pendingId: seeded.challengeId,
          expectedVersion: 1,
        },
      }),
    );
    expect(abandoned.pending).toBeNull();
    expect(
      (await peekPending(h.app, token, conversation.id)).pending,
    ).toBeNull();
    expect(await customerRow(seeded.customerId)).toBeDefined();
  });

  it("double-tap replays the same choice without a second write", async () => {
    const pendingStore = createMemoryPendingStore();
    const h = liveApp({ pendingStore, model: listThenSpeakModel() });
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await h.invoke(createConversation, {
      title: "Live double-tap",
    });
    const customer = await h.invoke(createCustomer, {
      name: "Double Tap Buyer",
      phone: nextPhone(),
    });
    const product = await h.invoke(createProduct, {
      name: "Double Tap Cake",
      basePriceMinor: "1500",
      variants: [{ name: "Lemon" }, { name: "Vanilla" }],
    });
    const opened = await parseOk(
      await liveRequest(
        liveApp({
          pendingStore,
          model: pickerCreateModel(customer.id, product.productId),
        }).app,
        {
          method: "POST",
          path: ASSISTANT_CHAT_PATH,
          token,
          body: {
            conversationId: conversation.id,
            text: "торт",
            locale: "uk",
          },
        },
      ),
    );
    expect(opened.pending?.kind).toBe("choice");
    if (opened.pending?.kind !== "choice") {
      return;
    }
    const optionId = opened.pending.envelope.options[0]?.id;
    expect(optionId).toEqual(expect.any(String));
    const before = await orderCount();
    const resumeApp = liveApp({
      pendingStore,
      model: listThenSpeakModel(),
    });
    const first = await parseOk(
      await liveRequest(resumeApp.app, {
        method: "POST",
        path: ASSISTANT_HOST_CHOICE_PATH,
        token,
        body: {
          conversationId: conversation.id,
          choiceId: opened.pending.id,
          optionId,
        },
      }),
    );
    expect(first.pending).toBeNull();
    expect(await orderCount()).toBe(before + 1);
    const replay = await parseOk(
      await liveRequest(resumeApp.app, {
        method: "POST",
        path: ASSISTANT_HOST_CHOICE_PATH,
        token,
        body: {
          conversationId: conversation.id,
          choiceId: opened.pending.id,
          optionId,
        },
      }),
    );
    expect(replay.status).toBe("ok");
    expect(await orderCount()).toBe(before + 1);
  });

  it("generation fail after write keeps the order and uses success speech fallback", async () => {
    const h = liveApp();
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await h.invoke(createConversation, {
      title: "Live gen fail",
    });
    const customer = await h.invoke(createCustomer, {
      name: "Gen Fail Buyer",
      phone: nextPhone(),
    });
    const product = await h.invoke(createProduct, {
      name: "Gen Fail Cake",
      basePriceMinor: "1500",
      variants: [{ name: "Default" }],
    });
    const before = await orderCount();
    let calls = 0;
    const createInput = uniqueCreateInput(customer.id, product);
    const chat = liveApp({
      pendingStore: h.pendingStore,
      model: new MockLanguageModelV3({
        doStream: () => {
          calls += 1;
          if (calls === 1) {
            return Promise.resolve(
              mockToolCallStream(
                "call-create",
                ORDERS_CREATE_TOOL_NAME,
                createInput,
              ),
            );
          }
          return Promise.reject(new Error("generation failed"));
        },
      }),
    });
    const body = await parseOk(
      await liveRequest(chat.app, {
        method: "POST",
        path: ASSISTANT_CHAT_PATH,
        token,
        body: {
          conversationId: conversation.id,
          text: "створи замовлення",
          locale: "uk",
        },
      }),
    );
    expect(body.pending).toBeNull();
    expect(body.speech).toBe(STAFF_ASSISTANT_SUCCESS_SPEECH_FALLBACK.uk);
    expect(await orderCount()).toBe(before + 1);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("Phase B after create can call orders_list_page on live choice resume", async () => {
    const pendingStore = createMemoryPendingStore();
    const h = liveApp({ pendingStore });
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await h.invoke(createConversation, {
      title: "Live Phase B list",
    });
    const customer = await h.invoke(createCustomer, {
      name: "Phase B Buyer",
      phone: nextPhone(),
    });
    const product = await h.invoke(createProduct, {
      name: "Phase B Cake",
      basePriceMinor: "1500",
      variants: [{ name: "A" }, { name: "B" }],
    });
    const opened = await parseOk(
      await liveRequest(
        liveApp({
          pendingStore,
          model: pickerCreateModel(customer.id, product.productId),
        }).app,
        {
          method: "POST",
          path: ASSISTANT_CHAT_PATH,
          token,
          body: {
            conversationId: conversation.id,
            text: "створи і покажи замовлення цього клієнта",
            locale: "uk",
          },
        },
      ),
    );
    expect(opened.pending?.kind).toBe("choice");
    if (opened.pending?.kind !== "choice") {
      return;
    }
    const pausedCreates = (await conversationToolRuns(conversation.id)).filter(
      (row) => row.actionName === "orders.create",
    );
    expect(pausedCreates).toHaveLength(1);
    expect(pausedCreates[0]?.outcome).toBe("choice_required");
    expect(pausedCreates[0]?.executionId).toEqual(expect.any(String));
    expect(pausedCreates[0]?.toolInput).toEqual({
      customerId: customer.id,
      items: [{ productId: product.productId, quantityMilli: "1000" }],
    });
    const optionId = opened.pending.envelope.options[0]?.id;
    const resumed = await parseOk(
      await liveRequest(
        liveApp({
          pendingStore,
          model: listThenSpeakModel(),
        }).app,
        {
          method: "POST",
          path: ASSISTANT_HOST_CHOICE_PATH,
          token,
          body: {
            conversationId: conversation.id,
            choiceId: opened.pending.id,
            optionId,
          },
        },
      ),
    );
    expect(resumed.pending).toBeNull();
    expect(resumed.speech).toBe("Here is the list.");
    expectKnownResumeCardKinds(resumed.cards);
    expect(surfaceCard(resumed.cards, "order-entity")).toBeDefined();
    expect(surfaceCard(resumed.cards, "orders-list")).toBeDefined();
    expect(orderIdFromEntityCard(resumed.cards)).toEqual(expect.any(String));
    const afterCreates = (await conversationToolRuns(conversation.id)).filter(
      (row) => row.actionName === "orders.create",
    );
    expect(afterCreates).toHaveLength(1);
    expect(afterCreates[0]?.executionId).toBe(pausedCreates[0]?.executionId);
    expect(afterCreates[0]?.outcome).toBe("success");
    expect(afterCreates[0]?.seq).toBe(pausedCreates[0]?.seq);
    expect(afterCreates[0]?.toolInput).toEqual(pausedCreates[0]?.toolInput);
    expect(afterCreates[0]?.toolInput).not.toMatchObject({
      customer: { by: "id" },
    });
    expect(afterCreates.some((row) => row.outcome === "choice_required")).toBe(
      false,
    );
    expect(
      afterCreates.some((row) => row.toolCallId.startsWith("phase-a:")),
    ).toBe(false);
    const replay = await parseOk(
      await liveRequest(
        liveApp({
          pendingStore,
          model: listThenSpeakModel(),
        }).app,
        {
          method: "POST",
          path: ASSISTANT_HOST_CHOICE_PATH,
          token,
          body: {
            conversationId: conversation.id,
            choiceId: opened.pending.id,
            optionId,
          },
        },
      ),
    );
    expect(replay.pending).toBeNull();
    const replayCreates = (await conversationToolRuns(conversation.id)).filter(
      (row) => row.actionName === "orders.create",
    );
    expect(replayCreates).toHaveLength(1);
    expect(replayCreates[0]?.executionId).toBe(pausedCreates[0]?.executionId);
    expect(replayCreates[0]?.outcome).toBe("success");
    expect(orderIdFromEntityCard(replay.cards)).toBe(
      orderIdFromEntityCard(resumed.cards),
    );
  });

  it("live choice speech-only Phase B still returns the order-entity card (SHO-544)", async () => {
    const pendingStore = createMemoryPendingStore();
    const h = liveApp({ pendingStore });
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await h.invoke(createConversation, {
      title: "Live T9 speech-only order card",
    });
    const customer = await h.invoke(createCustomer, {
      name: "Live T9 Speech Buyer",
      phone: nextPhone(),
    });
    const product = await h.invoke(createProduct, {
      name: "Live T9 Speech Cake",
      basePriceMinor: "1500",
      variants: [{ name: "A" }, { name: "B" }],
    });
    const opened = await parseOk(
      await liveRequest(
        liveApp({
          pendingStore,
          model: pickerCreateModel(customer.id, product.productId),
        }).app,
        {
          method: "POST",
          path: ASSISTANT_CHAT_PATH,
          token,
          body: {
            conversationId: conversation.id,
            text: "створи замовлення",
            locale: "uk",
          },
        },
      ),
    );
    expect(opened.pending?.kind).toBe("choice");
    if (opened.pending?.kind !== "choice") {
      return;
    }
    const optionId = opened.pending.envelope.options[0]?.id;
    const before = await orderCount();
    const resumed = await parseOk(
      await liveRequest(
        liveApp({
          pendingStore,
          model: silentModel("Замовлення створено"),
        }).app,
        {
          method: "POST",
          path: ASSISTANT_HOST_CHOICE_PATH,
          token,
          body: {
            conversationId: conversation.id,
            choiceId: opened.pending.id,
            optionId,
          },
        },
      ),
    );
    expect(resumed.speech).toBe("Замовлення створено");
    expect(resumed.pending).toBeNull();
    expectKnownResumeCardKinds(resumed.cards);
    expect(surfaceCard(resumed.cards, "orders-list")).toBeUndefined();
    const orderId = orderIdFromEntityCard(resumed.cards);
    expect(await orderCount()).toBe(before + 1);
    const replay = await parseOk(
      await liveRequest(
        liveApp({
          pendingStore,
          model: silentModel("Замовлення створено"),
        }).app,
        {
          method: "POST",
          path: ASSISTANT_HOST_CHOICE_PATH,
          token,
          body: {
            conversationId: conversation.id,
            choiceId: opened.pending.id,
            optionId,
          },
        },
      ),
    );
    expect(replay.pending).toBeNull();
    expect(orderIdFromEntityCard(replay.cards)).toBe(orderId);
    expect(await orderCount()).toBe(before + 1);
  });

  it("live Phase B generation failure after committed create still returns the order card (SHO-544)", async () => {
    const pendingStore = createMemoryPendingStore();
    const h = liveApp({ pendingStore });
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await h.invoke(createConversation, {
      title: "Live T9 Phase B generation fail",
    });
    const customer = await h.invoke(createCustomer, {
      name: "Live T9 Fail Buyer",
      phone: nextPhone(),
    });
    const product = await h.invoke(createProduct, {
      name: "Live T9 Fail Cake",
      basePriceMinor: "1500",
      variants: [{ name: "A" }, { name: "B" }],
    });
    const opened = await parseOk(
      await liveRequest(
        liveApp({
          pendingStore,
          model: pickerCreateModel(customer.id, product.productId),
        }).app,
        {
          method: "POST",
          path: ASSISTANT_CHAT_PATH,
          token,
          body: {
            conversationId: conversation.id,
            text: "створи замовлення",
            locale: "uk",
          },
        },
      ),
    );
    expect(opened.pending?.kind).toBe("choice");
    if (opened.pending?.kind !== "choice") {
      return;
    }
    const optionId = opened.pending.envelope.options[0]?.id;
    const pausedCreates = (await conversationToolRuns(conversation.id)).filter(
      (row) => row.actionName === "orders.create",
    );
    expect(pausedCreates).toHaveLength(1);
    const before = await orderCount();
    const resumed = await parseOk(
      await liveRequest(
        liveApp({
          pendingStore,
          model: failingGenerationModel(),
        }).app,
        {
          method: "POST",
          path: ASSISTANT_HOST_CHOICE_PATH,
          token,
          body: {
            conversationId: conversation.id,
            choiceId: opened.pending.id,
            optionId,
          },
        },
      ),
    );
    expect(resumed.speech).toBe(STAFF_ASSISTANT_SUCCESS_SPEECH_FALLBACK.uk);
    expect(resumed.pending).toBeNull();
    expectKnownResumeCardKinds(resumed.cards);
    const orderId = orderIdFromEntityCard(resumed.cards);
    expect(await orderCount()).toBe(before + 1);
    const afterCreates = (await conversationToolRuns(conversation.id)).filter(
      (row) => row.actionName === "orders.create",
    );
    expect(afterCreates).toHaveLength(1);
    expect(afterCreates[0]?.executionId).toBe(pausedCreates[0]?.executionId);
    expect(afterCreates[0]?.outcome).toBe("success");
    const replay = await parseOk(
      await liveRequest(
        liveApp({
          pendingStore,
          model: failingGenerationModel(),
        }).app,
        {
          method: "POST",
          path: ASSISTANT_HOST_CHOICE_PATH,
          token,
          body: {
            conversationId: conversation.id,
            choiceId: opened.pending.id,
            optionId,
          },
        },
      ),
    );
    expect(replay.pending).toBeNull();
    expect(orderIdFromEntityCard(replay.cards)).toBe(orderId);
    expect(await orderCount()).toBe(before + 1);
    expect(
      (await conversationToolRuns(conversation.id)).filter(
        (row) => row.actionName === "orders.create",
      ),
    ).toHaveLength(1);
  });

  it("live confirm speech-only Phase B uses only registry surfaces (SHO-544)", async () => {
    const pendingStore = createMemoryPendingStore();
    const h = liveApp({
      pendingStore,
      model: silentModel("Клієнта видалено."),
    });
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await h.invoke(createConversation, {
      title: "Live T9 confirm known surfaces",
    });
    const seeded = await seedConfirmationPending(h, conversation.id);
    const resumed = await parseOk(
      await liveRequest(h.app, {
        method: "POST",
        path: ASSISTANT_CONFIRM_PATH,
        token,
        body: {
          conversationId: conversation.id,
          challengeId: seeded.challengeId,
        },
      }),
    );
    expect(resumed.speech).toBe("Клієнта видалено.");
    expect(resumed.pending).toBeNull();
    expectKnownResumeCardKinds(resumed.cards);
    expect(resumed.cards.some((card) => card.kind === "confirmation")).toBe(
      false,
    );
    expect(surfaceCard(resumed.cards, "order-entity")).toBeUndefined();
    expect(await customerRow(seeded.customerId)).toBeUndefined();
  });

  it("Phase B choice resume does not execute a leftover chat-turn started create", async () => {
    const pendingStore = createMemoryPendingStore();
    const h = liveApp({
      pendingStore,
      model: silentModel("Named the chosen flavour."),
    });
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await h.invoke(createConversation, {
      title: "Live leftover chat create vs Phase B",
    });
    const leftoverCustomer = await h.invoke(createCustomer, {
      name: "Leftover Buyer",
      phone: nextPhone(),
    });
    const leftoverProduct = await h.invoke(createProduct, {
      name: "Leftover Cake",
      basePriceMinor: "1800",
      variants: [{ name: "Solo" }],
    });
    const leftoverVariant = leftoverProduct.variants[0];
    if (leftoverVariant === undefined) {
      throw new Error("leftover product missing variant");
    }
    const userMessage = await h.invoke(
      appendUserMessage,
      { conversationId: conversation.id, body: "Create the leftover cake" },
      { idempotencyKey: attemptKey("message", conversation.id, randomUUID()) },
    );
    const leftover = await stageNamedStartedRun(h, {
      conversationId: conversation.id,
      beginKey: `begin:${userMessage.id}`,
      actionName: "orders.create",
      toolName: ORDERS_CREATE_TOOL_NAME,
      toolCallId: "call-leftover-create",
      toolInput: {
        customerId: leftoverCustomer.id,
        items: [
          {
            productId: leftoverProduct.productId,
            variantId: leftoverVariant.variantId,
            quantityMilli: "1000",
          },
        ],
      },
    });
    const beforeChoice = await orderCount();
    const choiceCustomer = await h.invoke(createCustomer, {
      name: "Choice Buyer",
      phone: nextPhone(),
    });
    const choiceProduct = await h.invoke(createProduct, {
      name: "Choice Cake",
      basePriceMinor: "1500",
      variants: [{ name: "A" }, { name: "B" }],
    });
    const { record } = await seedChoicePending(h, {
      conversationId: conversation.id,
      customerId: choiceCustomer.id,
      product: choiceProduct,
    });
    const optionId = record.envelope.options[0]?.id;
    if (optionId === undefined) {
      throw new Error("seeded choice missing option");
    }
    const body = await parseOk(
      await liveRequest(h.app, {
        method: "POST",
        path: ASSISTANT_HOST_CHOICE_PATH,
        token,
        body: {
          conversationId: conversation.id,
          choiceId: record.id,
          optionId,
        },
      }),
    );
    expect(body.status).toBe("ok");
    expect(await orderCount()).toBe(beforeChoice + 1);
    const history = await h.invoke(getModelHistory, {
      conversationId: conversation.id,
    });
    const leftoverRun = history.messages
      .flatMap((message) => message.toolRuns)
      .find((run) => run.executionId === leftover.executionId);
    expect(leftoverRun?.outcome).toBe("started");
  });

  describe("SHO-539 turnKey recovery membership", () => {
    it("does not recover a user-preceded Phase B leftover after HITL and a dangling user", async () => {
      const pendingStore = createMemoryPendingStore();
      const h = liveApp({
        pendingStore,
        model: silentModel("Discussing the leftover."),
      });
      const token = await insertBearer(kit, kitIdentities.users.anna);
      const conversation = await h.invoke(createConversation, {
        title: "Live HITL dangling user Phase B leftover",
      });
      const choiceCustomer = await h.invoke(createCustomer, {
        name: "Live HITL Buyer",
        phone: nextPhone(),
      });
      const choiceProduct = await h.invoke(createProduct, {
        name: "Live HITL Cake",
        basePriceMinor: "1500",
        variants: [{ name: "A" }, { name: "B" }],
      });
      const { record } = await seedChoicePending(h, {
        conversationId: conversation.id,
        customerId: choiceCustomer.id,
        product: choiceProduct,
      });
      const optionId = record.envelope.options[0]?.id;
      if (optionId === undefined) {
        throw new Error("seeded choice missing option");
      }
      const bind = pendingBindFor(conversation.id);
      expect(
        (
          await pendingStore.claim({
            id: record.id,
            kind: "choice",
            bind,
            optionId,
          })
        ).kind,
      ).toBe("claimed");
      expect(
        (
          await pendingStore.complete({
            id: record.id,
            kind: "choice",
            bind,
            optionId,
          })
        ).kind,
      ).toBe("completed");
      await h.invoke(
        appendUserMessage,
        {
          conversationId: conversation.id,
          body: "what about this picker?",
        },
        {
          idempotencyKey: attemptKey("message", conversation.id, randomUUID()),
        },
      );
      const cake = await cakeCreateInputs(h, "Live dangling Phase B");
      const leftover = await stageNamedStartedRun(h, {
        conversationId: conversation.id,
        beginKey: `begin:resume:${record.id}`,
        actionName: "orders.create",
        toolName: ORDERS_CREATE_TOOL_NAME,
        toolCallId: "call-resume-dangling",
        toolInput: cake.facadeInput,
      });
      const beforeChat = await orderCount();
      await parseOk(
        await liveRequest(h.app, {
          method: "POST",
          path: ASSISTANT_CHAT_PATH,
          token,
          body: {
            conversationId: conversation.id,
            text: "Just asking about the picker",
            locale: "en",
          },
        }),
      );
      expect(await orderCount()).toBe(beforeChat);
      const history = await h.invoke(getModelHistory, {
        conversationId: conversation.id,
      });
      expect(
        history.unfinishedStartedRuns.some(
          (run) => run.executionId === leftover.executionId,
        ),
      ).toBe(true);
    });

    it("does not recover a Phase B leftover after confirm when the HITL run is already success", async () => {
      const pendingStore = createMemoryPendingStore();
      const h = liveApp({
        pendingStore,
        model: silentModel("The confirmation already landed."),
      });
      const token = await insertBearer(kit, kitIdentities.users.anna);
      const conversation = await h.invoke(createConversation, {
        title: "Live confirm then Phase B leftover",
      });
      const seeded = await seedConfirmationPending(h, conversation.id);
      const bind = pendingBindFor(conversation.id);
      expect(
        (
          await pendingStore.claim({
            id: seeded.challengeId,
            kind: "confirmation",
            bind,
          })
        ).kind,
      ).toBe("claimed");
      await h.invoke(
        deleteCustomer,
        { id: seeded.customerId },
        {
          idempotencyKey: executionAttemptKey(
            conversation.id,
            seeded.executionId,
          ),
          confirmationChallengeId: seeded.challengeId,
        },
      );
      await h.invoke(
        checkpointAssistantTurn,
        {
          kind: "finishRun",
          conversationId: conversation.id,
          executionId: seeded.executionId,
          outcome: "success",
          resultIds: [seeded.customerId],
          modelTrace: { id: seeded.customerId },
        },
        {
          idempotencyKey: attemptKey(
            "turn",
            conversation.id,
            `finish:${seeded.executionId}:success`,
          ),
        },
      );
      expect(
        (
          await pendingStore.complete({
            id: seeded.challengeId,
            kind: "confirmation",
            bind,
          })
        ).kind,
      ).toBe("completed");
      expect(await customerRow(seeded.customerId)).toBeUndefined();
      await h.invoke(
        appendUserMessage,
        { conversationId: conversation.id, body: "did that delete finish?" },
        {
          idempotencyKey: attemptKey("message", conversation.id, randomUUID()),
        },
      );
      const cake = await cakeCreateInputs(h, "Live confirm leftover");
      const leftover = await stageNamedStartedRun(h, {
        conversationId: conversation.id,
        beginKey: `begin:resume:${seeded.challengeId}`,
        actionName: "orders.create",
        toolName: ORDERS_CREATE_TOOL_NAME,
        toolCallId: "call-confirm-resume-leftover",
        toolInput: cake.facadeInput,
      });
      const beforeChat = await orderCount();
      await parseOk(
        await liveRequest(h.app, {
          method: "POST",
          path: ASSISTANT_CHAT_PATH,
          token,
          body: {
            conversationId: conversation.id,
            text: "what happened to the delete?",
            locale: "en",
          },
        }),
      );
      expect(await orderCount()).toBe(beforeChat);
      expect(await customerRow(seeded.customerId)).toBeUndefined();
      const history = await h.invoke(getModelHistory, {
        conversationId: conversation.id,
      });
      expect(
        history.unfinishedStartedRuns.find(
          (run) => run.executionId === leftover.executionId,
        )?.turnKey,
      ).toBe(`begin:resume:${seeded.challengeId}`);
    });

    it("discussion speech during an open picker does not execute a leftover resume started", async () => {
      const pendingStore = createMemoryPendingStore();
      const h = liveApp({
        pendingStore,
        model: silentModel("The picker is still open."),
      });
      const token = await insertBearer(kit, kitIdentities.users.anna);
      const conversation = await h.invoke(createConversation, {
        title: "Live discuss pending picker",
      });
      const customer = await h.invoke(createCustomer, {
        name: "Live Discuss Buyer",
        phone: nextPhone(),
      });
      const product = await h.invoke(createProduct, {
        name: "Live Discuss Cake",
        basePriceMinor: "1500",
        variants: [{ name: "A" }, { name: "B" }],
      });
      const { record } = await seedChoicePending(h, {
        conversationId: conversation.id,
        customerId: customer.id,
        product,
      });
      const cake = await cakeCreateInputs(h, "Live open-picker leftover");
      const leftover = await stageNamedStartedRun(h, {
        conversationId: conversation.id,
        beginKey: `begin:resume:${record.id}`,
        actionName: "orders.create",
        toolName: ORDERS_CREATE_TOOL_NAME,
        toolCallId: "call-open-picker-resume",
        toolInput: cake.facadeInput,
      });
      const beforeChat = await orderCount();
      const chatBody = await parseOk(
        await liveRequest(h.app, {
          method: "POST",
          path: ASSISTANT_CHAT_PATH,
          token,
          body: {
            conversationId: conversation.id,
            text: "what does this picker mean?",
            locale: "en",
          },
        }),
      );
      expect(chatBody.pending?.id).toBe(record.id);
      expect(await orderCount()).toBe(beforeChat);
      const history = await h.invoke(getModelHistory, {
        conversationId: conversation.id,
      });
      expect(
        history.messages
          .flatMap((message) => message.toolRuns)
          .find((run) => run.executionId === leftover.executionId)?.outcome,
      ).toBe("started");
      await parseOk(
        await liveRequest(
          liveApp({
            pendingStore,
            model: silentModel("Named the chosen flavour."),
          }).app,
          {
            method: "POST",
            path: ASSISTANT_HOST_CHOICE_PATH,
            token,
            body: {
              conversationId: conversation.id,
              choiceId: record.id,
              optionId: record.envelope.options[0]?.id,
            },
          },
        ),
      );
      expect(await orderCount()).toBe(beforeChat + 2);
      const afterChoice = await h.invoke(getModelHistory, {
        conversationId: conversation.id,
      });
      expect(
        afterChoice.messages
          .flatMap((message) => message.toolRuns)
          .find((run) => run.executionId === leftover.executionId)?.outcome,
      ).toBe("success");
    });

    it("recovers a later unfinished chat-turn after completed Phase B; choice replay stays done", async () => {
      const speech = "The order is ready.";
      const pendingStore = createMemoryPendingStore();
      const h = liveApp({ pendingStore, model: silentModel(speech) });
      const token = await insertBearer(kit, kitIdentities.users.anna);
      const conversation = await h.invoke(createConversation, {
        title: "Live completed Phase B then chat leftover",
      });
      const customer = await h.invoke(createCustomer, {
        name: "Live Phase B then chat Buyer",
        phone: nextPhone(),
      });
      const product = await h.invoke(createProduct, {
        name: "Live Phase B then chat Cake",
        basePriceMinor: "1500",
        variants: [{ name: "A" }, { name: "B" }],
      });
      const { record } = await seedChoicePending(h, {
        conversationId: conversation.id,
        customerId: customer.id,
        product,
      });
      const optionId = record.envelope.options[0]?.id;
      const first = await parseOk(
        await liveRequest(h.app, {
          method: "POST",
          path: ASSISTANT_HOST_CHOICE_PATH,
          token,
          body: {
            conversationId: conversation.id,
            choiceId: record.id,
            optionId,
          },
        }),
      );
      expect(first.speech).toBe(speech);
      const afterPhaseB = await orderCount();
      const cake = await cakeCreateInputs(h, "Live later chat leftover");
      const userMessage = await h.invoke(
        appendUserMessage,
        {
          conversationId: conversation.id,
          body: "Create another leftover cake",
        },
        {
          idempotencyKey: attemptKey("message", conversation.id, randomUUID()),
        },
      );
      const leftover = await stageNamedStartedRun(h, {
        conversationId: conversation.id,
        beginKey: `begin:${userMessage.id}`,
        actionName: "orders.create",
        toolName: ORDERS_CREATE_TOOL_NAME,
        toolCallId: "call-later-chat-create",
        toolInput: cake.facadeInput,
      });
      await h.invoke(createOrder, cake.canonicalInput, {
        idempotencyKey: executionAttemptKey(
          conversation.id,
          leftover.executionId,
        ),
      });
      const afterCommit = await orderCount();
      expect(afterCommit).toBe(afterPhaseB + 1);
      await parseOk(
        await liveRequest(
          liveApp({
            pendingStore,
            model: silentModel("The leftover create already landed."),
          }).app,
          {
            method: "POST",
            path: ASSISTANT_CHAT_PATH,
            token,
            body: {
              conversationId: conversation.id,
              text: "Did the leftover go through?",
              locale: "en",
            },
          },
        ),
      );
      expect(await orderCount()).toBe(afterCommit);
      const afterChat = await h.invoke(getModelHistory, {
        conversationId: conversation.id,
      });
      expect(
        afterChat.messages
          .flatMap((message) => message.toolRuns)
          .find((run) => run.executionId === leftover.executionId)?.outcome,
      ).toBe("success");
      const replay = await parseOk(
        await liveRequest(
          liveApp({
            pendingStore,
            model: new MockLanguageModelV3({
              doStream: () => {
                throw new Error(
                  "completed Phase B must not resume after a recovered chat leftover",
                );
              },
            }),
          }).app,
          {
            method: "POST",
            path: ASSISTANT_HOST_CHOICE_PATH,
            token,
            body: {
              conversationId: conversation.id,
              choiceId: record.id,
              optionId,
            },
          },
        ),
      );
      expect(replay.speech).toBe(speech);
      expect(replay.speech).not.toBe("The leftover create already landed.");
      expect(await orderCount()).toBe(afterCommit);
    });

    it("recovers a chat-turn started on the edge of and outside the 8-message window", async () => {
      const pendingStore = createMemoryPendingStore();
      const h = liveApp({
        pendingStore,
        model: silentModel("The earlier create already landed."),
      });
      const token = await insertBearer(kit, kitIdentities.users.anna);
      const edgeConversation = await h.invoke(createConversation, {
        title: "Live window edge chat leftover",
      });
      const edgeCake = await cakeCreateInputs(h, "Live window edge");
      const edgeUser = await h.invoke(
        appendUserMessage,
        { conversationId: edgeConversation.id, body: "Create the edge cake" },
        {
          idempotencyKey: attemptKey(
            "message",
            edgeConversation.id,
            randomUUID(),
          ),
        },
      );
      const edgeLeftover = await stageNamedStartedRun(h, {
        conversationId: edgeConversation.id,
        beginKey: `begin:${edgeUser.id}`,
        actionName: "orders.create",
        toolName: ORDERS_CREATE_TOOL_NAME,
        toolCallId: "call-edge-chat",
        toolInput: edgeCake.facadeInput,
      });
      await h.invoke(createOrder, edgeCake.canonicalInput, {
        idempotencyKey: executionAttemptKey(
          edgeConversation.id,
          edgeLeftover.executionId,
        ),
      });
      await padUserMessages(h, edgeConversation.id, 6);
      const edgeHistory = await h.invoke(getModelHistory, {
        conversationId: edgeConversation.id,
      });
      expect(edgeHistory.messages).toHaveLength(8);
      expect(
        edgeHistory.messages.some(
          (message) => message.id === edgeLeftover.messageId,
        ),
      ).toBe(true);
      expect(
        edgeHistory.unfinishedStartedRuns.some(
          (run) => run.executionId === edgeLeftover.executionId,
        ),
      ).toBe(true);
      const afterEdgeCommit = await orderCount();
      await parseOk(
        await liveRequest(h.app, {
          method: "POST",
          path: ASSISTANT_CHAT_PATH,
          token,
          body: {
            conversationId: edgeConversation.id,
            text: "Did the edge create land?",
            locale: "en",
          },
        }),
      );
      expect(await orderCount()).toBe(afterEdgeCommit);

      const outsideConversation = await h.invoke(createConversation, {
        title: "Live window outside chat leftover",
      });
      const outsideCake = await cakeCreateInputs(h, "Live window outside");
      const outsideUser = await h.invoke(
        appendUserMessage,
        {
          conversationId: outsideConversation.id,
          body: "Create the outside cake",
        },
        {
          idempotencyKey: attemptKey(
            "message",
            outsideConversation.id,
            randomUUID(),
          ),
        },
      );
      const outsideLeftover = await stageNamedStartedRun(h, {
        conversationId: outsideConversation.id,
        beginKey: `begin:${outsideUser.id}`,
        actionName: "orders.create",
        toolName: ORDERS_CREATE_TOOL_NAME,
        toolCallId: "call-outside-chat",
        toolInput: outsideCake.facadeInput,
      });
      await h.invoke(createOrder, outsideCake.canonicalInput, {
        idempotencyKey: executionAttemptKey(
          outsideConversation.id,
          outsideLeftover.executionId,
        ),
      });
      await padUserMessages(h, outsideConversation.id, 8);
      const outsideHistory = await h.invoke(getModelHistory, {
        conversationId: outsideConversation.id,
      });
      expect(outsideHistory.messages).toHaveLength(8);
      expect(
        outsideHistory.messages.some(
          (message) => message.id === outsideLeftover.messageId,
        ),
      ).toBe(false);
      expect(outsideHistory.unfinishedStartedRuns).toEqual([
        expect.objectContaining({
          executionId: outsideLeftover.executionId,
          turnKey: `begin:${outsideUser.id}`,
        }),
      ]);
      const afterOutsideCommit = await orderCount();
      const reissue = ordersCreateUnlessRecoveredModel({
        recoveredToolCallId: "call-outside-chat",
        facadeInput: outsideCake.facadeInput,
        speech: "The outside create already landed.",
      });
      await parseOk(
        await liveRequest(
          liveApp({
            pendingStore,
            model: reissue,
          }).app,
          {
            method: "POST",
            path: ASSISTANT_CHAT_PATH,
            token,
            body: {
              conversationId: outsideConversation.id,
              text: "Did the outside create land?",
              locale: "en",
            },
          },
        ),
      );
      expect(await orderCount()).toBe(afterOutsideCommit);
      const prompt = JSON.stringify(reissue.doStreamCalls[0]?.prompt ?? []);
      expect(prompt).toContain("call-outside-chat");
      expect(prompt).not.toContain("call-reissue-create");
      const outsideFinished = await h.invoke(getModelHistory, {
        conversationId: outsideConversation.id,
      });
      expect(
        outsideFinished.unfinishedStartedRuns.some(
          (run) => run.executionId === outsideLeftover.executionId,
        ),
      ).toBe(false);
      const leftoverRuns = await conversationToolRuns(outsideConversation.id);
      expect(
        leftoverRuns.find(
          (run) => run.executionId === outsideLeftover.executionId,
        )?.outcome,
      ).toBe("success");
      expect(
        leftoverRuns
          .filter((run) => run.toolName === ORDERS_CREATE_TOOL_NAME)
          .map((run) => run.executionId)
          .toSorted(),
      ).toEqual([outsideLeftover.executionId]);
    });

    it("recovers a Phase B leftover after eight discussion chats without a new execution_id", async () => {
      const pendingStore = createMemoryPendingStore();
      const token = await insertBearer(kit, kitIdentities.users.anna);
      const seedHarness = liveApp({ pendingStore, model: silentModel() });
      const conversation = await seedHarness.invoke(createConversation, {
        title: "Live Phase B leftover after discussion",
      });
      const cake = await cakeCreateInputs(
        seedHarness,
        "Live discussion leftover",
      );
      const choiceCustomer = await seedHarness.invoke(createCustomer, {
        name: "Live Discussion Buyer",
        phone: nextPhone(),
      });
      const choiceProduct = await seedHarness.invoke(createProduct, {
        name: "Live Discussion Cake",
        basePriceMinor: "1500",
        variants: [{ name: "A" }, { name: "B" }],
      });
      const { record } = await seedChoicePending(seedHarness, {
        conversationId: conversation.id,
        customerId: choiceCustomer.id,
        product: choiceProduct,
      });
      const optionId = record.envelope.options[0]?.id;
      if (optionId === undefined) {
        throw new Error("seeded choice missing option");
      }
      const bind = pendingBindFor(conversation.id);
      expect(
        (
          await pendingStore.claim({
            id: record.id,
            kind: "choice",
            bind,
            optionId,
          })
        ).kind,
      ).toBe("claimed");
      expect(
        (
          await pendingStore.complete({
            id: record.id,
            kind: "choice",
            bind,
            optionId,
          })
        ).kind,
      ).toBe("completed");
      const leftover = await stageNamedStartedRun(seedHarness, {
        conversationId: conversation.id,
        beginKey: `begin:resume:${record.id}`,
        actionName: "orders.create",
        toolName: ORDERS_CREATE_TOOL_NAME,
        toolCallId: "call-resume-discussion",
        toolInput: cake.facadeInput,
      });
      await seedHarness.invoke(createOrder, cake.canonicalInput, {
        idempotencyKey: executionAttemptKey(
          conversation.id,
          leftover.executionId,
        ),
      });
      const afterCommit = await orderCount();
      const discussion = liveApp({
        pendingStore,
        model: silentModel("Discussing the leftover."),
      });
      for (let index = 0; index < 8; index += 1) {
        await parseOk(
          await liveRequest(discussion.app, {
            method: "POST",
            path: ASSISTANT_CHAT_PATH,
            token,
            body: {
              conversationId: conversation.id,
              text: `Discussion ${String(index)}`,
              locale: "en",
            },
          }),
        );
      }
      expect(await orderCount()).toBe(afterCommit);
      const padded = await seedHarness.invoke(getModelHistory, {
        conversationId: conversation.id,
      });
      expect(padded.messages).toHaveLength(8);
      expect(
        padded.messages.some((message) => message.id === leftover.messageId),
      ).toBe(false);
      expect(
        padded.unfinishedStartedRuns.some(
          (run) => run.executionId === leftover.executionId,
        ),
      ).toBe(true);
      const reissue = ordersCreateUnlessRecoveredModel({
        recoveredToolCallId: "call-resume-discussion",
        facadeInput: cake.facadeInput,
        speech: "Named the leftover flavour.",
      });
      await parseOk(
        await liveRequest(liveApp({ pendingStore, model: reissue }).app, {
          method: "POST",
          path: ASSISTANT_HOST_CHOICE_PATH,
          token,
          body: {
            conversationId: conversation.id,
            choiceId: record.id,
            optionId,
          },
        }),
      );
      expect(await orderCount()).toBe(afterCommit);
      const prompt = JSON.stringify(reissue.doStreamCalls[0]?.prompt ?? []);
      expect(prompt).toContain("call-resume-discussion");
      expect(prompt).not.toContain("call-reissue-create");
      const leftoverRuns = await conversationToolRuns(conversation.id);
      expect(
        leftoverRuns.find((run) => run.executionId === leftover.executionId)
          ?.outcome,
      ).toBe("success");
    });

    it("refuses a re-issued orders_create while an excluded resume leftover stays started", async () => {
      const pendingStore = createMemoryPendingStore();
      const token = await insertBearer(kit, kitIdentities.users.anna);
      const seedHarness = liveApp({ pendingStore, model: silentModel() });
      const conversation = await seedHarness.invoke(createConversation, {
        title: "Live excluded resume plus reissue",
      });
      const cake = await cakeCreateInputs(seedHarness, "Live reissue leftover");
      const choiceCustomer = await seedHarness.invoke(createCustomer, {
        name: "Live Reissue Buyer",
        phone: nextPhone(),
      });
      const choiceProduct = await seedHarness.invoke(createProduct, {
        name: "Live Reissue Cake",
        basePriceMinor: "1500",
        variants: [{ name: "A" }, { name: "B" }],
      });
      const { record } = await seedChoicePending(seedHarness, {
        conversationId: conversation.id,
        customerId: choiceCustomer.id,
        product: choiceProduct,
      });
      const optionId = record.envelope.options[0]?.id;
      if (optionId === undefined) {
        throw new Error("seeded choice missing option");
      }
      const bind = pendingBindFor(conversation.id);
      expect(
        (
          await pendingStore.claim({
            id: record.id,
            kind: "choice",
            bind,
            optionId,
          })
        ).kind,
      ).toBe("claimed");
      expect(
        (
          await pendingStore.complete({
            id: record.id,
            kind: "choice",
            bind,
            optionId,
          })
        ).kind,
      ).toBe("completed");
      const leftover = await stageNamedStartedRun(seedHarness, {
        conversationId: conversation.id,
        beginKey: `begin:resume:${record.id}`,
        actionName: "orders.create",
        toolName: ORDERS_CREATE_TOOL_NAME,
        toolCallId: "call-excluded-resume",
        toolInput: cake.facadeInput,
      });
      const beforeChat = await orderCount();
      const beforeRuns = await seedHarness.invoke(getModelHistory, {
        conversationId: conversation.id,
      });
      const beforeStartedIds = beforeRuns.unfinishedStartedRuns
        .map((run) => run.executionId)
        .toSorted();
      const reissue = new MockLanguageModelV3({
        doStream: [
          mockToolCallStream(
            "call-reissue-create",
            ORDERS_CREATE_TOOL_NAME,
            JSON.stringify(cake.facadeInput),
          ),
          mockTextStream("Trying another create."),
        ],
      });
      await parseOk(
        await liveRequest(liveApp({ pendingStore, model: reissue }).app, {
          method: "POST",
          path: ASSISTANT_CHAT_PATH,
          token,
          body: {
            conversationId: conversation.id,
            text: "create another order",
            locale: "en",
          },
        }),
      );
      expect(await orderCount()).toBe(beforeChat);
      const prompt = JSON.stringify(reissue.doStreamCalls[0]?.prompt ?? []);
      expect(prompt).not.toContain("call-excluded-resume");
      expect(prompt).not.toContain('"status":"started"');
      const after = await seedHarness.invoke(getModelHistory, {
        conversationId: conversation.id,
      });
      expect(
        after.unfinishedStartedRuns.find(
          (run) => run.executionId === leftover.executionId,
        )?.turnKey,
      ).toBe(`begin:resume:${record.id}`);
      expect(
        after.unfinishedStartedRuns.map((run) => run.executionId).toSorted(),
      ).toEqual(beforeStartedIds);
    });

    it("does not reopen completed Phase B when the resume turn is clipped from checkpointTurns", async () => {
      const speech = "The order is ready.";
      const pendingStore = createMemoryPendingStore();
      const h = liveApp({ pendingStore, model: silentModel(speech) });
      const token = await insertBearer(kit, kitIdentities.users.anna);
      const conversation = await h.invoke(createConversation, {
        title: "Live clipped completed resume",
      });
      const customer = await h.invoke(createCustomer, {
        name: "Live Clipped Resume Buyer",
        phone: nextPhone(),
      });
      const product = await h.invoke(createProduct, {
        name: "Live Clipped Resume Cake",
        basePriceMinor: "1500",
        variants: [{ name: "A" }, { name: "B" }],
      });
      const { record } = await seedChoicePending(h, {
        conversationId: conversation.id,
        customerId: customer.id,
        product,
      });
      const optionId = record.envelope.options[0]?.id;
      const first = await parseOk(
        await liveRequest(h.app, {
          method: "POST",
          path: ASSISTANT_HOST_CHOICE_PATH,
          token,
          body: {
            conversationId: conversation.id,
            choiceId: record.id,
            optionId,
          },
        }),
      );
      expect(first.speech).toBe(speech);
      const afterPhaseB = await orderCount();
      const resumeKey = `begin:resume:${record.id}`;
      const newer = new Date(Date.now() + 60_000);
      await kit.db.runtime.db.insert(assistantMessages).values(
        Array.from({ length: 256 }, () => ({
          companyId: kitIdentities.companies.a,
          conversationId: conversation.id,
          role: "assistant" as const,
          body: "later speech",
          turnKey: `begin:${randomUUID()}`,
          createdAt: newer,
          updatedAt: newer,
        })),
      );
      const clipped = await h.invoke(getModelHistory, {
        conversationId: conversation.id,
      });
      expect(
        clipped.checkpointTurns.some((turn) => turn.turnKey === resumeKey),
      ).toBe(false);
      const replay = await parseOk(
        await liveRequest(
          liveApp({
            pendingStore,
            model: new MockLanguageModelV3({
              doStream: () => {
                throw new Error(
                  "clipped completed Phase B must not reopen as needed",
                );
              },
            }),
          }).app,
          {
            method: "POST",
            path: ASSISTANT_HOST_CHOICE_PATH,
            token,
            body: {
              conversationId: conversation.id,
              choiceId: record.id,
              optionId,
            },
          },
        ),
      );
      expect(replay.speech).toBe(speech);
      expect(replay.speech).not.toBe("later speech");
      expect(await orderCount()).toBe(afterPhaseB);
    });

    it("refuses a chat write when an empty Phase B begin is clipped from checkpointTurns", async () => {
      const pendingStore = createMemoryPendingStore();
      const token = await insertBearer(kit, kitIdentities.users.anna);
      const seedHarness = liveApp({ pendingStore, model: silentModel() });
      const conversation = await seedHarness.invoke(createConversation, {
        title: "Live clipped empty Phase B begin",
      });
      const cake = await cakeCreateInputs(
        seedHarness,
        "Live clipped empty begin",
      );
      const choiceCustomer = await seedHarness.invoke(createCustomer, {
        name: "Live Clipped Empty Begin Buyer",
        phone: nextPhone(),
      });
      const choiceProduct = await seedHarness.invoke(createProduct, {
        name: "Live Clipped Empty Begin Cake",
        basePriceMinor: "1500",
        variants: [{ name: "A" }, { name: "B" }],
      });
      const { record } = await seedChoicePending(seedHarness, {
        conversationId: conversation.id,
        customerId: choiceCustomer.id,
        product: choiceProduct,
      });
      const optionId = record.envelope.options[0]?.id;
      if (optionId === undefined) {
        throw new Error("seeded choice missing option");
      }
      const bind = pendingBindFor(conversation.id);
      expect(
        (
          await pendingStore.claim({
            id: record.id,
            kind: "choice",
            bind,
            optionId,
          })
        ).kind,
      ).toBe("claimed");
      expect(
        (
          await pendingStore.complete({
            id: record.id,
            kind: "choice",
            bind,
            optionId,
          })
        ).kind,
      ).toBe("completed");
      const resumeKey = `begin:resume:${record.id}`;
      const begun = await seedHarness.invoke(
        checkpointAssistantTurn,
        {
          kind: "begin",
          conversationId: conversation.id,
          turnKey: resumeKey,
        },
        {
          idempotencyKey: attemptKey("turn", conversation.id, resumeKey),
        },
      );
      const newer = new Date(Date.now() + 60_000);
      await kit.db.runtime.db.insert(assistantMessages).values(
        Array.from({ length: 256 }, () => ({
          companyId: kitIdentities.companies.a,
          conversationId: conversation.id,
          role: "assistant" as const,
          body: "later speech",
          turnKey: `begin:${randomUUID()}`,
          createdAt: newer,
          updatedAt: newer,
        })),
      );
      const history = await seedHarness.invoke(getModelHistory, {
        conversationId: conversation.id,
      });
      expect(
        history.checkpointTurns.filter(
          (turn) => turn.speech === "later speech",
        ),
      ).toHaveLength(256);
      expect(
        history.checkpointTurns.find((turn) => turn.turnKey === resumeKey),
      ).toEqual({
        messageId: begun.messageId,
        turnKey: resumeKey,
        hasSpeech: false,
        speech: "",
      });
      const beforeChat = await orderCount();
      const reissue = new MockLanguageModelV3({
        doStream: [
          mockToolCallStream(
            "call-reissue-create",
            ORDERS_CREATE_TOOL_NAME,
            JSON.stringify(cake.facadeInput),
          ),
          mockTextStream("Trying another create."),
        ],
      });
      await parseOk(
        await liveRequest(liveApp({ pendingStore, model: reissue }).app, {
          method: "POST",
          path: ASSISTANT_CHAT_PATH,
          token,
          body: {
            conversationId: conversation.id,
            text: "create another order",
            locale: "en",
          },
        }),
      );
      expect(await orderCount()).toBe(beforeChat);
    });

    it("does not auto-execute a started run whose message turnKey is null", async () => {
      const h = liveApp({
        model: silentModel("No legacy write from this chat."),
      });
      const token = await insertBearer(kit, kitIdentities.users.anna);
      const conversation = await h.invoke(createConversation, {
        title: "Live null turnKey fail closed",
      });
      const cake = await cakeCreateInputs(h, "Live null turnKey");
      const inserted = (
        await kit.db.runtime.db
          .insert(assistantMessages)
          .values({
            companyId: kitIdentities.companies.a,
            conversationId: conversation.id,
            role: "assistant",
            body: "",
          })
          .returning({ id: assistantMessages.id })
      )[0];
      if (inserted === undefined) {
        throw new Error("null turnKey insert returned no row");
      }
      const staged = await h.invoke(
        checkpointAssistantTurn,
        {
          kind: "stageRun",
          conversationId: conversation.id,
          messageId: inserted.id,
          seq: 0,
          actionName: "orders.create",
          toolName: ORDERS_CREATE_TOOL_NAME,
          toolCallId: "call-null-turn-key",
          toolInput: cake.facadeInput,
        },
        {
          idempotencyKey: attemptKey(
            "turn",
            conversation.id,
            `stage:${inserted.id}:0`,
          ),
        },
      );
      if (staged.executionId === null) {
        throw new Error("null turnKey stageRun returned no executionId");
      }
      const beforeChat = await orderCount();
      await parseOk(
        await liveRequest(h.app, {
          method: "POST",
          path: ASSISTANT_CHAT_PATH,
          token,
          body: {
            conversationId: conversation.id,
            text: "Just saying hi",
            locale: "en",
          },
        }),
      );
      expect(await orderCount()).toBe(beforeChat);
      const history = await h.invoke(getModelHistory, {
        conversationId: conversation.id,
      });
      expect(
        history.unfinishedStartedRuns.some(
          (run) =>
            run.executionId === staged.executionId && run.turnKey === null,
        ),
      ).toBe(true);
    });
  });

  it("live customers.deleteCustomer confirms on POST /assistant/confirm; Так does not", async () => {
    const confirmation = countingConfirmationStore();
    const pendingStore = createMemoryPendingStore();
    const h = liveApp({ pendingStore, confirmation });
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await h.invoke(createConversation, {
      title: "Live delete confirm",
    });
    const customer = await h.invoke(createCustomer, {
      name: "Live Delete Customer",
      phone: nextPhone(),
    });
    await h.invoke(archiveCustomer, { id: customer.id });
    const paused = await parseOk(
      await liveRequest(
        liveApp({
          pendingStore,
          confirmation,
          model: new MockLanguageModelV3({
            doStream: [
              mockToolCallStream(
                "call-delete",
                DELETE_CUSTOMER_TOOL,
                JSON.stringify({ id: customer.id }),
              ),
              mockTextStream("Confirm the delete."),
            ],
          }),
        }).app,
        {
          method: "POST",
          path: ASSISTANT_CHAT_PATH,
          token,
          body: {
            conversationId: conversation.id,
            text: "видали клієнта",
            locale: "uk",
          },
        },
      ),
    );
    expect(paused.pending?.kind).toBe("confirmation");
    if (paused.pending?.kind !== "confirmation") {
      return;
    }
    const pausedDeletes = (await conversationToolRuns(conversation.id)).filter(
      (row) => row.actionName === "customers.deleteCustomer",
    );
    expect(pausedDeletes).toHaveLength(1);
    expect(pausedDeletes[0]?.outcome).toBe("confirmation_required");
    expect(pausedDeletes[0]?.executionId).toEqual(expect.any(String));
    expect(pausedDeletes[0]?.toolInput).toEqual({ id: customer.id });
    const discuss = liveApp({
      pendingStore,
      confirmation,
      model: silentModel("Still waiting."),
    });
    const tak = await parseOk(
      await liveRequest(discuss.app, {
        method: "POST",
        path: ASSISTANT_CHAT_PATH,
        token,
        body: {
          conversationId: conversation.id,
          text: "Так",
          locale: "uk",
        },
      }),
    );
    expect(tak.pending?.id).toBe(paused.pending.id);
    expect(await customerRow(customer.id)).toBeDefined();
    const consumesBefore = h.consumeCount();
    const confirmed = await parseOk(
      await liveRequest(
        liveApp({
          pendingStore,
          confirmation,
          model: listThenSpeakModel(),
        }).app,
        {
          method: "POST",
          path: ASSISTANT_CONFIRM_PATH,
          token,
          body: {
            conversationId: conversation.id,
            challengeId: paused.pending.challengeId,
          },
        },
      ),
    );
    expect(confirmed.pending).toBeNull();
    expect(await customerRow(customer.id)).toBeUndefined();
    expect(discuss.consumeCount()).toBeGreaterThan(consumesBefore);
    const replay = await parseOk(
      await liveRequest(discuss.app, {
        method: "POST",
        path: ASSISTANT_CONFIRM_PATH,
        token,
        body: {
          conversationId: conversation.id,
          challengeId: paused.pending.challengeId,
        },
      }),
    );
    expect(replay.pending).toBeNull();
    expect(await customerRow(customer.id)).toBeUndefined();
    const afterDeletes = (await conversationToolRuns(conversation.id)).filter(
      (row) => row.actionName === "customers.deleteCustomer",
    );
    expect(afterDeletes).toHaveLength(1);
    expect(afterDeletes[0]?.executionId).toBe(pausedDeletes[0]?.executionId);
    expect(afterDeletes[0]?.outcome).toBe("success");
    expect(afterDeletes[0]?.toolInput).toEqual({ id: customer.id });
    expect(
      afterDeletes.some((row) => row.outcome === "confirmation_required"),
    ).toBe(false);
  });
});
