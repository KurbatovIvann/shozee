import { randomUUID } from "node:crypto";

import { staffHasPermission } from "@showzy/core";
import { NotFoundError } from "@showzy/core/errors";
import {
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
  assistantChatState,
  assistantConversations,
} from "@showzy/db/schema/assistant";
import { companyMembers } from "@showzy/db/schema/companies";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createConversation } from "./create-conversation.js";
import { getStaffActor } from "./get-staff-actor.js";
import { listConversations } from "./list-conversations.js";
import { readChatState } from "./read-chat-state.js";
import { writeChatState } from "./write-chat-state.js";

const fixtures = {
  convA: randomUUID(),
  convB: randomUUID(),
  newest: randomUUID(),
  older: randomUUID(),
  chatState: randomUUID(),
  chatStateIdempotent: randomUUID(),
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

async function countChatState(conversationId: string): Promise<number> {
  const rows = await kit.db.runtime.db
    .select({ conversationId: assistantChatState.conversationId })
    .from(assistantChatState)
    .where(eq(assistantChatState.conversationId, conversationId));
  return rows.length;
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
    id: fixtures.chatState,
    companyId: kitIdentities.companies.a,
    userId: kitIdentities.users.anna,
    title: "Chat state",
  });
  await insertConversation({
    id: fixtures.chatStateIdempotent,
    companyId: kitIdentities.companies.a,
    userId: kitIdentities.users.anna,
    title: "Chat state idempotent",
  });
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
      readChatState,
      { input: { conversationId: fixtures.convA } },
      { input: { conversationId: fixtures.convB } },
    ),
    isolationCase(
      writeChatState,
      { input: { conversationId: fixtures.convA, document: { a: 1 } } },
      { input: { conversationId: fixtures.convB, document: { a: 1 } } },
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
]);

describe("the durable chat state", () => {
  it("reads a conversation with no turns as empty rather than missing", async () => {
    const state = await kit.invoke(
      readChatState,
      { conversationId: fixtures.chatState },
      {},
    );

    expect(state).toEqual({ document: null, history: null });
  });

  it("round-trips both halves exactly as stored", async () => {
    const document = {
      conversationId: fixtures.chatState,
      bind: "anna:company-a",
      messages: [
        {
          messageId: randomUUID(),
          role: "assistant",
          createdAt: "2026-09-10T10:00:00.000Z",
          parts: [{ kind: "text", text: "Готово.", status: "complete" }],
        },
      ],
      openPause: null,
    };
    const history = [{ role: "user", content: "привіт" }];

    await kit.invoke(
      writeChatState,
      { conversationId: fixtures.chatState, document, history },
      {},
    );
    const state = await kit.invoke(
      readChatState,
      { conversationId: fixtures.chatState },
      {},
    );

    // Byte-identical: the whole point of storing the document settled is that
    // reading it back is not a second derivation of it.
    expect(state.document).toEqual(document);
    expect(state.history).toEqual(history);
  });

  /**
   * A turn writes the document several times and the history once. If a write
   * carrying one half blanked the other, the next turn would run with no memory
   * of the conversation it is in.
   */
  it("leaves the half a write does not carry alone", async () => {
    await kit.invoke(
      writeChatState,
      {
        conversationId: fixtures.chatState,
        document: { marker: "document" },
        history: [{ role: "user", content: "kept" }],
      },
      {},
    );

    await kit.invoke(
      writeChatState,
      { conversationId: fixtures.chatState, document: { marker: "replaced" } },
      {},
    );
    const state = await kit.invoke(
      readChatState,
      { conversationId: fixtures.chatState },
      {},
    );

    expect(state.document).toEqual({ marker: "replaced" });
    expect(state.history).toEqual([{ role: "user", content: "kept" }]);
  });

  it("replaces rather than accumulating", async () => {
    await kit.invoke(
      writeChatState,
      { conversationId: fixtures.chatState, document: { v: 1 } },
      {},
    );
    await kit.invoke(
      writeChatState,
      { conversationId: fixtures.chatState, document: { v: 2 } },
      {},
    );

    expect(await countChatState(fixtures.chatState)).toBe(1);
    const state = await kit.invoke(
      readChatState,
      { conversationId: fixtures.chatState },
      {},
    );
    expect(state.document).toEqual({ v: 2 });
  });

  it("is not-found for a conversation that does not exist", async () => {
    await expect(
      kit.invoke(readChatState, { conversationId: randomUUID() }, {}),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      kit.invoke(
        writeChatState,
        { conversationId: randomUUID(), document: {} },
        {},
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

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
});
