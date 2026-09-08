import { randomUUID } from "node:crypto";

import { staffHasPermission } from "@showzy/core";
import {
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
} from "@showzy/core/errors";
import {
  createCapturingLogger,
  createTestKit,
  crossTenantSuite,
  idempotencySuite,
  isolationCase,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import { auditLog } from "@showzy/db";
import { user } from "@showzy/db/schema/auth";
import {
  assistantConversations,
  assistantMessages,
  assistantToolRuns,
} from "@showzy/db/schema/assistant";
import { companyMembers } from "@showzy/db/schema/companies";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { appendUserMessage } from "./append-user-message.js";
import { checkpointAssistantTurn } from "./checkpoint-assistant-turn.js";
import { createConversation } from "./create-conversation.js";
import { getConversation } from "./get-conversation.js";
import { getModelHistory } from "./get-model-history.js";
import { getStaffActor } from "./get-staff-actor.js";
import { listConversations } from "./list-conversations.js";
import { LIST_CONVERSATIONS_MAX_LIMIT } from "./list-conversations.contract.js";
import { MODEL_TRACE_JSON_MAX } from "./record-assistant-turn.contract.js";
import { recordAssistantTurn } from "./record-assistant-turn.js";

const fixtures = {
  convA: randomUUID(),
  convB: randomUUID(),
  newest: randomUUID(),
  older: randomUUID(),
  appendIdempotent: randomUUID(),
  recordIdempotent: randomUUID(),
  recordIds: randomUUID(),
  modelTrace: randomUUID(),
  checkpoint: randomUUID(),
  checkpointIdempotent: randomUUID(),
  employee: randomUUID(),
};

const clerks = {
  denied: randomUUID(),
  employee: randomUUID(),
  lacking: randomUUID(),
};

const stamps = {
  newest: new Date("2026-04-01T00:00:00.000Z"),
  older: new Date("2026-03-01T00:00:00.000Z"),
  employee: new Date("2026-05-01T00:00:00.000Z"),
};

const orderId = randomUUID();
const challengeId = randomUUID();

function beginInput(
  conversationId: string,
  turnKey = `begin:${randomUUID()}`,
) {
  return { kind: "begin" as const, conversationId, turnKey };
}

let kit: TestKit;

function requireKit(): TestKit {
  return kit;
}

async function countConversations(companyId: string): Promise<number> {
  const rows = await kit.db.runtime.db
    .select({ id: assistantConversations.id })
    .from(assistantConversations)
    .where(eq(assistantConversations.companyId, companyId));
  return rows.length;
}

async function countMessages(conversationId: string): Promise<number> {
  const rows = await kit.db.runtime.db
    .select({ id: assistantMessages.id })
    .from(assistantMessages)
    .where(eq(assistantMessages.conversationId, conversationId));
  return rows.length;
}

async function countToolRuns(conversationId: string): Promise<number> {
  const rows = await kit.db.runtime.db
    .select({ id: assistantToolRuns.id })
    .from(assistantToolRuns)
    .where(eq(assistantToolRuns.conversationId, conversationId));
  return rows.length;
}

function notFoundWire(error: unknown): {
  readonly code: string;
  readonly clientMessage: string;
} {
  expect(error).toBeInstanceOf(NotFoundError);
  expect(error).not.toBeInstanceOf(PermissionDeniedError);
  if (!(error instanceof NotFoundError)) {
    throw error;
  }
  return { code: error.code, clientMessage: error.clientMessage };
}

async function invokeAsNotFound(
  invoke: Promise<unknown>,
  detail: string,
): Promise<{ readonly code: string; readonly clientMessage: string }> {
  return invoke.then(
    () => {
      throw new Error(`expected NotFoundError for ${detail}`);
    },
    (error: unknown) => notFoundWire(error),
  );
}

async function insertConversation(values: {
  id: string;
  companyId: string;
  userId: string;
  title?: string;
  createdAt?: Date;
  updatedAt?: Date;
}): Promise<void> {
  await kit.db.runtime.db.insert(assistantConversations).values({
    id: values.id,
    companyId: values.companyId,
    userId: values.userId,
    title: values.title,
    createdAt: values.createdAt,
    updatedAt: values.updatedAt,
  });
}

beforeAll(async () => {
  kit = await createTestKit();

  await insertConversation({
    id: fixtures.convA,
    companyId: kitIdentities.companies.a,
    userId: kitIdentities.users.anna,
    title: "Company A",
  });
  await insertConversation({
    id: fixtures.convB,
    companyId: kitIdentities.companies.b,
    userId: kitIdentities.users.boris,
    title: "Company B",
  });
  await insertConversation({
    id: fixtures.newest,
    companyId: kitIdentities.companies.a,
    userId: kitIdentities.users.anna,
    title: "Newest",
    createdAt: stamps.newest,
    updatedAt: stamps.newest,
  });
  await insertConversation({
    id: fixtures.older,
    companyId: kitIdentities.companies.a,
    userId: kitIdentities.users.anna,
    title: "Older",
    createdAt: stamps.older,
    updatedAt: stamps.older,
  });
  await insertConversation({
    id: fixtures.appendIdempotent,
    companyId: kitIdentities.companies.a,
    userId: kitIdentities.users.anna,
    title: "Append idempotent",
  });
  await insertConversation({
    id: fixtures.recordIdempotent,
    companyId: kitIdentities.companies.a,
    userId: kitIdentities.users.anna,
    title: "Record idempotent",
  });
  await insertConversation({
    id: fixtures.recordIds,
    companyId: kitIdentities.companies.a,
    userId: kitIdentities.users.anna,
    title: "Record ids",
  });
  await insertConversation({
    id: fixtures.modelTrace,
    companyId: kitIdentities.companies.a,
    userId: kitIdentities.users.anna,
    title: "Model trace",
  });
  await insertConversation({
    id: fixtures.checkpoint,
    companyId: kitIdentities.companies.a,
    userId: kitIdentities.users.anna,
    title: "Checkpoint",
  });
  await insertConversation({
    id: fixtures.checkpointIdempotent,
    companyId: kitIdentities.companies.a,
    userId: kitIdentities.users.anna,
    title: "Checkpoint idempotent",
  });

  await kit.db.runtime.db.insert(user).values([
    {
      id: clerks.denied,
      name: "Denied Clerk",
      email: "denied@assistant-kit.test",
    },
    {
      id: clerks.employee,
      name: "Employee Clerk",
      email: "employee@assistant-kit.test",
    },
    {
      id: clerks.lacking,
      name: "Lacking Clerk",
      email: "lacking@assistant-kit.test",
    },
  ]);
  await kit.db.runtime.db.insert(companyMembers).values([
    {
      companyId: kitIdentities.companies.a,
      userId: clerks.denied,
      role: "employee",
      permissions: { granted: [], denied: ["assistant:use"] },
    },
    {
      companyId: kitIdentities.companies.a,
      userId: clerks.employee,
      role: "employee",
      permissions: { granted: ["assistant:use"], denied: [] },
    },
    {
      companyId: kitIdentities.companies.a,
      userId: clerks.lacking,
      role: "employee",
      permissions: { granted: [], denied: [] },
    },
  ]);

  await insertConversation({
    id: fixtures.employee,
    companyId: kitIdentities.companies.a,
    userId: clerks.employee,
    title: "Employee thread",
    createdAt: stamps.employee,
    updatedAt: stamps.employee,
  });
});

afterAll(async () => {
  await kit.db.close();
});

crossTenantSuite(
  () => kit,
  [
    isolationCase(
      createConversation,
      { input: {} },
      {
        input: {},
        companyId: kitIdentities.companies.b,
        userId: kitIdentities.users.anna,
      },
    ),
    isolationCase(
      listConversations,
      { input: {} },
      {
        input: {},
        companyId: kitIdentities.companies.b,
        userId: kitIdentities.users.anna,
      },
    ),
    isolationCase(
      getConversation,
      { input: { conversationId: fixtures.convA } },
      { input: { conversationId: fixtures.convB } },
    ),
    isolationCase(
      getModelHistory,
      { input: { conversationId: fixtures.convA } },
      { input: { conversationId: fixtures.convB } },
    ),
    isolationCase(
      appendUserMessage,
      { input: { conversationId: fixtures.convA, body: "isolation append" } },
      { input: { conversationId: fixtures.convB, body: "isolation append" } },
    ),
    isolationCase(
      recordAssistantTurn,
      {
        input: {
          conversationId: fixtures.convA,
          body: "isolation record",
          toolRuns: [],
        },
      },
      {
        input: {
          conversationId: fixtures.convB,
          body: "isolation record",
          toolRuns: [],
        },
      },
    ),
    isolationCase(
      checkpointAssistantTurn,
      {
        input: beginInput(fixtures.convA, `begin:${fixtures.convA}`),
      },
      {
        input: beginInput(fixtures.convB, `begin:${fixtures.convB}`),
      },
    ),
    isolationCase(
      getStaffActor,
      { input: {} },
      {
        input: {},
        companyId: kitIdentities.companies.b,
        userId: kitIdentities.users.anna,
      },
    ),
  ],
);

idempotencySuite(requireKit, [
  {
    action: createConversation,
    input: {},
    conflictingInput: { title: "Conflict" },
    readEffect: () => countConversations(kitIdentities.companies.a),
  },
  {
    action: appendUserMessage,
    input: {
      conversationId: fixtures.appendIdempotent,
      body: "idempotent user",
    },
    conflictingInput: {
      conversationId: fixtures.appendIdempotent,
      body: "different user",
    },
    readEffect: () => countMessages(fixtures.appendIdempotent),
  },
  {
    action: recordAssistantTurn,
    input: {
      conversationId: fixtures.recordIdempotent,
      body: "idempotent assistant",
      toolRuns: [],
    },
    conflictingInput: {
      conversationId: fixtures.recordIdempotent,
      body: "different assistant",
      toolRuns: [],
    },
    readEffect: () => countMessages(fixtures.recordIdempotent),
  },
  {
    action: checkpointAssistantTurn,
    input: beginInput(
      fixtures.checkpointIdempotent,
      `begin:${fixtures.checkpointIdempotent}`,
    ),
    conflictingInput: beginInput(
      fixtures.checkpoint,
      `begin:${fixtures.checkpoint}`,
    ),
    readEffect: () => countMessages(fixtures.checkpointIdempotent),
  },
]);

describe("assistant staff conversation actions", () => {
  it("creates a conversation in the active company and writes hash-only audit", async () => {
    const requestId = randomUUID();
    const created = await kit.invoke(
      createConversation,
      { title: "Morning" },
      {},
      { request: { requestId } },
    );

    expect(created.title).toBe("Morning");
    expect(created.userId).toBe(kitIdentities.users.anna);
    expect(created).not.toHaveProperty("companyId");

    const row = (
      await kit.db.runtime.db
        .select()
        .from(assistantConversations)
        .where(eq(assistantConversations.id, created.id))
    )[0];
    expect(row?.companyId).toBe(kitIdentities.companies.a);
    expect(row?.userId).toBe(kitIdentities.users.anna);

    const auditRows = await kit.db.runtime.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.requestId, requestId));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: "assistant.createConversation",
      companyId: kitIdentities.companies.a,
      actorType: "user",
      actorId: kitIdentities.users.anna,
      targetType: "conversation",
      targetId: created.id,
      outcome: "ok",
      inputSnapshot: null,
    });
  });

  it("lists the author's conversations newest-updated-first and omits colleagues and company B", async () => {
    const result = await kit.invoke(listConversations, { limit: 50 });
    const ids = result.items.map((item) => item.id);
    expect(ids).toContain(fixtures.newest);
    expect(ids).toContain(fixtures.older);
    expect(ids).toContain(fixtures.convA);
    expect(ids).not.toContain(fixtures.convB);
    expect(ids).not.toContain(fixtures.employee);
    expect(ids.indexOf(fixtures.newest)).toBeLessThan(
      ids.indexOf(fixtures.older),
    );
    expect(
      result.items.every((item) => item.userId === kitIdentities.users.anna),
    ).toBe(true);
    expect(result.items[0]).not.toHaveProperty("companyId");
  });

  it("paginates with an updated-at/id cursor", async () => {
    const first = await kit.invoke(listConversations, { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await kit.invoke(listConversations, {
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.items.length).toBeGreaterThan(0);
    expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
  });

  it("gets messages and tool-run refs; missing and foreign are the same not-found", async () => {
    await kit.invoke(appendUserMessage, {
      conversationId: fixtures.newest,
      body: "Create an order",
    });
    await kit.invoke(recordAssistantTurn, {
      conversationId: fixtures.newest,
      body: "I will create it.",
      toolRuns: [
        {
          actionName: "orders.create",
          toolCallId: "call_get",
          resultIds: [orderId],
          outcome: "success",
        },
      ],
    });

    const detail = await kit.invoke(getConversation, {
      conversationId: fixtures.newest,
    });
    expect(detail.id).toBe(fixtures.newest);
    expect(detail.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(detail.messages[0]?.body).toBe("Create an order");
    expect(detail.toolRuns).toEqual([
      expect.objectContaining({
        actionName: "orders.create",
        toolCallId: "call_get",
        resultIds: [orderId],
        outcome: "success",
        challengeId: null,
      }),
    ]);
    expect(detail.toolRuns[0]).not.toHaveProperty("modelTrace");
    expect(detail.toolRuns[0]).not.toHaveProperty("toolInput");
    expect(JSON.stringify(detail)).not.toMatch(
      /modelTrace|model_trace|toolInput|tool_input/,
    );
    expect(detail).not.toHaveProperty("companyId");
    expect(JSON.stringify(detail.toolRuns)).not.toMatch(
      /confirmed|issued|paid|status/,
    );

    const missingId = randomUUID();
    const missingError = await kit
      .invoke(getConversation, { conversationId: missingId })
      .then(
        () => {
          throw new Error("expected NotFoundError for a missing conversation");
        },
        (error: unknown) => error,
      );
    const foreignError = await kit
      .invoke(getConversation, { conversationId: fixtures.convB })
      .then(
        () => {
          throw new Error("expected NotFoundError for a foreign conversation");
        },
        (error: unknown) => error,
      );
    expect(missingError).toBeInstanceOf(NotFoundError);
    expect(foreignError).toBeInstanceOf(NotFoundError);
    if (
      missingError instanceof NotFoundError &&
      foreignError instanceof NotFoundError
    ) {
      expect(missingError.clientMessage).toBe(foreignError.clientMessage);
    }
  });

  it("optional limit returns the newest messages in chronological order", async () => {
    const conversationId = randomUUID();
    await insertConversation({
      id: conversationId,
      companyId: kitIdentities.companies.a,
      userId: kitIdentities.users.anna,
      title: "Limit",
    });
    await kit.invoke(appendUserMessage, {
      conversationId,
      body: "oldest user",
    });
    await kit.invoke(recordAssistantTurn, {
      conversationId,
      body: "oldest assistant",
      toolRuns: [],
    });
    await kit.invoke(appendUserMessage, {
      conversationId,
      body: "newest user",
    });

    const unbounded = await kit.invoke(getConversation, { conversationId });
    expect(unbounded.messages.map((message) => message.body)).toEqual([
      "oldest user",
      "oldest assistant",
      "newest user",
    ]);

    const limited = await kit.invoke(getConversation, {
      conversationId,
      limit: 2,
    });
    expect(limited.messages.map((message) => message.body)).toEqual([
      "oldest assistant",
      "newest user",
    ]);
  });

  it("forces append role user and does not log the prompt body", async () => {
    const capturing = createCapturingLogger();
    const prompt = "Secret user prompt that must not hit logs";
    const appended = await kit.invoke(
      appendUserMessage,
      { conversationId: fixtures.older, body: prompt },
      {},
      { deps: { ...kit.pipeline, logger: capturing.logger } },
    );
    expect(appended.role).toBe("user");
    expect(appended.body).toBe(prompt);
    expect(appended.conversationId).toBe(fixtures.older);

    const row = (
      await kit.db.runtime.db
        .select()
        .from(assistantMessages)
        .where(eq(assistantMessages.id, appended.id))
    )[0];
    expect(row?.role).toBe("user");
    expect(row?.companyId).toBe(kitIdentities.companies.a);

    const logBlob = JSON.stringify(capturing.entries());
    expect(logBlob).not.toContain(prompt);
    expect(logBlob).toContain(appended.id);
  });

  it("append and record write hash-only audit without prompt bodies", async () => {
    const appendRequestId = randomUUID();
    const recordRequestId = randomUUID();
    const appendPrompt =
      "SECRET_APPEND_PROMPT_must_never_appear_in_audit_snapshot";
    const recordPrompt =
      "SECRET_RECORD_PROMPT_must_never_appear_in_audit_snapshot";

    const appended = await kit.invoke(
      appendUserMessage,
      { conversationId: fixtures.convA, body: appendPrompt },
      {},
      { request: { requestId: appendRequestId } },
    );

    const appendAudit = await kit.db.runtime.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.requestId, appendRequestId));
    expect(appendAudit).toHaveLength(1);
    expect(appendAudit[0]).toMatchObject({
      action: "assistant.appendUserMessage",
      companyId: kitIdentities.companies.a,
      actorType: "user",
      actorId: kitIdentities.users.anna,
      targetType: "conversation",
      targetId: appended.conversationId,
      outcome: "ok",
      inputSnapshot: null,
    });
    expect(JSON.stringify(appendAudit[0])).not.toContain(appendPrompt);

    const recorded = await kit.invoke(
      recordAssistantTurn,
      {
        conversationId: fixtures.convA,
        body: recordPrompt,
        toolRuns: [],
      },
      {},
      { request: { requestId: recordRequestId } },
    );

    const recordAudit = await kit.db.runtime.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.requestId, recordRequestId));
    expect(recordAudit).toHaveLength(1);
    expect(recordAudit[0]).toMatchObject({
      action: "assistant.recordAssistantTurn",
      companyId: kitIdentities.companies.a,
      actorType: "user",
      actorId: kitIdentities.users.anna,
      targetType: "conversation",
      targetId: recorded.conversationId,
      outcome: "ok",
      inputSnapshot: null,
    });
    expect(JSON.stringify(recordAudit[0])).not.toContain(recordPrompt);
  });

  it("recordAssistantTurn stores result ids and HITL outcome, not order status", async () => {
    const recorded = await kit.invoke(recordAssistantTurn, {
      conversationId: fixtures.recordIds,
      body: "Waiting on confirmation.",
      toolRuns: [
        {
          actionName: "customers.deleteCustomer",
          toolCallId: "call_hitl",
          challengeId,
          resultIds: [],
          outcome: "confirmation_required",
        },
        {
          actionName: "orders.create",
          toolCallId: "call_ok",
          resultIds: [orderId],
          outcome: "success",
        },
      ],
    });

    expect(recorded.conversationId).toBe(fixtures.recordIds);
    expect(recorded.toolRuns.map((run) => run.outcome).toSorted()).toEqual([
      "confirmation_required",
      "success",
    ]);
    expect(recorded).not.toHaveProperty("status");

    const rows = await kit.db.runtime.db
      .select()
      .from(assistantToolRuns)
      .where(
        and(
          eq(assistantToolRuns.companyId, kitIdentities.companies.a),
          eq(assistantToolRuns.conversationId, fixtures.recordIds),
        ),
      );
    expect(rows).toHaveLength(2);
    const hitl = rows.find((row) => row.toolCallId === "call_hitl");
    const created = rows.find((row) => row.toolCallId === "call_ok");
    expect(hitl).toMatchObject({
      actionName: "customers.deleteCustomer",
      challengeId,
      resultIds: [],
      outcome: "confirmation_required",
    });
    expect(created).toMatchObject({
      actionName: "orders.create",
      resultIds: [orderId],
      outcome: "success",
    });
    expect(hitl).not.toHaveProperty("status");
    expect(hitl?.modelTrace).toBeNull();
    expect(created?.modelTrace).toBeNull();
    expect(JSON.stringify(rows)).not.toMatch(/confirmed|issued|paid/);

    const confirmationMessage = (
      await kit.db.runtime.db
        .select()
        .from(assistantMessages)
        .where(eq(assistantMessages.id, recorded.messageId))
    )[0];
    expect(confirmationMessage?.role).toBe("assistant");
    expect(confirmationMessage?.body).toBe("Waiting on confirmation.");
  });

  it("recordAssistantTurn stores choice_required using the same challengeId", async () => {
    const conversation = await kit.invoke(createConversation, {
      title: "Choice HITL",
    });
    const recorded = await kit.invoke(recordAssistantTurn, {
      conversationId: conversation.id,
      body: "Pick a variant.",
      toolRuns: [
        {
          actionName: "orders.create",
          toolCallId: "call_choice",
          challengeId,
          resultIds: [],
          outcome: "choice_required",
        },
      ],
    });
    expect(recorded.toolRuns).toHaveLength(1);
    expect(recorded.toolRuns[0]).toMatchObject({
      actionName: "orders.create",
      toolCallId: "call_choice",
      challengeId,
      resultIds: [],
      outcome: "choice_required",
    });
    const rows = await kit.db.runtime.db
      .select()
      .from(assistantToolRuns)
      .where(
        and(
          eq(assistantToolRuns.companyId, kitIdentities.companies.a),
          eq(assistantToolRuns.conversationId, conversation.id),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      challengeId,
      outcome: "choice_required",
      modelTrace: null,
    });

    const message = (
      await kit.db.runtime.db
        .select()
        .from(assistantMessages)
        .where(eq(assistantMessages.id, recorded.messageId))
    )[0];
    expect(message?.role).toBe("assistant");
    expect(message?.body).toBe("Pick a variant.");
  });

  it("getStaffActor returns owner role with owner-all intact and stored employee permissions", async () => {
    const owner = await kit.invoke(getStaffActor, {});
    expect(owner.role).toBe("owner");
    expect(owner.permissions).not.toContain("assistant:use");
    expect(staffHasPermission(owner, "assistant:use")).toBe(true);
    expect(staffHasPermission(owner, "orders.create")).toBe(true);

    const employee = await kit.invoke(
      getStaffActor,
      {},
      { userId: clerks.employee, companyId: kitIdentities.companies.a },
    );
    expect(employee.role).toBe("employee");
    expect(employee.permissions).toContain("assistant:use");
    expect(staffHasPermission(employee, "assistant:use")).toBe(true);
    expect(staffHasPermission(employee, "files:upload")).toBe(false);
  });

  it("denies an employee with assistant:use deny override or a membership lacking the key", async () => {
    const denied = {
      userId: clerks.denied,
      companyId: kitIdentities.companies.a,
    };
    const lacking = {
      userId: clerks.lacking,
      companyId: kitIdentities.companies.a,
    };
    await expect(
      kit.invoke(createConversation, {}, denied),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      kit.invoke(listConversations, {}, denied),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      kit.invoke(getConversation, { conversationId: fixtures.convA }, denied),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      kit.invoke(getModelHistory, { conversationId: fixtures.convA }, denied),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      kit.invoke(
        appendUserMessage,
        { conversationId: fixtures.convA, body: "nope" },
        denied,
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      kit.invoke(
        recordAssistantTurn,
        { conversationId: fixtures.convA, body: "nope", toolRuns: [] },
        denied,
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      kit.invoke(
        checkpointAssistantTurn,
        beginInput(fixtures.convA),
        denied,
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(kit.invoke(getStaffActor, {}, denied)).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
    await expect(kit.invoke(getStaffActor, {}, lacking)).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
  });

  it("rejects validation failures on write and list inputs", async () => {
    await expect(
      kit.invoke(createConversation, {
        title: "x".repeat(201),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      kit.invoke(appendUserMessage, {
        conversationId: fixtures.convA,
        body: "",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      kit.invoke(getConversation, { conversationId: "not-a-uuid" }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      kit.invoke(getModelHistory, { conversationId: "not-a-uuid" }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      kit.invoke(listConversations, {
        limit: LIST_CONVERSATIONS_MAX_LIMIT + 1,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      kit.invoke(recordAssistantTurn, {
        conversationId: fixtures.convA,
        body: "x",
        toolRuns: [
          {
            actionName: "orders.create",
            toolCallId: "call_bad",
            outcome: "issued",
          },
        ],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      kit.invoke(recordAssistantTurn, {
        conversationId: fixtures.convA,
        body: "x",
        toolRuns: [
          {
            actionName: "orders.list",
            toolCallId: "call_huge",
            outcome: "success",
            modelTrace: { pad: "x".repeat(MODEL_TRACE_JSON_MAX) },
          },
        ],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      kit.invoke(checkpointAssistantTurn, {
        conversationId: fixtures.convA,
        body: "Done.",
        toolRuns: [],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      kit.invoke(checkpointAssistantTurn, {
        kind: "stageRun",
        conversationId: fixtures.convA,
        messageId: fixtures.convA,
        seq: 0,
        actionName: "orders.list",
        toolName: "orders_list_page",
        toolCallId: "call_huge",
        toolInput: { pad: "x".repeat(MODEL_TRACE_JSON_MAX) },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("append and record of a foreign conversation are not-found", async () => {
    await expect(
      kit.invoke(appendUserMessage, {
        conversationId: fixtures.convB,
        body: "hello",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      kit.invoke(recordAssistantTurn, {
        conversationId: fixtures.convB,
        body: "hello",
        toolRuns: [],
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await countMessages(fixtures.convB)).toBe(0);
    expect(await countToolRuns(fixtures.convB)).toBe(0);
  });

  it("a colleague with assistant:use gets the same not-found as a foreign company", async () => {
    const colleague = {
      userId: clerks.employee,
      companyId: kitIdentities.companies.a,
    };
    const colleagueGet = await invokeAsNotFound(
      kit.invoke(
        getConversation,
        { conversationId: fixtures.convA },
        colleague,
      ),
      "colleague getConversation of another author's id",
    );
    const foreignGet = await invokeAsNotFound(
      kit.invoke(
        getConversation,
        { conversationId: fixtures.convB },
        colleague,
      ),
      "colleague getConversation of a foreign-company id",
    );
    expect(colleagueGet).toEqual(foreignGet);

    const colleagueAppend = await invokeAsNotFound(
      kit.invoke(
        appendUserMessage,
        { conversationId: fixtures.convA, body: "peer append" },
        colleague,
      ),
      "colleague appendUserMessage into another author's thread",
    );
    const foreignAppend = await invokeAsNotFound(
      kit.invoke(
        appendUserMessage,
        { conversationId: fixtures.convB, body: "peer append" },
        colleague,
      ),
      "colleague appendUserMessage into a foreign-company thread",
    );
    expect(colleagueAppend).toEqual(foreignAppend);

    const colleagueRecord = await invokeAsNotFound(
      kit.invoke(
        recordAssistantTurn,
        {
          conversationId: fixtures.convA,
          body: "peer record",
          toolRuns: [],
        },
        colleague,
      ),
      "colleague recordAssistantTurn into another author's thread",
    );
    const foreignRecord = await invokeAsNotFound(
      kit.invoke(
        recordAssistantTurn,
        {
          conversationId: fixtures.convB,
          body: "peer record",
          toolRuns: [],
        },
        colleague,
      ),
      "colleague recordAssistantTurn into a foreign-company thread",
    );
    expect(colleagueRecord).toEqual(foreignRecord);

    const colleagueHistory = await invokeAsNotFound(
      kit.invoke(
        getModelHistory,
        { conversationId: fixtures.convA },
        colleague,
      ),
      "colleague getModelHistory of another author's id",
    );
    const foreignHistory = await invokeAsNotFound(
      kit.invoke(
        getModelHistory,
        { conversationId: fixtures.convB },
        colleague,
      ),
      "colleague getModelHistory of a foreign-company id",
    );
    expect(colleagueHistory).toEqual(foreignHistory);

    const colleagueBegin = await invokeAsNotFound(
      kit.invoke(
        checkpointAssistantTurn,
        beginInput(fixtures.convA),
        colleague,
      ),
      "colleague checkpointAssistantTurn begin on another author's thread",
    );
    const foreignBegin = await invokeAsNotFound(
      kit.invoke(
        checkpointAssistantTurn,
        beginInput(fixtures.convB),
        colleague,
      ),
      "colleague checkpointAssistantTurn begin on a foreign-company thread",
    );
    expect(colleagueBegin).toEqual(foreignBegin);

    const authorBegin = await kit.invoke(
      checkpointAssistantTurn,
      beginInput(fixtures.convA),
    );
    const authorStaged = await kit.invoke(checkpointAssistantTurn, {
      kind: "stageRun",
      conversationId: fixtures.convA,
      messageId: authorBegin.messageId,
      seq: 0,
      actionName: "orders.list",
      toolName: "orders_list_page",
      toolCallId: "call_colleague_author",
      toolInput: { limit: 1 },
    });
    const foreignAuthorBegin = await kit.invoke(
      checkpointAssistantTurn,
      beginInput(fixtures.convB),
      {
        companyId: kitIdentities.companies.b,
        userId: kitIdentities.users.boris,
      },
    );
    const foreignAuthorStaged = await kit.invoke(
      checkpointAssistantTurn,
      {
        kind: "stageRun",
        conversationId: fixtures.convB,
        messageId: foreignAuthorBegin.messageId,
        seq: 0,
        actionName: "orders.list",
        toolName: "orders_list_page",
        toolCallId: "call_colleague_foreign",
        toolInput: { limit: 1 },
      },
      {
        companyId: kitIdentities.companies.b,
        userId: kitIdentities.users.boris,
      },
    );
    const colleagueFinish = await invokeAsNotFound(
      kit.invoke(
        checkpointAssistantTurn,
        {
          kind: "finishRun",
          conversationId: fixtures.convA,
          executionId: authorStaged.executionId ?? "",
          outcome: "success",
        },
        colleague,
      ),
      "colleague checkpointAssistantTurn finishRun with the author's executionId",
    );
    const foreignFinish = await invokeAsNotFound(
      kit.invoke(
        checkpointAssistantTurn,
        {
          kind: "finishRun",
          conversationId: fixtures.convB,
          executionId: foreignAuthorStaged.executionId ?? "",
          outcome: "success",
        },
        colleague,
      ),
      "colleague checkpointAssistantTurn finishRun with a foreign-company executionId",
    );
    expect(colleagueFinish).toEqual(foreignFinish);
  });

  it("listConversations for a colleague omits the author's rows and leaves the author's page intact", async () => {
    const colleague = {
      userId: clerks.employee,
      companyId: kitIdentities.companies.a,
    };
    const authorFirst = await kit.invoke(listConversations, { limit: 2 });
    const authorIds = new Set(
      (await kit.invoke(listConversations, { limit: 50 })).items.map(
        (item) => item.id,
      ),
    );
    const colleaguePage = await kit.invoke(
      listConversations,
      { limit: 50 },
      colleague,
    );

    expect(colleaguePage.items.map((item) => item.id)).toContain(
      fixtures.employee,
    );
    expect(colleaguePage.items.map((item) => item.id)).not.toContain(
      fixtures.convA,
    );
    expect(colleaguePage.items.map((item) => item.id)).not.toContain(
      fixtures.newest,
    );
    expect(
      colleaguePage.items.every((item) => item.userId === clerks.employee),
    ).toBe(true);
    expect(authorIds.has(fixtures.employee)).toBe(false);
    expect(authorIds.has(fixtures.newest)).toBe(true);

    const authorFirstAgain = await kit.invoke(listConversations, {
      limit: 2,
    });
    expect(authorFirstAgain.items.map((item) => item.id)).toEqual(
      authorFirst.items.map((item) => item.id),
    );
    expect(authorFirstAgain.nextCursor).toBe(authorFirst.nextCursor);
  });

  it("the company owner gets the same not-found on an employee's conversation", async () => {
    const ownerGet = await invokeAsNotFound(
      kit.invoke(getConversation, { conversationId: fixtures.employee }),
      "owner getConversation of an employee's id",
    );
    const foreignGet = await invokeAsNotFound(
      kit.invoke(getConversation, { conversationId: fixtures.convB }),
      "owner getConversation of a foreign-company id",
    );
    expect(ownerGet).toEqual(foreignGet);

    const listed = await kit.invoke(listConversations, { limit: 50 });
    expect(listed.items.map((item) => item.id)).not.toContain(
      fixtures.employee,
    );

    await expect(
      kit.invoke(appendUserMessage, {
        conversationId: fixtures.employee,
        body: "owner append",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      kit.invoke(recordAssistantTurn, {
        conversationId: fixtures.employee,
        body: "owner record",
        toolRuns: [],
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    const ownerHistory = await invokeAsNotFound(
      kit.invoke(getModelHistory, { conversationId: fixtures.employee }),
      "owner getModelHistory of an employee's id",
    );
    expect(ownerHistory).toEqual(foreignGet);

    const ownerBegin = await invokeAsNotFound(
      kit.invoke(checkpointAssistantTurn, beginInput(fixtures.employee)),
      "owner checkpointAssistantTurn begin on an employee's thread",
    );
    const foreignBegin = await invokeAsNotFound(
      kit.invoke(checkpointAssistantTurn, beginInput(fixtures.convB)),
      "owner checkpointAssistantTurn begin on a foreign-company thread",
    );
    expect(ownerBegin).toEqual(foreignBegin);

    const employeeBegin = await kit.invoke(
      checkpointAssistantTurn,
      beginInput(fixtures.employee),
      {
        userId: clerks.employee,
        companyId: kitIdentities.companies.a,
      },
    );
    const employeeStaged = await kit.invoke(
      checkpointAssistantTurn,
      {
        kind: "stageRun",
        conversationId: fixtures.employee,
        messageId: employeeBegin.messageId,
        seq: 0,
        actionName: "orders.list",
        toolName: "orders_list_page",
        toolCallId: "call_owner_employee",
        toolInput: { limit: 1 },
      },
      {
        userId: clerks.employee,
        companyId: kitIdentities.companies.a,
      },
    );
    const foreignAuthorBegin = await kit.invoke(
      checkpointAssistantTurn,
      beginInput(fixtures.convB),
      {
        companyId: kitIdentities.companies.b,
        userId: kitIdentities.users.boris,
      },
    );
    const foreignAuthorStaged = await kit.invoke(
      checkpointAssistantTurn,
      {
        kind: "stageRun",
        conversationId: fixtures.convB,
        messageId: foreignAuthorBegin.messageId,
        seq: 0,
        actionName: "orders.list",
        toolName: "orders_list_page",
        toolCallId: "call_owner_foreign",
        toolInput: { limit: 1 },
      },
      {
        companyId: kitIdentities.companies.b,
        userId: kitIdentities.users.boris,
      },
    );
    const ownerFinish = await invokeAsNotFound(
      kit.invoke(checkpointAssistantTurn, {
        kind: "finishRun",
        conversationId: fixtures.employee,
        executionId: employeeStaged.executionId ?? "",
        outcome: "success",
      }),
      "owner checkpointAssistantTurn finishRun with the employee's executionId",
    );
    const foreignFinish = await invokeAsNotFound(
      kit.invoke(checkpointAssistantTurn, {
        kind: "finishRun",
        conversationId: fixtures.convB,
        executionId: foreignAuthorStaged.executionId ?? "",
        outcome: "success",
      }),
      "owner checkpointAssistantTurn finishRun with a foreign-company executionId",
    );
    expect(ownerFinish).toEqual(foreignFinish);
  });

  it("an employee still creates, lists, gets, appends, and records their own", async () => {
    const colleague = {
      userId: clerks.employee,
      companyId: kitIdentities.companies.a,
    };
    const created = await kit.invoke(
      createConversation,
      { title: "Employee own" },
      colleague,
    );
    expect(created.userId).toBe(clerks.employee);

    const listed = await kit.invoke(
      listConversations,
      { limit: 50 },
      colleague,
    );
    expect(listed.items.map((item) => item.id)).toEqual(
      expect.arrayContaining([created.id, fixtures.employee]),
    );
    expect(listed.items.every((item) => item.userId === clerks.employee)).toBe(
      true,
    );

    const appended = await kit.invoke(
      appendUserMessage,
      { conversationId: created.id, body: "my prompt" },
      colleague,
    );
    expect(appended.role).toBe("user");

    const recorded = await kit.invoke(
      recordAssistantTurn,
      {
        conversationId: created.id,
        body: "my reply",
        toolRuns: [],
      },
      colleague,
    );
    expect(recorded.conversationId).toBe(created.id);

    const detail = await kit.invoke(
      getConversation,
      { conversationId: created.id },
      colleague,
    );
    expect(detail.messages.map((message) => message.body)).toEqual([
      "my prompt",
      "my reply",
    ]);
    const ownHistory = await kit.invoke(
      getModelHistory,
      { conversationId: created.id },
      colleague,
    );
    expect(ownHistory.conversationId).toBe(created.id);
    expect(ownHistory.messages.map((message) => message.text)).toEqual([
      "my prompt",
      "my reply",
    ]);
  });

  it("persists post-clip modelTrace on success and returns it only from getModelHistory", async () => {
    const trace = {
      kind: "page.summary",
      rows: [{ orderId: orderId, orderNumber: "12", name: "Катя" }],
    };
    const recorded = await kit.invoke(recordAssistantTurn, {
      conversationId: fixtures.modelTrace,
      body: "Here are the last orders.",
      toolRuns: [
        {
          actionName: "orders.list",
          toolCallId: "call_trace",
          resultIds: [orderId],
          outcome: "success",
          toolName: "orders_list_page",
          modelTrace: trace,
        },
      ],
    });
    const clientView = await kit.invoke(getConversation, {
      conversationId: fixtures.modelTrace,
    });
    const history = await kit.invoke(getModelHistory, {
      conversationId: fixtures.modelTrace,
    });

    expect(recorded.toolRuns[0]).toEqual(
      expect.objectContaining({
        actionName: "orders.list",
        toolCallId: "call_trace",
        resultIds: [orderId],
        outcome: "success",
      }),
    );
    expect(recorded.toolRuns[0]).not.toHaveProperty("modelTrace");
    expect(JSON.stringify(clientView)).not.toMatch(
      /modelTrace|model_trace|toolInput|tool_input/,
    );
    expect(clientView.toolRuns[0]).not.toHaveProperty("modelTrace");
    const lastAssistant = history.messages.findLast(
      (row) => row.role === "assistant",
    );
    expect(lastAssistant?.text).toBe("Here are the last orders.");
    expect(lastAssistant?.toolRuns).toEqual([
      {
        action: "orders.list",
        toolCallId: "call_trace",
        toolName: "orders_list_page",
        modelTrace: trace,
        toolInput: null,
        seq: null,
        executionId: null,
        outcome: "success",
      },
    ]);
  });

  it("does not persist modelTrace for confirmation_required, choice_required, or error", async () => {
    const conversation = await kit.invoke(createConversation, {
      title: "No HITL trace",
    });
    await kit.invoke(recordAssistantTurn, {
      conversationId: conversation.id,
      body: "Need a choice.",
      toolRuns: [
        {
          actionName: "orders.confirm",
          toolCallId: "call_confirm",
          outcome: "confirmation_required",
          modelTrace: { shouldNotStore: true },
        },
        {
          actionName: "orders.create",
          toolCallId: "call_choice_drop",
          challengeId,
          outcome: "choice_required",
          modelTrace: { alsoDrop: true },
        },
        {
          actionName: "catalog.listProducts",
          toolCallId: "call_err_drop",
          outcome: "error",
          modelTrace: { dropError: true },
        },
      ],
    });
    const stored = await kit.db.runtime.db
      .select()
      .from(assistantToolRuns)
      .where(
        and(
          eq(assistantToolRuns.companyId, kitIdentities.companies.a),
          eq(assistantToolRuns.conversationId, conversation.id),
        ),
      );
    expect(stored).toHaveLength(3);
    expect(stored.every((row) => row.modelTrace === null)).toBe(true);

    const history = await kit.invoke(getModelHistory, {
      conversationId: conversation.id,
    });
    const lastAssistant = history.messages.findLast(
      (row) => row.role === "assistant",
    );
    expect(lastAssistant?.toolRuns).toHaveLength(3);
    expect(lastAssistant?.toolRuns).toEqual(
      expect.arrayContaining([
        {
          action: "orders.confirm",
          toolCallId: "call_confirm",
          toolName: null,
          modelTrace: null,
          toolInput: null,
          seq: null,
          executionId: null,
          outcome: "confirmation_required",
        },
        {
          action: "orders.create",
          toolCallId: "call_choice_drop",
          toolName: null,
          modelTrace: null,
          toolInput: null,
          seq: null,
          executionId: null,
          outcome: "choice_required",
        },
        {
          action: "catalog.listProducts",
          toolCallId: "call_err_drop",
          toolName: null,
          modelTrace: null,
          toolInput: null,
          seq: null,
          executionId: null,
          outcome: "error",
        },
      ]),
    );
  });

  it("keeps each turn's runs on its own message across a confirmation resume", async () => {
    // A confirmation resume records a second assistant turn with no user
    // message between the two, so the run/message join cannot use "the next
    // row of any role" as its upper bound.
    const conversation = await kit.invoke(createConversation, {
      title: "HITL resume trace",
    });
    await kit.invoke(appendUserMessage, {
      conversationId: conversation.id,
      body: "видали клієнта",
    });
    await kit.invoke(recordAssistantTurn, {
      conversationId: conversation.id,
      body: "Підтвердьте видалення.",
      toolRuns: [
        {
          actionName: "customers.deleteCustomer",
          toolCallId: "call_pause",
          challengeId,
          outcome: "confirmation_required",
        },
      ],
    });
    await kit.invoke(recordAssistantTurn, {
      conversationId: conversation.id,
      body: "Видалив.",
      toolRuns: [
        {
          actionName: "customers.deleteCustomer",
          toolCallId: "call_resumed",
          resultIds: [],
          outcome: "success",
          toolName: "customers_delete_customer",
          modelTrace: { deleted: true },
        },
      ],
    });

    const history = await kit.invoke(getModelHistory, {
      conversationId: conversation.id,
    });
    const assistants = history.messages.filter(
      (message) => message.role === "assistant",
    );
    expect(assistants).toHaveLength(2);
    expect(assistants[0]?.toolRuns.map((run) => run.toolCallId)).toEqual([
      "call_pause",
    ]);
    expect(assistants[1]?.toolRuns).toEqual([
      {
        action: "customers.deleteCustomer",
        toolCallId: "call_resumed",
        toolName: "customers_delete_customer",
        modelTrace: { deleted: true },
        toolInput: null,
        seq: null,
        executionId: null,
        outcome: "success",
      },
    ]);
  });

  it("keeps runs recorded with the oldest windowed message", async () => {
    // The run read is scoped to the windowed message ids, so the oldest
    // message in the window must still bring its own runs.
    const conversation = await kit.invoke(createConversation, {
      title: "Window boundary trace",
    });
    await kit.invoke(recordAssistantTurn, {
      conversationId: conversation.id,
      body: "перший список",
      toolRuns: [
        {
          actionName: "orders.list",
          toolCallId: "call_window_start",
          resultIds: [orderId],
          outcome: "success",
          toolName: "orders_list_page",
          modelTrace: { kind: "page.summary", rows: [{ orderNumber: "1" }] },
        },
      ],
    });
    for (let index = 0; index < 3; index += 1) {
      await kit.invoke(appendUserMessage, {
        conversationId: conversation.id,
        body: `user-${String(index)}`,
      });
      await kit.invoke(recordAssistantTurn, {
        conversationId: conversation.id,
        body: `assistant-${String(index)}`,
        toolRuns: [],
      });
    }

    const history = await kit.invoke(getModelHistory, {
      conversationId: conversation.id,
    });
    expect(history.messages[0]?.text).toBe("перший список");
    expect(history.messages[0]?.toolRuns).toEqual([
      {
        action: "orders.list",
        toolCallId: "call_window_start",
        toolName: "orders_list_page",
        modelTrace: { kind: "page.summary", rows: [{ orderNumber: "1" }] },
        toolInput: null,
        seq: null,
        executionId: null,
        outcome: "success",
      },
    ]);
  });

  it("windows getModelHistory to the newest 8 messages", async () => {
    const conversation = await kit.invoke(createConversation, {
      title: "History window",
    });
    for (let index = 0; index < 5; index += 1) {
      await kit.invoke(appendUserMessage, {
        conversationId: conversation.id,
        body: `user-${String(index)}`,
      });
      await kit.invoke(recordAssistantTurn, {
        conversationId: conversation.id,
        body: `assistant-${String(index)}`,
        toolRuns: [],
      });
    }
    const history = await kit.invoke(getModelHistory, {
      conversationId: conversation.id,
    });
    expect(history.messages).toHaveLength(8);
    expect(history.messages.map((message) => message.text)).toEqual([
      "user-1",
      "assistant-1",
      "user-2",
      "assistant-2",
      "user-3",
      "assistant-3",
      "user-4",
      "assistant-4",
    ]);
  });

  it("lists unfinished started runs outside the 8-message prompt window", async () => {
    const conversation = await kit.invoke(createConversation, {
      title: "Unfinished outside window",
    });
    const begun = await kit.invoke(
      checkpointAssistantTurn,
      beginInput(conversation.id),
    );
    const staged = await kit.invoke(checkpointAssistantTurn, {
      kind: "stageRun",
      conversationId: conversation.id,
      messageId: begun.messageId,
      seq: 0,
      actionName: "orders.list",
      toolName: "orders_list_page",
      toolCallId: "call_old_started",
      toolInput: { limit: 3 },
    });
    for (let index = 0; index < 8; index += 1) {
      await kit.invoke(appendUserMessage, {
        conversationId: conversation.id,
        body: `pad-user-${String(index)}`,
      });
    }
    const history = await kit.invoke(getModelHistory, {
      conversationId: conversation.id,
    });
    expect(history.messages).toHaveLength(8);
    expect(
      history.messages.some((message) => message.id === begun.messageId),
    ).toBe(false);
    expect(history.unfinishedStartedRuns).toEqual([
      {
        messageId: begun.messageId,
        turnKey: begun.turnKey,
        executionId: staged.executionId,
        seq: 0,
        action: "orders.list",
        toolName: "orders_list_page",
        toolCallId: "call_old_started",
        toolInput: { limit: 3 },
      },
    ]);
    expect(history.checkpointTurns).toEqual([
      {
        messageId: begun.messageId,
        turnKey: begun.turnKey,
        hasSpeech: false,
      },
    ]);
  });

  it("lists unfinished started runs whose message turnKey is null", async () => {
    const conversation = await kit.invoke(createConversation, {
      title: "Legacy null turnKey",
    });
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
      throw new Error("legacy assistant insert returned no row");
    }
    const staged = await kit.invoke(checkpointAssistantTurn, {
      kind: "stageRun",
      conversationId: conversation.id,
      messageId: inserted.id,
      seq: 0,
      actionName: "orders.create",
      toolName: "orders_create",
      toolCallId: "call_legacy_null",
      toolInput: { customerId: orderId },
    });
    const history = await kit.invoke(getModelHistory, {
      conversationId: conversation.id,
    });
    expect(history.unfinishedStartedRuns).toEqual([
      {
        messageId: inserted.id,
        turnKey: null,
        executionId: staged.executionId,
        seq: 0,
        action: "orders.create",
        toolName: "orders_create",
        toolCallId: "call_legacy_null",
        toolInput: { customerId: orderId },
      },
    ]);
    expect(history.checkpointTurns).toEqual([]);
    const open = history.messages.find((row) => row.id === inserted.id);
    expect(open?.turnKey).toBeNull();
  });

  it("begin then two stage/finish then complete is one assistant message in seq order", async () => {
    const conversation = await kit.invoke(createConversation, {
      title: "Checkpoint one message",
    });
    await kit.invoke(appendUserMessage, {
      conversationId: conversation.id,
      body: "List then get",
    });
    const begun = await kit.invoke(checkpointAssistantTurn,
      beginInput(conversation.id));
    const first = await kit.invoke(checkpointAssistantTurn, {
      kind: "stageRun",
      conversationId: conversation.id,
      messageId: begun.messageId,
      seq: 0,
      actionName: "orders.list",
      toolName: "orders_list_page",
      toolCallId: "call_list",
      toolInput: { limit: 20, query: "Леха" },
    });
    await kit.invoke(checkpointAssistantTurn, {
      kind: "finishRun",
      conversationId: conversation.id,
      executionId: first.executionId ?? "",
      outcome: "success",
      resultIds: [orderId],
      modelTrace: { kind: "page.summary", rows: [{ orderNumber: "12" }] },
    });
    const second = await kit.invoke(checkpointAssistantTurn, {
      kind: "stageRun",
      conversationId: conversation.id,
      messageId: begun.messageId,
      seq: 1,
      actionName: "orders.get",
      toolName: "orders_get",
      toolCallId: "call_get",
      toolInput: { id: orderId },
    });
    await kit.invoke(checkpointAssistantTurn, {
      kind: "finishRun",
      conversationId: conversation.id,
      executionId: second.executionId ?? "",
      outcome: "success",
      resultIds: [orderId],
      modelTrace: { orderNumber: "12" },
    });
    const completed = await kit.invoke(checkpointAssistantTurn, {
      kind: "complete",
      conversationId: conversation.id,
      messageId: begun.messageId,
      body: "Here they are.",
    });
    expect(completed.messageId).toBe(begun.messageId);
    expect(begun.turnKey).toEqual(expect.stringMatching(/^begin:/));
    expect(completed.turnKey).toBe(begun.turnKey);

    const messages = await kit.db.runtime.db
      .select()
      .from(assistantMessages)
      .where(
        and(
          eq(assistantMessages.companyId, kitIdentities.companies.a),
          eq(assistantMessages.conversationId, conversation.id),
          eq(assistantMessages.role, "assistant"),
        ),
      );
    expect(messages).toHaveLength(1);
    expect(messages[0]?.id).toBe(begun.messageId);
    expect(messages[0]?.body).toBe("Here they are.");
    expect(messages[0]?.turnKey).toBe(begun.turnKey);

    const history = await kit.invoke(getModelHistory, {
      conversationId: conversation.id,
    });
    const lastAssistant = history.messages.findLast(
      (row) => row.role === "assistant",
    );
    expect(lastAssistant?.id).toBe(begun.messageId);
    expect(lastAssistant?.turnKey).toBe(begun.turnKey);
    expect(history.checkpointTurns).toEqual([
      {
        messageId: begun.messageId,
        turnKey: begun.turnKey,
        hasSpeech: true,
      },
    ]);
    const sameBegin = await kit.invoke(
      checkpointAssistantTurn,
      beginInput(conversation.id, begun.turnKey ?? ""),
    );
    expect(sameBegin.messageId).toBe(begun.messageId);
    expect(sameBegin.turnKey).toBe(begun.turnKey);
    expect(lastAssistant?.toolRuns.map((run) => run.seq)).toEqual([0, 1]);
    expect(lastAssistant?.toolRuns[0]?.toolInput).toEqual({
      limit: 20,
      query: "Леха",
    });
    expect(lastAssistant?.toolRuns[0]?.toolInput).not.toEqual({});
    expect(lastAssistant?.toolRuns[1]?.toolInput).toEqual({ id: orderId });

    const secondTurn = await kit.invoke(checkpointAssistantTurn,
      beginInput(conversation.id));
    await kit.invoke(checkpointAssistantTurn, {
      kind: "complete",
      conversationId: conversation.id,
      messageId: secondTurn.messageId,
      body: "A new turn.",
    });
    expect(secondTurn.messageId).not.toBe(begun.messageId);
    const assistants = await kit.db.runtime.db
      .select()
      .from(assistantMessages)
      .where(
        and(
          eq(assistantMessages.companyId, kitIdentities.companies.a),
          eq(assistantMessages.conversationId, conversation.id),
          eq(assistantMessages.role, "assistant"),
        ),
      );
    expect(assistants).toHaveLength(2);
    expect(assistants.map((row) => row.id).toSorted()).toEqual(
      [begun.messageId, secondTurn.messageId].toSorted(),
    );
  });

  it("HTTP retry of stageRun loads the staged row and does not mint a second execution_id", async () => {
    const conversation = await kit.invoke(createConversation, {
      title: "Stage retry",
    });
    const begun = await kit.invoke(checkpointAssistantTurn,
      beginInput(conversation.id));
    const staged = await kit.invoke(checkpointAssistantTurn, {
      kind: "stageRun",
      conversationId: conversation.id,
      messageId: begun.messageId,
      seq: 0,
      actionName: "orders.list",
      toolName: "orders_list_page",
      toolCallId: "call_retry",
      toolInput: { limit: 7 },
    });
    const retried = await kit.invoke(checkpointAssistantTurn, {
      kind: "stageRun",
      conversationId: conversation.id,
      messageId: begun.messageId,
      seq: 0,
      actionName: "orders.list",
      toolName: "orders_list_page",
      toolCallId: "call_retry",
      toolInput: { limit: 7 },
    });
    expect(retried.executionId).toBe(staged.executionId);
    expect(retried.toolRunId).toBe(staged.toolRunId);
    expect(await countToolRuns(conversation.id)).toBe(1);
  });

  it("omits started runs and empty-body messages from getConversation", async () => {
    const conversation = await kit.invoke(createConversation, {
      title: "Open checkpoint turn",
    });
    const begun = await kit.invoke(checkpointAssistantTurn,
      beginInput(conversation.id));
    const staged = await kit.invoke(checkpointAssistantTurn, {
      kind: "stageRun",
      conversationId: conversation.id,
      messageId: begun.messageId,
      seq: 0,
      actionName: "orders.list",
      toolName: "orders_list_page",
      toolCallId: "call_open",
      toolInput: { limit: 5 },
    });
    const clientView = await kit.invoke(getConversation, {
      conversationId: conversation.id,
    });
    expect(clientView.messages.map((message) => message.id)).not.toContain(
      begun.messageId,
    );
    expect(clientView.toolRuns).toEqual([]);
    expect(JSON.stringify(clientView)).not.toMatch(
      /modelTrace|model_trace|toolInput|tool_input|executionId|execution_id|turnKey|turn_key/,
    );
    expect(JSON.stringify(clientView.toolRuns)).not.toContain("started");

    const history = await kit.invoke(getModelHistory, {
      conversationId: conversation.id,
    });
    const open = history.messages.find((row) => row.id === begun.messageId);
    expect(open?.text).toBe("");
    expect(open?.turnKey).toBe(begun.turnKey);
    expect(history.unfinishedStartedRuns).toEqual([
      {
        messageId: begun.messageId,
        turnKey: begun.turnKey,
        executionId: staged.executionId,
        seq: 0,
        action: "orders.list",
        toolName: "orders_list_page",
        toolCallId: "call_open",
        toolInput: { limit: 5 },
      },
    ]);
    expect(history.checkpointTurns).toEqual([
      {
        messageId: begun.messageId,
        turnKey: begun.turnKey,
        hasSpeech: false,
      },
    ]);
    expect(open?.toolRuns).toEqual([
      {
        action: "orders.list",
        toolCallId: "call_open",
        toolName: "orders_list_page",
        modelTrace: null,
        toolInput: { limit: 5 },
        seq: 0,
        executionId: staged.executionId,
        outcome: "started",
      },
    ]);
  });

  it("persists error, choice, and confirmation traces on finishRun", async () => {
    const conversation = await kit.invoke(createConversation, {
      title: "Checkpoint traces",
    });
    const begun = await kit.invoke(checkpointAssistantTurn,
      beginInput(conversation.id));
    const errorRun = await kit.invoke(checkpointAssistantTurn, {
      kind: "stageRun",
      conversationId: conversation.id,
      messageId: begun.messageId,
      seq: 0,
      actionName: "catalog.listProducts",
      toolName: "catalog_list_products",
      toolCallId: "call_err",
      toolInput: { query: "x" },
    });
    await kit.invoke(checkpointAssistantTurn, {
      kind: "finishRun",
      conversationId: conversation.id,
      executionId: errorRun.executionId ?? "",
      outcome: "error",
      modelTrace: { status: "error", code: "VALIDATION" },
    });
    const choiceRun = await kit.invoke(checkpointAssistantTurn, {
      kind: "stageRun",
      conversationId: conversation.id,
      messageId: begun.messageId,
      seq: 1,
      actionName: "orders.create",
      toolName: "orders_create",
      toolCallId: "call_choice",
      toolInput: { customerQuery: "Леха" },
    });
    await kit.invoke(checkpointAssistantTurn, {
      kind: "finishRun",
      conversationId: conversation.id,
      executionId: choiceRun.executionId ?? "",
      outcome: "choice_required",
      challengeId,
      modelTrace: { status: "needs_choice", challengeId },
    });
    const confirmRun = await kit.invoke(checkpointAssistantTurn, {
      kind: "stageRun",
      conversationId: conversation.id,
      messageId: begun.messageId,
      seq: 2,
      actionName: "customers.deleteCustomer",
      toolName: "customers_deleteCustomer",
      toolCallId: "call_confirm",
      toolInput: { id: orderId },
    });
    await kit.invoke(checkpointAssistantTurn, {
      kind: "finishRun",
      conversationId: conversation.id,
      executionId: confirmRun.executionId ?? "",
      outcome: "confirmation_required",
      challengeId,
      modelTrace: { status: "confirmation_required", challengeId },
    });
    await kit.invoke(checkpointAssistantTurn, {
      kind: "complete",
      conversationId: conversation.id,
      messageId: begun.messageId,
      body: "Need a choice.",
    });

    const history = await kit.invoke(getModelHistory, {
      conversationId: conversation.id,
    });
    const lastAssistant = history.messages.findLast(
      (row) => row.role === "assistant",
    );
    expect(lastAssistant?.toolRuns.map((run) => run.outcome)).toEqual([
      "error",
      "choice_required",
      "confirmation_required",
    ]);
    expect(lastAssistant?.toolRuns.map((run) => run.modelTrace)).toEqual([
      { status: "error", code: "VALIDATION" },
      { status: "needs_choice", challengeId },
      { status: "confirmation_required", challengeId },
    ]);
    const clientView = await kit.invoke(getConversation, {
      conversationId: conversation.id,
    });
    expect(JSON.stringify(clientView)).not.toMatch(
      /modelTrace|model_trace|toolInput|tool_input/,
    );
  });

  it("pre-T2 rows without tool_input still read as null and reconstruct as {}", async () => {
    const conversation = await kit.invoke(createConversation, {
      title: "Pre-T2 fixture",
    });
    await kit.invoke(recordAssistantTurn, {
      conversationId: conversation.id,
      body: "Listed.",
      toolRuns: [
        {
          actionName: "orders.list",
          toolCallId: "call_legacy",
          outcome: "success",
          toolName: "orders_list_page",
          modelTrace: { kind: "page.summary" },
        },
      ],
    });
    const history = await kit.invoke(getModelHistory, {
      conversationId: conversation.id,
    });
    const lastAssistant = history.messages.findLast(
      (row) => row.role === "assistant",
    );
    expect(lastAssistant?.toolRuns[0]?.toolInput).toBeNull();
    expect(lastAssistant?.toolRuns[0]?.executionId).toBeNull();
    expect(lastAssistant?.toolRuns[0]?.seq).toBeNull();
    expect(lastAssistant?.turnKey).toBeNull();
  });

  it("recovers execution_id from the started row after a crash before finishRun", async () => {
    const conversation = await kit.invoke(createConversation, {
      title: "Crash recovery",
    });
    const begun = await kit.invoke(checkpointAssistantTurn,
      beginInput(conversation.id));
    const staged = await kit.invoke(checkpointAssistantTurn, {
      kind: "stageRun",
      conversationId: conversation.id,
      messageId: begun.messageId,
      seq: 0,
      actionName: "assistant.createConversation",
      toolName: "assistant_createConversation",
      toolCallId: "call_create",
      toolInput: { title: "from staged tool" },
    });
    expect(staged.executionId).toEqual(expect.any(String));
    const firstWrite = await kit.invoke(
      createConversation,
      { title: "from staged tool" },
      {},
      {
        request: {
          idempotencyKey: `tool:${conversation.id}:${staged.executionId ?? ""}`,
        },
      },
    );
    const conversationsAfterCommit = await countConversations(
      kitIdentities.companies.a,
    );

    const history = await kit.invoke(getModelHistory, {
      conversationId: conversation.id,
    });
    const started = history.messages
      .flatMap((message) => message.toolRuns)
      .find((run) => run.outcome === "started");
    expect(started).toBeDefined();
    expect(started?.executionId).toEqual(expect.any(String));
    expect(started?.toolInput).toEqual({ title: "from staged tool" });
    const recoveredId = started?.executionId;
    if (recoveredId === undefined || recoveredId === null) {
      throw new Error("expected execution_id in started row");
    }

    const replay = await kit.invoke(
      createConversation,
      { title: "from staged tool" },
      {},
      {
        request: {
          idempotencyKey: `tool:${conversation.id}:${recoveredId}`,
        },
      },
    );
    expect(replay.id).toBe(firstWrite.id);
    expect(await countConversations(kitIdentities.companies.a)).toBe(
      conversationsAfterCommit,
    );

    await kit.invoke(checkpointAssistantTurn, {
      kind: "finishRun",
      conversationId: conversation.id,
      executionId: recoveredId,
      outcome: "success",
      resultIds: [],
      modelTrace: { id: firstWrite.id },
    });
    const finished = await kit.invoke(getModelHistory, {
      conversationId: conversation.id,
    });
    expect(
      finished.messages.flatMap((message) => message.toolRuns)[0]?.outcome,
    ).toBe("success");
    expect(
      finished.messages.flatMap((message) => message.toolRuns)[0]?.executionId,
    ).toBe(recoveredId);
  });

  it("does not let another tenant read traces or finish another tenant's execution_id", async () => {
    const begun = await kit.invoke(
      checkpointAssistantTurn,
      beginInput(fixtures.checkpoint),
    );
    const staged = await kit.invoke(checkpointAssistantTurn, {
      kind: "stageRun",
      conversationId: fixtures.checkpoint,
      messageId: begun.messageId,
      seq: 0,
      actionName: "orders.list",
      toolName: "orders_list_page",
      toolCallId: "call_secret",
      toolInput: { query: "secret-tenant-a" },
    });
    await expect(
      kit.invoke(
        getModelHistory,
        { conversationId: fixtures.checkpoint },
        {
          companyId: kitIdentities.companies.b,
          userId: kitIdentities.users.boris,
        },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    const own = await kit.invoke(getModelHistory, {
      conversationId: fixtures.checkpoint,
    });
    expect(
      own.messages.some((message) => message.turnKey === begun.turnKey),
    ).toBe(true);
    expect(
      own.unfinishedStartedRuns.some((run) => run.turnKey === begun.turnKey),
    ).toBe(true);
    await expect(
      kit.invoke(
        checkpointAssistantTurn,
        {
          kind: "finishRun",
          conversationId: fixtures.checkpoint,
          executionId: staged.executionId ?? "",
          outcome: "success",
          modelTrace: { leaked: true },
        },
        {
          companyId: kitIdentities.companies.b,
          userId: kitIdentities.users.boris,
        },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    const stillStarted = (
      await kit.db.runtime.db
        .select()
        .from(assistantToolRuns)
        .where(
          and(
            eq(assistantToolRuns.companyId, kitIdentities.companies.a),
            eq(assistantToolRuns.executionId, staged.executionId ?? ""),
          ),
        )
    )[0];
    expect(stillStarted?.outcome).toBe("started");
    expect(stillStarted?.toolInput).toEqual({ query: "secret-tenant-a" });
  });
});
