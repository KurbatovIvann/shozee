/**
 * SHO-320 (assistant-T2) verification for assistant persistence schema.
 * Data-path assertions use Drizzle through the runtime role; raw SQL is
 * limited to PostgreSQL catalog structure checks.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import pg from "pg";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  expectTypeOf,
  it,
} from "vitest";

import { rolePermissionDefaultRows } from "../seed/role-permission-defaults.js";
import type { DbClient } from "./client.js";
import type { UserId } from "./schema/auth-ids.js";
import {
  assistantConversations,
  assistantMessages,
  assistantToolRuns,
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

async function insertMessage(values: typeof assistantMessages.$inferInsert) {
  const rows = await dbClient.db
    .insert(assistantMessages)
    .values(values)
    .returning();
  const row = rows[0];
  assert.ok(row);
  return row;
}

async function insertToolRun(values: typeof assistantToolRuns.$inferInsert) {
  const rows = await dbClient.db
    .insert(assistantToolRuns)
    .values(values)
    .returning();
  const row = rows[0];
  assert.ok(row);
  return row;
}

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
  it("creates only the card-named columns with timestamptz timestamps", async () => {
    const result = await admin.query<{
      table_name: string;
      column_name: string;
      data_type: string;
      udt_name: string;
      is_nullable: string;
    }>(
      `SELECT table_name, column_name, data_type, udt_name, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name IN
           ('assistant_conversations', 'assistant_messages',
            'assistant_tool_runs')
       ORDER BY table_name, ordinal_position`,
    );

    const byTable = new Map<string, string[]>();
    for (const row of result.rows) {
      const names = byTable.get(row.table_name) ?? [];
      names.push(row.column_name);
      byTable.set(row.table_name, names);
      if (row.column_name.endsWith("_at")) {
        expect(row.data_type).toBe("timestamp with time zone");
      }
    }

    expect(byTable.get("assistant_conversations")).toEqual([
      "id",
      "company_id",
      "user_id",
      "title",
      "created_at",
      "updated_at",
    ]);
    expect(byTable.get("assistant_messages")).toEqual([
      "id",
      "company_id",
      "conversation_id",
      "role",
      "body",
      "created_at",
      "updated_at",
    ]);
    expect(byTable.get("assistant_tool_runs")).toEqual([
      "id",
      "company_id",
      "conversation_id",
      "action_name",
      "tool_call_id",
      "challenge_id",
      "result_ids",
      "outcome",
      "model_trace",
      "created_at",
      "updated_at",
    ]);

    const resultIds = result.rows.find(
      (row) =>
        row.table_name === "assistant_tool_runs" &&
        row.column_name === "result_ids",
    );
    expect(resultIds?.data_type).toBe("ARRAY");
    expect(resultIds?.udt_name).toBe("_uuid");
    expect(resultIds?.is_nullable).toBe("NO");

    const title = result.rows.find(
      (row) =>
        row.table_name === "assistant_conversations" &&
        row.column_name === "title",
    );
    expect(title?.is_nullable).toBe("YES");

    const challengeId = result.rows.find(
      (row) =>
        row.table_name === "assistant_tool_runs" &&
        row.column_name === "challenge_id",
    );
    expect(challengeId?.data_type).toBe("uuid");
    expect(challengeId?.is_nullable).toBe("YES");

    const modelTrace = result.rows.find(
      (row) =>
        row.table_name === "assistant_tool_runs" &&
        row.column_name === "model_trace",
    );
    expect(modelTrace?.udt_name).toBe("jsonb");
    expect(modelTrace?.is_nullable).toBe("YES");

    const names = result.rows.map((row) => row.column_name);
    for (const forbidden of [
      "status",
      "order_id",
      "document_id",
      "order_status",
      "document_status",
    ]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("represents staff user ids, uuid result ids, and optional challenge ids", () => {
    expectTypeOf<
      (typeof assistantConversations.$inferSelect)["userId"]
    >().toEqualTypeOf<UserId>();
    expectTypeOf<
      (typeof assistantConversations.$inferSelect)["title"]
    >().toEqualTypeOf<string | null>();
    expectTypeOf<
      (typeof assistantToolRuns.$inferSelect)["resultIds"]
    >().toEqualTypeOf<string[]>();
    expectTypeOf<
      (typeof assistantToolRuns.$inferSelect)["challengeId"]
    >().toEqualTypeOf<string | null>();
    expectTypeOf<
      (typeof assistantToolRuns.$inferSelect)["modelTrace"]
    >().toEqualTypeOf<unknown>();
  });

  it("declares UNIQUE (company_id, id) and the conversation list index", async () => {
    const result = await admin.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename IN
           ('assistant_conversations', 'assistant_messages',
            'assistant_tool_runs')`,
    );
    const indexes = new Map(
      result.rows.map((row) => [row.indexname, row.indexdef]),
    );

    for (const name of [
      "assistant_conversations_company_id_id_uq",
      "assistant_messages_company_id_id_uq",
      "assistant_tool_runs_company_id_id_uq",
    ] as const) {
      expect(indexes.get(name)).toContain("UNIQUE");
      expect(indexes.get(name)).toContain("(company_id, id)");
    }

    const list = indexes.get("assistant_conversations_company_updated_at_idx");
    expect(list).toContain("(company_id");
    expect(list).toMatch(/updated_at.*DESC/i);
    expect(
      indexes.get("assistant_messages_company_conversation_idx"),
    ).toContain("(company_id, conversation_id)");
    expect(
      indexes.get("assistant_tool_runs_company_conversation_idx"),
    ).toContain("(company_id, conversation_id)");
  });

  it("declares tenant, staff-user, and composite conversation foreign keys", async () => {
    const defs = await foreignKeysFor([
      "assistant_conversations",
      "assistant_messages",
      "assistant_tool_runs",
    ]);

    expect(
      defs.get("assistant_conversations_company_id_companies_id_fk"),
    ).toContain("FOREIGN KEY (company_id) REFERENCES companies(id)");
    expect(
      defs.get("assistant_conversations_company_id_companies_id_fk"),
    ).toContain("ON DELETE CASCADE");
    expect(defs.get("assistant_conversations_user_id_user_id_fk")).toContain(
      "FOREIGN KEY (user_id) REFERENCES",
    );
    expect(defs.get("assistant_conversations_user_id_user_id_fk")).toContain(
      "ON DELETE RESTRICT",
    );

    expect(defs.get("assistant_messages_conversations_company_fk")).toContain(
      "(company_id, conversation_id) REFERENCES assistant_conversations(company_id, id)",
    );
    expect(defs.get("assistant_messages_conversations_company_fk")).toContain(
      "ON DELETE CASCADE",
    );
    expect(defs.get("assistant_tool_runs_conversations_company_fk")).toContain(
      "(company_id, conversation_id) REFERENCES assistant_conversations(company_id, id)",
    );
    expect(defs.get("assistant_tool_runs_conversations_company_fk")).toContain(
      "ON DELETE CASCADE",
    );

    const joined = [...defs.values()].join("\n");
    expect(joined).not.toMatch(/REFERENCES (orders|documents|files)\b/);
  });

  it("declares role and outcome CHECKs", async () => {
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
         AND con.contype = 'c'
         AND rel.relname IN
           ('assistant_conversations', 'assistant_messages',
            'assistant_tool_runs')
       ORDER BY con.conname`,
    );
    const defs = new Map(
      result.rows.map((row) => [row.conname, row.definition]),
    );

    expect(defs.get("assistant_messages_role_check")).toContain("'user'");
    expect(defs.get("assistant_messages_role_check")).toContain("'assistant'");
    expect(defs.get("assistant_messages_role_check")).not.toContain("'system'");
    expect(defs.get("assistant_messages_role_check")).not.toContain("'tool'");
    expect(defs.get("assistant_tool_runs_outcome_check")).toContain(
      "'success'",
    );
    expect(defs.get("assistant_tool_runs_outcome_check")).toContain("'error'");
    expect(defs.get("assistant_tool_runs_outcome_check")).toContain(
      "'confirmation_required'",
    );
    expect(defs.get("assistant_tool_runs_outcome_check")).toContain(
      "'choice_required'",
    );
    expect(defs.get("assistant_tool_runs_outcome_check")).not.toContain(
      "'confirmed'",
    );
    expect(defs.get("assistant_tool_runs_model_trace_length_check")).toContain(
      "22000",
    );
    expect(defs.get("assistant_tool_runs_model_trace_length_check")).toMatch(
      /length\(.*model_trace.*::text\)/i,
    );
  });

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

  it("rejects a message that points at another tenant's conversation", async () => {
    const companyA = await insertCompany();
    const companyB = await insertCompany();
    const userId = await insertUser();
    const conversationB = await insertConversation({
      companyId: companyB.id,
      userId,
    });

    await expectSqlState(
      insertMessage({
        companyId: companyA.id,
        conversationId: conversationB.id,
        role: "user",
        body: "cross-tenant",
      }),
      "23503",
    );
  });

  it("rejects a tool run that points at another tenant's conversation", async () => {
    const companyA = await insertCompany();
    const companyB = await insertCompany();
    const userId = await insertUser();
    const conversationB = await insertConversation({
      companyId: companyB.id,
      userId,
    });

    await expectSqlState(
      insertToolRun({
        companyId: companyA.id,
        conversationId: conversationB.id,
        actionName: "orders.list",
        toolCallId: "call_cross",
        outcome: "success",
      }),
      "23503",
    );
  });

  it("rejects invalid message roles and tool-run outcomes", async () => {
    const company = await insertCompany();
    const userId = await insertUser();
    const conversation = await insertConversation({
      companyId: company.id,
      userId,
    });

    await expectSqlState(
      insertMessage({
        companyId: company.id,
        conversationId: conversation.id,
        role: "system",
        body: "no",
      }),
      "23514",
    );
    await expectSqlState(
      insertMessage({
        companyId: company.id,
        conversationId: conversation.id,
        role: "tool",
        body: "no",
      }),
      "23514",
    );
    await expectSqlState(
      insertToolRun({
        companyId: company.id,
        conversationId: conversation.id,
        actionName: "orders.create",
        toolCallId: "call_bad_outcome",
        outcome: "confirmed",
      }),
      "23514",
    );
    await expectSqlState(
      insertToolRun({
        companyId: company.id,
        conversationId: conversation.id,
        actionName: "orders.create",
        toolCallId: "call_status",
        outcome: "issued",
      }),
      "23514",
    );
  });

  it("stores user/assistant text and uuid result ids without status snapshots", async () => {
    const company = await insertCompany();
    const userId = await insertUser();
    const conversation = await insertConversation({
      companyId: company.id,
      userId,
    });
    const orderId = randomUUID();
    const challengeId = randomUUID();

    const userMessage = await insertMessage({
      companyId: company.id,
      conversationId: conversation.id,
      role: "user",
      body: "Create an order",
    });
    const assistantMessage = await insertMessage({
      companyId: company.id,
      conversationId: conversation.id,
      role: "assistant",
      body: "I will create it after you confirm.",
    });
    expect(userMessage.body).toBe("Create an order");
    expect(assistantMessage.role).toBe("assistant");

    const pending = await insertToolRun({
      companyId: company.id,
      conversationId: conversation.id,
      actionName: "customers.deleteCustomer",
      toolCallId: "call_hitl",
      challengeId,
      outcome: "confirmation_required",
    });
    expect(pending.resultIds).toEqual([]);
    expect(pending.challengeId).toBe(challengeId);
    expect(pending.outcome).toBe("confirmation_required");

    const choicePending = await insertToolRun({
      companyId: company.id,
      conversationId: conversation.id,
      actionName: "orders.create",
      toolCallId: "call_choice",
      challengeId,
      outcome: "choice_required",
    });
    expect(choicePending.resultIds).toEqual([]);
    expect(choicePending.challengeId).toBe(challengeId);
    expect(choicePending.outcome).toBe("choice_required");

    const succeeded = await insertToolRun({
      companyId: company.id,
      conversationId: conversation.id,
      actionName: "orders.create",
      toolCallId: "call_ok",
      resultIds: [orderId],
      outcome: "success",
    });
    expect(succeeded.resultIds).toEqual([orderId]);
    expect(succeeded.modelTrace).toBeNull();
    expect(pending.modelTrace).toBeNull();

    const failed = await insertToolRun({
      companyId: company.id,
      conversationId: conversation.id,
      actionName: "orders.list",
      toolCallId: "call_err",
      outcome: "error",
    });
    expect(failed.resultIds).toEqual([]);

    const traced = await insertToolRun({
      companyId: company.id,
      conversationId: conversation.id,
      actionName: "orders.list",
      toolCallId: "call_trace",
      outcome: "success",
      modelTrace: { kind: "page.summary", rows: [{ orderNumber: "12" }] },
    });
    expect(traced.modelTrace).toEqual({
      kind: "page.summary",
      rows: [{ orderNumber: "12" }],
    });

    await expectSqlState(
      insertToolRun({
        companyId: company.id,
        conversationId: conversation.id,
        actionName: "orders.list",
        toolCallId: "call_trace_huge",
        outcome: "success",
        modelTrace: { pad: "x".repeat(22_000) },
      }),
      "23514",
    );

    await expectSqlState(
      admin.query(
        `INSERT INTO assistant_tool_runs
           (company_id, conversation_id, action_name, tool_call_id,
            result_ids, outcome)
         VALUES ($1, $2, 'orders.create', 'call_json',
                 '{"status":"confirmed"}'::jsonb, 'success')`,
        [company.id, conversation.id],
      ),
      "42804",
    );
  });

  it("cascades conversation deletion and restricts deleting a staff user with conversations", async () => {
    const company = await insertCompany();
    const owner = await insertUser();
    const other = await insertUser();
    const conversation = await insertConversation({
      companyId: company.id,
      userId: owner,
    });
    await insertMessage({
      companyId: company.id,
      conversationId: conversation.id,
      role: "user",
      body: "hello",
    });
    await insertToolRun({
      companyId: company.id,
      conversationId: conversation.id,
      actionName: "orders.list",
      toolCallId: "call_list",
      outcome: "success",
    });

    await expectSqlState(
      dbClient.db.delete(user).where(eq(user.id, owner)),
      "23503",
    );
    await dbClient.db.delete(user).where(eq(user.id, other));

    await dbClient.db
      .delete(assistantConversations)
      .where(eq(assistantConversations.id, conversation.id));
    expect(
      await dbClient.db
        .select()
        .from(assistantMessages)
        .where(eq(assistantMessages.conversationId, conversation.id)),
    ).toEqual([]);
    expect(
      await dbClient.db
        .select()
        .from(assistantToolRuns)
        .where(eq(assistantToolRuns.conversationId, conversation.id)),
    ).toEqual([]);

    await dbClient.db.delete(user).where(eq(user.id, owner));
  });

  it("cascades company deletion to conversations, messages, and tool runs", async () => {
    const company = await insertCompany();
    const userId = await insertUser();
    const conversation = await insertConversation({
      companyId: company.id,
      userId,
    });
    const message = await insertMessage({
      companyId: company.id,
      conversationId: conversation.id,
      role: "user",
      body: "wipe",
    });
    const toolRun = await insertToolRun({
      companyId: company.id,
      conversationId: conversation.id,
      actionName: "orders.list",
      toolCallId: "call_wipe",
      outcome: "success",
    });

    await dbClient.db.delete(companies).where(eq(companies.id, company.id));
    expect(
      await dbClient.db
        .select()
        .from(assistantConversations)
        .where(eq(assistantConversations.id, conversation.id)),
    ).toEqual([]);
    expect(
      await dbClient.db
        .select()
        .from(assistantMessages)
        .where(eq(assistantMessages.id, message.id)),
    ).toEqual([]);
    expect(
      await dbClient.db
        .select()
        .from(assistantToolRuns)
        .where(eq(assistantToolRuns.id, toolRun.id)),
    ).toEqual([]);
  });

  it("attaches the shared updated_at trigger to assistant tables", async () => {
    const result = await admin.query<{ tgname: string }>(
      `SELECT t.tgname
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       WHERE NOT t.tgisinternal
         AND t.tgname LIKE '%_set_updated_at'
         AND c.relname IN
           ('assistant_conversations', 'assistant_messages',
            'assistant_tool_runs')
       ORDER BY t.tgname`,
    );
    expect(result.rows.map((row) => row.tgname)).toEqual([
      "assistant_conversations_set_updated_at",
      "assistant_messages_set_updated_at",
      "assistant_tool_runs_set_updated_at",
    ]);

    const company = await insertCompany();
    const userId = await insertUser();
    const conversation = await insertConversation({
      companyId: company.id,
      userId,
      title: "before",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const updated = await dbClient.db
      .update(assistantConversations)
      .set({ title: "after" })
      .where(eq(assistantConversations.id, conversation.id))
      .returning();
    expect(updated[0]?.updatedAt.getTime()).toBeGreaterThan(
      conversation.updatedAt.getTime(),
    );
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
