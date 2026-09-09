/**
 * SHO-522 unpublished host: pending lifecycle, confirm/choice Phase A+B,
 * abandon, GET pending. Not mounted on createApp. No live LLM.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyChoiceOptionToCanonicalInput,
  assistantHostInteractionResultSchema,
  assistantPendingPeekResultSchema,
  attemptKey,
  confirmationPendingRecord,
  executionAttemptKey,
  HOST_PHASE_A_TOOL_CALL_ID_PREFIX,
  ORDERS_CREATE_TOOL_NAME,
  ORDERS_LIST_PAGE_TOOL_NAME,
  PENDING_REPLACE_TOOL_NAME,
  pendingChoiceRecordFromChoiceRecord,
  STAFF_ASSISTANT_SUCCESS_SPEECH_FALLBACK,
  staffAssistantModelMessagesFromPersisted,
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
import {
  archiveProduct,
  archiveVariant,
  createProduct,
  restoreProduct,
} from "@showzy/catalog";
import { COMPANY_SELECTOR_HEADER } from "@showzy/contract";
import {
  createConfirmationHook,
  createInMemoryConfirmationStore,
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
  restoreCustomer,
} from "@showzy/customers";
import { createOrder, getOrder } from "@showzy/orders";
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
import { type AuthInstance } from "./app.js";
import { ASSISTANT_INVOCATION_CHANNEL } from "./assistant-chat.js";
import {
  ASSISTANT_CONFIRM_PATH,
  ASSISTANT_HOST_CHAT_PATH,
  ASSISTANT_HOST_CHOICE_PATH,
  ASSISTANT_PENDING_ABANDON_PATH,
  ASSISTANT_PENDING_PATH,
  createStaffAssistantHostApp,
} from "./assistant-host.js";
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
  return `+3806795${String(phoneSeq).padStart(5, "0")}`;
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
  readonly app: ReturnType<typeof createStaffAssistantHostApp>;
  readonly pendingStore: StaffAssistantPendingStore;
  readonly consumeCount: () => number;
  invoke: <TInput extends z.ZodType, TOutput extends z.ZodType, TTarget>(
    action: ImplementedAction<TInput, TOutput, TTarget>,
    input: unknown,
    request?: {
      readonly idempotencyKey?: string;
      readonly confirmationChallengeId?: string;
    },
    actor?: { readonly userId: string; readonly companyId: string },
  ) => Promise<z.output<TOutput>>;
};

function countingConversationLock(inner: ConversationLock): {
  readonly lock: ConversationLock;
  readonly maxConcurrent: () => number;
} {
  let current = 0;
  let max = 0;
  return {
    lock: {
      withLock(conversationId, work) {
        return inner.withLock(conversationId, async () => {
          current += 1;
          max = Math.max(max, current);
          try {
            return await work();
          } finally {
            current -= 1;
          }
        });
      },
    },
    maxConcurrent: () => max,
  };
}

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

function harness(options?: {
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
  const app = createStaffAssistantHostApp({
    auth,
    registry,
    pipeline,
    pendingStore,
    conversationLock:
      options?.conversationLock ?? createMemoryConversationLock(),
    model: options?.model ?? silentModel(),
    getPeerAddress: () => REAL_CLIENT,
  });
  return {
    app,
    pendingStore,
    consumeCount: confirmation.consumeCount,
    invoke(action, input, request, actor) {
      const userId = actor?.userId ?? kitIdentities.users.anna;
      const companyId = actor?.companyId ?? kitIdentities.companies.a;
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
          session: { userId },
          companySelector: companyId,
        },
      });
    },
  };
}

async function hostRequest(
  app: ReturnType<typeof createStaffAssistantHostApp>,
  options: {
    readonly method: "GET" | "POST";
    readonly path: string;
    readonly token: string;
    readonly companyId?: string;
    readonly body?: unknown;
    readonly requestId?: string;
  },
): Promise<Response> {
  const headers = new Headers({
    origin: "http://localhost:3000",
    authorization: `Bearer ${options.token}`,
    [COMPANY_SELECTOR_HEADER]: options.companyId ?? kitIdentities.companies.a,
  });
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  if (options.requestId !== undefined) {
    headers.set(REQUEST_ID_HEADER, options.requestId);
  }
  return app.request(options.path, {
    method: options.method,
    headers,
    ...(options.body !== undefined
      ? { body: JSON.stringify(options.body) }
      : {}),
  });
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

async function finishLaterOrdersCreate(
  h: Harness,
  conversationId: string,
  label: string,
): Promise<{ readonly orderId: string; readonly executionId: string }> {
  const later = await cakeCreateInputs(h, label);
  const laterRun = await stageNamedStartedRun(h, {
    conversationId,
    beginKey: `begin:${randomUUID()}`,
    actionName: "orders.create",
    toolName: ORDERS_CREATE_TOOL_NAME,
    toolCallId: `call-later-create-${randomUUID()}`,
    toolInput: later.facadeInput,
  });
  const laterCreated = await h.invoke(createOrder, later.canonicalInput, {
    idempotencyKey: executionAttemptKey(conversationId, laterRun.executionId),
  });
  await h.invoke(
    checkpointAssistantTurn,
    {
      kind: "finishRun",
      conversationId,
      executionId: laterRun.executionId,
      outcome: "success",
      resultIds: [laterCreated.orderId],
      modelTrace: laterCreated,
    },
    {
      idempotencyKey: attemptKey(
        "turn",
        conversationId,
        `finish:${laterRun.executionId}:success`,
      ),
    },
  );
  return {
    orderId: laterCreated.orderId,
    executionId: laterRun.executionId,
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
    readonly extraLine?: {
      readonly productId: string;
      readonly variantId: string;
    };
  },
): Promise<{
  readonly record: Extract<PendingInteractionRecord, { kind: "choice" }>;
  readonly optionByLabel: Map<string, string>;
  readonly facadeInput: ReturnType<typeof ordersCreateFacadeInput>;
}> {
  const choiceId = randomUUID();
  const optionByLabel = new Map<string, string>();
  const optionMap: Record<string, string> = {};
  const envelopeOptions = options.product.variants.map((variant) => {
    const optionId = randomUUID();
    optionByLabel.set(variant.name, optionId);
    optionMap[optionId] = variant.variantId;
    return { id: optionId, label: variant.name };
  });
  const items: Array<{
    product: { by: "id"; id: string };
    variantSelection:
      | { kind: "unspecified" }
      | { kind: "reference"; ref: { by: "id"; id: string } };
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
  if (options.extraLine !== undefined) {
    items.push({
      product: { by: "id", id: options.extraLine.productId },
      variantSelection: {
        kind: "reference",
        ref: { by: "id", id: options.extraLine.variantId },
      },
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
  const facadeInput = ordersCreateFacadeInput(options.customerId, productIds);
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
      locale: "en",
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
  return { record, optionByLabel, facadeInput };
}

async function seedConfirmationPending(
  h: Harness,
  conversationId: string,
): Promise<{
  readonly customerId: string;
  readonly challengeId: string;
  readonly executionId: string;
  readonly summary: string;
}> {
  const customer = await h.invoke(createCustomer, {
    name: "Archived Delete Target",
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
    bind: {
      actorId: kitIdentities.users.anna,
      companyId: kitIdentities.companies.a,
      conversationId,
    },
    actionName: "customers.deleteCustomer",
    toolCallId: `call-delete:${customer.id}`,
    canonicalInput,
    summary: unconfirmed.challenge.summary,
    challengeExpiresAt: unconfirmed.challenge.expiresAt,
    executionId,
    locale: "en",
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
    summary: unconfirmed.challenge.summary,
  };
}

async function customerRow(
  customerId: string,
): Promise<{ readonly id: string } | undefined> {
  const rows = (await kit.db.runtime.db.select().from(companyCustomers)).filter(
    (row) => row.id === customerId,
  );
  return rows[0];
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

function entityCardOrderIds(cards: OkResumeEnvelope["cards"]): string[] {
  return cards.flatMap((card) => {
    if (
      card.kind !== "surface" ||
      typeof card.data !== "object" ||
      card.data === null ||
      !("kind" in card.data) ||
      card.data.kind !== "order-entity" ||
      !("orderId" in card.data) ||
      typeof card.data.orderId !== "string"
    ) {
      return [];
    }
    return [card.data.orderId];
  });
}

function ordersCreateFacadeInput(
  customerId: string,
  productIds: readonly string[],
): {
  readonly customerId: string;
  readonly items: ReadonlyArray<{
    readonly productId: string;
    readonly quantityMilli: "1000";
  }>;
} {
  return {
    customerId,
    items: productIds.map((productId) => ({
      productId,
      quantityMilli: "1000",
    })),
  };
}

function modelMessagesFromHistory(history: {
  readonly messages: ReadonlyArray<{
    readonly role: "user" | "assistant";
    readonly text: string;
    readonly toolRuns: ReadonlyArray<{
      readonly action: string;
      readonly toolCallId: string;
      readonly toolName: string | null;
      readonly modelTrace: unknown;
      readonly toolInput: unknown;
      readonly seq: number | null;
      readonly outcome: string;
    }>;
  }>;
}) {
  return staffAssistantModelMessagesFromPersisted(
    history.messages.map((message) => ({
      role: message.role,
      body: message.text,
      toolRuns: message.toolRuns.map((run) => ({
        action: run.action,
        toolCallId: run.toolCallId,
        modelTrace: run.modelTrace,
        ...(run.toolName !== null ? { toolName: run.toolName } : {}),
        ...(run.toolInput !== null ? { toolInput: run.toolInput } : {}),
        ...(run.seq !== null ? { seq: run.seq } : {}),
        outcome: run.outcome,
      })),
    })),
  );
}

describe("unpublished staff assistant host HTTP", () => {
  it("replays the same choice option, conflicts on a different option, and expires a wrong bind", async () => {
    const h = harness({ model: listThenSpeakModel() });
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await h.invoke(createConversation, {
      title: "Choice CAS",
    });
    const customer = await h.invoke(createCustomer, {
      name: "Katia",
      phone: nextPhone(),
    });
    const product = await h.invoke(createProduct, {
      name: "Macarons Katia",
      basePriceMinor: "1500",
      variants: [{ name: "Lemon" }, { name: "Vanilla" }],
    });
    const { record, optionByLabel } = await seedChoicePending(h, {
      conversationId: conversation.id,
      customerId: customer.id,
      product,
    });
    const lemon = optionByLabel.get("Lemon");
    const vanilla = optionByLabel.get("Vanilla");
    expect(lemon).toBeDefined();
    const first = await hostRequest(h.app, {
      method: "POST",
      path: ASSISTANT_HOST_CHOICE_PATH,
      token,
      body: {
        conversationId: conversation.id,
        choiceId: record.id,
        optionId: lemon,
      },
    });
    expect(first.status).toBe(200);
    const firstBody = assistantHostInteractionResultSchema.parse(
      await first.json(),
    );
    expect(firstBody.status).toBe("ok");
    if (firstBody.status !== "ok") {
      return;
    }
    expect(firstBody.pending).toBeNull();
    const replay = await hostRequest(h.app, {
      method: "POST",
      path: ASSISTANT_HOST_CHOICE_PATH,
      token,
      body: {
        conversationId: conversation.id,
        choiceId: record.id,
        optionId: lemon,
      },
    });
    const replayBody = assistantHostInteractionResultSchema.parse(
      await replay.json(),
    );
    expect(replayBody.status).toBe("ok");
    const conflict = await hostRequest(h.app, {
      method: "POST",
      path: ASSISTANT_HOST_CHOICE_PATH,
      token,
      body: {
        conversationId: conversation.id,
        choiceId: record.id,
        optionId: vanilla,
      },
    });
    const conflictBody = assistantHostInteractionResultSchema.parse(
      await conflict.json(),
    );
    expect(conflictBody).toMatchObject({
      status: "error",
      code: "CHOICE_OPTION_CONFLICT",
    });
    const otherConversation = await h.invoke(createConversation, {
      title: "Other thread",
    });
    const wrongBind = await hostRequest(h.app, {
      method: "POST",
      path: ASSISTANT_HOST_CHOICE_PATH,
      token,
      body: {
        conversationId: otherConversation.id,
        choiceId: record.id,
        optionId: lemon,
      },
    });
    expect(
      assistantHostInteractionResultSchema.parse(await wrongBind.json()),
    ).toEqual({ status: "expired" });
  });

  it("choice resume finishRun the paused execution_id and keeps façade tool_input (SHO-543)", async () => {
    const h = harness({ model: listThenSpeakModel() });
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await h.invoke(createConversation, {
      title: "Choice resume same execution_id",
    });
    const customer = await h.invoke(createCustomer, {
      name: "T8 Choice Buyer",
      phone: nextPhone(),
    });
    const product = await h.invoke(createProduct, {
      name: "T8 Choice Cake",
      basePriceMinor: "1500",
      variants: [{ name: "A" }, { name: "B" }],
    });
    const { record, optionByLabel, facadeInput } = await seedChoicePending(h, {
      conversationId: conversation.id,
      customerId: customer.id,
      product,
    });
    const optionId = optionByLabel.get("A");
    if (optionId === undefined || record.executionId === undefined) {
      throw new Error("seeded choice missing option or executionId");
    }
    const pausedRows = (await conversationToolRuns(conversation.id)).filter(
      (row) => row.actionName === "orders.create",
    );
    expect(pausedRows).toHaveLength(1);
    expect(pausedRows[0]?.executionId).toBe(record.executionId);
    expect(pausedRows[0]?.outcome).toBe("choice_required");
    expect(pausedRows[0]?.seq).toBe(0);
    expect(pausedRows[0]?.toolInput).toEqual(facadeInput);
    const first = await hostRequest(h.app, {
      method: "POST",
      path: ASSISTANT_HOST_CHOICE_PATH,
      token,
      body: {
        conversationId: conversation.id,
        choiceId: record.id,
        optionId,
      },
    });
    const firstBody = assistantHostInteractionResultSchema.parse(
      await first.json(),
    );
    expect(firstBody.status).toBe("ok");
    if (firstBody.status !== "ok") {
      return;
    }
    expect(firstBody.pending).toBeNull();
    const afterRows = (await conversationToolRuns(conversation.id)).filter(
      (row) => row.actionName === "orders.create",
    );
    expect(afterRows).toHaveLength(1);
    expect(afterRows[0]?.executionId).toBe(record.executionId);
    expect(afterRows[0]?.outcome).toBe("success");
    expect(afterRows[0]?.seq).toBe(pausedRows[0]?.seq);
    expect(afterRows[0]?.toolInput).toEqual(facadeInput);
    expect(afterRows[0]?.toolInput).not.toEqual(record.canonicalInput);
    expect(afterRows.some((row) => row.outcome === "choice_required")).toBe(
      false,
    );
    expect(
      afterRows.some((row) =>
        row.toolCallId.startsWith(HOST_PHASE_A_TOOL_CALL_ID_PREFIX),
      ),
    ).toBe(false);
    const history = await h.invoke(getModelHistory, {
      conversationId: conversation.id,
    });
    const pausedHistoryRuns = history.messages
      .flatMap((message) =>
        message.toolRuns.map((run) => ({
          messageId: message.id,
          run,
        })),
      )
      .filter((entry) => entry.run.executionId === record.executionId);
    expect(pausedHistoryRuns).toHaveLength(1);
    expect(pausedHistoryRuns[0]?.run.outcome).toBe("success");
    expect(pausedHistoryRuns[0]?.run.seq).toBe(0);
    expect(pausedHistoryRuns[0]?.run.toolInput).toEqual(facadeInput);
    const reconstructed = modelMessagesFromHistory(history);
    const pauseMessage = reconstructed.find((message) => {
      if (message.role !== "assistant" || !Array.isArray(message.content)) {
        return false;
      }
      return message.content.some(
        (part) =>
          part.type === "tool-call" &&
          part.toolCallId === pausedHistoryRuns[0]?.run.toolCallId,
      );
    });
    expect(pauseMessage?.role).toBe("assistant");
    if (pauseMessage === undefined || pauseMessage.role !== "assistant") {
      throw new Error("expected reconstructed pause tool-call");
    }
    const pauseCalls = Array.isArray(pauseMessage.content)
      ? pauseMessage.content.filter(
          (part) =>
            part.type === "tool-call" &&
            part.toolCallId === pausedHistoryRuns[0]?.run.toolCallId,
        )
      : [];
    expect(pauseCalls).toHaveLength(1);
    expect(pauseCalls[0]).toMatchObject({
      type: "tool-call",
      input: facadeInput,
    });
    const pauseResults = reconstructed.flatMap((message) => {
      if (message.role !== "tool" || !Array.isArray(message.content)) {
        return [];
      }
      return message.content.filter(
        (part) =>
          part.type === "tool-result" &&
          part.toolCallId === pausedHistoryRuns[0]?.run.toolCallId,
      );
    });
    expect(pauseResults).toHaveLength(1);
    const replay = await hostRequest(h.app, {
      method: "POST",
      path: ASSISTANT_HOST_CHOICE_PATH,
      token,
      body: {
        conversationId: conversation.id,
        choiceId: record.id,
        optionId,
      },
    });
    expect(
      assistantHostInteractionResultSchema.parse(await replay.json()).status,
    ).toBe("ok");
    const replayRows = (await conversationToolRuns(conversation.id)).filter(
      (row) => row.actionName === "orders.create",
    );
    expect(replayRows).toHaveLength(1);
    expect(replayRows[0]?.executionId).toBe(record.executionId);
    expect(replayRows[0]?.outcome).toBe("success");
  });

  it("choice speech-only Phase B still returns the order-entity card (SHO-544)", async () => {
    const h = harness({ model: silentModel("Замовлення створено") });
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await h.invoke(createConversation, {
      title: "T9 speech-only order card",
    });
    const customer = await h.invoke(createCustomer, {
      name: "T9 Speech Buyer",
      phone: nextPhone(),
    });
    const product = await h.invoke(createProduct, {
      name: "T9 Speech Cake",
      basePriceMinor: "1500",
      variants: [{ name: "A" }, { name: "B" }],
    });
    const { record, optionByLabel } = await seedChoicePending(h, {
      conversationId: conversation.id,
      customerId: customer.id,
      product,
    });
    const optionId = optionByLabel.get("A");
    const before = await orderCount();
    const first = await hostRequest(h.app, {
      method: "POST",
      path: ASSISTANT_HOST_CHOICE_PATH,
      token,
      body: {
        conversationId: conversation.id,
        choiceId: record.id,
        optionId,
      },
    });
    const body = assistantHostInteractionResultSchema.parse(await first.json());
    expect(body.status).toBe("ok");
    if (body.status !== "ok") {
      return;
    }
    expect(body.speech).toBe("Замовлення створено");
    expect(body.pending).toBeNull();
    expectKnownResumeCardKinds(body.cards);
    expect(surfaceCard(body.cards, "orders-list")).toBeUndefined();
    const orderId = orderIdFromEntityCard(body.cards);
    expect(await orderCount()).toBe(before + 1);
    expect(
      (await kit.db.runtime.db.select({ id: orders.id }).from(orders)).some(
        (row) => row.id === orderId,
      ),
    ).toBe(true);
    const replay = await hostRequest(h.app, {
      method: "POST",
      path: ASSISTANT_HOST_CHOICE_PATH,
      token,
      body: {
        conversationId: conversation.id,
        choiceId: record.id,
        optionId,
      },
    });
    const replayBody = assistantHostInteractionResultSchema.parse(
      await replay.json(),
    );
    expect(replayBody.status).toBe("ok");
    if (replayBody.status !== "ok") {
      return;
    }
    expect(replayBody.pending).toBeNull();
    expect(orderIdFromEntityCard(replayBody.cards)).toBe(orderId);
    expect(await orderCount()).toBe(before + 1);
  });

  it("delayed choice replay keeps the Phase A order card when the pause key is knowable (SHO-544)", async () => {
    const h = harness({ model: silentModel("Замовлення створено") });
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await h.invoke(createConversation, {
      title: "T9 delayed replay knowable pause key",
    });
    const customer = await h.invoke(createCustomer, {
      name: "T9 Knowable Buyer",
      phone: nextPhone(),
    });
    const product = await h.invoke(createProduct, {
      name: "T9 Knowable Cake",
      basePriceMinor: "1500",
      variants: [{ name: "A" }, { name: "B" }],
    });
    const { record, optionByLabel } = await seedChoicePending(h, {
      conversationId: conversation.id,
      customerId: customer.id,
      product,
    });
    const optionId = optionByLabel.get("A");
    if (optionId === undefined || record.executionId === undefined) {
      throw new Error("seeded choice missing option or executionId");
    }
    const first = await hostRequest(h.app, {
      method: "POST",
      path: ASSISTANT_HOST_CHOICE_PATH,
      token,
      body: {
        conversationId: conversation.id,
        choiceId: record.id,
        optionId,
      },
    });
    const body = assistantHostInteractionResultSchema.parse(await first.json());
    expect(body.status).toBe("ok");
    if (body.status !== "ok") {
      return;
    }
    const orderId = orderIdFromEntityCard(body.cards);
    const later = await finishLaterOrdersCreate(
      h,
      conversation.id,
      "T9 Knowable Later Create",
    );
    const visible = await h.invoke(getModelHistory, {
      conversationId: conversation.id,
    });
    expect(
      visible.messages
        .flatMap((message) => message.toolRuns)
        .some((run) => run.executionId === record.executionId),
    ).toBe(true);
    const replay = await hostRequest(h.app, {
      method: "POST",
      path: ASSISTANT_HOST_CHOICE_PATH,
      token,
      body: {
        conversationId: conversation.id,
        choiceId: record.id,
        optionId,
      },
    });
    const replayBody = assistantHostInteractionResultSchema.parse(
      await replay.json(),
    );
    expect(replayBody.status).toBe("ok");
    if (replayBody.status !== "ok") {
      return;
    }
    expect(replayBody.pending).toBeNull();
    expectKnownResumeCardKinds(replayBody.cards);
    const replayOrderIds = entityCardOrderIds(replayBody.cards);
    expect(replayOrderIds).not.toContain(later.orderId);
    expect(orderIdFromEntityCard(replayBody.cards)).toBe(orderId);
    expect(replayOrderIds).toEqual([orderId]);
  });

  it("clipped unknown pause key fails closed and does not hijack a later create (SHO-544)", async () => {
    const h = harness({ model: silentModel("Замовлення створено") });
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await h.invoke(createConversation, {
      title: "T9 delayed replay unknown pause key",
    });
    const customer = await h.invoke(createCustomer, {
      name: "T9 Unknown Buyer",
      phone: nextPhone(),
    });
    const product = await h.invoke(createProduct, {
      name: "T9 Unknown Cake",
      basePriceMinor: "1500",
      variants: [{ name: "A" }, { name: "B" }],
    });
    const { record, optionByLabel } = await seedChoicePending(h, {
      conversationId: conversation.id,
      customerId: customer.id,
      product,
    });
    const optionId = optionByLabel.get("A");
    if (optionId === undefined || record.executionId === undefined) {
      throw new Error("seeded choice missing option or executionId");
    }
    const first = await hostRequest(h.app, {
      method: "POST",
      path: ASSISTANT_HOST_CHOICE_PATH,
      token,
      body: {
        conversationId: conversation.id,
        choiceId: record.id,
        optionId,
      },
    });
    const body = assistantHostInteractionResultSchema.parse(await first.json());
    expect(body.status).toBe("ok");
    if (body.status !== "ok") {
      return;
    }
    const later = await finishLaterOrdersCreate(
      h,
      conversation.id,
      "T9 Unknown Later Create",
    );
    await kit.db.runtime.db.insert(assistantMessages).values(
      Array.from({ length: 3 }, () => ({
        companyId: kitIdentities.companies.a,
        conversationId: conversation.id,
        role: "assistant" as const,
        body: "later filler speech",
        turnKey: `begin:${randomUUID()}`,
      })),
    );
    await padUserMessages(h, conversation.id, 8);
    const clipped = await h.invoke(getModelHistory, {
      conversationId: conversation.id,
    });
    expect(clipped.messages).toHaveLength(8);
    expect(
      clipped.messages
        .flatMap((message) => message.toolRuns)
        .some((run) => run.executionId === record.executionId),
    ).toBe(false);
    expect(
      clipped.unfinishedStartedRuns.some(
        (run) => run.executionId === record.executionId,
      ),
    ).toBe(false);
    expect(clipped.checkpointTurns.length).toBeGreaterThan(1);
    const replay = await hostRequest(h.app, {
      method: "POST",
      path: ASSISTANT_HOST_CHOICE_PATH,
      token,
      body: {
        conversationId: conversation.id,
        choiceId: record.id,
        optionId,
      },
    });
    const replayBody = assistantHostInteractionResultSchema.parse(
      await replay.json(),
    );
    expect(replayBody.status).toBe("ok");
    if (replayBody.status !== "ok") {
      return;
    }
    expect(replayBody.pending).toBeNull();
    expectKnownResumeCardKinds(replayBody.cards);
    expect(entityCardOrderIds(replayBody.cards)).not.toContain(later.orderId);
    expect(surfaceCard(replayBody.cards, "order-entity")).toBeUndefined();
  });

  it("Phase B generation failure after committed create still returns the order card (SHO-544)", async () => {
    const h = harness({ model: failingGenerationModel() });
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await h.invoke(createConversation, {
      title: "T9 Phase B generation fail",
    });
    const customer = await h.invoke(createCustomer, {
      name: "T9 Fail Buyer",
      phone: nextPhone(),
    });
    const product = await h.invoke(createProduct, {
      name: "T9 Fail Cake",
      basePriceMinor: "1500",
      variants: [{ name: "A" }, { name: "B" }],
    });
    const { record, optionByLabel } = await seedChoicePending(h, {
      conversationId: conversation.id,
      customerId: customer.id,
      product,
    });
    const optionId = optionByLabel.get("A");
    if (optionId === undefined || record.executionId === undefined) {
      throw new Error("seeded choice missing option or executionId");
    }
    const before = await orderCount();
    const first = await hostRequest(h.app, {
      method: "POST",
      path: ASSISTANT_HOST_CHOICE_PATH,
      token,
      body: {
        conversationId: conversation.id,
        choiceId: record.id,
        optionId,
      },
    });
    const body = assistantHostInteractionResultSchema.parse(await first.json());
    expect(body.status).toBe("ok");
    if (body.status !== "ok") {
      return;
    }
    expect(body.speech).toBe(STAFF_ASSISTANT_SUCCESS_SPEECH_FALLBACK.en);
    expect(body.pending).toBeNull();
    expectKnownResumeCardKinds(body.cards);
    const orderId = orderIdFromEntityCard(body.cards);
    expect(await orderCount()).toBe(before + 1);
    const createRows = (await conversationToolRuns(conversation.id)).filter(
      (row) => row.actionName === "orders.create",
    );
    expect(createRows).toHaveLength(1);
    expect(createRows[0]?.executionId).toBe(record.executionId);
    expect(createRows[0]?.outcome).toBe("success");
    const replay = await hostRequest(h.app, {
      method: "POST",
      path: ASSISTANT_HOST_CHOICE_PATH,
      token,
      body: {
        conversationId: conversation.id,
        choiceId: record.id,
        optionId,
      },
    });
    const replayBody = assistantHostInteractionResultSchema.parse(
      await replay.json(),
    );
    expect(replayBody.status).toBe("ok");
    if (replayBody.status !== "ok") {
      return;
    }
    expect(replayBody.pending).toBeNull();
    expect(orderIdFromEntityCard(replayBody.cards)).toBe(orderId);
    expect(await orderCount()).toBe(before + 1);
    expect(
      (await conversationToolRuns(conversation.id)).filter(
        (row) => row.actionName === "orders.create",
      ),
    ).toHaveLength(1);
  });

  it("confirm speech-only Phase B uses only registry surfaces and deletes the customer (SHO-544)", async () => {
    const h = harness({ model: silentModel("Customer deleted.") });
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await h.invoke(createConversation, {
      title: "T9 confirm known surfaces",
    });
    const seeded = await seedConfirmationPending(h, conversation.id);
    const first = await hostRequest(h.app, {
      method: "POST",
      path: ASSISTANT_CONFIRM_PATH,
      token,
      body: {
        conversationId: conversation.id,
        challengeId: seeded.challengeId,
      },
    });
    const body = assistantHostInteractionResultSchema.parse(await first.json());
    expect(body.status).toBe("ok");
    if (body.status !== "ok") {
      return;
    }
    expect(body.speech).toBe("Customer deleted.");
    expect(body.pending).toBeNull();
    expectKnownResumeCardKinds(body.cards);
    expect(body.cards.some((card) => card.kind === "choice")).toBe(false);
    expect(body.cards.some((card) => card.kind === "confirmation")).toBe(false);
    expect(surfaceCard(body.cards, "order-entity")).toBeUndefined();
    expect(await customerRow(seeded.customerId)).toBeUndefined();
    const replay = await hostRequest(h.app, {
      method: "POST",
      path: ASSISTANT_CONFIRM_PATH,
      token,
      body: {
        conversationId: conversation.id,
        challengeId: seeded.challengeId,
      },
    });
    const replayBody = assistantHostInteractionResultSchema.parse(
      await replay.json(),
    );
    expect(replayBody.status).toBe("ok");
    if (replayBody.status !== "ok") {
      return;
    }
    expect(replayBody.pending).toBeNull();
    expectKnownResumeCardKinds(replayBody.cards);
    expect(await customerRow(seeded.customerId)).toBeUndefined();
  });

  it("Phase B generation failure after committed delete still returns HTTP ok without a second delete (SHO-544)", async () => {
    const h = harness({ model: failingGenerationModel() });
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await h.invoke(createConversation, {
      title: "T9 confirm generation fail",
    });
    const seeded = await seedConfirmationPending(h, conversation.id);
    const first = await hostRequest(h.app, {
      method: "POST",
      path: ASSISTANT_CONFIRM_PATH,
      token,
      body: {
        conversationId: conversation.id,
        challengeId: seeded.challengeId,
      },
    });
    const body = assistantHostInteractionResultSchema.parse(await first.json());
    expect(body.status).toBe("ok");
    if (body.status !== "ok") {
      return;
    }
    expect(body.speech).toBe(STAFF_ASSISTANT_SUCCESS_SPEECH_FALLBACK.en);
    expect(body.pending).toBeNull();
    expectKnownResumeCardKinds(body.cards);
    expect(body.cards.some((card) => card.kind === "confirmation")).toBe(false);
    expect(await customerRow(seeded.customerId)).toBeUndefined();
    const deleteRows = (await conversationToolRuns(conversation.id)).filter(
      (row) => row.actionName === "customers.deleteCustomer",
    );
    expect(deleteRows).toHaveLength(1);
    expect(deleteRows[0]?.executionId).toBe(seeded.executionId);
    expect(deleteRows[0]?.outcome).toBe("success");
    const replay = await hostRequest(h.app, {
      method: "POST",
      path: ASSISTANT_CONFIRM_PATH,
      token,
      body: {
        conversationId: conversation.id,
        challengeId: seeded.challengeId,
      },
    });
    const replayBody = assistantHostInteractionResultSchema.parse(
      await replay.json(),
    );
    expect(replayBody.status).toBe("ok");
    if (replayBody.status !== "ok") {
      return;
    }
    expect(replayBody.pending).toBeNull();
    expectKnownResumeCardKinds(replayBody.cards);
    expect(await customerRow(seeded.customerId)).toBeUndefined();
    expect(
      (await conversationToolRuns(conversation.id)).filter(
        (row) => row.actionName === "customers.deleteCustomer",
      ),
    ).toHaveLength(1);
  });

  it("confirm resume still finishRun the staged execution_id (SHO-543)", async () => {
    const h = harness({ model: listThenSpeakModel() });
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await h.invoke(createConversation, {
      title: "Confirm staged execution_id",
    });
    const seeded = await seedConfirmationPending(h, conversation.id);
    const pausedRows = (await conversationToolRuns(conversation.id)).filter(
      (row) => row.actionName === "customers.deleteCustomer",
    );
    expect(pausedRows).toHaveLength(1);
    expect(pausedRows[0]?.executionId).toBe(seeded.executionId);
    expect(pausedRows[0]?.outcome).toBe("confirmation_required");
    const first = await hostRequest(h.app, {
      method: "POST",
      path: ASSISTANT_CONFIRM_PATH,
      token,
      body: {
        conversationId: conversation.id,
        challengeId: seeded.challengeId,
      },
    });
    expect(
      assistantHostInteractionResultSchema.parse(await first.json()).status,
    ).toBe("ok");
    const afterRows = (await conversationToolRuns(conversation.id)).filter(
      (row) => row.actionName === "customers.deleteCustomer",
    );
    expect(afterRows).toHaveLength(1);
    expect(afterRows[0]?.executionId).toBe(seeded.executionId);
    expect(afterRows[0]?.outcome).toBe("success");
    expect(afterRows[0]?.toolInput).toEqual({ id: seeded.customerId });
    expect(
      afterRows.some((row) => row.outcome === "confirmation_required"),
    ).toBe(false);
    const replay = await hostRequest(h.app, {
      method: "POST",
      path: ASSISTANT_CONFIRM_PATH,
      token,
      body: {
        conversationId: conversation.id,
        challengeId: seeded.challengeId,
      },
    });
    expect(
      assistantHostInteractionResultSchema.parse(await replay.json()).status,
    ).toBe("ok");
    const replayRows = (await conversationToolRuns(conversation.id)).filter(
      (row) => row.actionName === "customers.deleteCustomer",
    );
    expect(replayRows).toHaveLength(1);
    expect(replayRows[0]?.executionId).toBe(seeded.executionId);
  });

  it("choice resume does not finish another tenant's paused tool-run (SHO-543)", async () => {
    const h = harness({ model: listThenSpeakModel() });
    const anna = await insertBearer(kit, kitIdentities.users.anna);
    const boris = await insertBearer(kit, kitIdentities.users.boris);
    const conversation = await h.invoke(createConversation, {
      title: "Choice cross-tenant",
    });
    const customer = await h.invoke(createCustomer, {
      name: "Tenant A Buyer",
      phone: nextPhone(),
    });
    const product = await h.invoke(createProduct, {
      name: "Tenant A Cake",
      basePriceMinor: "1500",
      variants: [{ name: "A" }, { name: "B" }],
    });
    const { record, optionByLabel } = await seedChoicePending(h, {
      conversationId: conversation.id,
      customerId: customer.id,
      product,
    });
    const optionId = optionByLabel.get("A");
    if (optionId === undefined || record.executionId === undefined) {
      throw new Error("seeded choice missing option or executionId");
    }
    const beforeOrders = await orderCount();
    const foreign = await hostRequest(h.app, {
      method: "POST",
      path: ASSISTANT_HOST_CHOICE_PATH,
      token: boris,
      companyId: kitIdentities.companies.b,
      body: {
        conversationId: conversation.id,
        choiceId: record.id,
        optionId,
      },
    });
    expect(foreign.status).not.toBe(200);
    const foreignBody: unknown = await foreign.json();
    expect(foreignBody).not.toMatchObject({ status: "ok" });
    expect(await orderCount()).toBe(beforeOrders);
    const pausedRows = (await conversationToolRuns(conversation.id)).filter(
      (row) => row.actionName === "orders.create",
    );
    expect(pausedRows).toHaveLength(1);
    expect(pausedRows[0]?.executionId).toBe(record.executionId);
    expect(pausedRows[0]?.outcome).toBe("choice_required");
    const own = await hostRequest(h.app, {
      method: "POST",
      path: ASSISTANT_HOST_CHOICE_PATH,
      token: anna,
      body: {
        conversationId: conversation.id,
        choiceId: record.id,
        optionId,
      },
    });
    expect(
      assistantHostInteractionResultSchema.parse(await own.json()).status,
    ).toBe("ok");
    const afterRows = (await conversationToolRuns(conversation.id)).filter(
      (row) => row.actionName === "orders.create",
    );
    expect(afterRows).toHaveLength(1);
    expect(afterRows[0]?.executionId).toBe(record.executionId);
    expect(afterRows[0]?.outcome).toBe("success");
  });

  it("choice tap after replace finishRun the replace-staged id, not a Phase A replica (SHO-543)", async () => {
    const h = harness({ model: listThenSpeakModel() });
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await h.invoke(createConversation, {
      title: "Replace then choice tap",
    });
    await h.invoke(
      appendUserMessage,
      { conversationId: conversation.id, body: "Create the cake order" },
      { idempotencyKey: attemptKey("message", conversation.id, randomUUID()) },
    );
    const customer = await h.invoke(createCustomer, {
      name: "Replace Tap Buyer",
      phone: nextPhone(),
    });
    const product = await h.invoke(createProduct, {
      name: "Replace Tap Cake",
      basePriceMinor: "1500",
      variants: [{ name: "A" }, { name: "B" }],
    });
    const { record } = await seedChoicePending(h, {
      conversationId: conversation.id,
      customerId: customer.id,
      product,
    });
    const originalExecutionId = record.executionId;
    if (originalExecutionId === undefined) {
      throw new Error("seeded choice missing executionId");
    }
    const replaceHarness = harness({
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
      pendingStore: h.pendingStore,
    });
    const replaceChat = await hostRequest(replaceHarness.app, {
      method: "POST",
      path: ASSISTANT_HOST_CHAT_PATH,
      token,
      body: {
        conversationId: conversation.id,
        text: "Make it three of this cake instead",
        locale: "en",
      },
    });
    const replaced = assistantHostInteractionResultSchema.parse(
      await replaceChat.json(),
    );
    expect(replaced.status).toBe("ok");
    if (replaced.status !== "ok") {
      return;
    }
    expect(replaced.pending?.kind).toBe("choice");
    const peeked = await h.pendingStore.peekOpen({
      conversationId: conversation.id,
      bind: pendingBindFor(conversation.id),
    });
    expect(peeked.kind).toBe("found");
    if (peeked.kind !== "found" || peeked.record.kind !== "choice") {
      throw new Error("expected rebuilt choice pending");
    }
    expect(peeked.record.executionId).not.toBe(originalExecutionId);
    const optionId = peeked.record.envelope.options[0]?.id;
    if (optionId === undefined || peeked.record.executionId === undefined) {
      throw new Error("replaced choice missing option or executionId");
    }
    const tap = await hostRequest(h.app, {
      method: "POST",
      path: ASSISTANT_HOST_CHOICE_PATH,
      token,
      body: {
        conversationId: conversation.id,
        choiceId: peeked.record.id,
        optionId,
      },
    });
    expect(
      assistantHostInteractionResultSchema.parse(await tap.json()).status,
    ).toBe("ok");
    const createRows = (await conversationToolRuns(conversation.id)).filter(
      (row) => row.actionName === "orders.create",
    );
    expect(
      createRows.filter((row) =>
        row.toolCallId.startsWith(HOST_PHASE_A_TOOL_CALL_ID_PREFIX),
      ),
    ).toHaveLength(0);
    const original = createRows.find(
      (row) => row.executionId === originalExecutionId,
    );
    expect(original?.outcome).toBe("choice_required");
    const resolved = createRows.filter(
      (row) => row.executionId === peeked.record.executionId,
    );
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.outcome).toBe("success");
    expect(resolved[0]?.toolInput).toEqual({
      customerId: customer.id,
      items: [
        {
          productId: product.productId,
          quantityMilli: "3000",
        },
      ],
    });
    expect(resolved[0]?.toolInput).not.toEqual(peeked.record.canonicalInput);
    expect(createRows.filter((row) => row.outcome === "success")).toHaveLength(
      1,
    );
  });

  it("refuses a second orders.create while Katia picker is open (same actionName is not replace)", async () => {
    const h = harness({
      model: new MockLanguageModelV3({
        doStream: [
          mockToolCallStream(
            "call-create",
            ORDERS_CREATE_TOOL_NAME,
            JSON.stringify({
              customerId: kitIdentities.users.anna,
              items: [
                {
                  productId: kitIdentities.users.anna,
                  quantityMilli: "1000",
                },
              ],
            }),
          ),
          mockTextStream("Finish the current picker first."),
        ],
      }),
    });
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await h.invoke(createConversation, {
      title: "Katia then Olena",
    });
    await h.invoke(
      appendUserMessage,
      { conversationId: conversation.id, body: "Create for Katia" },
      { idempotencyKey: attemptKey("message", conversation.id, randomUUID()) },
    );
    const customer = await h.invoke(createCustomer, {
      name: "Katia",
      phone: nextPhone(),
    });
    const product = await h.invoke(createProduct, {
      name: "Macarons refuse",
      basePriceMinor: "1500",
      variants: [{ name: "Lemon" }, { name: "Vanilla" }],
    });
    const { record } = await seedChoicePending(h, {
      conversationId: conversation.id,
      customerId: customer.id,
      product,
    });
    const before = await orderCount();
    const chat = await hostRequest(h.app, {
      method: "POST",
      path: ASSISTANT_HOST_CHAT_PATH,
      token,
      body: {
        conversationId: conversation.id,
        text: "ще одне замовлення іншому клієнту",
        locale: "uk",
      },
    });
    expect(chat.status).toBe(200);
    const body = assistantHostInteractionResultSchema.parse(await chat.json());
    expect(body.status).toBe("ok");
    if (body.status !== "ok") {
      return;
    }
    expect(body.pending?.id).toBe(record.id);
    expect(body.pending?.actionName).toBe("orders.create");
    expect(await orderCount()).toBe(before);
    const peek = await hostRequest(h.app, {
      method: "GET",
      path: `${ASSISTANT_PENDING_PATH}?conversationId=${conversation.id}`,
      token,
    });
    const peeked = assistantPendingPeekResultSchema.parse(await peek.json());
    expect(peeked.pending?.id).toBe(record.id);
  });

  it("pending_replace supersedes the old confirmation; stale tap is expired", async () => {
    const confirmation = countingConfirmationStore();
    const pendingStore = createMemoryPendingStore();
    const h = harness({
      pendingStore,
      confirmation,
    });
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await h.invoke(createConversation, {
      title: "Replace confirm",
    });
    await h.invoke(
      appendUserMessage,
      { conversationId: conversation.id, body: "Delete the customer" },
      { idempotencyKey: attemptKey("message", conversation.id, randomUUID()) },
    );
    const seeded = await seedConfirmationPending(h, conversation.id);
    const other = await h.invoke(createCustomer, {
      name: "Replacement target",
      phone: nextPhone(),
    });
    await h.invoke(archiveCustomer, { id: other.id });
    const replaceHarness = harness({
      model: new MockLanguageModelV3({
        doStream: [
          mockToolCallStream(
            "call-replace",
            PENDING_REPLACE_TOOL_NAME,
            JSON.stringify({ id: other.id }),
          ),
          mockTextStream("Quantity unchanged; this is the new delete."),
        ],
      }),
      pendingStore,
      confirmation,
    });
    const replaceChat = await hostRequest(replaceHarness.app, {
      method: "POST",
      path: ASSISTANT_HOST_CHAT_PATH,
      token,
      body: {
        conversationId: conversation.id,
        text: "Actually delete the other archived customer",
        locale: "en",
      },
    });
    const replaced = assistantHostInteractionResultSchema.parse(
      await replaceChat.json(),
    );
    expect(replaced.status).toBe("ok");
    if (replaced.status !== "ok") {
      return;
    }
    expect(replaced.pending?.kind).toBe("confirmation");
    expect(replaced.pending?.id).not.toBe(seeded.challengeId);
    const successorId = replaced.pending?.id;
    expect(successorId).toEqual(expect.any(String));
    const stale = await hostRequest(h.app, {
      method: "POST",
      path: ASSISTANT_CONFIRM_PATH,
      token,
      body: {
        conversationId: conversation.id,
        challengeId: seeded.challengeId,
      },
    });
    expect(
      assistantHostInteractionResultSchema.parse(await stale.json()),
    ).toEqual({ status: "expired" });
    expect(await customerRow(seeded.customerId)).toBeDefined();
    expect(await customerRow(other.id)).toBeDefined();

    const confirmHarness = harness({
      model: listThenSpeakModel(),
      pendingStore,
      confirmation,
    });
    const consumesBefore = confirmHarness.consumeCount();
    const successor = await hostRequest(confirmHarness.app, {
      method: "POST",
      path: ASSISTANT_CONFIRM_PATH,
      token,
      body: {
        conversationId: conversation.id,
        challengeId: successorId,
      },
    });
    const successorBody = assistantHostInteractionResultSchema.parse(
      await successor.json(),
    );
    expect(successorBody.status).toBe("ok");
    expect(await customerRow(other.id)).toBeUndefined();
    expect(await customerRow(seeded.customerId)).toBeDefined();
    expect(confirmHarness.consumeCount()).toBeGreaterThan(consumesBefore);
    const replay = await hostRequest(confirmHarness.app, {
      method: "POST",
      path: ASSISTANT_CONFIRM_PATH,
      token,
      body: {
        conversationId: conversation.id,
        challengeId: successorId,
      },
    });
    expect(
      assistantHostInteractionResultSchema.parse(await replay.json()).status,
    ).toBe("ok");
    expect(await customerRow(other.id)).toBeUndefined();
  });

  it("pending_replace rebuilds the choice picker for a qty change; stale tap is expired", async () => {
    const h = harness();
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await h.invoke(createConversation, {
      title: "Replace choice qty",
    });
    await h.invoke(
      appendUserMessage,
      { conversationId: conversation.id, body: "Create the cake order" },
      { idempotencyKey: attemptKey("message", conversation.id, randomUUID()) },
    );
    const customer = await h.invoke(createCustomer, {
      name: "Qty Buyer",
      phone: nextPhone(),
    });
    const product = await h.invoke(createProduct, {
      name: "Qty Cake",
      basePriceMinor: "1500",
      variants: [{ name: "A" }, { name: "B" }],
    });
    const { record, optionByLabel } = await seedChoicePending(h, {
      conversationId: conversation.id,
      customerId: customer.id,
      product,
    });
    const beforeOrders = await orderCount();
    const staleOptionId = optionByLabel.get("A");
    expect(staleOptionId).toEqual(expect.any(String));
    const replaceHarness = harness({
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
      pendingStore: h.pendingStore,
    });
    const replaceChat = await hostRequest(replaceHarness.app, {
      method: "POST",
      path: ASSISTANT_HOST_CHAT_PATH,
      token,
      body: {
        conversationId: conversation.id,
        text: "Make it three of this cake instead",
        locale: "en",
      },
    });
    const replaced = assistantHostInteractionResultSchema.parse(
      await replaceChat.json(),
    );
    expect(replaced.status).toBe("ok");
    if (replaced.status !== "ok") {
      return;
    }
    expect(replaced.pending?.kind).toBe("choice");
    expect(replaced.pending?.id).not.toBe(record.id);
    expect(replaced.pending?.version).toBe(record.version + 1);
    const peeked = await h.pendingStore.peekOpen({
      conversationId: conversation.id,
      bind: pendingBindFor(conversation.id),
    });
    expect(peeked.kind).toBe("found");
    if (peeked.kind !== "found" || peeked.record.kind !== "choice") {
      throw new Error("expected rebuilt choice pending");
    }
    expect(peeked.record.canonicalInput.items[0]?.quantity).toEqual({
      milli: "3000",
    });
    expect(peeked.record.executionId).not.toBe(record.executionId);
    expect(peeked.record.version).toBe(record.version + 1);
    expect(Object.keys(peeked.record.optionMap).sort()).not.toEqual(
      Object.keys(record.optionMap).sort(),
    );
    expect(peeked.record.target).toMatchObject({
      productId: product.productId,
    });
    const stale = await hostRequest(h.app, {
      method: "POST",
      path: ASSISTANT_HOST_CHOICE_PATH,
      token,
      body: {
        conversationId: conversation.id,
        choiceId: record.id,
        optionId: staleOptionId,
      },
    });
    expect(
      assistantHostInteractionResultSchema.parse(await stale.json()),
    ).toEqual({ status: "expired" });
    expect(await orderCount()).toBe(beforeOrders);
  });

  it("pending_replace with a unique variantId does not create an order", async () => {
    const h = harness();
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await h.invoke(createConversation, {
      title: "Replace unique variant",
    });
    await h.invoke(
      appendUserMessage,
      { conversationId: conversation.id, body: "Create the cake order" },
      { idempotencyKey: attemptKey("message", conversation.id, randomUUID()) },
    );
    const customer = await h.invoke(createCustomer, {
      name: "Unique Variant Buyer",
      phone: nextPhone(),
    });
    const product = await h.invoke(createProduct, {
      name: "Unique Variant Cake",
      basePriceMinor: "1500",
      variants: [{ name: "A" }, { name: "B" }],
    });
    const uniqueVariant = product.variants.find(
      (variant) => variant.name === "A",
    );
    expect(uniqueVariant?.variantId).toEqual(expect.any(String));
    if (uniqueVariant === undefined) {
      throw new Error("expected variant A");
    }
    const { record, optionByLabel } = await seedChoicePending(h, {
      conversationId: conversation.id,
      customerId: customer.id,
      product,
    });
    const staleOptionId = optionByLabel.get("A");
    expect(staleOptionId).toEqual(expect.any(String));
    const beforeOrders = await orderCount();
    const replaceHarness = harness({
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
                  variantId: uniqueVariant.variantId,
                  quantityMilli: "2000",
                },
              ],
            }),
          ),
          mockTextStream("Picking the unique variant."),
        ],
      }),
      pendingStore: h.pendingStore,
    });
    const replaceChat = await hostRequest(replaceHarness.app, {
      method: "POST",
      path: ASSISTANT_HOST_CHAT_PATH,
      token,
      body: {
        conversationId: conversation.id,
        text: "Use variant A, two of them",
        locale: "en",
      },
    });
    const replaced = assistantHostInteractionResultSchema.parse(
      await replaceChat.json(),
    );
    expect(replaced.status).toBe("ok");
    if (replaced.status !== "ok") {
      return;
    }
    expect(replaced.pending?.kind).toBe("confirmation");
    expect(replaced.pending?.id).not.toBe(record.id);
    expect(replaced.pending?.version).toBe(record.version + 1);
    const successorId = replaced.pending?.id;
    expect(successorId).toEqual(expect.any(String));
    const peeked = await h.pendingStore.peekOpen({
      conversationId: conversation.id,
      bind: pendingBindFor(conversation.id),
    });
    expect(peeked.kind).toBe("found");
    if (peeked.kind !== "found" || peeked.record.kind !== "confirmation") {
      throw new Error("expected confirmation pending after unique replace");
    }
    expect(peeked.record.status).toBe("open");
    expect(peeked.record.version).toBe(record.version + 1);
    expect(peeked.record.executionId).not.toBe(record.executionId);
    expect(peeked.record.canonicalInput).toMatchObject({
      customer: { by: "id", id: customer.id },
      items: [
        {
          product: { by: "id", id: product.productId },
          variantSelection: {
            kind: "reference",
            ref: { by: "id", id: uniqueVariant.variantId },
          },
          quantity: { milli: "2000" },
        },
      ],
    });
    expect(await orderCount()).toBe(beforeOrders);

    const stale = await hostRequest(h.app, {
      method: "POST",
      path: ASSISTANT_HOST_CHOICE_PATH,
      token,
      body: {
        conversationId: conversation.id,
        choiceId: record.id,
        optionId: staleOptionId,
      },
    });
    expect(
      assistantHostInteractionResultSchema.parse(await stale.json()),
    ).toEqual({ status: "expired" });
    expect(await orderCount()).toBe(beforeOrders);

    const confirmHarness = harness({
      model: listThenSpeakModel(),
      pendingStore: h.pendingStore,
    });
    const confirm = await hostRequest(confirmHarness.app, {
      method: "POST",
      path: ASSISTANT_CONFIRM_PATH,
      token,
      body: {
        conversationId: conversation.id,
        challengeId: successorId,
      },
    });
    const confirmBody = assistantHostInteractionResultSchema.parse(
      await confirm.json(),
    );
    expect(confirmBody.status).toBe("ok");
    if (confirmBody.status !== "ok") {
      return;
    }
    expect(confirmBody.pending).toBeNull();
    expect(await orderCount()).toBe(beforeOrders + 1);
    const created = await h.invoke(getOrder, {
      orderId: orderIdFromEntityCard(confirmBody.cards),
    });
    expect(created.items).toHaveLength(1);
    expect(created.items[0]?.variantId).toBe(uniqueVariant.variantId);
    expect(created.items[0]?.quantityMilli).toBe("2000");
    const replay = await hostRequest(confirmHarness.app, {
      method: "POST",
      path: ASSISTANT_CONFIRM_PATH,
      token,
      body: {
        conversationId: conversation.id,
        challengeId: successorId,
      },
    });
    expect(
      assistantHostInteractionResultSchema.parse(await replay.json()).status,
    ).toBe("ok");
    expect(await orderCount()).toBe(beforeOrders + 1);
  });

  it("Phase A CoreError on confirm does not complete pending; retry is not ok with null pending", async () => {
    const h = harness({ model: silentModel() });
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await h.invoke(createConversation, {
      title: "Confirm Phase A error",
    });
    const seeded = await seedConfirmationPending(h, conversation.id);
    await h.invoke(restoreCustomer, { id: seeded.customerId });
    const first = await hostRequest(h.app, {
      method: "POST",
      path: ASSISTANT_CONFIRM_PATH,
      token,
      body: {
        conversationId: conversation.id,
        challengeId: seeded.challengeId,
      },
    });
    const firstBody = assistantHostInteractionResultSchema.parse(
      await first.json(),
    );
    expect(firstBody.status).toBe("error");
    if (firstBody.status !== "error") {
      return;
    }
    expect(firstBody.code).toBe("VALIDATION");
    const peeked = await h.pendingStore.peekOpen({
      conversationId: conversation.id,
      bind: pendingBindFor(conversation.id),
    });
    expect(peeked.kind).toBe("found");
    if (peeked.kind !== "found") {
      throw new Error("expected pending still blocking after Phase A error");
    }
    expect(peeked.record.status).toBe("claimed");
    expect(peeked.record.id).toBe(seeded.challengeId);
    expect(await customerRow(seeded.customerId)).toBeDefined();
    const retry = await hostRequest(h.app, {
      method: "POST",
      path: ASSISTANT_CONFIRM_PATH,
      token,
      body: {
        conversationId: conversation.id,
        challengeId: seeded.challengeId,
      },
    });
    const retryBody = assistantHostInteractionResultSchema.parse(
      await retry.json(),
    );
    expect(retryBody.status).not.toBe("ok");
    if (retryBody.status === "ok") {
      expect(retryBody.pending).not.toBeNull();
    }
    const peekedRetry = await h.pendingStore.peekOpen({
      conversationId: conversation.id,
      bind: pendingBindFor(conversation.id),
    });
    expect(peekedRetry.kind).toBe("found");
    expect(await customerRow(seeded.customerId)).toBeDefined();
  });

  it("Phase A CoreError on choice does not complete pending; retry re-executes once after restore", async () => {
    const h = harness({ model: silentModel() });
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await h.invoke(createConversation, {
      title: "Choice Phase A error",
    });
    const customer = await h.invoke(createCustomer, {
      name: "Phase A Error Buyer",
      phone: nextPhone(),
    });
    const product = await h.invoke(createProduct, {
      name: "Phase A Error Cake",
      basePriceMinor: "1500",
      variants: [{ name: "A" }, { name: "B" }],
    });
    const { record, optionByLabel } = await seedChoicePending(h, {
      conversationId: conversation.id,
      customerId: customer.id,
      product,
    });
    const optionId = optionByLabel.get("A");
    if (optionId === undefined) {
      throw new Error("expected option A");
    }
    await h.invoke(archiveProduct, { productId: product.productId });
    const beforeOrders = await orderCount();
    const first = await hostRequest(h.app, {
      method: "POST",
      path: ASSISTANT_HOST_CHOICE_PATH,
      token,
      body: {
        conversationId: conversation.id,
        choiceId: record.id,
        optionId,
      },
    });
    const firstBody = assistantHostInteractionResultSchema.parse(
      await first.json(),
    );
    expect(firstBody.status).toBe("error");
    if (firstBody.status !== "error") {
      return;
    }
    expect(firstBody.code).toBe("NOT_FOUND");
    const peeked = await h.pendingStore.peekOpen({
      conversationId: conversation.id,
      bind: pendingBindFor(conversation.id),
    });
    expect(peeked.kind).toBe("found");
    if (peeked.kind !== "found") {
      throw new Error("expected pending still blocking after Phase A error");
    }
    expect(peeked.record.status).toBe("claimed");
    if (peeked.record.kind !== "choice") {
      throw new Error("expected claimed choice pending");
    }
    expect(peeked.record.claimedOptionId).toBe(optionId);
    expect(peeked.record.id).toBe(record.id);
    expect(await orderCount()).toBe(beforeOrders);
    const why = await hostRequest(h.app, {
      method: "POST",
      path: ASSISTANT_HOST_CHAT_PATH,
      token,
      body: {
        conversationId: conversation.id,
        text: "what happened?",
        locale: "en",
      },
    });
    const whyBody = assistantHostInteractionResultSchema.parse(
      await why.json(),
    );
    expect(whyBody.status).toBe("ok");
    if (whyBody.status === "ok") {
      expect(whyBody.pending?.id).toBe(record.id);
    }
    const peekedAfterChat = await h.pendingStore.peekOpen({
      conversationId: conversation.id,
      bind: pendingBindFor(conversation.id),
    });
    expect(peekedAfterChat.kind).toBe("found");
    if (peekedAfterChat.kind === "found") {
      expect(peekedAfterChat.record.status).toBe("claimed");
      expect(peekedAfterChat.record.id).toBe(record.id);
    }
    const otherOptionId = optionByLabel.get("B");
    if (otherOptionId === undefined) {
      throw new Error("expected option B");
    }
    const conflict = await hostRequest(h.app, {
      method: "POST",
      path: ASSISTANT_HOST_CHOICE_PATH,
      token,
      body: {
        conversationId: conversation.id,
        choiceId: record.id,
        optionId: otherOptionId,
      },
    });
    const conflictBody = assistantHostInteractionResultSchema.parse(
      await conflict.json(),
    );
    expect(conflictBody).toMatchObject({
      status: "error",
      code: "CHOICE_OPTION_CONFLICT",
    });
    const peekedConflict = await h.pendingStore.peekOpen({
      conversationId: conversation.id,
      bind: pendingBindFor(conversation.id),
    });
    expect(peekedConflict.kind).toBe("found");
    if (peekedConflict.kind === "found") {
      expect(peekedConflict.record.status).toBe("claimed");
      expect(peekedConflict.record.id).toBe(record.id);
      if (peekedConflict.record.kind === "choice") {
        expect(peekedConflict.record.claimedOptionId).toBe(optionId);
      }
    }
    const blockedRetry = await hostRequest(h.app, {
      method: "POST",
      path: ASSISTANT_HOST_CHOICE_PATH,
      token,
      body: {
        conversationId: conversation.id,
        choiceId: record.id,
        optionId,
      },
    });
    const blockedBody = assistantHostInteractionResultSchema.parse(
      await blockedRetry.json(),
    );
    expect(blockedBody.status).not.toBe("ok");
    if (blockedBody.status === "ok") {
      expect(blockedBody.pending).not.toBeNull();
    }
    expect(await orderCount()).toBe(beforeOrders);
    await h.invoke(restoreProduct, { productId: product.productId });
    const recovered = await hostRequest(h.app, {
      method: "POST",
      path: ASSISTANT_HOST_CHOICE_PATH,
      token,
      body: {
        conversationId: conversation.id,
        choiceId: record.id,
        optionId,
      },
    });
    const recoveredBody = assistantHostInteractionResultSchema.parse(
      await recovered.json(),
    );
    expect(recoveredBody.status).toBe("ok");
    if (recoveredBody.status !== "ok") {
      return;
    }
    expect(recoveredBody.pending).toBeNull();
    expect(await orderCount()).toBe(beforeOrders + 1);
    const replay = await hostRequest(h.app, {
      method: "POST",
      path: ASSISTANT_HOST_CHOICE_PATH,
      token,
      body: {
        conversationId: conversation.id,
        choiceId: record.id,
        optionId,
      },
    });
    const replayBody = assistantHostInteractionResultSchema.parse(
      await replay.json(),
    );
    expect(replayBody.status).toBe("ok");
    expect(await orderCount()).toBe(beforeOrders + 1);
  });

  it("Phase A VALIDATION on choice leaves pending claimed; same-option retry stays blocking (SHO-545)", async () => {
    const h = harness({ model: silentModel() });
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await h.invoke(createConversation, {
      title: "Choice Phase A VALIDATION",
    });
    const customer = await h.invoke(createCustomer, {
      name: "Phase A Validation Buyer",
      phone: nextPhone(),
    });
    const product = await h.invoke(createProduct, {
      name: "Phase A Validation Cake",
      basePriceMinor: "1500",
      variants: [{ name: "A" }, { name: "B" }],
    });
    const variantA = product.variants.find((variant) => variant.name === "A");
    if (variantA === undefined) {
      throw new Error("expected variant A");
    }
    const { record, optionByLabel } = await seedChoicePending(h, {
      conversationId: conversation.id,
      customerId: customer.id,
      product,
      extraLine: {
        productId: product.productId,
        variantId: variantA.variantId,
      },
    });
    const optionId = optionByLabel.get("A");
    if (optionId === undefined) {
      throw new Error("expected option A");
    }
    const beforeOrders = await orderCount();
    const first = await hostRequest(h.app, {
      method: "POST",
      path: ASSISTANT_HOST_CHOICE_PATH,
      token,
      body: {
        conversationId: conversation.id,
        choiceId: record.id,
        optionId,
      },
    });
    const firstBody = assistantHostInteractionResultSchema.parse(
      await first.json(),
    );
    expect(firstBody.status).toBe("error");
    if (firstBody.status !== "error") {
      return;
    }
    expect(firstBody.code).toBe("VALIDATION");
    const peeked = await h.pendingStore.peekOpen({
      conversationId: conversation.id,
      bind: pendingBindFor(conversation.id),
    });
    expect(peeked.kind).toBe("found");
    if (peeked.kind !== "found") {
      throw new Error("expected pending still blocking after VALIDATION");
    }
    expect(peeked.record.status).toBe("claimed");
    expect(peeked.record.id).toBe(record.id);
    expect(await orderCount()).toBe(beforeOrders);
    const retry = await hostRequest(h.app, {
      method: "POST",
      path: ASSISTANT_HOST_CHOICE_PATH,
      token,
      body: {
        conversationId: conversation.id,
        choiceId: record.id,
        optionId,
      },
    });
    const retryBody = assistantHostInteractionResultSchema.parse(
      await retry.json(),
    );
    expect(retryBody.status).toBe("error");
    if (retryBody.status === "error") {
      expect(retryBody.code).toBe("VALIDATION");
    }
    if (retryBody.status === "ok") {
      expect(retryBody.pending).not.toBeNull();
    }
    const peekedRetry = await h.pendingStore.peekOpen({
      conversationId: conversation.id,
      bind: pendingBindFor(conversation.id),
    });
    expect(peekedRetry.kind).toBe("found");
    if (peekedRetry.kind === "found") {
      expect(peekedRetry.record.status).toBe("claimed");
      expect(peekedRetry.record.id).toBe(record.id);
    }
    expect(await orderCount()).toBe(beforeOrders);
  });

  it("Phase A CONFLICT without picker extras leaves pending claimed; same-option retry stays blocking (SHO-545)", async () => {
    const h = harness({ model: silentModel() });
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await h.invoke(createConversation, {
      title: "Choice Phase A CONFLICT",
    });
    const customer = await h.invoke(createCustomer, {
      name: "Phase A Conflict Buyer",
      phone: nextPhone(),
    });
    const product = await h.invoke(createProduct, {
      name: "Phase A Conflict Cake",
      basePriceMinor: "1500",
      variants: [{ name: "A" }, { name: "B" }],
    });
    const extra = await h.invoke(createProduct, {
      name: "Phase A Conflict Extra",
      basePriceMinor: "1000",
      variants: [{ name: "Only" }],
    });
    const extraVariant = extra.variants[0];
    if (extraVariant === undefined) {
      throw new Error("expected extra variant");
    }
    await h.invoke(archiveVariant, { variantId: extraVariant.variantId });
    const { record, optionByLabel } = await seedChoicePending(h, {
      conversationId: conversation.id,
      customerId: customer.id,
      product,
      extraProductId: extra.productId,
    });
    const optionId = optionByLabel.get("A");
    if (optionId === undefined) {
      throw new Error("expected option A");
    }
    const beforeOrders = await orderCount();
    const first = await hostRequest(h.app, {
      method: "POST",
      path: ASSISTANT_HOST_CHOICE_PATH,
      token,
      body: {
        conversationId: conversation.id,
        choiceId: record.id,
        optionId,
      },
    });
    expect(first.status).toBe(200);
    const firstBody = assistantHostInteractionResultSchema.parse(
      await first.json(),
    );
    expect(firstBody.status).toBe("error");
    if (firstBody.status !== "error") {
      return;
    }
    expect(firstBody.code).toBe("CONFLICT");
    const peeked = await h.pendingStore.peekOpen({
      conversationId: conversation.id,
      bind: pendingBindFor(conversation.id),
    });
    expect(peeked.kind).toBe("found");
    if (peeked.kind !== "found") {
      throw new Error("expected pending still blocking after CONFLICT");
    }
    expect(peeked.record.status).toBe("claimed");
    expect(peeked.record.id).toBe(record.id);
    if (peeked.record.kind === "choice") {
      expect(peeked.record.claimedOptionId).toBe(optionId);
    }
    expect(await orderCount()).toBe(beforeOrders);
    const why = await hostRequest(h.app, {
      method: "POST",
      path: ASSISTANT_HOST_CHAT_PATH,
      token,
      body: {
        conversationId: conversation.id,
        text: "what happened?",
        locale: "en",
      },
    });
    const whyBody = assistantHostInteractionResultSchema.parse(
      await why.json(),
    );
    expect(whyBody.status).toBe("ok");
    if (whyBody.status === "ok") {
      expect(whyBody.pending?.id).toBe(record.id);
    }
    const retry = await hostRequest(h.app, {
      method: "POST",
      path: ASSISTANT_HOST_CHOICE_PATH,
      token,
      body: {
        conversationId: conversation.id,
        choiceId: record.id,
        optionId,
      },
    });
    const retryBody = assistantHostInteractionResultSchema.parse(
      await retry.json(),
    );
    expect(retryBody.status).toBe("error");
    if (retryBody.status === "error") {
      expect(retryBody.code).toBe("CONFLICT");
    }
    if (retryBody.status === "ok") {
      expect(retryBody.pending).not.toBeNull();
    }
    const peekedRetry = await h.pendingStore.peekOpen({
      conversationId: conversation.id,
      bind: pendingBindFor(conversation.id),
    });
    expect(peekedRetry.kind).toBe("found");
    if (peekedRetry.kind === "found") {
      expect(peekedRetry.record.status).toBe("claimed");
      expect(peekedRetry.record.id).toBe(record.id);
    }
    const otherOptionId = optionByLabel.get("B");
    if (otherOptionId === undefined) {
      throw new Error("expected option B");
    }
    const conflict = await hostRequest(h.app, {
      method: "POST",
      path: ASSISTANT_HOST_CHOICE_PATH,
      token,
      body: {
        conversationId: conversation.id,
        choiceId: record.id,
        optionId: otherOptionId,
      },
    });
    const conflictBody = assistantHostInteractionResultSchema.parse(
      await conflict.json(),
    );
    expect(conflictBody).toMatchObject({
      status: "error",
      code: "CHOICE_OPTION_CONFLICT",
    });
    const peekedConflict = await h.pendingStore.peekOpen({
      conversationId: conversation.id,
      bind: pendingBindFor(conversation.id),
    });
    expect(peekedConflict.kind).toBe("found");
    if (peekedConflict.kind === "found") {
      expect(peekedConflict.record.status).toBe("claimed");
      expect(peekedConflict.record.id).toBe(record.id);
      if (peekedConflict.record.kind === "choice") {
        expect(peekedConflict.record.claimedOptionId).toBe(optionId);
      }
    }
    expect(await orderCount()).toBe(beforeOrders);
  });

  it("confirm executes once, consumes the core challenge, and may return list cards", async () => {
    const h = harness({ model: listThenSpeakModel() });
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await h.invoke(createConversation, {
      title: "Confirm once",
    });
    const seeded = await seedConfirmationPending(h, conversation.id);
    const consumesBefore = h.consumeCount();
    const first = await hostRequest(h.app, {
      method: "POST",
      path: ASSISTANT_CONFIRM_PATH,
      token,
      body: {
        conversationId: conversation.id,
        challengeId: seeded.challengeId,
      },
    });
    expect(first.status).toBe(200);
    const body = assistantHostInteractionResultSchema.parse(await first.json());
    expect(body.status).toBe("ok");
    if (body.status !== "ok") {
      return;
    }
    expect(body.pending).toBeNull();
    expectKnownResumeCardKinds(body.cards);
    expect(surfaceCard(body.cards, "orders-list")).toBeDefined();
    expect(surfaceCard(body.cards, "order-entity")).toBeUndefined();
    expect(await customerRow(seeded.customerId)).toBeUndefined();
    expect(h.consumeCount()).toBeGreaterThan(consumesBefore);
    const replay = await hostRequest(h.app, {
      method: "POST",
      path: ASSISTANT_CONFIRM_PATH,
      token,
      body: {
        conversationId: conversation.id,
        challengeId: seeded.challengeId,
      },
    });
    const replayBody = assistantHostInteractionResultSchema.parse(
      await replay.json(),
    );
    expect(replayBody.status).toBe("ok");
    expect(await customerRow(seeded.customerId)).toBeUndefined();
  });

  it("stale confirm replay while a newer pending is open returns that pending, not Phase B done with pending null", async () => {
    const pendingStore = createMemoryPendingStore();
    const confirmation = countingConfirmationStore();
    const h = harness({
      model: listThenSpeakModel(),
      pendingStore,
      confirmation,
    });
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await h.invoke(createConversation, {
      title: "Stale confirm vs newer pending",
    });
    const seeded = await seedConfirmationPending(h, conversation.id);
    const first = await hostRequest(h.app, {
      method: "POST",
      path: ASSISTANT_CONFIRM_PATH,
      token,
      body: {
        conversationId: conversation.id,
        challengeId: seeded.challengeId,
      },
    });
    expect(first.status).toBe(200);
    const firstBody = assistantHostInteractionResultSchema.parse(
      await first.json(),
    );
    expect(firstBody.status).toBe("ok");
    if (firstBody.status !== "ok") {
      return;
    }
    expect(firstBody.pending).toBeNull();
    expect(await customerRow(seeded.customerId)).toBeUndefined();
    const consumesAfterConfirm = h.consumeCount();
    const customer = await h.invoke(createCustomer, {
      name: "Newer Choice Buyer",
      phone: nextPhone(),
    });
    const product = await h.invoke(createProduct, {
      name: "Newer Choice Cake",
      basePriceMinor: "1500",
      variants: [{ name: "A" }, { name: "B" }],
    });
    const { record: newer } = await seedChoicePending(h, {
      conversationId: conversation.id,
      customerId: customer.id,
      product,
    });
    const beforeOrders = await orderCount();
    const staleHarness = harness({
      model: new MockLanguageModelV3({
        doStream: () => {
          throw new Error(
            "Phase B must not run on a stale completed confirm while a newer pending is open",
          );
        },
      }),
      pendingStore,
      confirmation,
    });
    const stale = await hostRequest(staleHarness.app, {
      method: "POST",
      path: ASSISTANT_CONFIRM_PATH,
      token,
      body: {
        conversationId: conversation.id,
        challengeId: seeded.challengeId,
      },
    });
    expect(stale.status).toBe(200);
    const staleBody = assistantHostInteractionResultSchema.parse(
      await stale.json(),
    );
    expect(staleBody.status).toBe("ok");
    if (staleBody.status !== "ok") {
      return;
    }
    expect(staleBody.pending).not.toBeNull();
    expect(staleBody.pending?.id).toBe(newer.id);
    expect(staleBody.pending?.id).not.toBe(seeded.challengeId);
    expect(await customerRow(seeded.customerId)).toBeUndefined();
    expect(await orderCount()).toBe(beforeOrders);
    expect(h.consumeCount()).toBe(consumesAfterConfirm);
    const peeked = await pendingStore.peekOpen({
      conversationId: conversation.id,
      bind: pendingBindFor(conversation.id),
    });
    expect(peeked.kind).toBe("found");
    if (peeked.kind !== "found") {
      return;
    }
    expect(peeked.record.id).toBe(newer.id);
    expect(peeked.record.status).toBe("open");
  });

  it("wrong conversation bind returns expired and does not consume the challenge", async () => {
    const h = harness({ model: silentModel() });
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await h.invoke(createConversation, {
      title: "Confirm bind",
    });
    const other = await h.invoke(createConversation, {
      title: "Other confirm bind",
    });
    const seeded = await seedConfirmationPending(h, conversation.id);
    const consumesBefore = h.consumeCount();
    const wrong = await hostRequest(h.app, {
      method: "POST",
      path: ASSISTANT_CONFIRM_PATH,
      token,
      body: {
        conversationId: other.id,
        challengeId: seeded.challengeId,
      },
    });
    expect(
      assistantHostInteractionResultSchema.parse(await wrong.json()),
    ).toEqual({ status: "expired" });
    expect(h.consumeCount()).toBe(consumesBefore);
    expect(await customerRow(seeded.customerId)).toBeDefined();
    const ok = await hostRequest(h.app, {
      method: "POST",
      path: ASSISTANT_CONFIRM_PATH,
      token,
      body: {
        conversationId: conversation.id,
        challengeId: seeded.challengeId,
      },
    });
    expect(
      assistantHostInteractionResultSchema.parse(await ok.json()).status,
    ).toBe("ok");
    expect(await customerRow(seeded.customerId)).toBeUndefined();
  });

  it("tampered canonical input fails the hash, does not execute, and does not enter the loop", async () => {
    const inner = createMemoryPendingStore();
    const decoy = randomUUID();
    const wrapped: StaffAssistantPendingStore = {
      open: (record) => inner.open(record),
      claim: async (input) => {
        const claimed = await inner.claim(input);
        if (
          (claimed.kind === "claimed" || claimed.kind === "replay") &&
          claimed.record.kind === "confirmation"
        ) {
          return {
            ...claimed,
            record: {
              ...claimed.record,
              canonicalInput: { id: decoy },
            },
          };
        }
        return claimed;
      },
      peek: (input) => inner.peek(input),
      peekOpen: (input) => inner.peekOpen(input),
      complete: (input) => inner.complete(input),
      abandon: (input) => inner.abandon(input),
      replace: (input) => inner.replace(input),
    };
    const h = harness({
      pendingStore: wrapped,
      model: new MockLanguageModelV3({
        doStream: () => {
          throw new Error("Phase B must not run after a hash failure");
        },
      }),
    });
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await h.invoke(createConversation, {
      title: "Tamper",
    });
    const seeded = await seedConfirmationPending(h, conversation.id);
    await kit.db.runtime.db.insert(companyCustomers).values({
      id: decoy,
      companyId: kitIdentities.companies.a,
      name: "Decoy",
      phone: nextPhone(),
      status: "archived",
    });
    const response = await hostRequest(h.app, {
      method: "POST",
      path: ASSISTANT_CONFIRM_PATH,
      token,
      body: {
        conversationId: conversation.id,
        challengeId: seeded.challengeId,
      },
    });
    const body = assistantHostInteractionResultSchema.parse(
      await response.json(),
    );
    expect(body.status).toBe("error");
    expect(await customerRow(seeded.customerId)).toBeDefined();
    expect(await customerRow(decoy)).toBeDefined();
  });

  it("recovers execution_id after domain commit before finishRun without a double write", async () => {
    const h = harness({ model: silentModel() });
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await h.invoke(createConversation, {
      title: "Crash finishRun",
    });
    const seeded = await seedConfirmationPending(h, conversation.id);
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
    expect(await customerRow(seeded.customerId)).toBeUndefined();
    const resume = await hostRequest(h.app, {
      method: "POST",
      path: ASSISTANT_CONFIRM_PATH,
      token,
      body: {
        conversationId: conversation.id,
        challengeId: seeded.challengeId,
      },
    });
    expect(
      assistantHostInteractionResultSchema.parse(await resume.json()).status,
    ).toBe("ok");
    expect(await customerRow(seeded.customerId)).toBeUndefined();
  });

  it("crash mid-Phase B after a continuation write does not create a second order for that execution_id", async () => {
    const h = harness({
      model: new MockLanguageModelV3({
        doStream: () => {
          throw new Error("Phase B is seeded without the model");
        },
      }),
    });
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await h.invoke(createConversation, {
      title: "Crash Phase B",
    });
    const customer = await h.invoke(createCustomer, {
      name: "Phase A Buyer",
      phone: nextPhone(),
    });
    const product = await h.invoke(createProduct, {
      name: "Phase A Cake",
      basePriceMinor: "1500",
      variants: [{ name: "A" }, { name: "B" }],
    });
    const { record, optionByLabel } = await seedChoicePending(h, {
      conversationId: conversation.id,
      customerId: customer.id,
      product,
    });
    const optionId = optionByLabel.get("A");
    if (optionId === undefined || record.executionId === undefined) {
      throw new Error("seeded choice missing option or executionId");
    }
    const bind = {
      actorId: kitIdentities.users.anna,
      companyId: kitIdentities.companies.a,
      conversationId: conversation.id,
    };
    const claimed = await h.pendingStore.claim({
      id: record.id,
      kind: "choice",
      bind,
      optionId,
    });
    expect(claimed.kind).toBe("claimed");
    const mappedId = record.optionMap[optionId];
    if (mappedId === undefined) {
      throw new Error("seeded choice missing mapped variant");
    }
    const patched = applyChoiceOptionToCanonicalInput(
      record.canonicalInput,
      record.target,
      mappedId,
    );
    const created = await h.invoke(createOrder, patched, {
      idempotencyKey: executionAttemptKey(conversation.id, record.executionId),
    });
    await h.invoke(
      checkpointAssistantTurn,
      {
        kind: "finishRun",
        conversationId: conversation.id,
        executionId: record.executionId,
        outcome: "success",
        resultIds: [created.orderId],
        modelTrace: created,
      },
      {
        idempotencyKey: attemptKey(
          "turn",
          conversation.id,
          `finish:${record.executionId}`,
        ),
      },
    );
    await h.pendingStore.complete({
      id: record.id,
      kind: "choice",
      bind,
      optionId,
    });
    const continuationCustomer = await h.invoke(createCustomer, {
      name: "Phase B Buyer",
      phone: nextPhone(),
    });
    const continuationProduct = await h.invoke(createProduct, {
      name: "Phase B Cake",
      basePriceMinor: "1800",
      variants: [{ name: "X" }],
    });
    const continuationVariant = continuationProduct.variants[0];
    if (continuationVariant === undefined) {
      throw new Error("continuation product missing variant");
    }
    const continuationFacadeInput = {
      customerId: continuationCustomer.id,
      items: [
        {
          productId: continuationProduct.productId,
          variantId: continuationVariant.variantId,
          quantityMilli: "1000",
        },
      ],
    };
    const continuationInput = {
      customer: { by: "id" as const, id: continuationCustomer.id },
      items: [
        {
          product: { by: "id" as const, id: continuationProduct.productId },
          variantSelection: {
            kind: "reference" as const,
            ref: { by: "id" as const, id: continuationVariant.variantId },
          },
          quantity: { milli: "1000" },
        },
      ],
    };
    const begun = await h.invoke(
      checkpointAssistantTurn,
      {
        kind: "begin",
        conversationId: conversation.id,
        turnKey: `begin:resume:${record.id}`,
      },
      {
        idempotencyKey: attemptKey(
          "turn",
          conversation.id,
          `begin:resume:${record.id}`,
        ),
      },
    );
    const staged = await h.invoke(
      checkpointAssistantTurn,
      {
        kind: "stageRun",
        conversationId: conversation.id,
        messageId: begun.messageId,
        seq: 0,
        actionName: "orders.create",
        toolName: ORDERS_CREATE_TOOL_NAME,
        toolCallId: "call-continue-create",
        toolInput: continuationFacadeInput,
      },
      {
        idempotencyKey: attemptKey(
          "turn",
          conversation.id,
          `stage:${begun.messageId}:0`,
        ),
      },
    );
    if (staged.executionId === null) {
      throw new Error("Phase B stageRun returned no executionId");
    }
    await h.invoke(createOrder, continuationInput, {
      idempotencyKey: executionAttemptKey(conversation.id, staged.executionId),
    });
    const afterCommit = await orderCount();
    const crashedHistory = await h.invoke(getModelHistory, {
      conversationId: conversation.id,
    });
    const started = crashedHistory.messages
      .flatMap((message) => message.toolRuns)
      .find((run) => run.outcome === "started");
    expect(started?.executionId).toBe(staged.executionId);
    expect(started?.modelTrace).toBeNull();
    expect(started?.toolInput).toEqual(continuationFacadeInput);
    const reconstructed = staffAssistantModelMessagesFromPersisted(
      crashedHistory.messages.map((message) => ({
        role: message.role,
        body: message.text,
        toolRuns: message.toolRuns.map((run) => ({
          action: run.action,
          toolCallId: run.toolCallId,
          modelTrace: run.modelTrace,
          ...(run.toolName !== null ? { toolName: run.toolName } : {}),
          ...(run.toolInput !== null ? { toolInput: run.toolInput } : {}),
          ...(run.seq !== null ? { seq: run.seq } : {}),
          outcome: run.outcome,
        })),
      })),
    );
    const lastAssistant = reconstructed.findLast(
      (message) => message.role === "assistant",
    );
    expect(lastAssistant?.content).toEqual(
      expect.arrayContaining([
        {
          type: "tool-call",
          toolCallId: "call-continue-create",
          toolName: ORDERS_CREATE_TOOL_NAME,
          input: continuationFacadeInput,
        },
      ]),
    );
    expect(typeof lastAssistant?.content).not.toBe("string");
    const resumeApp = harness({
      pendingStore: h.pendingStore,
      model: new MockLanguageModelV3({
        doStream: () =>
          Promise.resolve(mockTextStream("Created the follow-up order.")),
      }),
    });
    const resume = await hostRequest(resumeApp.app, {
      method: "POST",
      path: ASSISTANT_HOST_CHOICE_PATH,
      token,
      body: {
        conversationId: conversation.id,
        choiceId: record.id,
        optionId,
      },
    });
    expect(
      assistantHostInteractionResultSchema.parse(await resume.json()).status,
    ).toBe("ok");
    expect(await orderCount()).toBe(afterCommit);
    const finishedHistory = await h.invoke(getModelHistory, {
      conversationId: conversation.id,
    });
    const finished = finishedHistory.messages
      .flatMap((message) => message.toolRuns)
      .find((run) => run.executionId === staged.executionId);
    expect(finished?.outcome).toBe("success");
  });

  it("crash after Phase B begin with empty body continues Phase B", async () => {
    const h = harness({
      model: new MockLanguageModelV3({
        doStream: () => {
          throw new Error("Phase B begin is seeded without the model");
        },
      }),
    });
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await h.invoke(createConversation, {
      title: "Crash Phase B begin",
    });
    const customer = await h.invoke(createCustomer, {
      name: "Begin Buyer",
      phone: nextPhone(),
    });
    const product = await h.invoke(createProduct, {
      name: "Begin Cake",
      basePriceMinor: "1500",
      variants: [{ name: "A" }, { name: "B" }],
    });
    const { record, optionByLabel } = await seedChoicePending(h, {
      conversationId: conversation.id,
      customerId: customer.id,
      product,
    });
    const optionId = optionByLabel.get("A");
    if (optionId === undefined || record.executionId === undefined) {
      throw new Error("seeded choice missing option or executionId");
    }
    const bind = {
      actorId: kitIdentities.users.anna,
      companyId: kitIdentities.companies.a,
      conversationId: conversation.id,
    };
    const claimed = await h.pendingStore.claim({
      id: record.id,
      kind: "choice",
      bind,
      optionId,
    });
    expect(claimed.kind).toBe("claimed");
    const mappedId = record.optionMap[optionId];
    if (mappedId === undefined) {
      throw new Error("seeded choice missing mapped variant");
    }
    const patched = applyChoiceOptionToCanonicalInput(
      record.canonicalInput,
      record.target,
      mappedId,
    );
    const created = await h.invoke(createOrder, patched, {
      idempotencyKey: executionAttemptKey(conversation.id, record.executionId),
    });
    await h.invoke(
      checkpointAssistantTurn,
      {
        kind: "finishRun",
        conversationId: conversation.id,
        executionId: record.executionId,
        outcome: "success",
        resultIds: [created.orderId],
        modelTrace: created,
      },
      {
        idempotencyKey: attemptKey(
          "turn",
          conversation.id,
          `finish:${record.executionId}`,
        ),
      },
    );
    await h.pendingStore.complete({
      id: record.id,
      kind: "choice",
      bind,
      optionId,
    });
    const begun = await h.invoke(
      checkpointAssistantTurn,
      {
        kind: "begin",
        conversationId: conversation.id,
        turnKey: `begin:resume:${record.id}`,
      },
      {
        idempotencyKey: attemptKey(
          "turn",
          conversation.id,
          `begin:resume:${record.id}`,
        ),
      },
    );
    const openHistory = await h.invoke(getModelHistory, {
      conversationId: conversation.id,
    });
    const open = openHistory.messages.find(
      (message) => message.id === begun.messageId,
    );
    expect(open?.text).toBe("");
    expect(open?.toolRuns).toEqual([]);
    const resumeApp = harness({
      pendingStore: h.pendingStore,
      model: silentModel("Phase B continued."),
    });
    const resume = await hostRequest(resumeApp.app, {
      method: "POST",
      path: ASSISTANT_HOST_CHOICE_PATH,
      token,
      body: {
        conversationId: conversation.id,
        choiceId: record.id,
        optionId,
      },
    });
    const body = assistantHostInteractionResultSchema.parse(
      await resume.json(),
    );
    expect(body).toEqual(
      expect.objectContaining({
        status: "ok",
        speech: "Phase B continued.",
      }),
    );
    const finishedHistory = await h.invoke(getModelHistory, {
      conversationId: conversation.id,
    });
    const completed = finishedHistory.messages.find(
      (message) => message.id === begun.messageId,
    );
    expect(completed?.text).toBe("Phase B continued.");
    expect(
      finishedHistory.messages.filter((message) => message.role === "assistant")
        .length,
    ).toBe(
      openHistory.messages.filter((message) => message.role === "assistant")
        .length,
    );
  });

  it("choice replay is done when Phase B speech exists and a later begin is empty", async () => {
    const speech = "The order is ready.";
    const h = harness({ model: silentModel(speech) });
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await h.invoke(createConversation, {
      title: "Later empty begin",
    });
    const customer = await h.invoke(createCustomer, {
      name: "Later Begin Buyer",
      phone: nextPhone(),
    });
    const product = await h.invoke(createProduct, {
      name: "Later Begin Cake",
      basePriceMinor: "1500",
      variants: [{ name: "A" }, { name: "B" }],
    });
    const { record, optionByLabel } = await seedChoicePending(h, {
      conversationId: conversation.id,
      customerId: customer.id,
      product,
    });
    const optionId = optionByLabel.get("A");
    const first = await hostRequest(h.app, {
      method: "POST",
      path: ASSISTANT_HOST_CHOICE_PATH,
      token,
      body: {
        conversationId: conversation.id,
        choiceId: record.id,
        optionId,
      },
    });
    const firstBody = assistantHostInteractionResultSchema.parse(
      await first.json(),
    );
    expect(firstBody).toEqual(
      expect.objectContaining({ status: "ok", speech }),
    );
    const afterPhaseB = await orderCount();
    const phaseBHistory = await h.invoke(getModelHistory, {
      conversationId: conversation.id,
    });
    const phaseB = phaseBHistory.messages.findLast(
      (message) => message.role === "assistant" && message.text === speech,
    );
    expect(phaseB).toBeDefined();
    const laterBeginKey = `begin:${randomUUID()}`;
    await h.invoke(
      checkpointAssistantTurn,
      {
        kind: "begin",
        conversationId: conversation.id,
        turnKey: laterBeginKey,
      },
      {
        idempotencyKey: attemptKey("turn", conversation.id, laterBeginKey),
      },
    );
    const crashed = await h.invoke(getModelHistory, {
      conversationId: conversation.id,
    });
    const laterEmpty = crashed.messages.findLast(
      (message) => message.role === "assistant",
    );
    expect(laterEmpty?.text).toBe("");
    expect(laterEmpty?.id).not.toBe(phaseB?.id);
    const replayApp = harness({
      pendingStore: h.pendingStore,
      model: new MockLanguageModelV3({
        doStream: () => {
          throw new Error(
            "completed Phase B must not resume after a later empty begin",
          );
        },
      }),
    });
    const replay = await hostRequest(replayApp.app, {
      method: "POST",
      path: ASSISTANT_HOST_CHOICE_PATH,
      token,
      body: {
        conversationId: conversation.id,
        choiceId: record.id,
        optionId,
      },
    });
    const replayBody = assistantHostInteractionResultSchema.parse(
      await replay.json(),
    );
    expect(replayBody.status).toBe("ok");
    if (replayBody.status !== "ok") {
      return;
    }
    expect(replayBody.speech).toBe(speech);
    expect(await orderCount()).toBe(afterPhaseB);
    const finalHistory = await h.invoke(getModelHistory, {
      conversationId: conversation.id,
    });
    expect(
      finalHistory.messages.find((message) => message.id === phaseB?.id)?.text,
    ).toBe(speech);
  });

  it("choice replay is done when Phase B speech exists and a later chat leftover is started", async () => {
    const speech = "The order is ready.";
    const h = harness({ model: silentModel(speech) });
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await h.invoke(createConversation, {
      title: "Later chat leftover started",
    });
    const customer = await h.invoke(createCustomer, {
      name: "Later Leftover Buyer",
      phone: nextPhone(),
    });
    const product = await h.invoke(createProduct, {
      name: "Later Leftover Cake",
      basePriceMinor: "1500",
      variants: [{ name: "A" }, { name: "B" }],
    });
    const { record, optionByLabel } = await seedChoicePending(h, {
      conversationId: conversation.id,
      customerId: customer.id,
      product,
    });
    const optionId = optionByLabel.get("A");
    const first = await hostRequest(h.app, {
      method: "POST",
      path: ASSISTANT_HOST_CHOICE_PATH,
      token,
      body: {
        conversationId: conversation.id,
        choiceId: record.id,
        optionId,
      },
    });
    const firstBody = assistantHostInteractionResultSchema.parse(
      await first.json(),
    );
    expect(firstBody).toEqual(
      expect.objectContaining({ status: "ok", speech }),
    );
    const afterPhaseB = await orderCount();
    const phaseBHistory = await h.invoke(getModelHistory, {
      conversationId: conversation.id,
    });
    const phaseB = phaseBHistory.messages.findLast(
      (message) => message.role === "assistant" && message.text === speech,
    );
    expect(phaseB).toBeDefined();
    const leftoverCustomer = await h.invoke(createCustomer, {
      name: "Chat Leftover Buyer",
      phone: nextPhone(),
    });
    const leftoverProduct = await h.invoke(createProduct, {
      name: "Chat Leftover Cake",
      basePriceMinor: "1800",
      variants: [{ name: "Solo" }],
    });
    const leftoverVariant = leftoverProduct.variants[0];
    if (leftoverVariant === undefined) {
      throw new Error("leftover product missing variant");
    }
    const userMessage = await h.invoke(
      appendUserMessage,
      { conversationId: conversation.id, body: "Create another leftover cake" },
      { idempotencyKey: attemptKey("message", conversation.id, randomUUID()) },
    );
    const leftover = await stageNamedStartedRun(h, {
      conversationId: conversation.id,
      beginKey: `begin:${userMessage.id}`,
      actionName: "orders.create",
      toolName: ORDERS_CREATE_TOOL_NAME,
      toolCallId: "call-leftover-after-speech",
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
    const replayApp = harness({
      pendingStore: h.pendingStore,
      model: new MockLanguageModelV3({
        doStream: () => {
          throw new Error(
            "completed Phase B must not resume after a later chat leftover started",
          );
        },
      }),
    });
    const replay = await hostRequest(replayApp.app, {
      method: "POST",
      path: ASSISTANT_HOST_CHOICE_PATH,
      token,
      body: {
        conversationId: conversation.id,
        choiceId: record.id,
        optionId,
      },
    });
    const replayBody = assistantHostInteractionResultSchema.parse(
      await replay.json(),
    );
    expect(replayBody.status).toBe("ok");
    if (replayBody.status !== "ok") {
      return;
    }
    expect(replayBody.speech).toBe(speech);
    expect(await orderCount()).toBe(afterPhaseB);
    const finalHistory = await h.invoke(getModelHistory, {
      conversationId: conversation.id,
    });
    expect(
      finalHistory.messages.find((message) => message.id === phaseB?.id)?.text,
    ).toBe(speech);
    const leftoverRun = finalHistory.messages
      .flatMap((message) => message.toolRuns)
      .find((run) => run.executionId === leftover.executionId);
    expect(leftoverRun?.outcome).toBe("started");
    expect(leftoverRun?.toolCallId).toBe("call-leftover-after-speech");
  });

  it("empty Phase B body with finished tool-runs still continues speech without a second write", async () => {
    const h = harness({
      model: new MockLanguageModelV3({
        doStream: () => {
          throw new Error("Phase B tools are seeded without the model");
        },
      }),
    });
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await h.invoke(createConversation, {
      title: "Empty body finished runs",
    });
    const customer = await h.invoke(createCustomer, {
      name: "Finished-run Buyer",
      phone: nextPhone(),
    });
    const product = await h.invoke(createProduct, {
      name: "Finished-run Cake",
      basePriceMinor: "1500",
      variants: [{ name: "A" }, { name: "B" }],
    });
    const { record, optionByLabel } = await seedChoicePending(h, {
      conversationId: conversation.id,
      customerId: customer.id,
      product,
    });
    const optionId = optionByLabel.get("A");
    if (optionId === undefined || record.executionId === undefined) {
      throw new Error("seeded choice missing option or executionId");
    }
    const bind = {
      actorId: kitIdentities.users.anna,
      companyId: kitIdentities.companies.a,
      conversationId: conversation.id,
    };
    const claimed = await h.pendingStore.claim({
      id: record.id,
      kind: "choice",
      bind,
      optionId,
    });
    expect(claimed.kind).toBe("claimed");
    const mappedId = record.optionMap[optionId];
    if (mappedId === undefined) {
      throw new Error("seeded choice missing mapped variant");
    }
    const patched = applyChoiceOptionToCanonicalInput(
      record.canonicalInput,
      record.target,
      mappedId,
    );
    const created = await h.invoke(createOrder, patched, {
      idempotencyKey: executionAttemptKey(conversation.id, record.executionId),
    });
    await h.invoke(
      checkpointAssistantTurn,
      {
        kind: "finishRun",
        conversationId: conversation.id,
        executionId: record.executionId,
        outcome: "success",
        resultIds: [created.orderId],
        modelTrace: created,
      },
      {
        idempotencyKey: attemptKey(
          "turn",
          conversation.id,
          `finish:${record.executionId}`,
        ),
      },
    );
    await h.pendingStore.complete({
      id: record.id,
      kind: "choice",
      bind,
      optionId,
    });
    const continuationCustomer = await h.invoke(createCustomer, {
      name: "Finished-run Follow-up",
      phone: nextPhone(),
    });
    const continuationProduct = await h.invoke(createProduct, {
      name: "Finished-run Follow-up Cake",
      basePriceMinor: "1800",
      variants: [{ name: "X" }],
    });
    const continuationVariant = continuationProduct.variants[0];
    if (continuationVariant === undefined) {
      throw new Error("continuation product missing variant");
    }
    const continuationFacadeInput = {
      customerId: continuationCustomer.id,
      items: [
        {
          productId: continuationProduct.productId,
          variantId: continuationVariant.variantId,
          quantityMilli: "1000",
        },
      ],
    };
    const continuationInput = {
      customer: { by: "id" as const, id: continuationCustomer.id },
      items: [
        {
          product: { by: "id" as const, id: continuationProduct.productId },
          variantSelection: {
            kind: "reference" as const,
            ref: { by: "id" as const, id: continuationVariant.variantId },
          },
          quantity: { milli: "1000" },
        },
      ],
    };
    const begun = await h.invoke(
      checkpointAssistantTurn,
      {
        kind: "begin",
        conversationId: conversation.id,
        turnKey: `begin:resume:${record.id}`,
      },
      {
        idempotencyKey: attemptKey(
          "turn",
          conversation.id,
          `begin:resume:${record.id}`,
        ),
      },
    );
    const staged = await h.invoke(
      checkpointAssistantTurn,
      {
        kind: "stageRun",
        conversationId: conversation.id,
        messageId: begun.messageId,
        seq: 0,
        actionName: "orders.create",
        toolName: ORDERS_CREATE_TOOL_NAME,
        toolCallId: "call-finished-create",
        toolInput: continuationFacadeInput,
      },
      {
        idempotencyKey: attemptKey(
          "turn",
          conversation.id,
          `stage:${begun.messageId}:0`,
        ),
      },
    );
    if (staged.executionId === null) {
      throw new Error("Phase B stageRun returned no executionId");
    }
    const continuationCreated = await h.invoke(createOrder, continuationInput, {
      idempotencyKey: executionAttemptKey(conversation.id, staged.executionId),
    });
    await h.invoke(
      checkpointAssistantTurn,
      {
        kind: "finishRun",
        conversationId: conversation.id,
        executionId: staged.executionId,
        outcome: "success",
        resultIds: [continuationCreated.orderId],
        modelTrace: continuationCreated,
      },
      {
        idempotencyKey: attemptKey(
          "turn",
          conversation.id,
          `finish:${staged.executionId}:success`,
        ),
      },
    );
    const afterCommit = await orderCount();
    const openHistory = await h.invoke(getModelHistory, {
      conversationId: conversation.id,
    });
    const open = openHistory.messages.find(
      (message) => message.id === begun.messageId,
    );
    expect(open?.text).toBe("");
    expect(open?.toolRuns.some((run) => run.outcome === "started")).toBe(false);
    expect(
      open?.toolRuns.some((run) => run.executionId === staged.executionId),
    ).toBe(true);
    const resumeApp = harness({
      pendingStore: h.pendingStore,
      model: silentModel("Named the follow-up order."),
    });
    const resume = await hostRequest(resumeApp.app, {
      method: "POST",
      path: ASSISTANT_HOST_CHOICE_PATH,
      token,
      body: {
        conversationId: conversation.id,
        choiceId: record.id,
        optionId,
      },
    });
    const body = assistantHostInteractionResultSchema.parse(
      await resume.json(),
    );
    expect(body).toEqual(
      expect.objectContaining({
        status: "ok",
        speech: "Named the follow-up order.",
      }),
    );
    expect(await orderCount()).toBe(afterCommit);
    const finishedHistory = await h.invoke(getModelHistory, {
      conversationId: conversation.id,
    });
    const completed = finishedHistory.messages.find(
      (message) => message.id === begun.messageId,
    );
    expect(completed?.text).toBe("Named the follow-up order.");
    const finished = finishedHistory.messages
      .flatMap((message) => message.toolRuns)
      .find((run) => run.executionId === staged.executionId);
    expect(finished?.outcome).toBe("success");
    expect(
      finishedHistory.messages.filter((message) => message.role === "assistant")
        .length,
    ).toBe(
      openHistory.messages.filter((message) => message.role === "assistant")
        .length,
    );
  });

  it("crash after domain commit then a new chat turn finishes the stored execution_id without a second order", async () => {
    const h = harness({
      model: silentModel("The earlier create already landed."),
    });
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await h.invoke(createConversation, {
      title: "Crash then new chat",
    });
    const customer = await h.invoke(createCustomer, {
      name: "Next Turn Buyer",
      phone: nextPhone(),
    });
    const product = await h.invoke(createProduct, {
      name: "Next Turn Cake",
      basePriceMinor: "1800",
      variants: [{ name: "X" }],
    });
    const variant = product.variants[0];
    if (variant === undefined) {
      throw new Error("unique-variant product missing variant");
    }
    const userMessage = await h.invoke(
      appendUserMessage,
      { conversationId: conversation.id, body: "Create the cake order" },
      { idempotencyKey: attemptKey("message", conversation.id, randomUUID()) },
    );
    const facadeInput = {
      customerId: customer.id,
      items: [
        {
          productId: product.productId,
          variantId: variant.variantId,
          quantityMilli: "1000",
        },
      ],
    };
    const canonicalInput = {
      customer: { by: "id" as const, id: customer.id },
      items: [
        {
          product: { by: "id" as const, id: product.productId },
          variantSelection: {
            kind: "reference" as const,
            ref: { by: "id" as const, id: variant.variantId },
          },
          quantity: { milli: "1000" },
        },
      ],
    };
    const staged = await stageNamedStartedRun(h, {
      conversationId: conversation.id,
      beginKey: `begin:${userMessage.id}`,
      actionName: "orders.create",
      toolName: ORDERS_CREATE_TOOL_NAME,
      toolCallId: "call-create-crash",
      toolInput: facadeInput,
    });
    await h.invoke(createOrder, canonicalInput, {
      idempotencyKey: executionAttemptKey(conversation.id, staged.executionId),
    });
    const afterCommit = await orderCount();
    const crashedHistory = await h.invoke(getModelHistory, {
      conversationId: conversation.id,
    });
    const started = crashedHistory.messages
      .flatMap((message) => message.toolRuns)
      .find((run) => run.executionId === staged.executionId);
    const startedMessage = crashedHistory.messages.find((message) =>
      message.toolRuns.some((run) => run.executionId === staged.executionId),
    );
    expect(startedMessage?.id).toBe(staged.messageId);
    expect(started?.outcome).toBe("started");
    expect(started?.modelTrace).toBeNull();
    const resume = await hostRequest(h.app, {
      method: "POST",
      path: ASSISTANT_HOST_CHAT_PATH,
      token,
      body: {
        conversationId: conversation.id,
        text: "Did the order go through?",
        locale: "en",
      },
    });
    expect(
      assistantHostInteractionResultSchema.parse(await resume.json()).status,
    ).toBe("ok");
    expect(await orderCount()).toBe(afterCommit);
    const finishedHistory = await h.invoke(getModelHistory, {
      conversationId: conversation.id,
    });
    const createRuns = finishedHistory.messages
      .flatMap((message) => message.toolRuns)
      .filter((run) => run.action === "orders.create");
    expect(createRuns).toHaveLength(1);
    expect(createRuns[0]?.executionId).toBe(staged.executionId);
    expect(createRuns[0]?.outcome).toBe("success");
    const latestAssistant = finishedHistory.messages.findLast(
      (message) => message.role === "assistant",
    );
    expect(latestAssistant?.id).not.toBe(staged.messageId);
  });

  it("chat recovery does not execute Phase A started rows on another message", async () => {
    const h = harness({
      model: silentModel("No pending write from this chat."),
    });
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await h.invoke(createConversation, {
      title: "Skip Phase A on chat",
    });
    const customer = await h.invoke(createCustomer, {
      name: "Phase A Skip Buyer",
      phone: nextPhone(),
    });
    const product = await h.invoke(createProduct, {
      name: "Phase A Skip Cake",
      basePriceMinor: "1500",
      variants: [{ name: "Solo" }],
    });
    const variant = product.variants[0];
    if (variant === undefined) {
      throw new Error("unique-variant product missing variant");
    }
    const pendingId = randomUUID();
    const facadeInput = {
      customerId: customer.id,
      items: [
        {
          productId: product.productId,
          variantId: variant.variantId,
          quantityMilli: "1000",
        },
      ],
    };
    const staged = await stageNamedStartedRun(h, {
      conversationId: conversation.id,
      beginKey: `begin:phase-a:${pendingId}`,
      actionName: "orders.create",
      toolName: ORDERS_CREATE_TOOL_NAME,
      toolCallId: `${HOST_PHASE_A_TOOL_CALL_ID_PREFIX}${pendingId}`,
      toolInput: facadeInput,
    });
    const beforeChat = await orderCount();
    const chat = await hostRequest(h.app, {
      method: "POST",
      path: ASSISTANT_HOST_CHAT_PATH,
      token,
      body: {
        conversationId: conversation.id,
        text: "Just saying hi",
        locale: "en",
      },
    });
    expect(
      assistantHostInteractionResultSchema.parse(await chat.json()).status,
    ).toBe("ok");
    expect(await orderCount()).toBe(beforeChat);
    const history = await h.invoke(getModelHistory, {
      conversationId: conversation.id,
    });
    const phaseA = history.messages
      .flatMap((message) => message.toolRuns)
      .find((run) => run.executionId === staged.executionId);
    expect(phaseA?.outcome).toBe("started");
    expect(phaseA?.toolCallId).toBe(
      `${HOST_PHASE_A_TOOL_CALL_ID_PREFIX}${pendingId}`,
    );
  });

  it("Phase B choice resume does not execute a leftover chat-turn started create", async () => {
    const h = harness({
      model: silentModel("Named the chosen flavour."),
    });
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await h.invoke(createConversation, {
      title: "Leftover chat create vs Phase B",
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
    const { record, optionByLabel } = await seedChoicePending(h, {
      conversationId: conversation.id,
      customerId: choiceCustomer.id,
      product: choiceProduct,
    });
    const optionId = optionByLabel.get("A");
    if (optionId === undefined) {
      throw new Error("seeded choice missing option A");
    }
    const resume = await hostRequest(h.app, {
      method: "POST",
      path: ASSISTANT_HOST_CHOICE_PATH,
      token,
      body: {
        conversationId: conversation.id,
        choiceId: record.id,
        optionId,
      },
    });
    expect(
      assistantHostInteractionResultSchema.parse(await resume.json()).status,
    ).toBe("ok");
    expect(await orderCount()).toBe(beforeChoice + 1);
    const history = await h.invoke(getModelHistory, {
      conversationId: conversation.id,
    });
    const leftoverRun = history.messages
      .flatMap((message) => message.toolRuns)
      .find((run) => run.executionId === leftover.executionId);
    expect(leftoverRun?.outcome).toBe("started");
  });

  it("chat recovery does not execute a leftover Phase B started create", async () => {
    const h = harness({
      model: silentModel("No pending write from this chat."),
    });
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await h.invoke(createConversation, {
      title: "Skip Phase B leftover on chat",
    });
    const choiceCustomer = await h.invoke(createCustomer, {
      name: "Choice Buyer",
      phone: nextPhone(),
    });
    const choiceProduct = await h.invoke(createProduct, {
      name: "Choice Cake",
      basePriceMinor: "1500",
      variants: [{ name: "A" }, { name: "B" }],
    });
    const { record, optionByLabel } = await seedChoicePending(h, {
      conversationId: conversation.id,
      customerId: choiceCustomer.id,
      product: choiceProduct,
    });
    const optionId = optionByLabel.get("A");
    if (optionId === undefined) {
      throw new Error("seeded choice missing option A");
    }
    const bind = pendingBindFor(conversation.id);
    const claimed = await h.pendingStore.claim({
      id: record.id,
      kind: "choice",
      bind,
      optionId,
    });
    expect(claimed.kind).toBe("claimed");
    const completed = await h.pendingStore.complete({
      id: record.id,
      kind: "choice",
      bind,
      optionId,
    });
    expect(completed.kind).toBe("completed");
    const leftoverCustomer = await h.invoke(createCustomer, {
      name: "Phase B Leftover Buyer",
      phone: nextPhone(),
    });
    const leftoverProduct = await h.invoke(createProduct, {
      name: "Phase B Leftover Cake",
      basePriceMinor: "1800",
      variants: [{ name: "Solo" }],
    });
    const leftoverVariant = leftoverProduct.variants[0];
    if (leftoverVariant === undefined) {
      throw new Error("leftover product missing variant");
    }
    const leftover = await stageNamedStartedRun(h, {
      conversationId: conversation.id,
      beginKey: `begin:resume:${record.id}`,
      actionName: "orders.create",
      toolName: ORDERS_CREATE_TOOL_NAME,
      toolCallId: "call-continue-create",
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
    const beforeChat = await orderCount();
    const chat = await hostRequest(h.app, {
      method: "POST",
      path: ASSISTANT_HOST_CHAT_PATH,
      token,
      body: {
        conversationId: conversation.id,
        text: "Just saying hi",
        locale: "en",
      },
    });
    const chatBody = assistantHostInteractionResultSchema.parse(
      await chat.json(),
    );
    expect(chatBody.status).toBe("ok");
    expect(await orderCount()).toBe(beforeChat);
    const history = await h.invoke(getModelHistory, {
      conversationId: conversation.id,
    });
    const leftoverRun = history.messages
      .flatMap((message) => message.toolRuns)
      .find((run) => run.executionId === leftover.executionId);
    expect(leftoverRun?.outcome).toBe("started");
    expect(leftoverRun?.toolCallId).toBe("call-continue-create");
  });

  describe("SHO-539 turnKey recovery membership", () => {
    it("does not recover a user-preceded Phase B leftover after HITL and a dangling user", async () => {
      const h = harness({
        model: silentModel("Discussing the leftover."),
      });
      const token = await insertBearer(kit, kitIdentities.users.anna);
      const conversation = await h.invoke(createConversation, {
        title: "HITL dangling user Phase B leftover",
      });
      const choiceCustomer = await h.invoke(createCustomer, {
        name: "HITL Buyer",
        phone: nextPhone(),
      });
      const choiceProduct = await h.invoke(createProduct, {
        name: "HITL Cake",
        basePriceMinor: "1500",
        variants: [{ name: "A" }, { name: "B" }],
      });
      const { record, optionByLabel } = await seedChoicePending(h, {
        conversationId: conversation.id,
        customerId: choiceCustomer.id,
        product: choiceProduct,
      });
      const optionId = optionByLabel.get("A");
      if (optionId === undefined) {
        throw new Error("seeded choice missing option A");
      }
      const bind = pendingBindFor(conversation.id);
      expect(
        (
          await h.pendingStore.claim({
            id: record.id,
            kind: "choice",
            bind,
            optionId,
          })
        ).kind,
      ).toBe("claimed");
      expect(
        (
          await h.pendingStore.complete({
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
      const cake = await cakeCreateInputs(h, "Dangling Phase B");
      const leftover = await stageNamedStartedRun(h, {
        conversationId: conversation.id,
        beginKey: `begin:resume:${record.id}`,
        actionName: "orders.create",
        toolName: ORDERS_CREATE_TOOL_NAME,
        toolCallId: "call-resume-dangling",
        toolInput: cake.facadeInput,
      });
      const beforeChat = await orderCount();
      const chat = await hostRequest(h.app, {
        method: "POST",
        path: ASSISTANT_HOST_CHAT_PATH,
        token,
        body: {
          conversationId: conversation.id,
          text: "Just asking about the picker",
          locale: "en",
        },
      });
      expect(
        assistantHostInteractionResultSchema.parse(await chat.json()).status,
      ).toBe("ok");
      expect(await orderCount()).toBe(beforeChat);
      const history = await h.invoke(getModelHistory, {
        conversationId: conversation.id,
      });
      const leftoverRun = history.messages
        .flatMap((message) => message.toolRuns)
        .find((run) => run.executionId === leftover.executionId);
      expect(leftoverRun?.outcome).toBe("started");
      expect(
        history.unfinishedStartedRuns.some(
          (run) => run.executionId === leftover.executionId,
        ),
      ).toBe(true);
    });

    it("does not recover a Phase B leftover after confirm when the HITL run is already success", async () => {
      const h = harness({
        model: silentModel("The confirmation already landed."),
      });
      const token = await insertBearer(kit, kitIdentities.users.anna);
      const conversation = await h.invoke(createConversation, {
        title: "Confirm then Phase B leftover",
      });
      const seeded = await seedConfirmationPending(h, conversation.id);
      const bind = pendingBindFor(conversation.id);
      expect(
        (
          await h.pendingStore.claim({
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
          await h.pendingStore.complete({
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
      const cake = await cakeCreateInputs(h, "Confirm leftover");
      const leftover = await stageNamedStartedRun(h, {
        conversationId: conversation.id,
        beginKey: `begin:resume:${seeded.challengeId}`,
        actionName: "orders.create",
        toolName: ORDERS_CREATE_TOOL_NAME,
        toolCallId: "call-confirm-resume-leftover",
        toolInput: cake.facadeInput,
      });
      const beforeChat = await orderCount();
      const chat = await hostRequest(h.app, {
        method: "POST",
        path: ASSISTANT_HOST_CHAT_PATH,
        token,
        body: {
          conversationId: conversation.id,
          text: "what happened to the delete?",
          locale: "en",
        },
      });
      expect(
        assistantHostInteractionResultSchema.parse(await chat.json()).status,
      ).toBe("ok");
      expect(await orderCount()).toBe(beforeChat);
      expect(await customerRow(seeded.customerId)).toBeUndefined();
      const history = await h.invoke(getModelHistory, {
        conversationId: conversation.id,
      });
      const leftoverRun = history.unfinishedStartedRuns.find(
        (run) => run.executionId === leftover.executionId,
      );
      expect(leftoverRun?.turnKey).toBe(`begin:resume:${seeded.challengeId}`);
      const started = history.messages
        .flatMap((message) => message.toolRuns)
        .find((run) => run.executionId === leftover.executionId);
      expect(started?.outcome).toBe("started");
      const hitl = history.messages
        .flatMap((message) => message.toolRuns)
        .find((run) => run.executionId === seeded.executionId);
      expect(hitl?.outcome).toBe("success");
    });

    it("discussion speech during an open picker does not execute a leftover resume started", async () => {
      const h = harness({
        model: silentModel("The picker is still open."),
      });
      const token = await insertBearer(kit, kitIdentities.users.anna);
      const conversation = await h.invoke(createConversation, {
        title: "Discuss pending picker",
      });
      const customer = await h.invoke(createCustomer, {
        name: "Discuss Buyer",
        phone: nextPhone(),
      });
      const product = await h.invoke(createProduct, {
        name: "Discuss Cake",
        basePriceMinor: "1500",
        variants: [{ name: "A" }, { name: "B" }],
      });
      const { record } = await seedChoicePending(h, {
        conversationId: conversation.id,
        customerId: customer.id,
        product,
      });
      const cake = await cakeCreateInputs(h, "Open-picker leftover");
      const leftover = await stageNamedStartedRun(h, {
        conversationId: conversation.id,
        beginKey: `begin:resume:${record.id}`,
        actionName: "orders.create",
        toolName: ORDERS_CREATE_TOOL_NAME,
        toolCallId: "call-open-picker-resume",
        toolInput: cake.facadeInput,
      });
      const beforeChat = await orderCount();
      const chat = await hostRequest(h.app, {
        method: "POST",
        path: ASSISTANT_HOST_CHAT_PATH,
        token,
        body: {
          conversationId: conversation.id,
          text: "what does this picker mean?",
          locale: "en",
        },
      });
      const chatBody = assistantHostInteractionResultSchema.parse(
        await chat.json(),
      );
      expect(chatBody.status).toBe("ok");
      if (chatBody.status !== "ok") {
        return;
      }
      expect(chatBody.pending?.id).toBe(record.id);
      expect(await orderCount()).toBe(beforeChat);
      const history = await h.invoke(getModelHistory, {
        conversationId: conversation.id,
      });
      const leftoverRun = history.messages
        .flatMap((message) => message.toolRuns)
        .find((run) => run.executionId === leftover.executionId);
      expect(leftoverRun?.outcome).toBe("started");
      const resume = await hostRequest(
        harness({
          pendingStore: h.pendingStore,
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
      );
      expect(
        assistantHostInteractionResultSchema.parse(await resume.json()).status,
      ).toBe("ok");
      expect(await orderCount()).toBe(beforeChat + 2);
      const afterChoice = await h.invoke(getModelHistory, {
        conversationId: conversation.id,
      });
      const recovered = afterChoice.messages
        .flatMap((message) => message.toolRuns)
        .find((run) => run.executionId === leftover.executionId);
      expect(recovered?.outcome).toBe("success");
    });

    it("recovers a later unfinished chat-turn after completed Phase B; choice replay stays done", async () => {
      const speech = "The order is ready.";
      const h = harness({ model: silentModel(speech) });
      const token = await insertBearer(kit, kitIdentities.users.anna);
      const conversation = await h.invoke(createConversation, {
        title: "Completed Phase B then chat leftover",
      });
      const customer = await h.invoke(createCustomer, {
        name: "Phase B then chat Buyer",
        phone: nextPhone(),
      });
      const product = await h.invoke(createProduct, {
        name: "Phase B then chat Cake",
        basePriceMinor: "1500",
        variants: [{ name: "A" }, { name: "B" }],
      });
      const { record, optionByLabel } = await seedChoicePending(h, {
        conversationId: conversation.id,
        customerId: customer.id,
        product,
      });
      const optionId = optionByLabel.get("A");
      const first = await hostRequest(h.app, {
        method: "POST",
        path: ASSISTANT_HOST_CHOICE_PATH,
        token,
        body: {
          conversationId: conversation.id,
          choiceId: record.id,
          optionId,
        },
      });
      expect(
        assistantHostInteractionResultSchema.parse(await first.json()),
      ).toEqual(expect.objectContaining({ status: "ok", speech }));
      const afterPhaseB = await orderCount();
      const cake = await cakeCreateInputs(h, "Later chat leftover");
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
      const chat = await hostRequest(
        harness({
          pendingStore: h.pendingStore,
          model: silentModel("The leftover create already landed."),
        }).app,
        {
          method: "POST",
          path: ASSISTANT_HOST_CHAT_PATH,
          token,
          body: {
            conversationId: conversation.id,
            text: "Did the leftover go through?",
            locale: "en",
          },
        },
      );
      expect(
        assistantHostInteractionResultSchema.parse(await chat.json()).status,
      ).toBe("ok");
      expect(await orderCount()).toBe(afterCommit);
      const afterChat = await h.invoke(getModelHistory, {
        conversationId: conversation.id,
      });
      const recovered = afterChat.messages
        .flatMap((message) => message.toolRuns)
        .find((run) => run.executionId === leftover.executionId);
      expect(recovered?.outcome).toBe("success");
      const replay = await hostRequest(
        harness({
          pendingStore: h.pendingStore,
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
      );
      const replayBody = assistantHostInteractionResultSchema.parse(
        await replay.json(),
      );
      expect(replayBody.status).toBe("ok");
      if (replayBody.status !== "ok") {
        return;
      }
      expect(replayBody.speech).toBe(speech);
      expect(replayBody.speech).not.toBe("The leftover create already landed.");
      expect(await orderCount()).toBe(afterCommit);
    });

    it("recovers a chat-turn started on the edge of and outside the 8-message window", async () => {
      const h = harness({
        model: silentModel("The earlier create already landed."),
      });
      const token = await insertBearer(kit, kitIdentities.users.anna);
      const edgeConversation = await h.invoke(createConversation, {
        title: "Window edge chat leftover",
      });
      const edgeCake = await cakeCreateInputs(h, "Window edge");
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
      const edgeChat = await hostRequest(h.app, {
        method: "POST",
        path: ASSISTANT_HOST_CHAT_PATH,
        token,
        body: {
          conversationId: edgeConversation.id,
          text: "Did the edge create land?",
          locale: "en",
        },
      });
      expect(
        assistantHostInteractionResultSchema.parse(await edgeChat.json())
          .status,
      ).toBe("ok");
      expect(await orderCount()).toBe(afterEdgeCommit);
      const edgeFinished = await h.invoke(getModelHistory, {
        conversationId: edgeConversation.id,
      });
      expect(
        edgeFinished.unfinishedStartedRuns.some(
          (run) => run.executionId === edgeLeftover.executionId,
        ),
      ).toBe(false);

      const outsideConversation = await h.invoke(createConversation, {
        title: "Window outside chat leftover",
      });
      const outsideCake = await cakeCreateInputs(h, "Window outside");
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
      const outsideChat = await hostRequest(
        harness({
          pendingStore: h.pendingStore,
          model: reissue,
        }).app,
        {
          method: "POST",
          path: ASSISTANT_HOST_CHAT_PATH,
          token,
          body: {
            conversationId: outsideConversation.id,
            text: "Did the outside create land?",
            locale: "en",
          },
        },
      );
      expect(
        assistantHostInteractionResultSchema.parse(await outsideChat.json())
          .status,
      ).toBe("ok");
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
      expect(
        outsideFinished.checkpointTurns.some(
          (turn) =>
            turn.messageId === outsideLeftover.messageId &&
            turn.turnKey === `begin:${outsideUser.id}`,
        ),
      ).toBe(true);
    });

    it("recovers a Phase B leftover after eight discussion chats without a new execution_id", async () => {
      const pendingStore = createMemoryPendingStore();
      const token = await insertBearer(kit, kitIdentities.users.anna);
      const seedHarness = harness({ pendingStore, model: silentModel() });
      const conversation = await seedHarness.invoke(createConversation, {
        title: "Phase B leftover after discussion",
      });
      const cake = await cakeCreateInputs(seedHarness, "Discussion leftover");
      const choiceCustomer = await seedHarness.invoke(createCustomer, {
        name: "Discussion Buyer",
        phone: nextPhone(),
      });
      const choiceProduct = await seedHarness.invoke(createProduct, {
        name: "Discussion Cake",
        basePriceMinor: "1500",
        variants: [{ name: "A" }, { name: "B" }],
      });
      const { record, optionByLabel } = await seedChoicePending(seedHarness, {
        conversationId: conversation.id,
        customerId: choiceCustomer.id,
        product: choiceProduct,
      });
      const optionId = optionByLabel.get("A");
      if (optionId === undefined) {
        throw new Error("seeded choice missing option A");
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
      const discussion = harness({
        pendingStore,
        model: silentModel("Discussing the leftover."),
      });
      for (let index = 0; index < 8; index += 1) {
        const chat = await hostRequest(discussion.app, {
          method: "POST",
          path: ASSISTANT_HOST_CHAT_PATH,
          token,
          body: {
            conversationId: conversation.id,
            text: `Discussion ${String(index)}`,
            locale: "en",
          },
        });
        expect(
          assistantHostInteractionResultSchema.parse(await chat.json()).status,
        ).toBe("ok");
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
      const resume = await hostRequest(
        harness({ pendingStore, model: reissue }).app,
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
      );
      expect(
        assistantHostInteractionResultSchema.parse(await resume.json()).status,
      ).toBe("ok");
      expect(await orderCount()).toBe(afterCommit);
      const prompt = JSON.stringify(reissue.doStreamCalls[0]?.prompt ?? []);
      expect(prompt).toContain("call-resume-discussion");
      expect(prompt).not.toContain("call-reissue-create");
      const finished = await seedHarness.invoke(getModelHistory, {
        conversationId: conversation.id,
      });
      expect(
        finished.unfinishedStartedRuns.some(
          (run) => run.executionId === leftover.executionId,
        ),
      ).toBe(false);
      const leftoverRuns = await conversationToolRuns(conversation.id);
      expect(
        leftoverRuns.find((run) => run.executionId === leftover.executionId)
          ?.outcome,
      ).toBe("success");
      expect(
        leftoverRuns.filter(
          (run) =>
            run.toolName === ORDERS_CREATE_TOOL_NAME &&
            run.outcome === "success",
        ),
      ).toEqual([
        expect.objectContaining({ executionId: leftover.executionId }),
      ]);
    });

    it("does not reopen completed Phase B when the resume turn is clipped from checkpointTurns", async () => {
      const speech = "The order is ready.";
      const h = harness({ model: silentModel(speech) });
      const token = await insertBearer(kit, kitIdentities.users.anna);
      const conversation = await h.invoke(createConversation, {
        title: "Clipped completed resume",
      });
      const customer = await h.invoke(createCustomer, {
        name: "Clipped Resume Buyer",
        phone: nextPhone(),
      });
      const product = await h.invoke(createProduct, {
        name: "Clipped Resume Cake",
        basePriceMinor: "1500",
        variants: [{ name: "A" }, { name: "B" }],
      });
      const { record, optionByLabel } = await seedChoicePending(h, {
        conversationId: conversation.id,
        customerId: customer.id,
        product,
      });
      const optionId = optionByLabel.get("A");
      const first = await hostRequest(h.app, {
        method: "POST",
        path: ASSISTANT_HOST_CHOICE_PATH,
        token,
        body: {
          conversationId: conversation.id,
          choiceId: record.id,
          optionId,
        },
      });
      expect(
        assistantHostInteractionResultSchema.parse(await first.json()),
      ).toEqual(expect.objectContaining({ status: "ok", speech }));
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
      const replay = await hostRequest(
        harness({
          pendingStore: h.pendingStore,
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
      );
      const replayBody = assistantHostInteractionResultSchema.parse(
        await replay.json(),
      );
      expect(replayBody.status).toBe("ok");
      if (replayBody.status !== "ok") {
        return;
      }
      expect(replayBody.speech).toBe(speech);
      expect(replayBody.speech).not.toBe("later speech");
      expect(await orderCount()).toBe(afterPhaseB);
      const pinned = await h.invoke(getModelHistory, {
        conversationId: conversation.id,
        includeTurnKeys: [resumeKey],
      });
      expect(
        pinned.checkpointTurns.find((turn) => turn.turnKey === resumeKey),
      ).toEqual(
        expect.objectContaining({
          turnKey: resumeKey,
          hasSpeech: true,
          speech,
        }),
      );
    });

    it("refuses a chat write when an empty Phase B begin is clipped from checkpointTurns", async () => {
      const pendingStore = createMemoryPendingStore();
      const token = await insertBearer(kit, kitIdentities.users.anna);
      const seedHarness = harness({ pendingStore, model: silentModel() });
      const conversation = await seedHarness.invoke(createConversation, {
        title: "Clipped empty Phase B begin",
      });
      const cake = await cakeCreateInputs(seedHarness, "Clipped empty begin");
      const choiceCustomer = await seedHarness.invoke(createCustomer, {
        name: "Clipped Empty Begin Buyer",
        phone: nextPhone(),
      });
      const choiceProduct = await seedHarness.invoke(createProduct, {
        name: "Clipped Empty Begin Cake",
        basePriceMinor: "1500",
        variants: [{ name: "A" }, { name: "B" }],
      });
      const { record, optionByLabel } = await seedChoicePending(seedHarness, {
        conversationId: conversation.id,
        customerId: choiceCustomer.id,
        product: choiceProduct,
      });
      const optionId = optionByLabel.get("A");
      if (optionId === undefined) {
        throw new Error("seeded choice missing option A");
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
      const chat = await hostRequest(
        harness({ pendingStore, model: reissue }).app,
        {
          method: "POST",
          path: ASSISTANT_HOST_CHAT_PATH,
          token,
          body: {
            conversationId: conversation.id,
            text: "create another order",
            locale: "en",
          },
        },
      );
      expect(
        assistantHostInteractionResultSchema.parse(await chat.json()).status,
      ).toBe("ok");
      expect(await orderCount()).toBe(beforeChat);
      const after = await seedHarness.invoke(getModelHistory, {
        conversationId: conversation.id,
      });
      expect(
        after.checkpointTurns.find((turn) => turn.turnKey === resumeKey)
          ?.hasSpeech,
      ).toBe(false);
    });

    it("refuses a re-issued orders_create while an excluded resume leftover stays started", async () => {
      const pendingStore = createMemoryPendingStore();
      const token = await insertBearer(kit, kitIdentities.users.anna);
      const seedHarness = harness({ pendingStore, model: silentModel() });
      const conversation = await seedHarness.invoke(createConversation, {
        title: "Excluded resume plus reissue",
      });
      const cake = await cakeCreateInputs(seedHarness, "Reissue leftover");
      const choiceCustomer = await seedHarness.invoke(createCustomer, {
        name: "Reissue Buyer",
        phone: nextPhone(),
      });
      const choiceProduct = await seedHarness.invoke(createProduct, {
        name: "Reissue Cake",
        basePriceMinor: "1500",
        variants: [{ name: "A" }, { name: "B" }],
      });
      const { record, optionByLabel } = await seedChoicePending(seedHarness, {
        conversationId: conversation.id,
        customerId: choiceCustomer.id,
        product: choiceProduct,
      });
      const optionId = optionByLabel.get("A");
      if (optionId === undefined) {
        throw new Error("seeded choice missing option A");
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
      const chat = await hostRequest(
        harness({ pendingStore, model: reissue }).app,
        {
          method: "POST",
          path: ASSISTANT_HOST_CHAT_PATH,
          token,
          body: {
            conversationId: conversation.id,
            text: "create another order",
            locale: "en",
          },
        },
      );
      expect(
        assistantHostInteractionResultSchema.parse(await chat.json()).status,
      ).toBe("ok");
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

    it("does not auto-execute a started run whose message turnKey is null", async () => {
      const h = harness({
        model: silentModel("No legacy write from this chat."),
      });
      const token = await insertBearer(kit, kitIdentities.users.anna);
      const conversation = await h.invoke(createConversation, {
        title: "Null turnKey fail closed",
      });
      const cake = await cakeCreateInputs(h, "Null turnKey");
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
      const chat = await hostRequest(h.app, {
        method: "POST",
        path: ASSISTANT_HOST_CHAT_PATH,
        token,
        body: {
          conversationId: conversation.id,
          text: "Just saying hi",
          locale: "en",
        },
      });
      expect(
        assistantHostInteractionResultSchema.parse(await chat.json()).status,
      ).toBe("ok");
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

  it("claimed confirm wins over concurrent chat", async () => {
    const counted = countingConversationLock(createMemoryConversationLock());
    const h = harness({
      model: silentModel("The confirmation is still open."),
      conversationLock: counted.lock,
    });
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await h.invoke(createConversation, {
      title: "Claimed vs chat",
    });
    await h.invoke(
      appendUserMessage,
      { conversationId: conversation.id, body: "Delete please" },
      { idempotencyKey: attemptKey("message", conversation.id, randomUUID()) },
    );
    const seeded = await seedConfirmationPending(h, conversation.id);
    const [confirm, chat] = await Promise.all([
      hostRequest(h.app, {
        method: "POST",
        path: ASSISTANT_CONFIRM_PATH,
        token,
        body: {
          conversationId: conversation.id,
          challengeId: seeded.challengeId,
        },
      }),
      hostRequest(h.app, {
        method: "POST",
        path: ASSISTANT_HOST_CHAT_PATH,
        token,
        body: {
          conversationId: conversation.id,
          text: "why confirm?",
          locale: "en",
        },
      }),
    ]);
    const confirmBody = assistantHostInteractionResultSchema.parse(
      await confirm.json(),
    );
    const chatBody = assistantHostInteractionResultSchema.parse(
      await chat.json(),
    );
    expect(counted.maxConcurrent()).toBe(1);
    expect([confirmBody.status, chatBody.status]).toEqual(["ok", "ok"]);
    expect(await customerRow(seeded.customerId)).toBeUndefined();
    const peek = await hostRequest(h.app, {
      method: "GET",
      path: `${ASSISTANT_PENDING_PATH}?conversationId=${conversation.id}`,
      token,
    });
    const peeked = assistantPendingPeekResultSchema.parse(await peek.json());
    expect(peeked.pending).toBeNull();
  });

  it("choice Phase B can call orders_list_* after create", async () => {
    const h = harness({ model: listThenSpeakModel() });
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await h.invoke(createConversation, {
      title: "List after create",
    });
    await h.invoke(
      appendUserMessage,
      {
        conversationId: conversation.id,
        body: "Create then list my orders",
      },
      { idempotencyKey: attemptKey("message", conversation.id, randomUUID()) },
    );
    const customer = await h.invoke(createCustomer, {
      name: "List Buyer",
      phone: nextPhone(),
    });
    const product = await h.invoke(createProduct, {
      name: "List Cake",
      basePriceMinor: "1500",
      variants: [{ name: "A" }, { name: "B" }],
    });
    const { record, optionByLabel } = await seedChoicePending(h, {
      conversationId: conversation.id,
      customerId: customer.id,
      product,
    });
    const optionId = optionByLabel.get("A");
    const response = await hostRequest(h.app, {
      method: "POST",
      path: ASSISTANT_HOST_CHOICE_PATH,
      token,
      body: {
        conversationId: conversation.id,
        choiceId: record.id,
        optionId,
      },
    });
    const body = assistantHostInteractionResultSchema.parse(
      await response.json(),
    );
    expect(body.status).toBe("ok");
    if (body.status !== "ok") {
      return;
    }
    expect(body.speech).toBe("Here is the list.");
    expect(body.pending).toBeNull();
    expectKnownResumeCardKinds(body.cards);
    expect(surfaceCard(body.cards, "order-entity")).toBeDefined();
    expect(surfaceCard(body.cards, "orders-list")).toBeDefined();
    const created = (await conversationToolRuns(conversation.id)).filter(
      (row) => row.actionName === "orders.create" && row.outcome === "success",
    );
    expect(created).toHaveLength(1);
    const createdOrderId = created[0]?.resultIds[0];
    expect(typeof createdOrderId).toBe("string");
    expect(orderIdFromEntityCard(body.cards)).toBe(createdOrderId);
  });

  it("why-confirm chat keeps pending; abandon then allows a new create", async () => {
    const h = harness({
      model: silentModel("The confirmation is still open."),
    });
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await h.invoke(createConversation, {
      title: "Why confirm",
    });
    await h.invoke(
      appendUserMessage,
      { conversationId: conversation.id, body: "Delete please" },
      { idempotencyKey: attemptKey("message", conversation.id, randomUUID()) },
    );
    const seeded = await seedConfirmationPending(h, conversation.id);
    const why = await hostRequest(h.app, {
      method: "POST",
      path: ASSISTANT_HOST_CHAT_PATH,
      token,
      body: {
        conversationId: conversation.id,
        text: "why confirm?",
        locale: "en",
      },
    });
    const whyBody = assistantHostInteractionResultSchema.parse(
      await why.json(),
    );
    expect(whyBody.status).toBe("ok");
    if (whyBody.status !== "ok") {
      return;
    }
    expect(whyBody.pending?.id).toBe(seeded.challengeId);
    expect(await customerRow(seeded.customerId)).toBeDefined();
    const tak = await hostRequest(h.app, {
      method: "POST",
      path: ASSISTANT_HOST_CHAT_PATH,
      token,
      body: {
        conversationId: conversation.id,
        text: "Так",
        locale: "uk",
      },
    });
    const takBody = assistantHostInteractionResultSchema.parse(
      await tak.json(),
    );
    expect(takBody.status).toBe("ok");
    if (takBody.status !== "ok") {
      return;
    }
    expect(takBody.pending?.id).toBe(seeded.challengeId);
    const abandoned = await hostRequest(h.app, {
      method: "POST",
      path: ASSISTANT_PENDING_ABANDON_PATH,
      token,
      body: {
        conversationId: conversation.id,
        pendingId: seeded.challengeId,
        expectedVersion: 1,
      },
    });
    const abandonedBody = assistantHostInteractionResultSchema.parse(
      await abandoned.json(),
    );
    expect(abandonedBody.status).toBe("ok");
    if (abandonedBody.status !== "ok") {
      return;
    }
    expect(abandonedBody.pending).toBeNull();
    const peek = await hostRequest(h.app, {
      method: "GET",
      path: `${ASSISTANT_PENDING_PATH}?conversationId=${conversation.id}`,
      token,
    });
    expect(
      assistantPendingPeekResultSchema.parse(await peek.json()).pending,
    ).toBeNull();
    const createChat = harness({
      pendingStore: h.pendingStore,
      model: new MockLanguageModelV3({
        doStream: [
          mockToolCallStream(
            "call-create",
            ORDERS_CREATE_TOOL_NAME,
            JSON.stringify({
              customerId: kitIdentities.users.anna,
              items: [
                {
                  productId: kitIdentities.users.anna,
                  quantityMilli: "1000",
                },
              ],
            }),
          ),
          mockTextStream("Trying a new create."),
        ],
      }),
    });
    const after = await hostRequest(createChat.app, {
      method: "POST",
      path: ASSISTANT_HOST_CHAT_PATH,
      token,
      body: {
        conversationId: conversation.id,
        text: "create another order",
        locale: "en",
      },
    });
    expect(after.status).toBe(200);
  });

  it("opens a successor picker on the shared envelope without treating it as order-created-only", async () => {
    const h = harness({ model: silentModel() });
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const conversation = await h.invoke(createConversation, {
      title: "Successor",
    });
    const customer = await h.invoke(createCustomer, {
      name: "Seq Buyer",
      phone: nextPhone(),
    });
    const first = await h.invoke(createProduct, {
      name: "Macarons Seq",
      basePriceMinor: "1500",
      variants: [{ name: "Lemon" }, { name: "Vanilla" }],
    });
    const second = await h.invoke(createProduct, {
      name: "Eclairs Seq",
      basePriceMinor: "1500",
      variants: [{ name: "Coffee" }, { name: "Chocolate" }],
    });
    const { record, optionByLabel } = await seedChoicePending(h, {
      conversationId: conversation.id,
      customerId: customer.id,
      product: first,
      extraProductId: second.productId,
    });
    const lemon = optionByLabel.get("Lemon");
    const response = await hostRequest(h.app, {
      method: "POST",
      path: ASSISTANT_HOST_CHOICE_PATH,
      token,
      body: {
        conversationId: conversation.id,
        choiceId: record.id,
        optionId: lemon,
      },
    });
    const body = assistantHostInteractionResultSchema.parse(
      await response.json(),
    );
    expect(body.status).toBe("ok");
    if (body.status !== "ok") {
      return;
    }
    expect(body.pending?.kind).toBe("choice");
    expect(body.pending?.id).not.toBe(record.id);
    expect(body.cards.some((card) => card.kind === "choice")).toBe(true);
  });

  it("pending Lua and host source never GETDEL confirmation keys", () => {
    const redisSrc = readFileSync(join(here, "../stores/redis.ts"), "utf8");
    const pendingBlock = redisSrc.slice(
      redisSrc.indexOf("const PENDING_OPEN_LUA"),
      redisSrc.indexOf("export function createRedisSecondaryStorage"),
    );
    expect(pendingBlock).not.toContain("GETDEL");
    expect(readFileSync(join(here, "assistant-host.ts"), "utf8")).not.toContain(
      "getAndDelete",
    );
  });
});
