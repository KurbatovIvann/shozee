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
import { checkpointAssistantTurn, createConversation } from "@showzy/assistant";
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
      locale: "uk",
    },
    {
      actionName: "orders.create",
      toolCallId: `choice:${choiceId}`,
      executionId,
    },
  );
  expect(await h.pendingStore.open(record)).toBe(true);
  return { record };
}

async function seedConfirmationPending(
  h: Harness,
  conversationId: string,
): Promise<{
  readonly customerId: string;
  readonly challengeId: string;
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
  return {
    customerId: customer.id,
    challengeId: unconfirmed.challenge.challengeId,
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
    expect(
      resumed.cards.some(
        (card) => card.kind === "surface" && card.surface.includes("order"),
      ),
    ).toBe(true);
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
  });
});
