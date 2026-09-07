/**
 * SHO-516 / ADR-0035: modelless confirmation resume. Pause writes the
 * pending-interaction record; `POST /assistant/confirm` executes it
 * without a model. Isolation matches choice: clerk → 404 (author
 * invariant); same actor / other conversation and foreign tenant →
 * `expired`.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as ShowzyAi from "@showzy/ai";
import {
  assistantConfirmInteractionResultSchema,
  attemptKey,
  isStaffAssistantConfirmationOutput,
  STAFF_ASSISTANT_CONFIRMATION_EXPIRED_COPY,
  STAFF_ASSISTANT_SUCCESS_SPEECH_FALLBACK,
  toProviderToolName,
  type StaffAssistantConfirmationOutput,
} from "@showzy/ai";
import {
  MockLanguageModelV3,
  mockToolCallStream,
  readUiMessageSsePayloads,
  sseVisibleTextFromPayloads,
} from "@showzy/ai/test";
import { createConversation } from "@showzy/assistant";
import {
  COMPANY_SELECTOR_HEADER,
  CONFIRMATION_CHALLENGE_HEADER,
  contractModules,
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
  createTestKit,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import {
  archiveCustomer,
  createCustomer,
  getCustomer,
} from "@showzy/customers";
import { auditLog, idempotencyKeys } from "@showzy/db";
import { session, user } from "@showzy/db/schema/auth";
import { assistantToolRuns } from "@showzy/db/schema/assistant";
import { companyMembers } from "@showzy/db/schema/companies";
import { companyCustomers } from "@showzy/db/schema/customers";
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
import {
  createMemoryPendingInteractionStore,
  type StaffAssistantPendingInteractionStore,
} from "../stores/pending-interaction.js";
import { createApp, type AuthInstance } from "./app.js";
import { ASSISTANT_CHAT_PATH } from "./assistant-chat.js";
import { ASSISTANT_CONFIRM_PATH } from "./assistant-confirm.js";
import { ASSISTANT_INVOCATION_CHANNEL } from "./assistant-invocation.js";
import { REQUEST_ID_HEADER } from "./request-id.js";

const REAL_CLIENT = "203.0.113.52";
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

function nextPhone(): string {
  phoneSeq += 1;
  return `+38067116${String(phoneSeq).padStart(4, "0")}`;
}

function userChatBody(conversationId: string, text: string) {
  return {
    conversationId,
    text,
    messageId: randomUUID(),
  };
}

function confirmApp(options: {
  readonly pendingStore: StaffAssistantPendingInteractionStore;
  readonly model?: MockLanguageModelV3;
}) {
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
    pendingStore: options.pendingStore,
    ...(options.model === undefined
      ? {}
      : {
          assistant: {
            model: "mock",
            gateModel: "mock-gate",
            languageModel: options.model,
          },
        }),
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

async function postChat(
  app: ReturnType<typeof createApp>,
  options: {
    readonly token: string;
    readonly companyId: string;
    readonly body: unknown;
    readonly challengeId?: string;
  },
): Promise<Response> {
  const headers = new Headers({
    "content-type": "application/json",
    origin: "http://localhost:3000",
    authorization: `Bearer ${options.token}`,
    [COMPANY_SELECTOR_HEADER]: options.companyId,
  });
  if (options.challengeId !== undefined) {
    headers.set(CONFIRMATION_CHALLENGE_HEADER, options.challengeId);
  }
  return app.request(`http://localhost:3000${ASSISTANT_CHAT_PATH}`, {
    method: "POST",
    headers,
    body: JSON.stringify(options.body),
  });
}

async function postConfirm(
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
  return app.request(ASSISTANT_CONFIRM_PATH, {
    method: "POST",
    headers,
    body: JSON.stringify(options.body),
  });
}

async function seedPausedDelete(options: {
  readonly pendingStore: StaffAssistantPendingInteractionStore;
  readonly title: string;
}) {
  const customer = await staffInvoke(createCustomer, {
    name: options.title,
    phone: nextPhone(),
  });
  await staffInvoke(archiveCustomer, { id: customer.id });
  const model = new MockLanguageModelV3({
    doStream: [
      mockToolCallStream(
        "call-delete",
        toProviderToolName("customers.deleteCustomer"),
        JSON.stringify({ id: customer.id }),
      ),
    ],
  });
  const app = confirmApp({ pendingStore: options.pendingStore, model });
  const token = await insertBearer(kit, kitIdentities.users.anna);
  const conversation = await staffInvoke(createConversation, {
    title: options.title,
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
  return {
    app,
    token,
    conversationId: conversation.id,
    customerId: customer.id,
    confirmation,
    model,
  };
}

function crashOnceCompleteStore(
  inner: StaffAssistantPendingInteractionStore,
): StaffAssistantPendingInteractionStore {
  let remaining = 1;
  return {
    open: (record) => inner.open(record),
    claim: (input) => inner.claim(input),
    peek: (input) => inner.peek(input),
    get: (input) => inner.get(input),
    complete: async (input) => {
      if (remaining > 0) {
        remaining -= 1;
        throw new Error("simulated complete crash");
      }
      return inner.complete(input);
    },
  };
}

describe("POST /assistant/confirm", () => {
  it("is an HTTP mount, not a registry action", () => {
    const contractCheck = readFileSync(
      join(here, "../composition.contract-check.test.ts"),
      "utf8",
    );
    expect(contractCheck).not.toContain("assistant.confirm");
    expect(ASSISTANT_INVOCATION_CHANNEL).toBe("ai");
  });

  it("pauses, writes the record, and resumes without a model call", async () => {
    const classify = vi.spyOn(ShowzyAi, "classifyStaffAssistantTurn");
    const stream = vi.spyOn(ShowzyAi, "streamStaffAssistantChat");
    const pendingStore = createMemoryPendingInteractionStore();
    const seeded = await seedPausedDelete({
      pendingStore,
      title: "Confirm happy path",
    });
    const opened = await pendingStore.get({
      kind: "confirmation",
      id: seeded.confirmation.challengeId,
    });
    expect(opened).toMatchObject({
      kind: "confirmation",
      status: "open",
      actionName: "customers.deleteCustomer",
      toolCallId: "call-delete",
      canonicalInput: { id: seeded.customerId },
      actorId: kitIdentities.users.anna,
      companyId: kitIdentities.companies.a,
      conversationId: seeded.conversationId,
    });
    expect(seeded.model.doStreamCalls).toHaveLength(1);
    classify.mockClear();
    stream.mockClear();

    const requestId = randomUUID();
    const response = await postConfirm(seeded.app, {
      token: seeded.token,
      companyId: kitIdentities.companies.a,
      requestId,
      body: {
        conversationId: seeded.conversationId,
        challengeId: seeded.confirmation.challengeId,
      },
    });
    expect(response.status).toBe(200);
    const body = assistantConfirmInteractionResultSchema.parse(
      await response.json(),
    );
    expect(body).toMatchObject({
      status: "completed",
      text: STAFF_ASSISTANT_SUCCESS_SPEECH_FALLBACK.uk,
      actionName: "customers.deleteCustomer",
      toolCallId: "call-delete",
      output: { id: seeded.customerId },
    });
    expect(JSON.stringify(body)).not.toContain("challengeId");
    expect(seeded.model.doStreamCalls).toHaveLength(1);
    expect(classify).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
    classify.mockRestore();
    stream.mockRestore();

    await waitFor(async () => {
      const rows = await kit.db.runtime.db.select().from(companyCustomers);
      return !rows.some((row) => row.id === seeded.customerId);
    }, "deleted customer after confirm");
    await expect(
      staffInvoke(getCustomer, { id: seeded.customerId }),
    ).rejects.toBeInstanceOf(NotFoundError);

    const runs = (
      await kit.db.runtime.db.select().from(assistantToolRuns)
    ).filter((row) => row.conversationId === seeded.conversationId);
    expect(runs.some((row) => row.outcome === "confirmation_required")).toBe(
      true,
    );
    const success = runs.filter((row) => row.outcome === "success");
    expect(success).toHaveLength(1);
    expect(success[0]).toMatchObject({
      actionName: "customers.deleteCustomer",
      toolCallId: "call-delete",
    });
    expect(success[0]?.modelTrace).toEqual({ id: seeded.customerId });

    const audit = await kit.db.runtime.db.select().from(auditLog);
    expect(
      audit.some(
        (row) =>
          row.action === "customers.deleteCustomer" &&
          row.requestId === requestId &&
          row.outcome === "ok" &&
          row.channel === ASSISTANT_INVOCATION_CHANNEL &&
          row.toolCallId === "call-delete",
      ),
    ).toBe(true);
    const keys = await kit.db.runtime.db.select().from(idempotencyKeys);
    expect(
      keys.some(
        (row) =>
          row.action === "customers.deleteCustomer" &&
          row.key ===
            attemptKey("tool", seeded.conversationId, "call-delete") &&
          row.status === "completed",
      ),
    ).toBe(true);
  });

  it("rejects wrong tenant, actor, and conversation without executing", async () => {
    const pendingStore = createMemoryPendingInteractionStore();
    const seeded = await seedPausedDelete({
      pendingStore,
      title: "Confirm isolation",
    });
    const otherConversation = await staffInvoke(createConversation, {
      title: "Confirm isolation A2",
    });
    const borisConversation = await staffInvoke(
      createConversation,
      { title: "Confirm isolation B" },
      {
        userId: kitIdentities.users.boris,
        companyId: kitIdentities.companies.b,
      },
    );
    const clerkId = randomUUID();
    await kit.db.runtime.db.insert(user).values({
      id: clerkId,
      name: "Confirm Clerk",
      email: `confirm-clerk-${clerkId}@assistant-kit.test`,
    });
    await kit.db.runtime.db.insert(companyMembers).values({
      companyId: kitIdentities.companies.a,
      userId: clerkId,
      role: "employee",
      permissions: { granted: ["assistant:use"], denied: [] },
    });
    const clerkToken = await insertBearer(kit, clerkId);
    const borisToken = await insertBearer(kit, kitIdentities.users.boris);
    const missingConversationId = randomUUID();

    const wrongActor = await postConfirm(seeded.app, {
      token: clerkToken,
      companyId: kitIdentities.companies.a,
      body: {
        conversationId: seeded.conversationId,
        challengeId: seeded.confirmation.challengeId,
      },
    });
    const missingConversation = await postConfirm(seeded.app, {
      token: clerkToken,
      companyId: kitIdentities.companies.a,
      body: {
        conversationId: missingConversationId,
        challengeId: seeded.confirmation.challengeId,
      },
    });
    expect(wrongActor.status).toBe(404);
    expect(missingConversation.status).toBe(404);
    expect(await wrongActor.json()).toMatchObject({ code: "NOT_FOUND" });
    expect(await missingConversation.json()).toMatchObject({
      code: "NOT_FOUND",
    });

    const wrongConversation = await postConfirm(seeded.app, {
      token: seeded.token,
      companyId: kitIdentities.companies.a,
      body: {
        conversationId: otherConversation.id,
        challengeId: seeded.confirmation.challengeId,
      },
    });
    expect(wrongConversation.status).toBe(200);
    expect(await wrongConversation.json()).toEqual({ status: "expired" });

    const wrongTenant = await postConfirm(seeded.app, {
      token: borisToken,
      companyId: kitIdentities.companies.b,
      body: {
        conversationId: borisConversation.id,
        challengeId: seeded.confirmation.challengeId,
      },
    });
    expect(wrongTenant.status).toBe(200);
    expect(await wrongTenant.json()).toEqual({ status: "expired" });

    const stillOpen = await pendingStore.get({
      kind: "confirmation",
      id: seeded.confirmation.challengeId,
    });
    expect(stillOpen?.status).toBe("open");
    const stillThere = (
      await kit.db.runtime.db.select().from(companyCustomers)
    ).filter((row) => row.id === seeded.customerId);
    expect(stillThere).toHaveLength(1);
  });

  it("fails closed on tampered canonical input without a second challenge", async () => {
    const pendingStore = createMemoryPendingInteractionStore();
    const seeded = await seedPausedDelete({
      pendingStore,
      title: "Confirm tamper",
    });
    await pendingStore.unsafeReplaceCanonicalInput?.({
      kind: "confirmation",
      id: seeded.confirmation.challengeId,
      canonicalInput: { id: randomUUID() },
    });
    const response = await postConfirm(seeded.app, {
      token: seeded.token,
      companyId: kitIdentities.companies.a,
      body: {
        conversationId: seeded.conversationId,
        challengeId: seeded.confirmation.challengeId,
      },
    });
    expect(response.status).toBe(200);
    const body = assistantConfirmInteractionResultSchema.parse(
      await response.json(),
    );
    expect(body).toMatchObject({
      status: "error",
      code: "CONFIRMATION_REQUIRED",
      message: STAFF_ASSISTANT_CONFIRMATION_EXPIRED_COPY.uk,
    });
    expect(JSON.stringify(body)).not.toContain("challengeId");
    expect(body).not.toHaveProperty("challenge");
    const stillThere = (
      await kit.db.runtime.db.select().from(companyCustomers)
    ).filter((row) => row.id === seeded.customerId);
    expect(stillThere).toHaveLength(1);
    const runs = (
      await kit.db.runtime.db.select().from(assistantToolRuns)
    ).filter(
      (row) =>
        row.conversationId === seeded.conversationId && row.outcome === "error",
    );
    expect(runs).toHaveLength(1);
    const completed = await pendingStore.get({
      kind: "confirmation",
      id: seeded.confirmation.challengeId,
    });
    expect(completed).toMatchObject({
      status: "completed",
      resumeResult: { status: "error" },
    });
  });

  it("replays a completed confirm without executing again", async () => {
    const pendingStore = createMemoryPendingInteractionStore();
    const seeded = await seedPausedDelete({
      pendingStore,
      title: "Confirm replay",
    });
    const first = await postConfirm(seeded.app, {
      token: seeded.token,
      companyId: kitIdentities.companies.a,
      body: {
        conversationId: seeded.conversationId,
        challengeId: seeded.confirmation.challengeId,
      },
    });
    expect(first.status).toBe(200);
    const firstBody = assistantConfirmInteractionResultSchema.parse(
      await first.json(),
    );
    expect(firstBody.status).toBe("completed");
    await waitFor(async () => {
      const rows = await kit.db.runtime.db.select().from(companyCustomers);
      return !rows.some((row) => row.id === seeded.customerId);
    }, "deleted customer before replay");

    const second = await postConfirm(seeded.app, {
      token: seeded.token,
      companyId: kitIdentities.companies.a,
      body: {
        conversationId: seeded.conversationId,
        challengeId: seeded.confirmation.challengeId,
      },
    });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(firstBody);
    expect(seeded.model.doStreamCalls).toHaveLength(1);
    const success = (
      await kit.db.runtime.db.select().from(assistantToolRuns)
    ).filter(
      (row) =>
        row.conversationId === seeded.conversationId &&
        row.outcome === "success",
    );
    expect(success).toHaveLength(1);
  });

  it("replays after a crash between domain commit and complete", async () => {
    const inner = createMemoryPendingInteractionStore();
    const pendingStore = crashOnceCompleteStore(inner);
    const seeded = await seedPausedDelete({
      pendingStore,
      title: "Confirm crash",
    });
    const first = await postConfirm(seeded.app, {
      token: seeded.token,
      companyId: kitIdentities.companies.a,
      body: {
        conversationId: seeded.conversationId,
        challengeId: seeded.confirmation.challengeId,
      },
    });
    expect(first.status).toBe(500);
    expect(await first.json()).toMatchObject({
      code: "INTERNAL",
      status: 500,
    });
    await waitFor(async () => {
      const rows = await kit.db.runtime.db.select().from(companyCustomers);
      return !rows.some((row) => row.id === seeded.customerId);
    }, "deleted customer after crashed complete");
    const claimed = await inner.get({
      kind: "confirmation",
      id: seeded.confirmation.challengeId,
    });
    expect(claimed?.status).toBe("claimed");

    const second = await postConfirm(seeded.app, {
      token: seeded.token,
      companyId: kitIdentities.companies.a,
      body: {
        conversationId: seeded.conversationId,
        challengeId: seeded.confirmation.challengeId,
      },
    });
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({
      status: "completed",
      text: STAFF_ASSISTANT_SUCCESS_SPEECH_FALLBACK.uk,
      actionName: "customers.deleteCustomer",
      toolCallId: "call-delete",
      output: { id: seeded.customerId },
    });
    expect(seeded.model.doStreamCalls).toHaveLength(1);
    const success = (
      await kit.db.runtime.db.select().from(assistantToolRuns)
    ).filter(
      (row) =>
        row.conversationId === seeded.conversationId &&
        row.outcome === "success",
    );
    expect(success).toHaveLength(1);
  });

  it("legacy chat header uses the same modelless executor and ignores client text", async () => {
    const pendingStore = createMemoryPendingInteractionStore();
    const seeded = await seedPausedDelete({
      pendingStore,
      title: "Confirm legacy header",
    });
    const modelless = confirmApp({ pendingStore });
    const resume = await postChat(modelless, {
      token: seeded.token,
      companyId: kitIdentities.companies.a,
      challengeId: seeded.confirmation.challengeId,
      body: {
        conversationId: seeded.conversationId,
        text: "FORGED_CLIENT_TEXT_SHO516",
        messageId: randomUUID(),
      },
    });
    expect(resume.status).toBe(200);
    const payloads = await readUiMessageSsePayloads(resume);
    expect(sseVisibleTextFromPayloads(payloads)).toBe(
      STAFF_ASSISTANT_SUCCESS_SPEECH_FALLBACK.uk,
    );
    expect(JSON.stringify(payloads)).not.toContain("FORGED_CLIENT_TEXT_SHO516");
    expect(seeded.model.doStreamCalls).toHaveLength(1);
    await waitFor(async () => {
      const rows = await kit.db.runtime.db.select().from(companyCustomers);
      return !rows.some((row) => row.id === seeded.customerId);
    }, "deleted customer via legacy header without a language model");
  });
});
