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
import { archiveProduct, createProduct, restoreProduct } from "@showzy/catalog";
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
import { createOrder } from "@showzy/orders";
import { session } from "@showzy/db/schema/auth";
import { companyCustomers } from "@showzy/db/schema/customers";
import { orders } from "@showzy/db/schema/orders";
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
  const begun = await h.invoke(
    checkpointAssistantTurn,
    { kind: "begin", conversationId },
    {
      idempotencyKey: attemptKey(
        "turn",
        conversationId,
        `begin:seed:${randomUUID()}`,
      ),
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
    { kind: "begin", conversationId: options.conversationId },
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
  readonly optionByLabel: Map<string, string>;
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
  const executionId = await stageExecution(
    h,
    options.conversationId,
    "orders.create",
    canonicalInput,
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
  return { record, optionByLabel };
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
    const { record } = await seedChoicePending(h, {
      conversationId: conversation.id,
      customerId: customer.id,
      product,
    });
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
    expect(replaced.pending?.id).toBe(record.id);
    expect(replaced.pending?.version).toBe(record.version);
    const peeked = await h.pendingStore.peekOpen({
      conversationId: conversation.id,
      bind: pendingBindFor(conversation.id),
    });
    expect(peeked.kind).toBe("found");
    if (peeked.kind !== "found" || peeked.record.kind !== "choice") {
      throw new Error("expected original choice pending still open");
    }
    expect(peeked.record.status).toBe("open");
    expect(peeked.record.id).toBe(record.id);
    expect(peeked.record.executionId).toBe(record.executionId);
    expect(await orderCount()).toBe(beforeOrders);
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
    expect(peeked.record.status).not.toBe("completed");
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
    expect(firstBody.code).not.toBeUndefined();
    const peeked = await h.pendingStore.peekOpen({
      conversationId: conversation.id,
      bind: pendingBindFor(conversation.id),
    });
    expect(peeked.kind).toBe("found");
    if (peeked.kind !== "found") {
      throw new Error("expected pending still blocking after Phase A error");
    }
    expect(peeked.record.status).not.toBe("completed");
    expect(peeked.record.id).toBe(record.id);
    expect(await orderCount()).toBe(beforeOrders);
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
    expect(body.cards.some((card) => card.kind === "surface")).toBe(true);
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
      { kind: "begin", conversationId: conversation.id },
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
      { kind: "begin", conversationId: conversation.id },
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
    await h.invoke(
      checkpointAssistantTurn,
      { kind: "begin", conversationId: conversation.id },
      {
        idempotencyKey: attemptKey(
          "turn",
          conversation.id,
          `begin:${randomUUID()}`,
        ),
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
      { kind: "begin", conversationId: conversation.id },
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
    expect(
      body.cards.some(
        (card) => card.kind === "surface" && card.surface.includes("order"),
      ),
    ).toBe(true);
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
