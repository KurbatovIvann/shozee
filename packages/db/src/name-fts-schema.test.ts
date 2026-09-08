/**
 * SHO-528 (db-T4): generated name `tsvector` + GIN/trgm on six owner
 * name fields. Catalog checks only — no matcher queries.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { eq, getTableColumns } from "drizzle-orm";
import pg from "pg";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  expectTypeOf,
  it,
} from "vitest";

import { projectionGrants } from "./capabilities.js";
import type { DbClient } from "./client.js";
import { products } from "./schema/catalog.js";
import { companies } from "./schema/companies.js";
import { companyCustomers, customerGroups } from "./schema/customers.js";
import { priceLists } from "./schema/pricing.js";
import { tsvector } from "./schema/tsvector.js";
import { createTestDatabase, type TestDatabase } from "./testing/harness.js";

const NAME_FTS_TABLES = [
  "products",
  "product_variants",
  "company_customers",
  "counterparties",
  "price_lists",
  "customer_groups",
] as const;

const migrationsFolder = path.resolve(import.meta.dirname, "../migrations");
const nameFtsMigrationSql = readFileSync(
  path.join(migrationsFolder, "0052_right_blink.sql"),
  "utf8",
);

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

describe("staff name FTS schema (SHO-528)", () => {
  it("does not add schema/search.ts or projection grants", () => {
    expect(
      existsSync(path.resolve(import.meta.dirname, "schema/search.ts")),
    ).toBe(false);
    expect(projectionGrants.size).toBe(0);
  });

  it("declares a tsvector customType and name-only setweight SQL", () => {
    expect(typeof tsvector).toBe("function");
    expect(nameFtsMigrationSql).toContain("GENERATED ALWAYS AS");
    expect(nameFtsMigrationSql).toContain("STORED");
    expect(nameFtsMigrationSql).toContain("setweight");
    expect(nameFtsMigrationSql).toContain("to_tsvector");
    expect(nameFtsMigrationSql).toContain("'simple'::regconfig");
    expect(nameFtsMigrationSql).not.toMatch(/unaccent\s*\(/i);
    expect(nameFtsMigrationSql).not.toContain("customer_name_snapshot");
    expect(nameFtsMigrationSql).not.toContain("order_number");
    expect(nameFtsMigrationSql).not.toContain("document_number");
    expect(getTableColumns(products).nameFts.getSQLType()).toBe("tsvector");
  });

  it("adds STORED/ALWAYS name_fts on the six owner name tables only", async () => {
    const columns = await admin.query<{
      table_name: string;
      column_name: string;
      type_name: string;
      attgenerated: string;
      is_generated: string;
      is_nullable: string;
      generation_expression: string | null;
    }>(
      `SELECT c.relname AS table_name,
              a.attname AS column_name,
              t.typname AS type_name,
              a.attgenerated,
              cols.is_generated,
              cols.is_nullable,
              cols.generation_expression
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_type t ON t.oid = a.atttypid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN information_schema.columns cols
         ON cols.table_schema = n.nspname
        AND cols.table_name = c.relname
        AND cols.column_name = a.attname
       WHERE n.nspname = 'public'
         AND a.attnum > 0
         AND NOT a.attisdropped
         AND t.typname = 'tsvector'
       ORDER BY c.relname`,
    );

    expect(columns.rows.map((row) => row.table_name)).toEqual(
      [...NAME_FTS_TABLES].toSorted(),
    );
    for (const row of columns.rows) {
      expect(row.column_name).toBe("name_fts");
      expect(row.type_name).toBe("tsvector");
      expect(row.attgenerated).toBe("s");
      expect(row.is_generated).toBe("ALWAYS");
      expect(row.is_nullable).toBe("NO");
      const expression = row.generation_expression ?? "";
      expect(expression).toMatch(/setweight/i);
      expect(expression).toMatch(/to_tsvector/i);
      expect(expression).toMatch(/simple/i);
      expect(expression).toMatch(/\bname\b/);
      expect(expression).not.toMatch(/unaccent/i);
      expect(expression).not.toMatch(/phone/i);
      expect(expression).not.toMatch(/email/i);
      expect(expression).not.toMatch(/edrpou/i);
    }
  });

  it("adds GIN on name_fts and gin_trgm_ops on name for each owner table", async () => {
    const indexes = await admin.query<{
      tablename: string;
      indexname: string;
      indexdef: string;
    }>(
      `SELECT tablename, indexname, indexdef
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = ANY($1::text[])`,
      [[...NAME_FTS_TABLES]],
    );
    const byTable = new Map<string, Map<string, string>>();
    for (const row of indexes.rows) {
      const table = byTable.get(row.tablename) ?? new Map<string, string>();
      table.set(row.indexname, row.indexdef);
      byTable.set(row.tablename, table);
    }

    for (const table of NAME_FTS_TABLES) {
      const defs = byTable.get(table);
      assert.ok(defs);
      const trgm = defs.get(`${table}_name_trgm_idx`);
      expect(trgm).toMatch(/USING gin/i);
      expect(trgm).toContain("gin_trgm_ops");
      expect(trgm).toMatch(/\bname\b/);
      expect(trgm).not.toContain("name_fts");
      const fts = defs.get(`${table}_name_fts_gin_idx`);
      expect(fts).toMatch(/USING gin/i);
      expect(fts).toContain("name_fts");
      expect(fts).not.toContain("gin_trgm_ops");
    }
  });

  it("does not put tsvector or GIN FTS on identifiers or the order snapshot", async () => {
    const identifierIndexes = await admin.query<{
      tablename: string;
      indexname: string;
      indexdef: string;
    }>(
      `SELECT tablename, indexname, indexdef
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexdef ILIKE '%USING gin%'
         AND (
           indexdef ILIKE '%order_number%'
           OR indexdef ILIKE '%document_number%'
           OR indexdef ILIKE '%customer_name_snapshot%'
           OR indexdef ILIKE '%edrpou%'
           OR indexdef ILIKE '%phone%'
           OR indexdef ILIKE '%email%'
         )`,
    );
    expect(identifierIndexes.rows).toEqual([]);

    const snapshot = await admin.query<{
      udt_name: string;
      is_generated: string;
    }>(
      `SELECT udt_name, is_generated
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'orders'
         AND column_name = 'customer_name_snapshot'`,
    );
    expect(snapshot.rows).toEqual([
      { udt_name: "text", is_generated: "NEVER" },
    ]);

    const extraTsvector = await admin.query<{
      table_name: string;
      column_name: string;
    }>(
      `SELECT c.relname AS table_name, a.attname AS column_name
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_type t ON t.oid = a.atttypid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND a.attnum > 0
         AND NOT a.attisdropped
         AND t.typname = 'tsvector'
         AND NOT (c.relname = ANY($1::text[]) AND a.attname = 'name_fts')
       ORDER BY 1, 2`,
      [[...NAME_FTS_TABLES]],
    );
    expect(extraTsvector.rows).toEqual([]);
  });

  it("computes name_fts from name and refreshes it on update", async () => {
    sequence += 1;
    const companyRows = await dbClient.db
      .insert(companies)
      .values({
        name: `Name FTS Co ${String(sequence)}`,
        slug: `name-fts-co-${String(sequence)}`,
        prefix: `F${String(sequence)}`,
      })
      .returning();
    const company = companyRows[0];
    assert.ok(company);

    const inserted = await dbClient.db
      .insert(products)
      .values({
        companyId: company.id,
        name: "Макаронс",
        basePriceMinor: 10_000n,
      })
      .returning();
    const product = inserted[0];
    assert.ok(product);
    expect(product.nameFts).toMatch(/макаронс/i);

    const updated = await dbClient.db
      .update(products)
      .set({ name: "Шоколадний" })
      .where(eq(products.id, product.id))
      .returning();
    expect(updated[0]?.nameFts).toMatch(/шоколадний/i);
    expect(updated[0]?.nameFts).not.toMatch(/макаронс/i);
  });

  it("types nameFts as a generated string on the six tables", () => {
    expectTypeOf<
      (typeof products.$inferSelect)["nameFts"]
    >().toEqualTypeOf<string>();
    expectTypeOf<
      (typeof companyCustomers.$inferSelect)["nameFts"]
    >().toEqualTypeOf<string>();
    expectTypeOf<
      (typeof customerGroups.$inferSelect)["nameFts"]
    >().toEqualTypeOf<string>();
    expectTypeOf<
      (typeof priceLists.$inferSelect)["nameFts"]
    >().toEqualTypeOf<string>();
    expectTypeOf<typeof products.$inferInsert>().not.toHaveProperty("nameFts");
  });
});
