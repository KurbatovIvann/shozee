/**
 * SHO-223 (companies-T3) verification for `company_legal_info` and the
 * `settings:payments` seed. Data-path assertions use Drizzle through the
 * runtime role; raw SQL is limited to PostgreSQL catalog structure checks.
 */
import assert from "node:assert/strict";

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
import { companies, companyLegalInfo } from "./schema/companies.js";
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

async function insertCompany() {
  sequence += 1;
  const rows = await dbClient.db
    .insert(companies)
    .values({
      name: `Legal Co ${String(sequence)}`,
      slug: `legal-co-${String(sequence)}`,
      prefix: `L${String(sequence)}`,
    })
    .returning();
  const row = rows[0];
  assert.ok(row);
  return row;
}

async function insertLegal(
  companyId: string,
  overrides: Partial<typeof companyLegalInfo.$inferInsert> = {},
) {
  const rows = await dbClient.db
    .insert(companyLegalInfo)
    .values({
      companyId,
      ...overrides,
    })
    .returning();
  const row = rows[0];
  assert.ok(row);
  return row;
}

describe("company_legal_info schema slice", () => {
  it("adds the 1:1 legal table without widening companies identity columns", async () => {
    const identity = await admin.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'companies'
       ORDER BY ordinal_position`,
    );
    expect(identity.rows.map((row) => row.column_name)).toEqual([
      "id",
      "name",
      "slug",
      "prefix",
      "created_at",
      "updated_at",
    ]);
    expect(identity.rows.map((row) => row.column_name)).not.toContain(
      "legal_name",
    );
    expect(identity.rows.map((row) => row.column_name)).not.toContain("edrpou");
    expect(identity.rows.map((row) => row.column_name)).not.toContain("iban");

    const legal = await admin.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'company_legal_info'
       ORDER BY ordinal_position`,
    );
    expect(legal.rows.map((row) => row.column_name)).toEqual([
      "id",
      "company_id",
      "company_type",
      "legal_name",
      "edrpou",
      "legal_address",
      "iban",
      "bank_name",
      "bank_mfo",
      "bank_edrpou",
      "phone",
      "email",
      "created_at",
      "updated_at",
    ]);
    const companyType = legal.rows.find(
      (row) => row.column_name === "company_type",
    );
    expect(companyType?.data_type).toBe("text");
    expect(companyType?.is_nullable).toBe("NO");
    expect(companyType?.column_default).toContain("fop");
    for (const name of [
      "legal_name",
      "edrpou",
      "legal_address",
      "iban",
      "bank_name",
      "bank_mfo",
      "bank_edrpou",
      "phone",
      "email",
    ] as const) {
      const column = legal.rows.find((row) => row.column_name === name);
      expect(column?.data_type).toBe("text");
      expect(column?.is_nullable).toBe("YES");
    }
    for (const name of ["created_at", "updated_at"] as const) {
      const column = legal.rows.find((row) => row.column_name === name);
      expect(column?.data_type).toBe("timestamp with time zone");
      expect(column?.is_nullable).toBe("NO");
    }

    expectTypeOf<
      (typeof companyLegalInfo.$inferSelect)["companyType"]
    >().toEqualTypeOf<string>();
    expectTypeOf<
      (typeof companyLegalInfo.$inferSelect)["legalName"]
    >().toEqualTypeOf<string | null>();

    const buyerFaces = await admin.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
       WHERE table_schema = 'public'
         AND (
           (table_name = 'customer_legal_profiles' AND column_name = 'company_id')
           OR (table_name = 'counterparties' AND column_name = 'bank_edrpou')
         )`,
    );
    expect(buyerFaces.rows).toEqual([]);
  });

  it("declares CHECK, 1:1 unique, ADR-0025 unique pair, and cascade FK", async () => {
    const checks = await admin.query<{
      conname: string;
      definition: string;
    }>(
      `SELECT con.conname, pg_get_constraintdef(con.oid) AS definition
       FROM pg_constraint con
       JOIN pg_class rel ON rel.oid = con.conrelid
       JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
       WHERE nsp.nspname = 'public'
         AND con.contype = 'c'
         AND rel.relname = 'company_legal_info'`,
    );
    const checkDefs = new Map(
      checks.rows.map((row) => [row.conname, row.definition]),
    );
    expect(checkDefs.get("company_legal_info_company_type_check")).toContain(
      "fop",
    );
    expect(checkDefs.get("company_legal_info_company_type_check")).toContain(
      "tov",
    );

    const indexes = await admin.query<{
      indexname: string;
      indexdef: string;
    }>(
      `SELECT indexname, indexdef
       FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'company_legal_info'`,
    );
    const indexDefs = new Map(
      indexes.rows.map((row) => [row.indexname, row.indexdef]),
    );
    expect(indexDefs.get("company_legal_info_company_id_uq")).toContain(
      "UNIQUE",
    );
    expect(indexDefs.get("company_legal_info_company_id_uq")).toContain(
      "(company_id)",
    );
    expect(indexDefs.get("company_legal_info_company_id_id_uq")).toContain(
      "UNIQUE",
    );
    expect(indexDefs.get("company_legal_info_company_id_id_uq")).toContain(
      "(company_id, id)",
    );

    const fks = await admin.query<{
      conname: string;
      definition: string;
    }>(
      `SELECT con.conname, pg_get_constraintdef(con.oid) AS definition
       FROM pg_constraint con
       JOIN pg_class rel ON rel.oid = con.conrelid
       JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
       WHERE nsp.nspname = 'public'
         AND con.contype = 'f'
         AND rel.relname = 'company_legal_info'`,
    );
    const defs = new Map(fks.rows.map((row) => [row.conname, row.definition]));
    expect(defs.get("company_legal_info_company_id_companies_id_fk")).toContain(
      "FOREIGN KEY (company_id) REFERENCES companies(id)",
    );
    expect(defs.get("company_legal_info_company_id_companies_id_fk")).toContain(
      "ON DELETE CASCADE",
    );
  });

  it("does not require a legal row at company create", async () => {
    const company = await insertCompany();
    const rows = await dbClient.db
      .select()
      .from(companyLegalInfo)
      .where(eq(companyLegalInfo.companyId, company.id));
    expect(rows).toEqual([]);
  });

  it("defaults company_type to fop, stores nulls, and rejects other types", async () => {
    const company = await insertCompany();
    const row = await insertLegal(company.id);
    expect(row.companyType).toBe("fop");
    expect(row.legalName).toBeNull();
    expect(row.edrpou).toBeNull();
    expect(row.iban).toBeNull();

    const other = await insertCompany();
    const tov = await insertLegal(other.id, {
      companyType: "tov",
      legalName: "ТОВ Приклад",
    });
    expect(tov.companyType).toBe("tov");
    expect(tov.legalName).toBe("ТОВ Приклад");

    await expectSqlState(
      insertLegal((await insertCompany()).id, { companyType: "llc" }),
      "23514",
    );
  });

  it("enforces one legal row per company and allows one per tenant", async () => {
    const companyA = await insertCompany();
    const companyB = await insertCompany();
    await insertLegal(companyA.id);
    await expectSqlState(insertLegal(companyA.id), "23505");
    const other = await insertLegal(companyB.id);
    expect(other.companyId).toBe(companyB.id);
  });

  it("cascades legal rows when the company is deleted", async () => {
    const company = await insertCompany();
    await insertLegal(company.id, { edrpou: "12345678" });
    await dbClient.db.delete(companies).where(eq(companies.id, company.id));
    expect(
      await dbClient.db
        .select()
        .from(companyLegalInfo)
        .where(eq(companyLegalInfo.companyId, company.id)),
    ).toEqual([]);
  });

  it("attaches the shared updated_at trigger", async () => {
    const result = await admin.query<{ tgname: string }>(
      `SELECT t.tgname
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       WHERE NOT t.tgisinternal
         AND t.tgname LIKE '%_set_updated_at'
         AND c.relname = 'company_legal_info'`,
    );
    expect(result.rows.map((row) => row.tgname)).toEqual([
      "company_legal_info_set_updated_at",
    ]);

    const company = await insertCompany();
    const row = await insertLegal(company.id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const updated = await dbClient.db
      .update(companyLegalInfo)
      .set({ legalName: "ФОП Приклад" })
      .where(eq(companyLegalInfo.id, row.id))
      .returning();
    expect(updated[0]?.updatedAt.getTime()).toBeGreaterThan(
      row.updatedAt.getTime(),
    );
  });

  it("seeds settings:payments for admin only", () => {
    const keys = new Set(
      rolePermissionDefaultRows.map((row) => `${row.role}:${row.permission}`),
    );
    expect(keys.has("admin:settings:payments")).toBe(true);
    expect(keys.has("manager:settings:payments")).toBe(false);
    expect(keys.has("employee:settings:payments")).toBe(false);
    expect(keys.has("owner:settings:payments")).toBe(false);
  });

  it("seeds companies:view for admin, manager, and employee, not owner", () => {
    const keys = new Set(
      rolePermissionDefaultRows.map((row) => `${row.role}:${row.permission}`),
    );
    expect(keys.has("admin:companies:view")).toBe(true);
    expect(keys.has("manager:companies:view")).toBe(true);
    expect(keys.has("employee:companies:view")).toBe(true);
    expect(keys.has("owner:companies:view")).toBe(false);
  });
});
