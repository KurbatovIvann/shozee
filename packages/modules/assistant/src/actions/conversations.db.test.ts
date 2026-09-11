import { randomUUID } from "node:crypto";

import { staffHasPermission } from "@showzy/core";
import {
  ConflictError,
  NotFoundError,
  PermissionDeniedError,
} from "@showzy/core/errors";
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
  assistantChatMessages,
  assistantChatState,
  assistantConversations,
} from "@showzy/db/schema/assistant";
import { companyMembers } from "@showzy/db/schema/companies";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createConversation } from "./create-conversation.js";
import { getStaffActor } from "./get-staff-actor.js";
import { insertChatMessage } from "./insert-chat-message.js";
import { listConversations } from "./list-conversations.js";
import { readChatMessages } from "./read-chat-messages.js";
import { readChatState } from "./read-chat-state.js";
import { updateChatMessage } from "./update-chat-message.js";
import { writeChatState } from "./write-chat-state.js";

const fixtures = {
  convA: randomUUID(),
  /** A message already stored in `convA`, for the update isolation case. */
  convAMessage: randomUUID(),
  convB: randomUUID(),
  log: randomUUID(),
  newest: randomUUID(),
  older: randomUUID(),
  chatState: randomUUID(),
  employee: randomUUID(),
};

const clerks = {
  denied: randomUUID(),
  employee: randomUUID(),
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
    id: fixtures.employee,
    companyId: kitIdentities.companies.a,
    userId: clerks.employee,
    title: "Employee thread",
    createdAt: stamps.employee,
    updatedAt: stamps.employee,
  });
  await insertConversation({
    id: fixtures.log,
    companyId: kitIdentities.companies.a,
    userId: kitIdentities.users.anna,
    title: "Message log",
  });
  await kit.db.runtime.db.insert(assistantChatMessages).values({
    companyId: kitIdentities.companies.a,
    conversationId: fixtures.convA,
    seq: 1,
    messageId: fixtures.convAMessage,
    bind: "anna:company-a",
    message: { messageId: fixtures.convAMessage },
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
      { input: { conversationId: fixtures.convA, history: [] } },
      { input: { conversationId: fixtures.convB, history: [] } },
    ),
    isolationCase(
      readChatMessages,
      { input: { conversationId: fixtures.convA, limit: 10 } },
      { input: { conversationId: fixtures.convB, limit: 10 } },
    ),
    isolationCase(
      insertChatMessage,
      {
        input: {
          conversationId: fixtures.convA,
          messageId: randomUUID(),
          bind: "anna:company-a",
          message: { a: 1 },
        },
      },
      {
        input: {
          conversationId: fixtures.convB,
          messageId: randomUUID(),
          bind: "anna:company-a",
          message: { a: 1 },
        },
      },
    ),
    isolationCase(
      updateChatMessage,
      {
        input: {
          conversationId: fixtures.convA,
          seq: 1,
          messageId: fixtures.convAMessage,
          revision: 1,
          message: { a: 2 },
        },
      },
      {
        input: {
          conversationId: fixtures.convB,
          seq: 1,
          messageId: fixtures.convAMessage,
          revision: 1,
          message: { a: 2 },
        },
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
]);

describe("the durable chat state", () => {
  it("reads a conversation with no turns as empty rather than missing", async () => {
    const state = await kit.invoke(
      readChatState,
      { conversationId: fixtures.chatState },
      {},
    );

    expect(state).toEqual({ history: null });
  });

  it("round-trips the history exactly as stored", async () => {
    const history = [
      { role: "user", content: "привіт" },
      { role: "assistant", content: [{ type: "text", text: "Готово." }] },
    ];

    await kit.invoke(
      writeChatState,
      { conversationId: fixtures.chatState, history },
      {},
    );
    const state = await kit.invoke(
      readChatState,
      { conversationId: fixtures.chatState },
      {},
    );

    // Exactly the provider messages the turn ran with: the next turn replays
    // them rather than reconstructing them.
    expect(state.history).toEqual(history);
  });

  it("replaces rather than accumulating", async () => {
    await kit.invoke(
      writeChatState,
      { conversationId: fixtures.chatState, history: [{ v: 1 }] },
      {},
    );
    await kit.invoke(
      writeChatState,
      { conversationId: fixtures.chatState, history: [{ v: 2 }] },
      {},
    );

    expect(await countChatState(fixtures.chatState)).toBe(1);
    const state = await kit.invoke(
      readChatState,
      { conversationId: fixtures.chatState },
      {},
    );
    expect(state.history).toEqual([{ v: 2 }]);
  });

  it("is not-found for a conversation that does not exist", async () => {
    await expect(
      kit.invoke(readChatState, { conversationId: randomUUID() }, {}),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      kit.invoke(
        writeChatState,
        { conversationId: randomUUID(), history: [] },
        {},
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("the message log", () => {
  const BIND = "anna:company-a";

  function message(label: string) {
    return {
      messageId: randomUUID(),
      role: "assistant",
      createdAt: "2026-09-10T10:00:00.000Z",
      parts: [{ kind: "text", text: label, status: "complete" }],
    };
  }

  async function append(stored: ReturnType<typeof message>) {
    return kit.invoke(
      insertChatMessage,
      {
        conversationId: fixtures.log,
        messageId: stored.messageId,
        bind: BIND,
        message: stored,
      },
      {},
    );
  }

  const stored: ReturnType<typeof message>[] = [];

  it("reads a conversation with no messages as an empty page, not as missing", async () => {
    const page = await kit.invoke(
      readChatMessages,
      { conversationId: fixtures.log, limit: 10 },
      {},
    );

    expect(page).toEqual({ records: [], hasOlder: false });
  });

  it("numbers messages in the order they arrive and returns them as stored", async () => {
    for (const label of ["one", "two", "three"]) {
      const next = message(label);
      stored.push(next);
      const written = await append(next);
      expect(written).toEqual({
        conversationId: fixtures.log,
        seq: stored.length,
      });
    }

    const page = await kit.invoke(
      readChatMessages,
      { conversationId: fixtures.log, limit: 10 },
      {},
    );

    expect(page.hasOlder).toBe(false);
    expect(page.records).toEqual(
      stored.map((entry, index) => ({
        seq: index + 1,
        messageId: entry.messageId,
        bind: BIND,
        message: entry,
        revision: 1,
      })),
    );
  });

  it("pages back from a position without skipping or repeating one", async () => {
    const latest = await kit.invoke(
      readChatMessages,
      { conversationId: fixtures.log, limit: 2 },
      {},
    );
    expect(latest.records.map((record) => record.seq)).toEqual([2, 3]);
    expect(latest.hasOlder).toBe(true);

    const older = await kit.invoke(
      readChatMessages,
      { conversationId: fixtures.log, limit: 2, beforeSeq: 2 },
      {},
    );
    expect(older.records.map((record) => record.seq)).toEqual([1]);
    expect(older.hasOlder).toBe(false);
  });

  /**
   * The only message a runtime may change is the latest, by naming it. An
   * insert that quietly became an update would let a turn rewrite a message it
   * never read.
   */
  it("refuses a message id the conversation already holds, and changes nothing", async () => {
    const first = stored[0];
    expect(first).toBeDefined();
    if (first === undefined) {
      return;
    }

    await expect(append({ ...first, parts: [] })).rejects.toBeInstanceOf(
      ConflictError,
    );

    const page = await kit.invoke(
      readChatMessages,
      { conversationId: fixtures.log, limit: 10 },
      {},
    );
    expect(page.records).toHaveLength(3);
    expect(page.records[0]?.message).toEqual(first);
  });

  it("replaces a message only when its position and its id both name it", async () => {
    const second = stored[1];
    const third = stored[2];
    expect(second).toBeDefined();
    expect(third).toBeDefined();
    if (second === undefined || third === undefined) {
      return;
    }
    const replaced = { ...third, parts: [] };

    await expect(
      kit.invoke(
        updateChatMessage,
        {
          conversationId: fixtures.log,
          seq: 3,
          messageId: second.messageId,
          revision: 1,
          message: replaced,
        },
        {},
      ),
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(
      await kit.invoke(
        updateChatMessage,
        {
          conversationId: fixtures.log,
          seq: 3,
          messageId: third.messageId,
          revision: 1,
          message: replaced,
        },
        {},
      ),
    ).toEqual({ conversationId: fixtures.log, seq: 3, revision: 2 });

    const page = await kit.invoke(
      readChatMessages,
      { conversationId: fixtures.log, limit: 10 },
      {},
    );
    expect(page.records.map((record) => record.message)).toEqual([
      stored[0],
      second,
      replaced,
    ]);
  });

  it("audits each write against the conversation", async () => {
    const requestId = randomUUID();
    const next = message("audited");
    await kit.invoke(
      insertChatMessage,
      {
        conversationId: fixtures.log,
        messageId: next.messageId,
        bind: BIND,
        message: next,
      },
      {},
      { request: { requestId } },
    );

    const rows = await kit.db.runtime.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.requestId, requestId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "assistant.insertChatMessage",
      companyId: kitIdentities.companies.a,
      actorId: kitIdentities.users.anna,
      targetType: "conversation",
      targetId: fixtures.log,
      outcome: "ok",
    });
  });

  it("is not-found for a conversation that does not exist, or that a colleague wrote", async () => {
    const colleague = {
      userId: clerks.employee,
      companyId: kitIdentities.companies.a,
    };
    for (const [conversationId, actor] of [
      [randomUUID(), {}],
      [fixtures.log, colleague],
    ] as const) {
      await expect(
        kit.invoke(readChatMessages, { conversationId, limit: 10 }, actor),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        kit.invoke(
          insertChatMessage,
          {
            conversationId,
            messageId: randomUUID(),
            bind: BIND,
            message: {},
          },
          actor,
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        kit.invoke(
          updateChatMessage,
          {
            conversationId,
            seq: 1,
            messageId: randomUUID(),
            revision: 1,
            message: {},
          },
          actor,
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    }
  });

  it("refuses a person without assistant:use", async () => {
    const denied = {
      userId: clerks.denied,
      companyId: kitIdentities.companies.a,
    };

    await expect(
      kit.invoke(
        readChatMessages,
        { conversationId: fixtures.log, limit: 10 },
        denied,
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      kit.invoke(
        insertChatMessage,
        {
          conversationId: fixtures.log,
          messageId: randomUUID(),
          bind: BIND,
          message: {},
        },
        denied,
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
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
    expect(owner.companyId).toBe(kitIdentities.companies.a);
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
