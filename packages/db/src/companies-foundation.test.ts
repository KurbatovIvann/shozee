/**
 * fnd-T7 verification for the minimal tenant/RBAC prerequisite in
 * companies-foundation.md. Data-path assertions use Drizzle through the
 * runtime role; raw SQL is limited to PostgreSQL catalog structure checks.
 */
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";

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

import {
  rolePermissionDefaultRows,
  seedRolePermissionDefaults,
} from "../seed/index.js";
import type { DbClient } from "./client.js";
import type { UserId } from "./schema/auth-ids.js";
import { user } from "./schema/auth.js";
import {
  companies,
  companyMembers,
  rolePermissionDefaults,
} from "./schema/companies.js";
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
  const id = `company_user_${String(sequence)}`;
  await dbClient.db.insert(user).values({
    id,
    name: `Company User ${String(sequence)}`,
    email: `company-user-${String(sequence)}@example.com`,
  });
  return id;
}

async function insertCompany(
  overrides: Partial<typeof companies.$inferInsert> = {},
) {
  sequence += 1;
  const rows = await dbClient.db
    .insert(companies)
    .values({
      name: `Company ${String(sequence)}`,
      slug: `company-${String(sequence)}`,
      prefix: `C${String(sequence)}`,
      ...overrides,
    })
    .returning();
  const row = rows[0];
  assert.ok(row);
  return row;
}

async function insertMember(
  companyId: string,
  userId: UserId,
  overrides: Partial<typeof companyMembers.$inferInsert> = {},
) {
  const rows = await dbClient.db
    .insert(companyMembers)
    .values({
      companyId,
      userId,
      role: "employee",
      ...overrides,
    })
    .returning();
  const row = rows[0];
  assert.ok(row);
  return row;
}

describe("companies foundation schema", () => {
  it("creates only the phase-0 columns with timestamptz timestamps", async () => {
    const result = await admin.query<{
      table_name: string;
      column_name: string;
      data_type: string;
    }>(
      `SELECT table_name, column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name IN
           ('companies', 'company_members', 'role_permission_defaults')
       ORDER BY table_name, ordinal_position`,
    );
    const columns = new Map<string, string[]>();
    for (const row of result.rows) {
      const names = columns.get(row.table_name) ?? [];
      names.push(row.column_name);
      columns.set(row.table_name, names);
      if (row.column_name.endsWith("_at")) {
        expect(row.data_type).toBe("timestamp with time zone");
      }
    }

    expect(columns.get("companies")).toEqual([
      "id",
      "name",
      "slug",
      "prefix",
      "created_at",
      "updated_at",
    ]);
    expect(columns.get("company_members")).toEqual([
      "id",
      "company_id",
      "user_id",
      "role",
      "permissions",
      "created_at",
      "updated_at",
    ]);
    expect(columns.get("role_permission_defaults")).toEqual([
      "role",
      "permission",
    ]);
  });

  it("uses the generated better-auth user id type without casts", () => {
    expectTypeOf<
      (typeof companyMembers.$inferInsert)["userId"]
    >().toEqualTypeOf<UserId>();
  });

  it("enforces unique company slugs and prefixes", async () => {
    const company = await insertCompany();
    await expectSqlState(
      insertCompany({ slug: company.slug, prefix: "UNIQUEPREFIX" }),
      "23505",
    );
    await expectSqlState(
      insertCompany({ slug: "unique-slug", prefix: company.prefix }),
      "23505",
    );
  });

  it("enforces one membership per company and user plus the role CHECK", async () => {
    const company = await insertCompany();
    const userId = await insertUser();
    await insertMember(company.id, userId);
    await expectSqlState(insertMember(company.id, userId), "23505");

    const secondUserId = await insertUser();
    await expectSqlState(
      insertMember(company.id, secondUserId, { role: "viewer" }),
      "23514",
    );
  });

  it("defaults permission overrides to canonical granted/denied arrays", async () => {
    const company = await insertCompany();
    const member = await insertMember(company.id, await insertUser());
    expect(member.permissions).toEqual({ granted: [], denied: [] });
  });

  it("cascades company deletion but restricts deletion of a referenced user", async () => {
    const company = await insertCompany();
    const userId = await insertUser();
    await insertMember(company.id, userId);

    await expectSqlState(
      dbClient.db.delete(user).where(eq(user.id, userId)),
      "23503",
    );
    await dbClient.db.delete(companies).where(eq(companies.id, company.id));

    expect(
      await dbClient.db
        .select()
        .from(companyMembers)
        .where(eq(companyMembers.companyId, company.id)),
    ).toEqual([]);
    expect(
      await dbClient.db.select().from(user).where(eq(user.id, userId)),
    ).toHaveLength(1);
  });

  it("creates the specified unique and tenant-leading indexes", async () => {
    const result = await admin.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename IN ('companies', 'company_members')`,
    );
    const indexes = new Map(
      result.rows.map((row) => [row.indexname, row.indexdef]),
    );

    expect(indexes.get("companies_slug_uq")).toContain("UNIQUE");
    expect(indexes.get("companies_prefix_uq")).toContain("UNIQUE");
    expect(indexes.get("company_members_company_user_uq")).toContain(
      "(company_id, user_id)",
    );
    expect(indexes.get("company_members_company_id_id_uq")).toContain(
      "(company_id, id)",
    );
    expect(indexes.get("company_members_user_company_idx")).toContain(
      "(user_id, company_id)",
    );
    expect(indexes.get("company_members_company_role_idx")).toContain(
      "(company_id, role)",
    );
  });

  it("attaches the shared updated_at trigger to mutable tables", async () => {
    const company = await insertCompany();
    const member = await insertMember(company.id, await insertUser());
    await new Promise((resolve) => setTimeout(resolve, 20));

    const updatedCompanies = await dbClient.db
      .update(companies)
      .set({ name: "Updated company" })
      .where(eq(companies.id, company.id))
      .returning();
    const updatedMembers = await dbClient.db
      .update(companyMembers)
      .set({ role: "manager" })
      .where(eq(companyMembers.id, member.id))
      .returning();

    expect(updatedCompanies[0]?.updatedAt.getTime()).toBeGreaterThan(
      company.updatedAt.getTime(),
    );
    expect(updatedMembers[0]?.updatedAt.getTime()).toBeGreaterThan(
      member.updatedAt.getTime(),
    );
  });
});

describe("role permission defaults seed", () => {
  it("does not ship the local-dev company/staff/product fixture seed (db.md §9)", async () => {
    const seedDir = path.resolve(import.meta.dirname, "../seed");
    const names = (await readdir(seedDir)).filter((name) =>
      name.endsWith(".ts"),
    );
    expect(names.sort()).toEqual(["index.ts", "role-permission-defaults.ts"]);
  });

  it("is idempotent and never seeds the implicit owner role", async () => {
    const firstRun = await seedRolePermissionDefaults(dbClient.db);
    const secondRun = await seedRolePermissionDefaults(dbClient.db);
    const stored = await dbClient.db.select().from(rolePermissionDefaults);

    expect(firstRun).toHaveLength(rolePermissionDefaultRows.length);
    expect(secondRun).toEqual([]);
    expect(stored).toHaveLength(rolePermissionDefaultRows.length);
    expect(stored.some((row) => row.role === "owner")).toBe(false);
    expect(
      stored.some(
        (row) => row.role === "admin" && row.permission === "settings:payments",
      ),
    ).toBe(true);
    expect(
      stored.some(
        (row) =>
          row.role === "manager" && row.permission === "settings:payments",
      ),
    ).toBe(false);
    expect(
      stored.some(
        (row) =>
          row.role === "employee" && row.permission === "settings:payments",
      ),
    ).toBe(false);
    expect(
      stored.some(
        (row) => row.role === "admin" && row.permission === "companies:view",
      ),
    ).toBe(true);
    expect(
      stored.some(
        (row) => row.role === "manager" && row.permission === "companies:view",
      ),
    ).toBe(true);
    expect(
      stored.some(
        (row) => row.role === "employee" && row.permission === "companies:view",
      ),
    ).toBe(true);
    expect(
      stored.some(
        (row) => row.role === "owner" && row.permission === "companies:view",
      ),
    ).toBe(false);
    expect(
      new Set(stored.map((row) => `${row.role}:${row.permission}`)),
    ).toEqual(
      new Set(
        rolePermissionDefaultRows.map((row) => `${row.role}:${row.permission}`),
      ),
    );
  });

  it("rejects company slugs and prefixes that fail the shape CHECKs", async () => {
    await expectSqlState(insertCompany({ slug: "ab" }), "23514");
    await expectSqlState(insertCompany({ slug: "ABC" }), "23514");
    await expectSqlState(insertCompany({ slug: "-abc" }), "23514");
    await expectSqlState(insertCompany({ prefix: "co" }), "23514");
  });
});
