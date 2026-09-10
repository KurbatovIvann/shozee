/**
 * SHO-320 (assistant-T2) verification for assistant persistence schema.
 * Data-path assertions use Drizzle through the runtime role; raw SQL is
 * limited to PostgreSQL catalog structure checks.
 */
import assert from "node:assert/strict";

import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { rolePermissionDefaultRows } from "../seed/role-permission-defaults.js";
import type { DbClient } from "./client.js";
import type { UserId } from "./schema/auth-ids.js";
import {
  assistantChatMessages,
  assistantChatState,
  assistantConversations,
} from "./schema/assistant.js";
import { user } from "./schema/auth.js";
import { companies } from "./schema/companies.js";
import { createTestDatabase, type TestDatabase } from "./testing/harness.js";

let database: TestDatabase;
let dbClient: DbClient;
let admin: pg.Client;
let sequence = 0;

beforeAll(async () => {
  database = await createTestDatabase();
  dbClient = database.runtime;
  admin = database.admin;
});

afterAll(async () => {
  await database.close();
});

function sqlStateOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if ("code" in error && typeof error.code === "string") return error.code;
  if ("cause" in error) return sqlStateOf(error.cause);
  return undefined;
}

async function expectSqlState(promise: Promise<unknown>, sqlState: string) {
  const outcome = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(outcome).toBeInstanceOf(Error);
  expect(sqlStateOf(outcome)).toBe(sqlState);
}

async function insertUser(): Promise<UserId> {
  sequence += 1;
  const id = `assistant_user_${String(sequence)}`;
  await dbClient.db.insert(user).values({
    id,
    name: `Assistant User ${String(sequence)}`,
    email: `assistant-user-${String(sequence)}@example.com`,
  });
  return id;
}

async function insertCompany() {
  sequence += 1;
  const rows = await dbClient.db
    .insert(companies)
    .values({
      name: `Assistant Co ${String(sequence)}`,
      slug: `assistant-co-${String(sequence)}`,
      prefix: `A${String(sequence)}`,
    })
    .returning();
  const row = rows[0];
  assert.ok(row);
  return row;
}

async function insertConversation(
  values: Omit<typeof assistantConversations.$inferInsert, "userId"> & {
    userId: UserId;
  },
) {
  const rows = await dbClient.db
    .insert(assistantConversations)
    .values(values)
    .returning();
  const row = rows[0];
  assert.ok(row);
  return row;
}

/**
 * `message_id` is NOT NULL: a run is always recorded with the assistant
 * turn that produced it. Cases that do not care which turn get a fresh
 * assistant message in the same conversation.
 */

/** The `message_id` backfill statement shipped in migration 0050. */

async function foreignKeysFor(
  tables: readonly string[],
): Promise<Map<string, string>> {
  const result = await admin.query<{
    conname: string;
    definition: string;
  }>(
    `SELECT con.conname,
            pg_get_constraintdef(con.oid) AS definition
     FROM pg_constraint con
     JOIN pg_class rel ON rel.oid = con.conrelid
     JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
     WHERE nsp.nspname = 'public'
       AND con.contype = 'f'
       AND rel.relname = ANY($1::text[])
     ORDER BY con.conname`,
    [tables],
  );
  return new Map(result.rows.map((row) => [row.conname, row.definition]));
}

describe("assistant schema slice", () => {
  it("accepts a conversation with optional title and rejects a missing staff user", async () => {
    const company = await insertCompany();
    const userId = await insertUser();
    const titled = await insertConversation({
      companyId: company.id,
      userId,
      title: "Price list",
    });
    expect(titled.title).toBe("Price list");
    expect(titled.userId).toBe(userId);

    const untitled = await insertConversation({
      companyId: company.id,
      userId,
    });
    expect(untitled.title).toBeNull();

    await expectSqlState(
      insertConversation({
        companyId: company.id,
        userId: "missing_staff",
      }),
      "23503",
    );
  });

  it("declares the conversation's tenant, staff-user, chat-state and message keys", async () => {
    const keys = await foreignKeysFor([
      "assistant_conversations",
      "assistant_chat_state",
      "assistant_chat_messages",
    ]);
    expect(keys.get("assistant_chat_messages_conversations_company_fk")).toBe(
      "FOREIGN KEY (company_id, conversation_id) REFERENCES assistant_conversations(company_id, id) ON DELETE CASCADE",
    );
    const definitions = [...keys.values()].join("\n");

    // The staff user is RESTRICT: a person with conversations is not deleted
    // out from under them.
    expect(definitions).toContain("FOREIGN KEY (user_id) REFERENCES");
    const byColumn = (column: string) =>
      [...keys.values()].find((definition) =>
        definition.includes(`FOREIGN KEY (${column})`),
      ) ?? "";
    expect(byColumn("user_id")).toMatch(/ON DELETE RESTRICT/i);
    // Company is CASCADE, for tenant wipe.
    expect(byColumn("company_id")).toMatch(/ON DELETE CASCADE/i);
    // Chat state hangs off the conversation composite key, not off its id
    // alone: a conversation id is only unique within a tenant.
    expect(definitions).toContain(
      "FOREIGN KEY (company_id, conversation_id) REFERENCES assistant_conversations(company_id, id)",
    );
  });

  it("keeps one row of chat state per conversation", async () => {
    const company = await insertCompany();
    const userId = await insertUser();
    const conversation = await insertConversation({
      companyId: company.id,
      userId,
    });

    await dbClient.db.insert(assistantChatState).values({
      companyId: company.id,
      conversationId: conversation.id,
      history: [],
    });

    // A second row for the same conversation is the shape that would let two
    // histories disagree, so the database refuses it.
    await expectSqlState(
      dbClient.db.insert(assistantChatState).values({
        companyId: company.id,
        conversationId: conversation.id,
        history: [],
      }),
      "23505",
    );
  });

  it("refuses chat state for another tenant's conversation", async () => {
    const owner = await insertCompany();
    const other = await insertCompany();
    const userId = await insertUser();
    const conversation = await insertConversation({
      companyId: owner.id,
      userId,
    });

    await expectSqlState(
      dbClient.db.insert(assistantChatState).values({
        companyId: other.id,
        conversationId: conversation.id,
        history: [],
      }),
      "23503",
    );
  });

  it("takes the chat state with the conversation and with the company", async () => {
    const company = await insertCompany();
    const userId = await insertUser();
    const conversation = await insertConversation({
      companyId: company.id,
      userId,
    });
    await dbClient.db.insert(assistantChatState).values({
      companyId: company.id,
      conversationId: conversation.id,
      history: [],
    });

    await dbClient.db
      .delete(assistantConversations)
      .where(eq(assistantConversations.id, conversation.id));

    expect(
      await dbClient.db
        .select({ conversationId: assistantChatState.conversationId })
        .from(assistantChatState)
        .where(eq(assistantChatState.conversationId, conversation.id)),
    ).toEqual([]);
  });

  it("orders a conversation's messages by a sequence that neither repeats nor starts below one", async () => {
    const company = await insertCompany();
    const userId = await insertUser();
    const conversation = await insertConversation({
      companyId: company.id,
      userId,
    });
    const first = crypto.randomUUID();
    const row = (seq: number, messageId: string) => ({
      companyId: company.id,
      conversationId: conversation.id,
      seq,
      messageId,
      bind: "owner",
      message: { messageId },
    });

    await dbClient.db.insert(assistantChatMessages).values(row(1, first));

    // Two messages at one position is the shape that lets a lost lease
    // overwrite a turn silently, so the database refuses it.
    await expectSqlState(
      dbClient.db
        .insert(assistantChatMessages)
        .values(row(1, crypto.randomUUID())),
      "23505",
    );
    // The same message twice is a second insert, never an update.
    await expectSqlState(
      dbClient.db.insert(assistantChatMessages).values(row(2, first)),
      "23505",
    );
    await expectSqlState(
      dbClient.db
        .insert(assistantChatMessages)
        .values(row(0, crypto.randomUUID())),
      "23514",
    );
  });

  it("refuses a message for another tenant's conversation", async () => {
    const owner = await insertCompany();
    const other = await insertCompany();
    const userId = await insertUser();
    const conversation = await insertConversation({
      companyId: owner.id,
      userId,
    });

    await expectSqlState(
      dbClient.db.insert(assistantChatMessages).values({
        companyId: other.id,
        conversationId: conversation.id,
        seq: 1,
        messageId: crypto.randomUUID(),
        bind: "owner",
        message: {},
      }),
      "23503",
    );
  });

  it("takes the messages with the conversation", async () => {
    const company = await insertCompany();
    const userId = await insertUser();
    const conversation = await insertConversation({
      companyId: company.id,
      userId,
    });
    await dbClient.db.insert(assistantChatMessages).values({
      companyId: company.id,
      conversationId: conversation.id,
      seq: 1,
      messageId: crypto.randomUUID(),
      bind: "owner",
      message: {},
    });

    await dbClient.db
      .delete(assistantConversations)
      .where(eq(assistantConversations.id, conversation.id));

    expect(
      await dbClient.db
        .select({ seq: assistantChatMessages.seq })
        .from(assistantChatMessages)
        .where(eq(assistantChatMessages.conversationId, conversation.id)),
    ).toEqual([]);
  });

  it("carries only the tables the assistant still has", async () => {
    const result = await admin.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name LIKE 'assistant%'
       ORDER BY table_name`,
    );

    // `assistant_messages` and `assistant_tool_runs` stored a turn row by row
    // so the model conversation could be rebuilt from them. Nothing rebuilds
    // it, and the audit lives in `audit_log` (ADR-0038). The message log that
    // came later is the transcript a person reads, stored as written.
    expect(result.rows.map((row) => row.table_name)).toEqual([
      "assistant_chat_messages",
      "assistant_chat_state",
      "assistant_conversations",
    ]);
  });

  /**
   * The transcript was a document in this row, replaced whole on every write,
   * and one message nobody could parse emptied it. It is a log in
   * `assistant_chat_messages` now; a transcript blob back here is that defect
   * again (SHO-555).
   */
  it("keeps only the provider history in chat state, not the transcript", async () => {
    const result = await admin.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'assistant_chat_state'
       ORDER BY column_name`,
    );

    expect(result.rows.map((row) => row.column_name)).toEqual([
      "company_id",
      "conversation_id",
      "created_at",
      "history",
      "updated_at",
    ]);
  });

  it("seeds assistant:use for admin, manager, and employee, not owner", () => {
    const keys = new Set(
      rolePermissionDefaultRows.map((row) => `${row.role}:${row.permission}`),
    );
    for (const role of ["admin", "manager", "employee"] as const) {
      expect(keys.has(`${role}:assistant:use`)).toBe(true);
    }
    expect(keys.has("owner:assistant:use")).toBe(false);
  });
});
