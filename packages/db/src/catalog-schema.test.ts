/**
 * SHO-131 (catalog-T3) verification for product/variant status columns and
 * product_media. Data-path assertions use Drizzle through the runtime role;
 * raw SQL is limited to PostgreSQL catalog structure checks.
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

import type { DbClient } from "./client.js";
import type { UserId } from "./schema/auth-ids.js";
import { user } from "./schema/auth.js";
import { productMedia, products, productVariants } from "./schema/catalog.js";
import { companies } from "./schema/companies.js";
import { files } from "./schema/files.js";
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
  const id = `catalog_user_${String(sequence)}`;
  await dbClient.db.insert(user).values({
    id,
    name: `Catalog User ${String(sequence)}`,
    email: `catalog-user-${String(sequence)}@example.com`,
  });
  return id;
}

async function insertCompany() {
  sequence += 1;
  const rows = await dbClient.db
    .insert(companies)
    .values({
      name: `Catalog Co ${String(sequence)}`,
      slug: `catalog-co-${String(sequence)}`,
      prefix: `C${String(sequence)}`,
    })
    .returning();
  const row = rows[0];
  assert.ok(row);
  return row;
}

async function insertProduct(
  companyId: string,
  overrides: Partial<typeof products.$inferInsert> = {},
) {
  const rows = await dbClient.db
    .insert(products)
    .values({
      companyId,
      name: "Fixture product",
      basePriceMinor: 10_000n,
      ...overrides,
    })
    .returning();
  const row = rows[0];
  assert.ok(row);
  return row;
}

async function insertVariant(
  companyId: string,
  productId: string,
  overrides: Partial<typeof productVariants.$inferInsert> = {},
) {
  const rows = await dbClient.db
    .insert(productVariants)
    .values({
      companyId,
      productId,
      name: "Fixture variant",
      ...overrides,
    })
    .returning();
  const row = rows[0];
  assert.ok(row);
  return row;
}

async function insertFile(
  values: Omit<
    typeof files.$inferInsert,
    "purpose" | "mimeType" | "byteSize" | "objectKey"
  > &
    Partial<typeof files.$inferInsert>,
) {
  const id = values.id ?? randomUUID();
  const rows = await dbClient.db
    .insert(files)
    .values({
      id,
      purpose: "catalog",
      mimeType: "image/jpeg",
      byteSize: 0n,
      objectKey: `${values.companyId}/catalog/${id}`,
      ...values,
    })
    .returning();
  const row = rows[0];
  assert.ok(row);
  return row;
}

async function insertMedia(
  values: Omit<typeof productMedia.$inferInsert, "position"> &
    Partial<typeof productMedia.$inferInsert>,
) {
  const rows = await dbClient.db
    .insert(productMedia)
    .values({
      position: 0,
      ...values,
    })
    .returning();
  const row = rows[0];
  assert.ok(row);
  return row;
}

describe("catalog status and product_media schema slice", () => {
  it("adds status columns with active default and the product_media table", async () => {
    const statusColumns = await admin.query<{
      table_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT table_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name IN ('products', 'product_variants')
         AND column_name = 'status'
       ORDER BY table_name`,
    );
    expect(statusColumns.rows).toHaveLength(2);
    expect(statusColumns.rows[0]).toMatchObject({
      table_name: "product_variants",
      data_type: "text",
      is_nullable: "NO",
    });
    expect(statusColumns.rows[1]).toMatchObject({
      table_name: "products",
      data_type: "text",
      is_nullable: "NO",
    });
    expect(statusColumns.rows[0]?.column_default).toContain("active");
    expect(statusColumns.rows[1]?.column_default).toContain("active");

    const media = await admin.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'product_media'
       ORDER BY ordinal_position`,
    );
    expect(media.rows.map((row) => row.column_name)).toEqual([
      "id",
      "company_id",
      "product_id",
      "file_id",
      "position",
      "created_at",
    ]);
    const createdAt = media.rows.find(
      (row) => row.column_name === "created_at",
    );
    expect(createdAt?.data_type).toBe("timestamp with time zone");
    expect(createdAt?.is_nullable).toBe("NO");
    const position = media.rows.find((row) => row.column_name === "position");
    expect(position?.data_type).toBe("integer");
    expect(position?.is_nullable).toBe("NO");
    expect(media.rows.map((row) => row.column_name)).not.toContain(
      "updated_at",
    );

    expectTypeOf<
      (typeof products.$inferSelect)["status"]
    >().toEqualTypeOf<string>();
    expectTypeOf<
      (typeof productVariants.$inferSelect)["status"]
    >().toEqualTypeOf<string>();
    expectTypeOf<
      (typeof productMedia.$inferSelect)["position"]
    >().toEqualTypeOf<number>();
  });

  it("declares status CHECKs, position CHECK, uniques, and list indexes", async () => {
    const checks = await admin.query<{
      relname: string;
      conname: string;
      definition: string;
    }>(
      `SELECT rel.relname,
              con.conname,
              pg_get_constraintdef(con.oid) AS definition
       FROM pg_constraint con
       JOIN pg_class rel ON rel.oid = con.conrelid
       JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
       WHERE nsp.nspname = 'public'
         AND con.contype = 'c'
         AND rel.relname IN ('products', 'product_variants', 'product_media')`,
    );
    const checkDefs = new Map(
      checks.rows.map((row) => [row.conname, row.definition]),
    );
    expect(checkDefs.get("products_status_check")).toContain("active");
    expect(checkDefs.get("products_status_check")).toContain("archived");
    expect(checkDefs.get("product_variants_status_check")).toContain("active");
    expect(checkDefs.get("product_variants_status_check")).toContain(
      "archived",
    );
    expect(checkDefs.get("product_media_position_check")).toContain("position");
    expect(checkDefs.get("product_media_position_check")).toContain(">= 0");

    const indexes = await admin.query<{
      indexname: string;
      indexdef: string;
    }>(
      `SELECT indexname, indexdef
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename IN
           ('products', 'product_variants', 'product_media')`,
    );
    const indexDefs = new Map(
      indexes.rows.map((row) => [row.indexname, row.indexdef]),
    );
    expect(indexDefs.get("products_company_status_idx")).toContain(
      "(company_id, status)",
    );
    const productsCreatedAt = indexDefs.get(
      "products_company_created_at_id_idx",
    );
    expect(productsCreatedAt).toContain("(company_id");
    expect(productsCreatedAt).toMatch(/created_at.*DESC/i);
    expect(productsCreatedAt).toMatch(/id.*DESC/i);
    expect(indexDefs.has("products_company_idx")).toBe(false);
    expect(indexDefs.has("product_variants_company_idx")).toBe(false);
    expect(indexDefs.has("product_media_company_idx")).toBe(false);
    expect(indexDefs.get("product_media_company_id_id_uq")).toContain("UNIQUE");
    expect(indexDefs.get("product_media_company_id_id_uq")).toContain(
      "(company_id, id)",
    );
    expect(indexDefs.get("product_media_product_file_uq")).toContain("UNIQUE");
    expect(indexDefs.get("product_media_product_file_uq")).toContain(
      "(company_id, product_id, file_id)",
    );
    expect(indexDefs.get("product_media_file_idx")).toContain(
      "(company_id, file_id)",
    );
    expect(indexDefs.get("product_media_product_idx")).toContain(
      '(company_id, product_id, "position")',
    );
    const nameTrgm = indexDefs.get("products_name_trgm_idx");
    expect(nameTrgm).toMatch(/USING gin/i);
    expect(nameTrgm).toContain("gin_trgm_ops");
    expect(nameTrgm).toMatch(/\bname\b/);
    const variantTrgm = indexDefs.get("product_variants_name_trgm_idx");
    expect(variantTrgm).toMatch(/USING gin/i);
    expect(variantTrgm).toContain("gin_trgm_ops");
    expect(indexDefs.get("products_name_fts_gin_idx")).toMatch(/USING gin/i);
    expect(indexDefs.get("products_name_fts_gin_idx")).toContain("name_fts");
    expect(indexDefs.get("product_variants_name_fts_gin_idx")).toContain(
      "name_fts",
    );
  });

  it("declares composite same-tenant FKs with cascade on product and restrict on file", async () => {
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
         AND rel.relname = 'product_media'`,
    );
    const defs = new Map(
      result.rows.map((row) => [row.conname, row.definition]),
    );

    expect(defs.get("product_media_products_company_fk")).toContain(
      "(company_id, product_id) REFERENCES products(company_id, id)",
    );
    expect(defs.get("product_media_products_company_fk")).toContain(
      "ON DELETE CASCADE",
    );
    expect(defs.get("product_media_files_company_fk")).toContain(
      "(company_id, file_id) REFERENCES files(company_id, id)",
    );
    expect(defs.get("product_media_files_company_fk")).toContain(
      "ON DELETE RESTRICT",
    );
    expect(defs.get("product_media_company_id_companies_id_fk")).toContain(
      "FOREIGN KEY (company_id) REFERENCES companies(id)",
    );
    expect(defs.get("product_media_company_id_companies_id_fk")).toContain(
      "ON DELETE CASCADE",
    );
  });

  it("does not attach an updated_at trigger to product_media", async () => {
    const result = await admin.query<{ tgname: string }>(
      `SELECT t.tgname
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       WHERE NOT t.tgisinternal
         AND t.tgname LIKE '%_set_updated_at'
         AND c.relname = 'product_media'`,
    );
    expect(result.rows).toEqual([]);
  });

  it("defaults status to active and rejects illegal status and negative position", async () => {
    const company = await insertCompany();
    const userId = await insertUser();
    const product = await insertProduct(company.id);
    expect(product.status).toBe("active");

    const variant = await insertVariant(company.id, product.id);
    expect(variant.status).toBe("active");

    const archived = await insertProduct(company.id, { status: "archived" });
    expect(archived.status).toBe("archived");
    const archivedVariant = await insertVariant(company.id, product.id, {
      status: "archived",
    });
    expect(archivedVariant.status).toBe("archived");

    await expectSqlState(
      insertProduct(company.id, { status: "draft" }),
      "23514",
    );
    await expectSqlState(
      insertVariant(company.id, product.id, { status: "hidden" }),
      "23514",
    );

    const file = await insertFile({
      companyId: company.id,
      uploadedByUserId: userId,
    });
    await expectSqlState(
      insertMedia({
        companyId: company.id,
        productId: product.id,
        fileId: file.id,
        position: -1,
      }),
      "23514",
    );
    const media = await insertMedia({
      companyId: company.id,
      productId: product.id,
      fileId: file.id,
      position: 0,
    });
    expect(media.position).toBe(0);
  });

  it("rejects a media row that points at another tenant's product or file", async () => {
    const companyA = await insertCompany();
    const companyB = await insertCompany();
    const userA = await insertUser();
    const userB = await insertUser();
    const productA = await insertProduct(companyA.id);
    const productB = await insertProduct(companyB.id);
    const fileA = await insertFile({
      companyId: companyA.id,
      uploadedByUserId: userA,
    });
    const fileB = await insertFile({
      companyId: companyB.id,
      uploadedByUserId: userB,
    });

    await expectSqlState(
      insertMedia({
        companyId: companyA.id,
        productId: productB.id,
        fileId: fileA.id,
      }),
      "23503",
    );
    await expectSqlState(
      insertMedia({
        companyId: companyA.id,
        productId: productA.id,
        fileId: fileB.id,
      }),
      "23503",
    );
  });

  it("keeps a file unique per product and allows the same file on another product", async () => {
    const company = await insertCompany();
    const userId = await insertUser();
    const productA = await insertProduct(company.id);
    const productB = await insertProduct(company.id);
    const file = await insertFile({
      companyId: company.id,
      uploadedByUserId: userId,
    });

    await insertMedia({
      companyId: company.id,
      productId: productA.id,
      fileId: file.id,
    });
    await expectSqlState(
      insertMedia({
        companyId: company.id,
        productId: productA.id,
        fileId: file.id,
        position: 1,
      }),
      "23505",
    );

    const onOtherProduct = await insertMedia({
      companyId: company.id,
      productId: productB.id,
      fileId: file.id,
    });
    expect(onOtherProduct.productId).toBe(productB.id);
    expect(onOtherProduct.fileId).toBe(file.id);
  });

  it("cascades product deletion to media and restricts deleting a linked file", async () => {
    const company = await insertCompany();
    const userId = await insertUser();
    const product = await insertProduct(company.id);
    const file = await insertFile({
      companyId: company.id,
      uploadedByUserId: userId,
    });
    const media = await insertMedia({
      companyId: company.id,
      productId: product.id,
      fileId: file.id,
    });

    await expectSqlState(
      dbClient.db.delete(files).where(eq(files.id, file.id)),
      "23503",
    );
    expect(
      await dbClient.db
        .select()
        .from(productMedia)
        .where(eq(productMedia.id, media.id)),
    ).toHaveLength(1);

    await dbClient.db.delete(products).where(eq(products.id, product.id));
    expect(
      await dbClient.db
        .select()
        .from(productMedia)
        .where(eq(productMedia.id, media.id)),
    ).toEqual([]);

    await dbClient.db.delete(files).where(eq(files.id, file.id));
    expect(
      await dbClient.db.select().from(files).where(eq(files.id, file.id)),
    ).toEqual([]);
  });

  it("cascades company deletion to product_media", async () => {
    const company = await insertCompany();
    const userId = await insertUser();
    const product = await insertProduct(company.id);
    const file = await insertFile({
      companyId: company.id,
      uploadedByUserId: userId,
    });
    await insertMedia({
      companyId: company.id,
      productId: product.id,
      fileId: file.id,
    });

    await dbClient.db.delete(companies).where(eq(companies.id, company.id));
    expect(
      await dbClient.db
        .select()
        .from(productMedia)
        .where(eq(productMedia.companyId, company.id)),
    ).toEqual([]);
  });

  it("rejects non-ISO currency and allows a null variant currency with a null price", async () => {
    const company = await insertCompany();
    const product = await insertProduct(company.id);

    await expectSqlState(
      insertProduct(company.id, { currency: "uah" }),
      "23514",
    );
    await expectSqlState(
      insertProduct(company.id, { currency: "US" }),
      "23514",
    );
    await expectSqlState(
      insertProduct(company.id, { currency: "UA1" }),
      "23514",
    );
    await expectSqlState(
      insertProduct(company.id, { currency: "UAH1" }),
      "22001",
    );

    const withoutOverride = await insertVariant(company.id, product.id);
    expect(withoutOverride.currency).toBeNull();
    expect(withoutOverride.basePriceMinor).toBeNull();

    await expectSqlState(
      insertVariant(company.id, product.id, {
        basePriceMinor: 1_000n,
        currency: "uah",
      }),
      "23514",
    );
  });
});
