/**
 * SHO-85 (pricing-T1) verification for the price-resolution schema slice:
 * catalog (minimal products/variants), customers (minimal CRM pricing
 * links), and pricing (price lists, entries, personal prices). Data-path
 * assertions use Drizzle through the runtime role; raw SQL is limited to
 * PostgreSQL catalog structure checks.
 */
import assert from "node:assert/strict";

import { eq, isNull } from "drizzle-orm";
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
import { products, productVariants } from "./schema/catalog.js";
import { companies } from "./schema/companies.js";
import { companyCustomers, customerGroups } from "./schema/customers.js";
import {
  personalPrices,
  priceListEntries,
  priceLists,
} from "./schema/pricing.js";
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
      name: `Pricing Co ${String(sequence)}`,
      slug: `pricing-co-${String(sequence)}`,
      prefix: `P${String(sequence)}`,
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

async function insertPriceList(
  companyId: string,
  overrides: Partial<typeof priceLists.$inferInsert> = {},
) {
  const rows = await dbClient.db
    .insert(priceLists)
    .values({ companyId, name: "Price list", ...overrides })
    .returning();
  const row = rows[0];
  assert.ok(row);
  return row;
}

async function insertEntry(
  values: Omit<typeof priceListEntries.$inferInsert, "priceMinor"> & {
    priceMinor?: bigint;
  },
) {
  const rows = await dbClient.db
    .insert(priceListEntries)
    .values({ priceMinor: 5_000n, ...values })
    .returning();
  const row = rows[0];
  assert.ok(row);
  return row;
}

async function insertGroup(
  companyId: string,
  overrides: Partial<typeof customerGroups.$inferInsert> = {},
) {
  sequence += 1;
  const rows = await dbClient.db
    .insert(customerGroups)
    .values({
      companyId,
      name: `Fixture group ${String(sequence)}`,
      slug: `fixture-group-${String(sequence)}`,
      ...overrides,
    })
    .returning();
  const row = rows[0];
  assert.ok(row);
  return row;
}

async function insertCustomer(
  companyId: string,
  overrides: Partial<typeof companyCustomers.$inferInsert> = {},
) {
  sequence += 1;
  const rows = await dbClient.db
    .insert(companyCustomers)
    .values({
      companyId,
      name: `Fixture customer ${String(sequence)}`,
      email: `fixture-customer-${String(sequence)}@example.com`,
      ...overrides,
    })
    .returning();
  const row = rows[0];
  assert.ok(row);
  return row;
}

async function insertPersonalPrice(
  values: Omit<typeof personalPrices.$inferInsert, "priceMinor"> & {
    priceMinor?: bigint;
  },
) {
  const rows = await dbClient.db
    .insert(personalPrices)
    .values({ priceMinor: 4_000n, ...values })
    .returning();
  const row = rows[0];
  assert.ok(row);
  return row;
}

describe("price resolution schema slice", () => {
  it("creates only the card-named columns with timestamptz timestamps", async () => {
    const result = await admin.query<{
      table_name: string;
      column_name: string;
      data_type: string;
    }>(
      `SELECT table_name, column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name IN
           ('products', 'product_variants', 'customer_groups',
            'company_customers', 'price_lists', 'price_list_entries',
            'personal_prices')
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
      if (row.column_name.endsWith("_minor")) {
        expect(row.data_type).toBe("bigint");
      }
    }

    expect(columns.get("products")).toEqual([
      "id",
      "company_id",
      "base_price_minor",
      "currency",
      "created_at",
      "updated_at",
      "name",
      "status",
      "created_via",
      "vouched_by",
      "vouched_at",
      "name_fts",
    ]);
    expect(columns.get("product_variants")).toEqual([
      "id",
      "company_id",
      "product_id",
      "base_price_minor",
      "currency",
      "created_at",
      "updated_at",
      "name",
      "status",
      "created_via",
      "vouched_by",
      "vouched_at",
      "name_fts",
    ]);
    expect(columns.get("customer_groups")).toEqual([
      "id",
      "company_id",
      "price_list_id",
      "created_at",
      "updated_at",
      "name",
      "slug",
      "description",
      "sort_order",
      "created_via",
      "vouched_by",
      "vouched_at",
      "name_fts",
    ]);
    expect(columns.get("company_customers")).toEqual([
      "id",
      "company_id",
      "group_id",
      "price_list_id",
      "created_at",
      "updated_at",
      "name",
      "phone",
      "email",
      "user_id",
      "notes",
      "status",
      "created_via",
      "vouched_by",
      "vouched_at",
      "name_fts",
    ]);
    expect(columns.get("price_lists")).toEqual([
      "id",
      "company_id",
      "is_active",
      "is_default",
      "created_at",
      "updated_at",
      "name",
      "created_via",
      "vouched_by",
      "vouched_at",
      "name_fts",
    ]);
    expect(columns.get("price_list_entries")).toEqual([
      "id",
      "company_id",
      "price_list_id",
      "product_id",
      "variant_id",
      "price_minor",
      "currency",
      "created_at",
      "updated_at",
    ]);
    expect(columns.get("personal_prices")).toEqual([
      "id",
      "company_id",
      "customer_id",
      "product_id",
      "variant_id",
      "price_minor",
      "currency",
      "created_at",
      "updated_at",
    ]);
  });

  it("requires a text name on price_lists", async () => {
    const result = await admin.query<{
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT table_name, column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'price_lists'
         AND column_name = 'name'`,
    );
    expect(result.rows).toEqual([
      {
        table_name: "price_lists",
        column_name: "name",
        data_type: "text",
        is_nullable: "NO",
        column_default: null,
      },
    ]);
    expectTypeOf<
      (typeof priceLists.$inferInsert)["name"]
    >().toEqualTypeOf<string>();

    const checks = await admin.query<{
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
         AND rel.relname = 'price_lists'
         AND con.conname = 'price_lists_name_length_check'`,
    );
    expect(checks.rows).toHaveLength(1);
    expect(checks.rows[0]?.definition).toContain("char_length");
    expect(checks.rows[0]?.definition).toContain("120");

    const company = await insertCompany();
    await expectSqlState(insertPriceList(company.id, { name: "" }), "23514");
    await expectSqlState(
      insertPriceList(company.id, { name: "x".repeat(121) }),
      "23514",
    );
    const max = await insertPriceList(company.id, { name: "x".repeat(120) });
    expect(max.name).toHaveLength(120);
  });

  it("requires a text name on products and product_variants", async () => {
    const result = await admin.query<{
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      `SELECT table_name, column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name IN ('products', 'product_variants')
         AND column_name = 'name'
       ORDER BY table_name`,
    );
    expect(result.rows).toEqual([
      {
        table_name: "product_variants",
        column_name: "name",
        data_type: "text",
        is_nullable: "NO",
      },
      {
        table_name: "products",
        column_name: "name",
        data_type: "text",
        is_nullable: "NO",
      },
    ]);
    expectTypeOf<
      (typeof products.$inferInsert)["name"]
    >().toEqualTypeOf<string>();
    expectTypeOf<
      (typeof productVariants.$inferInsert)["name"]
    >().toEqualTypeOf<string>();
  });

  it("represents money columns as bigint in TypeScript", () => {
    expectTypeOf<
      (typeof products.$inferInsert)["basePriceMinor"]
    >().toEqualTypeOf<bigint>();
    expectTypeOf<
      (typeof priceListEntries.$inferInsert)["priceMinor"]
    >().toEqualTypeOf<bigint>();
    expectTypeOf<
      (typeof personalPrices.$inferInsert)["priceMinor"]
    >().toEqualTypeOf<bigint>();
  });

  it("rejects negative prices and accepts zero on every money column", async () => {
    const company = await insertCompany();
    const product = await insertProduct(company.id);
    const list = await insertPriceList(company.id);
    const customer = await insertCustomer(company.id);

    await expectSqlState(
      insertProduct(company.id, { basePriceMinor: -1n }),
      "23514",
    );
    await expectSqlState(
      insertVariant(company.id, product.id, {
        basePriceMinor: -1n,
        currency: "UAH",
      }),
      "23514",
    );
    await expectSqlState(
      insertEntry({
        companyId: company.id,
        priceListId: list.id,
        productId: product.id,
        priceMinor: -1n,
      }),
      "23514",
    );
    await expectSqlState(
      insertPersonalPrice({
        companyId: company.id,
        customerId: customer.id,
        productId: product.id,
        priceMinor: -1n,
      }),
      "23514",
    );

    const freeProduct = await insertProduct(company.id, {
      basePriceMinor: 0n,
    });
    expect(freeProduct.basePriceMinor).toBe(0n);
    const freeVariant = await insertVariant(company.id, product.id, {
      basePriceMinor: 0n,
      currency: "UAH",
    });
    expect(freeVariant.basePriceMinor).toBe(0n);
    const freeEntry = await insertEntry({
      companyId: company.id,
      priceListId: list.id,
      productId: freeProduct.id,
      priceMinor: 0n,
    });
    expect(freeEntry.priceMinor).toBe(0n);
    const freePersonal = await insertPersonalPrice({
      companyId: company.id,
      customerId: customer.id,
      productId: freeProduct.id,
      priceMinor: 0n,
    });
    expect(freePersonal.priceMinor).toBe(0n);
  });

  it("requires the variant base-price override and currency together", async () => {
    const company = await insertCompany();
    const product = await insertProduct(company.id);

    await expectSqlState(
      insertVariant(company.id, product.id, { basePriceMinor: 1_000n }),
      "23514",
    );
    await expectSqlState(
      insertVariant(company.id, product.id, { currency: "UAH" }),
      "23514",
    );

    const withoutOverride = await insertVariant(company.id, product.id);
    expect(withoutOverride.basePriceMinor).toBeNull();
    expect(withoutOverride.currency).toBeNull();

    const withOverride = await insertVariant(company.id, product.id, {
      basePriceMinor: 1_000n,
      currency: "UAH",
    });
    expect(withOverride.basePriceMinor).toBe(1_000n);
    expect(withOverride.currency).toBe("UAH");
  });

  it("allows at most one default price list per company", async () => {
    const company = await insertCompany();
    const otherCompany = await insertCompany();

    await insertPriceList(company.id, { isDefault: true });
    await expectSqlState(
      insertPriceList(company.id, { isDefault: true }),
      "23505",
    );

    await insertPriceList(otherCompany.id, { isDefault: true });
    await insertPriceList(company.id);
    await insertPriceList(company.id);
  });

  it("enforces the four partial unique entry indexes", async () => {
    const company = await insertCompany();
    const product = await insertProduct(company.id);
    const variantA = await insertVariant(company.id, product.id);
    const variantB = await insertVariant(company.id, product.id);
    const list = await insertPriceList(company.id);
    const customer = await insertCustomer(company.id);

    // Product-level and variant-level entries coexist within one list.
    await insertEntry({
      companyId: company.id,
      priceListId: list.id,
      productId: product.id,
    });
    await insertEntry({
      companyId: company.id,
      priceListId: list.id,
      productId: product.id,
      variantId: variantA.id,
    });
    await insertEntry({
      companyId: company.id,
      priceListId: list.id,
      productId: product.id,
      variantId: variantB.id,
    });

    await expectSqlState(
      insertEntry({
        companyId: company.id,
        priceListId: list.id,
        productId: product.id,
      }),
      "23505",
    );
    await expectSqlState(
      insertEntry({
        companyId: company.id,
        priceListId: list.id,
        productId: product.id,
        variantId: variantA.id,
      }),
      "23505",
    );

    await insertPersonalPrice({
      companyId: company.id,
      customerId: customer.id,
      productId: product.id,
    });
    await insertPersonalPrice({
      companyId: company.id,
      customerId: customer.id,
      productId: product.id,
      variantId: variantA.id,
    });

    await expectSqlState(
      insertPersonalPrice({
        companyId: company.id,
        customerId: customer.id,
        productId: product.id,
      }),
      "23505",
    );
    await expectSqlState(
      insertPersonalPrice({
        companyId: company.id,
        customerId: customer.id,
        productId: product.id,
        variantId: variantA.id,
      }),
      "23505",
    );
  });

  it("declares the partial unique indexes and tenant-leading indexes in DDL", async () => {
    const result = await admin.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename IN
           ('price_lists', 'price_list_entries', 'personal_prices')`,
    );
    const indexes = new Map(
      result.rows.map((row) => [row.indexname, row.indexdef]),
    );

    const defaultUq = indexes.get("price_lists_company_default_uq");
    expect(defaultUq).toContain("UNIQUE");
    expect(defaultUq).toContain("WHERE (is_default = true)");

    const listProductUq = indexes.get("price_list_entries_list_product_uq");
    expect(listProductUq).toContain("UNIQUE");
    expect(listProductUq).toContain("(price_list_id, product_id)");
    expect(listProductUq).toContain("WHERE (variant_id IS NULL)");

    const listVariantUq = indexes.get("price_list_entries_list_variant_uq");
    expect(listVariantUq).toContain("UNIQUE");
    expect(listVariantUq).toContain("(price_list_id, product_id, variant_id)");
    expect(listVariantUq).toContain("WHERE (variant_id IS NOT NULL)");

    const customerProductUq = indexes.get(
      "personal_prices_customer_product_uq",
    );
    expect(customerProductUq).toContain("UNIQUE");
    expect(customerProductUq).toContain("(customer_id, product_id)");
    expect(customerProductUq).toContain("WHERE (variant_id IS NULL)");

    const customerVariantUq = indexes.get(
      "personal_prices_customer_variant_uq",
    );
    expect(customerVariantUq).toContain("UNIQUE");
    expect(customerVariantUq).toContain(
      "(customer_id, product_id, variant_id)",
    );
    expect(customerVariantUq).toContain("WHERE (variant_id IS NOT NULL)");

    expect(indexes.has("price_lists_company_idx")).toBe(false);
    expect(indexes.get("price_lists_name_trgm_idx")).toMatch(/USING gin/i);
    expect(indexes.get("price_lists_name_trgm_idx")).toContain("gin_trgm_ops");
    expect(indexes.get("price_lists_name_fts_gin_idx")).toMatch(/USING gin/i);
    expect(indexes.get("price_lists_name_fts_gin_idx")).toContain("name_fts");
    expect(indexes.has("price_list_entries_company_idx")).toBe(false);
    expect(indexes.get("price_list_entries_price_list_idx")).toContain(
      "(price_list_id)",
    );
    expect(indexes.has("personal_prices_company_idx")).toBe(false);
    expect(indexes.get("personal_prices_customer_idx")).toContain(
      "(customer_id)",
    );

    for (const name of [
      "price_lists_company_id_id_uq",
      "price_list_entries_company_id_id_uq",
      "personal_prices_company_id_id_uq",
    ]) {
      expect(indexes.get(name)).toContain("UNIQUE");
      expect(indexes.get(name)).toContain("(company_id, id)");
    }
  });

  it("declares UNIQUE (company_id, id) on every slice tenant table", async () => {
    const result = await admin.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname LIKE '%_company_id_id_uq'`,
    );
    const indexes = new Map(
      result.rows.map((row) => [row.indexname, row.indexdef]),
    );
    for (const name of [
      "products_company_id_id_uq",
      "product_variants_company_id_id_uq",
      "customer_groups_company_id_id_uq",
      "company_customers_company_id_id_uq",
      "price_lists_company_id_id_uq",
      "price_list_entries_company_id_id_uq",
      "personal_prices_company_id_id_uq",
    ]) {
      expect(indexes.get(name)).toContain("UNIQUE");
      expect(indexes.get(name)).toContain("(company_id, id)");
    }
  });

  it("declares composite same-tenant foreign keys (ADR-0025)", async () => {
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
         AND rel.relname IN
           ('product_variants', 'customer_groups', 'company_customers',
            'price_list_entries', 'personal_prices')
       ORDER BY con.conname`,
    );
    const defs = new Map(
      result.rows.map((row) => [row.conname, row.definition]),
    );

    expect(defs.get("product_variants_products_company_fk")).toContain(
      "(company_id, product_id) REFERENCES products(company_id, id)",
    );
    expect(defs.get("customer_groups_price_lists_company_fk")).toContain(
      "(company_id, price_list_id) REFERENCES price_lists(company_id, id)",
    );
    expect(defs.get("customer_groups_price_lists_company_fk")).toContain(
      "ON DELETE SET NULL (price_list_id)",
    );
    expect(defs.get("company_customers_customer_groups_company_fk")).toContain(
      "(company_id, group_id) REFERENCES customer_groups(company_id, id)",
    );
    expect(defs.get("company_customers_customer_groups_company_fk")).toContain(
      "ON DELETE SET NULL (group_id)",
    );
    expect(defs.get("company_customers_price_lists_company_fk")).toContain(
      "(company_id, price_list_id) REFERENCES price_lists(company_id, id)",
    );
    expect(defs.get("company_customers_price_lists_company_fk")).toContain(
      "ON DELETE SET NULL (price_list_id)",
    );
    expect(defs.get("price_list_entries_price_lists_company_fk")).toContain(
      "(company_id, price_list_id) REFERENCES price_lists(company_id, id)",
    );
    expect(defs.get("price_list_entries_products_company_fk")).toContain(
      "(company_id, product_id) REFERENCES products(company_id, id)",
    );
    expect(
      defs.get("price_list_entries_product_variants_company_fk"),
    ).toContain(
      "(company_id, variant_id) REFERENCES product_variants(company_id, id)",
    );
    expect(defs.get("personal_prices_company_customers_company_fk")).toContain(
      "(company_id, customer_id) REFERENCES company_customers(company_id, id)",
    );
    expect(defs.get("personal_prices_products_company_fk")).toContain(
      "(company_id, product_id) REFERENCES products(company_id, id)",
    );
    expect(defs.get("personal_prices_product_variants_company_fk")).toContain(
      "(company_id, variant_id) REFERENCES product_variants(company_id, id)",
    );
  });

  it("rejects a child row that points at another tenant's parent", async () => {
    const companyA = await insertCompany();
    const companyB = await insertCompany();
    const productA = await insertProduct(companyA.id);
    const productB = await insertProduct(companyB.id);
    const variantB = await insertVariant(companyB.id, productB.id);
    const listA = await insertPriceList(companyA.id);
    const listB = await insertPriceList(companyB.id);
    const groupB = await insertGroup(companyB.id);
    const customerA = await insertCustomer(companyA.id);
    const customerB = await insertCustomer(companyB.id);

    await expectSqlState(insertVariant(companyA.id, productB.id), "23503");
    await expectSqlState(
      insertGroup(companyA.id, { priceListId: listB.id }),
      "23503",
    );
    await expectSqlState(
      insertCustomer(companyA.id, { groupId: groupB.id }),
      "23503",
    );
    await expectSqlState(
      insertCustomer(companyA.id, { priceListId: listB.id }),
      "23503",
    );
    await expectSqlState(
      insertEntry({
        companyId: companyA.id,
        priceListId: listB.id,
        productId: productA.id,
      }),
      "23503",
    );
    await expectSqlState(
      insertEntry({
        companyId: companyA.id,
        priceListId: listA.id,
        productId: productB.id,
      }),
      "23503",
    );
    await expectSqlState(
      insertEntry({
        companyId: companyA.id,
        priceListId: listA.id,
        productId: productA.id,
        variantId: variantB.id,
      }),
      "23503",
    );
    await expectSqlState(
      insertPersonalPrice({
        companyId: companyA.id,
        customerId: customerB.id,
        productId: productA.id,
      }),
      "23503",
    );
    await expectSqlState(
      insertPersonalPrice({
        companyId: companyA.id,
        customerId: customerA.id,
        productId: productB.id,
      }),
      "23503",
    );
    await expectSqlState(
      insertPersonalPrice({
        companyId: companyA.id,
        customerId: customerA.id,
        productId: productA.id,
        variantId: variantB.id,
      }),
      "23503",
    );
  });

  it("cascades product deletion to variants, entries, and personal prices", async () => {
    const company = await insertCompany();
    const product = await insertProduct(company.id);
    const variant = await insertVariant(company.id, product.id);
    const list = await insertPriceList(company.id);
    const customer = await insertCustomer(company.id);
    await insertEntry({
      companyId: company.id,
      priceListId: list.id,
      productId: product.id,
      variantId: variant.id,
    });
    await insertPersonalPrice({
      companyId: company.id,
      customerId: customer.id,
      productId: product.id,
    });

    await dbClient.db.delete(products).where(eq(products.id, product.id));

    expect(
      await dbClient.db
        .select()
        .from(productVariants)
        .where(eq(productVariants.productId, product.id)),
    ).toEqual([]);
    expect(
      await dbClient.db
        .select()
        .from(priceListEntries)
        .where(eq(priceListEntries.productId, product.id)),
    ).toEqual([]);
    expect(
      await dbClient.db
        .select()
        .from(personalPrices)
        .where(eq(personalPrices.productId, product.id)),
    ).toEqual([]);
  });

  it("cascades variant deletion to variant rows but keeps product-level rows", async () => {
    const company = await insertCompany();
    const product = await insertProduct(company.id);
    const variant = await insertVariant(company.id, product.id);
    const list = await insertPriceList(company.id);
    const customer = await insertCustomer(company.id);
    await insertEntry({
      companyId: company.id,
      priceListId: list.id,
      productId: product.id,
    });
    await insertEntry({
      companyId: company.id,
      priceListId: list.id,
      productId: product.id,
      variantId: variant.id,
    });
    await insertPersonalPrice({
      companyId: company.id,
      customerId: customer.id,
      productId: product.id,
    });
    await insertPersonalPrice({
      companyId: company.id,
      customerId: customer.id,
      productId: product.id,
      variantId: variant.id,
    });

    await dbClient.db
      .delete(productVariants)
      .where(eq(productVariants.id, variant.id));

    const remainingEntries = await dbClient.db
      .select()
      .from(priceListEntries)
      .where(eq(priceListEntries.productId, product.id));
    expect(remainingEntries).toHaveLength(1);
    expect(remainingEntries[0]?.variantId).toBeNull();

    const remainingPersonal = await dbClient.db
      .select()
      .from(personalPrices)
      .where(eq(personalPrices.productId, product.id));
    expect(remainingPersonal).toHaveLength(1);
    expect(remainingPersonal[0]?.variantId).toBeNull();
  });

  it("cascades price list deletion to entries and unlinks customers and groups", async () => {
    const company = await insertCompany();
    const product = await insertProduct(company.id);
    const list = await insertPriceList(company.id);
    const group = await insertGroup(company.id, { priceListId: list.id });
    const customer = await insertCustomer(company.id, {
      groupId: group.id,
      priceListId: list.id,
    });
    await insertEntry({
      companyId: company.id,
      priceListId: list.id,
      productId: product.id,
    });

    await dbClient.db.delete(priceLists).where(eq(priceLists.id, list.id));

    expect(
      await dbClient.db
        .select()
        .from(priceListEntries)
        .where(eq(priceListEntries.priceListId, list.id)),
    ).toEqual([]);

    const groups = await dbClient.db
      .select()
      .from(customerGroups)
      .where(eq(customerGroups.id, group.id));
    expect(groups[0]?.priceListId).toBeNull();

    const customers = await dbClient.db
      .select()
      .from(companyCustomers)
      .where(eq(companyCustomers.id, customer.id));
    expect(customers[0]?.priceListId).toBeNull();
    expect(customers[0]?.groupId).toBe(group.id);
  });

  it("cascades customer deletion to personal prices and group deletion unlinks members", async () => {
    const company = await insertCompany();
    const product = await insertProduct(company.id);
    const group = await insertGroup(company.id);
    const customer = await insertCustomer(company.id, { groupId: group.id });
    await insertPersonalPrice({
      companyId: company.id,
      customerId: customer.id,
      productId: product.id,
    });

    await dbClient.db
      .delete(companyCustomers)
      .where(eq(companyCustomers.id, customer.id));
    expect(
      await dbClient.db
        .select()
        .from(personalPrices)
        .where(eq(personalPrices.customerId, customer.id)),
    ).toEqual([]);

    const groupedCustomer = await insertCustomer(company.id, {
      groupId: group.id,
    });
    await dbClient.db
      .delete(customerGroups)
      .where(eq(customerGroups.id, group.id));
    const remaining = await dbClient.db
      .select()
      .from(companyCustomers)
      .where(eq(companyCustomers.id, groupedCustomer.id));
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.groupId).toBeNull();
  });

  it("cascades company deletion across all seven slice tables", async () => {
    const company = await insertCompany();
    const product = await insertProduct(company.id);
    const variant = await insertVariant(company.id, product.id);
    const list = await insertPriceList(company.id, { isDefault: true });
    const group = await insertGroup(company.id, { priceListId: list.id });
    const customer = await insertCustomer(company.id, {
      groupId: group.id,
      priceListId: list.id,
    });
    await insertEntry({
      companyId: company.id,
      priceListId: list.id,
      productId: product.id,
      variantId: variant.id,
    });
    await insertPersonalPrice({
      companyId: company.id,
      customerId: customer.id,
      productId: product.id,
    });

    await dbClient.db.delete(companies).where(eq(companies.id, company.id));

    for (const table of [
      products,
      productVariants,
      customerGroups,
      companyCustomers,
      priceLists,
      priceListEntries,
      personalPrices,
    ] as const) {
      expect(
        await dbClient.db
          .select()
          .from(table)
          .where(eq(table.companyId, company.id)),
      ).toEqual([]);
    }
  });

  it("attaches the shared updated_at trigger to every slice table", async () => {
    const result = await admin.query<{ tgname: string }>(
      `SELECT tgname
       FROM pg_trigger
       WHERE NOT tgisinternal AND tgname LIKE '%_set_updated_at'`,
    );
    const triggers = new Set(result.rows.map((row) => row.tgname));
    for (const table of [
      "products",
      "product_variants",
      "customer_groups",
      "company_customers",
      "price_lists",
      "price_list_entries",
      "personal_prices",
    ]) {
      expect(triggers).toContain(`${table}_set_updated_at`);
    }

    const company = await insertCompany();
    const list = await insertPriceList(company.id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const updated = await dbClient.db
      .update(priceLists)
      .set({ isActive: false })
      .where(eq(priceLists.id, list.id))
      .returning();
    expect(updated[0]?.updatedAt.getTime()).toBeGreaterThan(
      list.updatedAt.getTime(),
    );
  });

  it("keeps nullable variant references queryable through Drizzle", async () => {
    const company = await insertCompany();
    const product = await insertProduct(company.id);
    const list = await insertPriceList(company.id);
    await insertEntry({
      companyId: company.id,
      priceListId: list.id,
      productId: product.id,
    });

    const productLevel = await dbClient.db
      .select()
      .from(priceListEntries)
      .where(isNull(priceListEntries.variantId));
    expect(productLevel.length).toBeGreaterThan(0);
  });

  it("seeds pricing:manage for admin and manager, view only for employee", () => {
    const keys = new Set(
      rolePermissionDefaultRows.map((row) => `${row.role}:${row.permission}`),
    );
    for (const role of ["admin", "manager"] as const) {
      expect(keys.has(`${role}:pricing:view`)).toBe(true);
      expect(keys.has(`${role}:pricing:manage`)).toBe(true);
    }
    expect(keys.has("employee:pricing:view")).toBe(true);
    expect(keys.has("employee:pricing:manage")).toBe(false);
    expect(keys.has("owner:pricing:manage")).toBe(false);
  });

  it("rejects non-ISO stored currency on entries and personal prices", async () => {
    const company = await insertCompany();
    const product = await insertProduct(company.id);
    const list = await insertPriceList(company.id);
    const customer = await insertCustomer(company.id);

    await expectSqlState(
      insertEntry({
        companyId: company.id,
        priceListId: list.id,
        productId: product.id,
        currency: "uah",
      }),
      "23514",
    );
    await expectSqlState(
      insertEntry({
        companyId: company.id,
        priceListId: list.id,
        productId: product.id,
        currency: "US",
      }),
      "23514",
    );
    await expectSqlState(
      insertPersonalPrice({
        companyId: company.id,
        customerId: customer.id,
        productId: product.id,
        currency: "uah",
      }),
      "23514",
    );
  });
});
