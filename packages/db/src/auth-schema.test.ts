/**
 * fnd-T6 verification: the better-auth generated schema (`src/schema/auth.ts`,
 * regenerated only via `pnpm --filter @showzy/api auth:generate`) migrates
 * cleanly, enforces the identity constraints the auth flows rely on (unique
 * email/phone/session token, FK cascade from sessions and accounts to users),
 * and the runtime role can perform the DML better-auth needs. The `userIdColumn`
 * helper is pinned so module FKs to users cannot drift from the generated ID
 * type. There is deliberately no `verification` table: OTP codes live only in
 * TTL'd secondary storage (security-operations §2), never in Postgres.
 *
 * Raw SQL below is test-only structure verification (catalog queries) — not a
 * domain data path (db.md §7).
 */
import { eq } from "drizzle-orm";
import { getTableConfig, pgTable } from "drizzle-orm/pg-core";
import pg from "pg";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from "vitest";

import type { DbClient } from "./client.js";
import { userIdColumn, type UserId } from "./schema/auth-ids.js";
import { account, session, user } from "./schema/auth.js";
import { createTestDatabase, type TestDatabase } from "./testing/harness.js";

let database: TestDatabase;
let dbClient: DbClient;
/** Superuser session for catalog assertions. */
let admin: pg.Client;

beforeAll(async () => {
  database = await createTestDatabase();
  dbClient = database.runtime;
  admin = database.admin;
});

afterAll(async () => {
  await database.close();
});

/** Walks `cause` chains (Drizzle wraps pg errors) to the SQLSTATE code. */
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

let userSeq = 0;
/** Inserts a user through the runtime Drizzle client and returns its id. */
async function insertUser(overrides: Partial<typeof user.$inferInsert> = {}) {
  userSeq += 1;
  const row: typeof user.$inferInsert = {
    id: `user_${String(userSeq)}`,
    name: `Test User ${String(userSeq)}`,
    email: `user${String(userSeq)}@example.com`,
    ...overrides,
  };
  await dbClient.db.insert(user).values(row);
  return row.id;
}

describe("better-auth generated schema (db.md §4)", () => {
  it("creates the user, session, and account tables — and no verification table", async () => {
    const result = await admin.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    const names = result.rows.map(
      (row: { table_name: string }) => row.table_name,
    );
    expect(names).toEqual(
      expect.arrayContaining(["user", "session", "account"]),
    );
    // OTP codes must have nowhere to land in Postgres: verification values
    // live only in TTL'd secondary storage (security-operations §2), so the
    // generator (run with secondaryStorage configured) emits no table.
    expect(names).not.toContain("verification");
  });

  it("uses text ids for users and text FKs everywhere they are referenced", async () => {
    const result = await admin.query(
      `SELECT table_name, column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND (table_name, column_name) IN
           (('user', 'id'), ('session', 'user_id'), ('account', 'user_id'))`,
    );
    for (const row of result.rows as { data_type: string }[]) {
      expect(row.data_type).toBe("text");
    }
    expect(result.rows).toHaveLength(3);
  });

  it("uses timestamptz for every timestamp column (db.md §3)", async () => {
    // The better-auth CLI emits `timestamp without time zone` (upstream
    // better-auth#9920); auth:generate applies a deterministic codemod so the
    // generated schema honors the §3 convention. This pins the result.
    const result = await admin.query(
      `SELECT table_name, column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name IN ('user', 'session', 'account')
         AND data_type LIKE 'timestamp%'`,
    );
    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows as {
      table_name: string;
      column_name: string;
      data_type: string;
    }[]) {
      expect(
        row.data_type,
        `${row.table_name}.${row.column_name} must be timestamptz`,
      ).toBe("timestamp with time zone");
    }
  });

  it("indexes the session and account FKs to users", async () => {
    const result = await admin.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`,
    );
    const names = new Set(
      result.rows.map((row: { indexname: string }) => row.indexname),
    );
    // Upstream camelCase names — deliberate db.md §4 exception to §3 snake_case.
    for (const expected of ["session_userId_idx", "account_userId_idx"]) {
      expect(names.has(expected), `missing index ${expected}`).toBe(true);
    }
  });

  it("keeps upstream $onUpdate semantics — no set_updated_at trigger (db.md §4)", async () => {
    const triggers = await admin.query<{ tgname: string }>(
      `SELECT t.tgname
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_proc p ON p.oid = t.tgfoid
       WHERE n.nspname = 'public'
         AND c.relname IN ('user', 'session', 'account')
         AND NOT t.tgisinternal
         AND p.proname = 'set_updated_at'`,
    );
    expect(triggers.rows).toEqual([]);

    // Pinning Node's clock makes the drizzle write carry a time no clock would
    // produce: a BEFORE UPDATE trigger would overwrite it with Postgres now().
    // Never compare it against a Postgres-written time — the container clock
    // drifts hundreds of ms either side of the host (SHO-556).
    const mark = new Date("2001-02-03T04:05:06.789Z");
    const userId = await insertUser({ name: "Before" });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(mark);
      await dbClient.db
        .update(user)
        .set({ name: "Drizzle" })
        .where(eq(user.id, userId));
    } finally {
      vi.useRealTimers();
    }
    const afterDrizzle = await dbClient.db
      .select({ updatedAt: user.updatedAt })
      .from(user)
      .where(eq(user.id, userId));
    expect(afterDrizzle[0]?.updatedAt.getTime()).toBe(mark.getTime());

    await admin.query(`UPDATE "user" SET name = $2 WHERE id = $1`, [
      userId,
      "Raw",
    ]);
    const afterRaw = await dbClient.db
      .select({ updatedAt: user.updatedAt, name: user.name })
      .from(user)
      .where(eq(user.id, userId));
    expect(afterRaw[0]?.name).toBe("Raw");
    expect(afterRaw[0]?.updatedAt.getTime()).toBe(mark.getTime());
  });
});

describe("identity constraints", () => {
  it("rejects duplicate emails", async () => {
    await insertUser({ email: "dupe@example.com" });
    await expectSqlState(insertUser({ email: "dupe@example.com" }), "23505");
  });

  it("rejects duplicate phone numbers", async () => {
    await insertUser({ phoneNumber: "+380671110001" });
    await expectSqlState(insertUser({ phoneNumber: "+380671110001" }), "23505");
  });

  it("rejects duplicate session tokens", async () => {
    const userId = await insertUser();
    const row: typeof session.$inferInsert = {
      id: "session_dupe_a",
      token: "token-dupe",
      userId,
      expiresAt: new Date(Date.now() + 3_600_000),
    };
    await dbClient.db.insert(session).values(row);
    await expectSqlState(
      dbClient.db.insert(session).values({ ...row, id: "session_dupe_b" }),
      "23505",
    );
  });

  it("rejects sessions and accounts pointing at a missing user", async () => {
    await expectSqlState(
      dbClient.db.insert(session).values({
        id: "session_orphan",
        token: "token-orphan",
        userId: "user_missing",
        expiresAt: new Date(Date.now() + 3_600_000),
      }),
      "23503",
    );
    await expectSqlState(
      dbClient.db.insert(account).values({
        id: "account_orphan",
        accountId: "acc-orphan",
        providerId: "credential",
        userId: "user_missing",
      }),
      "23503",
    );
  });

  it("cascades user deletion to sessions and accounts", async () => {
    const userId = await insertUser();
    await dbClient.db.insert(session).values({
      id: "session_cascade",
      token: "token-cascade",
      userId,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    await dbClient.db.insert(account).values({
      id: "account_cascade",
      accountId: "acc-cascade",
      providerId: "credential",
      userId,
    });

    await dbClient.db.delete(user).where(eq(user.id, userId));

    const sessions = await dbClient.db
      .select()
      .from(session)
      .where(eq(session.userId, userId));
    const accounts = await dbClient.db
      .select()
      .from(account)
      .where(eq(account.userId, userId));
    expect(sessions).toEqual([]);
    expect(accounts).toEqual([]);
  });
});

describe("userIdColumn helper (companies-foundation §2)", () => {
  it("matches the generated user primary-key type exactly", () => {
    expectTypeOf<UserId>().toEqualTypeOf<string>();
    expectTypeOf<UserId>().toEqualTypeOf<(typeof user.$inferSelect)["id"]>();
  });

  it("builds a text column module schemas can attach references() to", () => {
    // Probe table using the exact chain module schema files will use.
    // (Runtime FK behavior is the referencing table's own migration's
    // concern; this table is never migrated.)
    const probe = pgTable("user_fk_probe", {
      userId: userIdColumn("user_id")
        .notNull()
        .references(() => user.id, { onDelete: "restrict" }),
    });
    const config = getTableConfig(probe);
    const column = config.columns[0];
    expect(column?.getSQLType()).toBe("text");
    expect(column?.notNull).toBe(true);
    expect(config.foreignKeys).toHaveLength(1);
  });
});
