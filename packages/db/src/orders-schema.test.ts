/**
 * SHO-91 (orders-T1) verification for the staff-order schema slice.
 * Data-path assertions use Drizzle through the runtime role; raw SQL is
 * limited to PostgreSQL catalog structure checks.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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
import { products, productVariants } from "./schema/catalog.js";
import { companies } from "./schema/companies.js";
import { companyCustomers } from "./schema/customers.js";
import { orderItems, orderNumberCounters, orders } from "./schema/orders.js";
import { createTestDatabase, type TestDatabase } from "./testing/harness.js";

let database: TestDatabase;
let dbClient: DbClient;
let admin: pg.Client;
let sequence = 0;
const nextOrderNumberByCompany = new Map<string, number>();

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
      name: `Orders Co ${String(sequence)}`,
      slug: `orders-co-${String(sequence)}`,
      prefix: `O${String(sequence)}`,
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
      email: `orders-customer-${String(sequence)}@example.com`,
      ...overrides,
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

function nextOrderNumber(companyId: string): string {
  const next = (nextOrderNumberByCompany.get(companyId) ?? 0) + 1;
  nextOrderNumberByCompany.set(companyId, next);
  return `T-${String(next)}`;
}

async function insertOrder(
  values: Omit<
    typeof orders.$inferInsert,
    | "totalNetMinor"
    | "totalTaxMinor"
    | "totalGrossMinor"
    | "orderNumber"
    | "customerNameSnapshot"
  > & {
    totalNetMinor?: bigint;
    totalTaxMinor?: bigint;
    totalGrossMinor?: bigint;
    orderNumber?: string;
    customerNameSnapshot?: string;
  },
) {
  const rows = await dbClient.db
    .insert(orders)
    .values({
      totalNetMinor: 10_000n,
      totalTaxMinor: 0n,
      totalGrossMinor: 10_000n,
      orderNumber: nextOrderNumber(values.companyId),
      customerNameSnapshot: "unlinked",
      ...values,
    })
    .returning();
  const row = rows[0];
  assert.ok(row);
  return row;
}

async function insertItem(
  values: Omit<
    typeof orderItems.$inferInsert,
    | "titleSnapshot"
    | "quantityMilli"
    | "unitPriceMinor"
    | "taxTreatment"
    | "netAmountMinor"
    | "grossAmountMinor"
    | "resolverVersion"
  > &
    Partial<typeof orderItems.$inferInsert>,
) {
  const rows = await dbClient.db
    .insert(orderItems)
    .values({
      titleSnapshot: "Fixture product",
      quantityMilli: 1000n,
      unitPriceMinor: 10_000n,
      taxTreatment: "exempt",
      netAmountMinor: 10_000n,
      grossAmountMinor: 10_000n,
      resolverVersion: 1,
      ...values,
    })
    .returning();
  const row = rows[0];
  assert.ok(row);
  return row;
}

describe("staff orders schema slice", () => {
  it("creates only the card-named columns with timestamptz timestamps", async () => {
    const result = await admin.query<{
      table_name: string;
      column_name: string;
      data_type: string;
    }>(
      `SELECT table_name, column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name IN ('orders', 'order_items', 'order_number_counters')
       ORDER BY table_name, ordinal_position`,
    );
    const columns = new Map<string, string[]>();
    for (const row of result.rows) {
      const names = columns.get(row.table_name) ?? [];
      names.push(row.column_name);
      columns.set(row.table_name, names);
      if (row.column_name === "order_number") {
        expect(row.data_type).toBe("text");
      }
      if (row.column_name.endsWith("_at")) {
        expect(row.data_type).toBe("timestamp with time zone");
      }
      if (
        row.column_name.endsWith("_minor") ||
        row.column_name.endsWith("_milli") ||
        row.column_name === "discount_value"
      ) {
        expect(row.data_type).toBe("bigint");
      }
    }

    expect(columns.get("orders")).toEqual([
      "id",
      "company_id",
      "customer_id",
      "status",
      "comment",
      "total_net_minor",
      "total_tax_minor",
      "total_gross_minor",
      "currency",
      "confirmed_at",
      "created_at",
      "updated_at",
      // 0029 ADD COLUMN appends after the 0013 table; Drizzle field order
      // in schema/orders.ts is company_id then order_number.
      "order_number",
      // 0040 ADD COLUMN appends after order_number.
      "customer_name_snapshot",
      // 0047 ADD COLUMN appends after customer_name_snapshot (SHO-465).
      "created_via",
      "vouched_by",
      "vouched_at",
    ]);
    expect(columns.get("order_items")).toEqual([
      "id",
      "company_id",
      "order_id",
      "product_id",
      "variant_id",
      "title_snapshot",
      "quantity_milli",
      "unit_price_minor",
      "discount_kind",
      "discount_value",
      "discount_amount_minor",
      "tax_treatment",
      "tax_rate_bp",
      "tax_amount_minor",
      "net_amount_minor",
      "gross_amount_minor",
      "currency",
      "price_source",
      "personal_price_id",
      "price_list_id",
      "price_list_entry_id",
      "resolver_version",
      "created_at",
    ]);
    expect(columns.get("order_items")).not.toContain("updated_at");
    expect(columns.get("order_number_counters")).toEqual([
      "company_id",
      "last_number",
    ]);
  });

  it("represents money and quantity columns as bigint in TypeScript", () => {
    expectTypeOf<
      (typeof orders.$inferSelect)["orderNumber"]
    >().toEqualTypeOf<string>();
    expectTypeOf<
      (typeof orderNumberCounters.$inferSelect)["lastNumber"]
    >().toEqualTypeOf<bigint>();
    expectTypeOf<
      (typeof orders.$inferSelect)["totalNetMinor"]
    >().toEqualTypeOf<bigint>();
    expectTypeOf<
      (typeof orders.$inferSelect)["totalTaxMinor"]
    >().toEqualTypeOf<bigint>();
    expectTypeOf<
      (typeof orders.$inferSelect)["totalGrossMinor"]
    >().toEqualTypeOf<bigint>();
    expectTypeOf<
      (typeof orderItems.$inferSelect)["quantityMilli"]
    >().toEqualTypeOf<bigint>();
    expectTypeOf<
      (typeof orderItems.$inferSelect)["unitPriceMinor"]
    >().toEqualTypeOf<bigint>();
    expectTypeOf<
      (typeof orderItems.$inferSelect)["discountValue"]
    >().toEqualTypeOf<bigint>();
    expectTypeOf<
      (typeof orderItems.$inferSelect)["discountAmountMinor"]
    >().toEqualTypeOf<bigint>();
    expectTypeOf<
      (typeof orderItems.$inferSelect)["taxAmountMinor"]
    >().toEqualTypeOf<bigint>();
    expectTypeOf<
      (typeof orderItems.$inferSelect)["netAmountMinor"]
    >().toEqualTypeOf<bigint>();
    expectTypeOf<
      (typeof orderItems.$inferSelect)["grossAmountMinor"]
    >().toEqualTypeOf<bigint>();
  });

  it("declares UNIQUE (company_id, id) and the card-named indexes", async () => {
    const result = await admin.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename IN ('orders', 'order_items', 'order_number_counters')`,
    );
    const indexes = new Map(
      result.rows.map((row) => [row.indexname, row.indexdef]),
    );

    for (const name of [
      "orders_company_id_id_uq",
      "order_items_company_id_id_uq",
    ]) {
      expect(indexes.get(name)).toContain("UNIQUE");
      expect(indexes.get(name)).toContain("(company_id, id)");
    }
    expect(indexes.get("orders_company_id_order_number_uq")).toContain(
      "UNIQUE",
    );
    expect(indexes.get("orders_company_id_order_number_uq")).toContain(
      "(company_id, order_number)",
    );
    expect(indexes.get("orders_company_id_order_number_uq")).not.toContain(
      "text_pattern_ops",
    );
    const numberPattern = indexes.get(
      "orders_company_id_order_number_pattern_idx",
    );
    expect(numberPattern).toMatch(/USING btree/i);
    expect(numberPattern).toContain("text_pattern_ops");
    expect(numberPattern).toMatch(/company_id/);
    expect(numberPattern).toMatch(/order_number/);
    expect(numberPattern).not.toContain("UNIQUE");
    expect(numberPattern).not.toMatch(/gin_trgm_ops|USING gin/i);

    const createdAt = indexes.get("orders_company_created_at_idx");
    expect(createdAt).toContain("(company_id");
    expect(createdAt).toMatch(/created_at.*DESC/i);
    expect(createdAt).toMatch(/id.*DESC/i);
    expect(indexes.get("orders_company_status_idx")).toContain(
      "(company_id, status)",
    );
    expect(indexes.get("orders_customer_idx")).toContain("(customer_id)");
    expect(indexes.get("orders_company_status_created_at_id_idx")).toMatch(
      /company_id.*status.*created_at.*DESC/i,
    );
    expect(indexes.get("orders_company_customer_id_created_at_id_idx")).toMatch(
      /company_id.*customer_id.*created_at.*DESC/i,
    );
    expect(indexes.get("order_items_order_idx")).toContain("(order_id)");
    expect(indexes.has("order_items_company_idx")).toBe(false);
    expect(indexes.get("order_items_company_order_id_idx")).toContain(
      "(company_id, order_id)",
    );
    expect(indexes.get("order_items_product_idx")).toContain("(product_id)");
    expect(indexes.get("order_items_variant_idx")).toContain("(variant_id)");
    expect(indexes.get("order_number_counters_pk")).toContain("UNIQUE");
    expect(indexes.get("order_number_counters_pk")).toContain("(company_id)");
  });

  it("enforces UNIQUE (company_id, order_number) and the prefix-token CHECK", async () => {
    const companyA = await insertCompany();
    const companyB = await insertCompany();
    const first = await insertOrder({
      companyId: companyA.id,
      orderNumber: "KA-17Z992",
    });
    expect(first.orderNumber).toBe("KA-17Z992");
    const second = await insertOrder({
      companyId: companyA.id,
      orderNumber: "KA-2FY8Z7",
    });
    expect(second.orderNumber).toBe("KA-2FY8Z7");
    const otherTenant = await insertOrder({
      companyId: companyB.id,
      orderNumber: "KA-17Z992",
    });
    expect(otherTenant.orderNumber).toBe("KA-17Z992");

    await expectSqlState(
      insertOrder({ companyId: companyA.id, orderNumber: "KA-17Z992" }),
      "23505",
    );
    await expectSqlState(
      insertOrder({ companyId: companyA.id, orderNumber: "1" }),
      "23514",
    );
    await expectSqlState(
      insertOrder({ companyId: companyA.id, orderNumber: "KA" }),
      "23514",
    );
    await expectSqlState(
      insertOrder({ companyId: companyA.id, orderNumber: "ka-k7x2" }),
      "23514",
    );
  });

  it("enforces order_number_counters PK and last_number > 0", async () => {
    const company = await insertCompany();
    const inserted = await dbClient.db
      .insert(orderNumberCounters)
      .values({ companyId: company.id, lastNumber: 1n })
      .returning();
    expect(inserted[0]?.lastNumber).toBe(1n);

    await expectSqlState(
      dbClient.db.insert(orderNumberCounters).values({
        companyId: company.id,
        lastNumber: 2n,
      }),
      "23505",
    );
    const other = await insertCompany();
    await expectSqlState(
      dbClient.db.insert(orderNumberCounters).values({
        companyId: other.id,
        lastNumber: 0n,
      }),
      "23514",
    );
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
         AND rel.relname IN ('orders', 'order_items', 'order_number_counters')
       ORDER BY con.conname`,
    );
    const defs = new Map(
      result.rows.map((row) => [row.conname, row.definition]),
    );

    expect(defs.get("orders_company_customers_company_fk")).toContain(
      "(company_id, customer_id) REFERENCES company_customers(company_id, id)",
    );
    expect(defs.get("orders_company_customers_company_fk")).toContain(
      "ON DELETE SET NULL (customer_id)",
    );
    expect(defs.get("order_items_orders_company_fk")).toContain(
      "(company_id, order_id) REFERENCES orders(company_id, id)",
    );
    expect(defs.get("order_items_orders_company_fk")).toContain(
      "ON DELETE CASCADE",
    );
    expect(defs.get("order_items_products_company_fk")).toContain(
      "(company_id, product_id) REFERENCES products(company_id, id)",
    );
    expect(defs.get("order_items_products_company_fk")).toContain(
      "ON DELETE RESTRICT",
    );
    expect(defs.get("order_items_product_variants_company_fk")).toContain(
      "(company_id, variant_id) REFERENCES product_variants(company_id, id)",
    );
    expect(defs.get("order_items_product_variants_company_fk")).toContain(
      "ON DELETE RESTRICT",
    );
    expect(
      defs.get("order_number_counters_company_id_companies_id_fk"),
    ).toContain("REFERENCES companies(id)");
    expect(
      defs.get("order_number_counters_company_id_companies_id_fk"),
    ).toContain("ON DELETE CASCADE");
  });

  it("rejects negative money, zero quantity, and illegal status/discount/source", async () => {
    const company = await insertCompany();
    const product = await insertProduct(company.id);
    const order = await insertOrder({ companyId: company.id });

    await expectSqlState(
      insertOrder({ companyId: company.id, totalNetMinor: -1n }),
      "23514",
    );
    await expectSqlState(
      insertOrder({ companyId: company.id, totalTaxMinor: -1n }),
      "23514",
    );
    await expectSqlState(
      insertOrder({ companyId: company.id, totalGrossMinor: -1n }),
      "23514",
    );
    await expectSqlState(
      insertOrder({ companyId: company.id, status: "draft" }),
      "23514",
    );
    await expectSqlState(
      insertOrder({ companyId: company.id, status: "completed" }),
      "23514",
    );
    await expectSqlState(
      insertOrder({
        companyId: company.id,
        status: "active",
        confirmedAt: new Date(),
      }),
      "23514",
    );
    await expectSqlState(
      insertOrder({ companyId: company.id, customerNameSnapshot: "" }),
      "23514",
    );
    await expectSqlState(
      insertItem({
        companyId: company.id,
        orderId: order.id,
        productId: product.id,
        quantityMilli: 0n,
      }),
      "23514",
    );
    await expectSqlState(
      insertItem({
        companyId: company.id,
        orderId: order.id,
        productId: product.id,
        unitPriceMinor: -1n,
      }),
      "23514",
    );
    await expectSqlState(
      insertItem({
        companyId: company.id,
        orderId: order.id,
        productId: product.id,
        discountAmountMinor: -1n,
      }),
      "23514",
    );
    await expectSqlState(
      insertItem({
        companyId: company.id,
        orderId: order.id,
        productId: product.id,
        taxAmountMinor: -1n,
      }),
      "23514",
    );
    await expectSqlState(
      insertItem({
        companyId: company.id,
        orderId: order.id,
        productId: product.id,
        netAmountMinor: -1n,
      }),
      "23514",
    );
    await expectSqlState(
      insertItem({
        companyId: company.id,
        orderId: order.id,
        productId: product.id,
        grossAmountMinor: -1n,
      }),
      "23514",
    );
    await expectSqlState(
      insertItem({
        companyId: company.id,
        orderId: order.id,
        productId: product.id,
        taxRateBp: -1,
      }),
      "23514",
    );
    await expectSqlState(
      insertItem({
        companyId: company.id,
        orderId: order.id,
        productId: product.id,
        discountKind: "percent",
      }),
      "23514",
    );
    await expectSqlState(
      insertItem({
        companyId: company.id,
        orderId: order.id,
        productId: product.id,
        taxTreatment: "vat",
      }),
      "23514",
    );
    await expectSqlState(
      insertItem({
        companyId: company.id,
        orderId: order.id,
        productId: product.id,
        priceSource: "list",
      }),
      "23514",
    );

    const free = await insertOrder({
      companyId: company.id,
      totalNetMinor: 0n,
      totalTaxMinor: 0n,
      totalGrossMinor: 0n,
      status: "canceled",
    });
    expect(free.totalGrossMinor).toBe(0n);
    expect(free.status).toBe("canceled");

    const line = await insertItem({
      companyId: company.id,
      orderId: order.id,
      productId: product.id,
      priceSource: "base",
      quantityMilli: 1n,
      unitPriceMinor: 0n,
      netAmountMinor: 0n,
      grossAmountMinor: 0n,
    });
    expect(line.quantityMilli).toBe(1n);
    expect(line.priceSource).toBe("base");
    expect(line.discountKind).toBe("none");
    expect(line.discountValue).toBe(0n);
  });

  it("accepts the five price sources and a null source", async () => {
    const company = await insertCompany();
    const product = await insertProduct(company.id);
    const order = await insertOrder({ companyId: company.id });

    const sources = [
      "personal",
      "customer_price_list",
      "group_price_list",
      "default_price_list",
      "base",
      null,
    ] as const;
    for (const priceSource of sources) {
      const line = await insertItem({
        companyId: company.id,
        orderId: order.id,
        productId: product.id,
        priceSource,
      });
      expect(line.priceSource).toBe(priceSource);
    }
  });

  it("rejects a child row that points at another tenant's parent", async () => {
    const companyA = await insertCompany();
    const companyB = await insertCompany();
    const customerB = await insertCustomer(companyB.id);
    const productA = await insertProduct(companyA.id);
    const productB = await insertProduct(companyB.id);
    const variantB = await insertVariant(companyB.id, productB.id);
    const orderA = await insertOrder({ companyId: companyA.id });
    const orderB = await insertOrder({ companyId: companyB.id });

    await expectSqlState(
      insertOrder({ companyId: companyA.id, customerId: customerB.id }),
      "23503",
    );
    await expectSqlState(
      insertItem({
        companyId: companyA.id,
        orderId: orderB.id,
        productId: productA.id,
      }),
      "23503",
    );
    await expectSqlState(
      insertItem({
        companyId: companyA.id,
        orderId: orderA.id,
        productId: productB.id,
      }),
      "23503",
    );
    await expectSqlState(
      insertItem({
        companyId: companyA.id,
        orderId: orderA.id,
        productId: productA.id,
        variantId: variantB.id,
      }),
      "23503",
    );
  });

  it("nulls customer_id only when the CRM row is deleted", async () => {
    const company = await insertCompany();
    const customer = await insertCustomer(company.id);
    const order = await insertOrder({
      companyId: company.id,
      customerId: customer.id,
      customerNameSnapshot: "Live CRM",
    });

    await dbClient.db
      .delete(companyCustomers)
      .where(eq(companyCustomers.id, customer.id));

    const remaining = await dbClient.db
      .select()
      .from(orders)
      .where(eq(orders.id, order.id));
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.customerId).toBeNull();
    expect(remaining[0]?.companyId).toBe(company.id);
    expect(remaining[0]?.customerNameSnapshot).toBe("Live CRM");
  });

  it("restricts product and variant deletes while lines exist", async () => {
    const company = await insertCompany();
    const product = await insertProduct(company.id);
    const variant = await insertVariant(company.id, product.id);
    const order = await insertOrder({ companyId: company.id });
    await insertItem({
      companyId: company.id,
      orderId: order.id,
      productId: product.id,
      variantId: variant.id,
    });

    await expectSqlState(
      dbClient.db
        .delete(productVariants)
        .where(eq(productVariants.id, variant.id)),
      "23503",
    );
    await expectSqlState(
      dbClient.db.delete(products).where(eq(products.id, product.id)),
      "23503",
    );
  });

  it("cascades order deletion to items and company deletion to both tables", async () => {
    const company = await insertCompany();
    const product = await insertProduct(company.id);
    const order = await insertOrder({ companyId: company.id });
    await insertItem({
      companyId: company.id,
      orderId: order.id,
      productId: product.id,
    });

    await dbClient.db.delete(orders).where(eq(orders.id, order.id));
    expect(
      await dbClient.db
        .select()
        .from(orderItems)
        .where(eq(orderItems.orderId, order.id)),
    ).toEqual([]);

    const surviving = await insertOrder({ companyId: company.id });
    await insertItem({
      companyId: company.id,
      orderId: surviving.id,
      productId: product.id,
    });
    await dbClient.db.insert(orderNumberCounters).values({
      companyId: company.id,
      lastNumber: 1n,
    });
    await dbClient.db.delete(companies).where(eq(companies.id, company.id));
    expect(
      await dbClient.db
        .select()
        .from(orders)
        .where(eq(orders.companyId, company.id)),
    ).toEqual([]);
    expect(
      await dbClient.db
        .select()
        .from(orderItems)
        .where(eq(orderItems.companyId, company.id)),
    ).toEqual([]);
    expect(
      await dbClient.db
        .select()
        .from(orderNumberCounters)
        .where(eq(orderNumberCounters.companyId, company.id)),
    ).toEqual([]);
  });

  it("attaches the shared updated_at trigger to orders only", async () => {
    const result = await admin.query<{ tgname: string; relname: string }>(
      `SELECT t.tgname, c.relname
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       WHERE NOT t.tgisinternal
         AND t.tgname LIKE '%_set_updated_at'
         AND c.relname IN ('orders', 'order_items')`,
    );
    const byTable = new Map(
      result.rows.map((row) => [row.relname, row.tgname]),
    );
    expect(byTable.get("orders")).toBe("orders_set_updated_at");
    expect(byTable.has("order_items")).toBe(false);

    const company = await insertCompany();
    const order = await insertOrder({ companyId: company.id });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const updated = await dbClient.db
      .update(orders)
      .set({ comment: "touched" })
      .where(eq(orders.id, order.id))
      .returning();
    expect(updated[0]?.updatedAt.getTime()).toBeGreaterThan(
      order.updatedAt.getTime(),
    );
  });

  it("seeds orders view/create/edit for admin, manager, and employee", () => {
    const keys = new Set(
      rolePermissionDefaultRows.map((row) => `${row.role}:${row.permission}`),
    );
    for (const role of ["admin", "manager", "employee"] as const) {
      for (const permission of [
        "orders:view",
        "orders:create",
        "orders:edit",
      ] as const) {
        expect(keys.has(`${role}:${permission}`)).toBe(true);
      }
    }
    expect(keys.has("owner:orders:view")).toBe(false);
  });

  it("accepts the five CHECK statuses and ties confirmed_at without requiring it after cancel", async () => {
    const company = await insertCompany();

    await expectSqlState(
      insertOrder({ companyId: company.id, status: "confirmed" }),
      "23514",
    );
    await expectSqlState(
      insertOrder({
        companyId: company.id,
        status: "in_progress",
      }),
      "23514",
    );
    await expectSqlState(
      insertOrder({
        companyId: company.id,
        status: "done",
      }),
      "23514",
    );
    await expectSqlState(
      insertOrder({
        companyId: company.id,
        status: "new",
        confirmedAt: new Date(),
      }),
      "23514",
    );

    const created = await insertOrder({
      companyId: company.id,
      status: "new",
    });
    expect(created.status).toBe("new");
    expect(created.confirmedAt).toBeNull();

    const confirmed = await insertOrder({
      companyId: company.id,
      status: "confirmed",
      confirmedAt: new Date(),
    });
    expect(confirmed.confirmedAt).not.toBeNull();

    const inProgress = await insertOrder({
      companyId: company.id,
      status: "in_progress",
      confirmedAt: new Date(),
    });
    expect(inProgress.status).toBe("in_progress");
    expect(inProgress.confirmedAt).not.toBeNull();

    const done = await insertOrder({
      companyId: company.id,
      status: "done",
      confirmedAt: new Date(),
    });
    expect(done.status).toBe("done");
    expect(done.confirmedAt).not.toBeNull();

    const canceledFromConfirmed = await insertOrder({
      companyId: company.id,
      status: "canceled",
      confirmedAt: new Date(),
    });
    expect(canceledFromConfirmed.confirmedAt).not.toBeNull();

    const canceledFromNew = await insertOrder({
      companyId: company.id,
      status: "canceled",
    });
    expect(canceledFromNew.confirmedAt).toBeNull();
  });

  it("rejects non-ISO order currency", async () => {
    const company = await insertCompany();
    const product = await insertProduct(company.id);
    const order = await insertOrder({ companyId: company.id });

    await expectSqlState(
      insertOrder({ companyId: company.id, currency: "uah" }),
      "23514",
    );
    await expectSqlState(
      insertOrder({ companyId: company.id, currency: "US" }),
      "23514",
    );
    await expectSqlState(
      insertOrder({ companyId: company.id, currency: "UA1" }),
      "23514",
    );
    await expectSqlState(
      insertItem({
        companyId: company.id,
        orderId: order.id,
        productId: product.id,
        currency: "uah",
      }),
      "23514",
    );
  });

  it("writes the unlinked sentinel without a column default; omitted inserts fail NOT NULL", async () => {
    const company = await insertCompany();
    const customer = await insertCustomer(company.id, { name: "Live CRM" });
    const linked = await insertOrder({
      companyId: company.id,
      customerId: customer.id,
    });
    expect(linked.customerNameSnapshot).toBe("unlinked");
    const orphaned = await insertOrder({
      companyId: company.id,
      customerId: null,
    });
    expect(orphaned.customerNameSnapshot).toBe("unlinked");

    const column = await admin.query<{
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'orders'
         AND column_name = 'customer_name_snapshot'`,
    );
    expect(column.rows[0]?.is_nullable).toBe("NO");
    expect(column.rows[0]?.column_default).toBeNull();

    await expectSqlState(
      admin.query(
        `INSERT INTO "orders" (
           "company_id",
           "order_number",
           "total_net_minor",
           "total_tax_minor",
           "total_gross_minor"
         ) VALUES ($1, $2, 1, 0, 1)`,
        [company.id, nextOrderNumber(company.id)],
      ),
      "23502",
    );
  });

  it("ships the CRM snapshot backfill in 0040 (db.md §7)", () => {
    const sql = readFileSync(
      new URL("../migrations/0040_dapper_killraven.sql", import.meta.url),
      "utf8",
    );
    expect(sql).toContain('ADD COLUMN "customer_name_snapshot"');
    expect(sql).toContain("DEFAULT 'unlinked'");
    expect(sql).toContain('FROM "company_customers" AS c');
    expect(sql).toContain("db.md §7");
    expect(sql).not.toContain("Deleted customer");
  });

  it("drops the snapshot column default in 0041 once create always writes it", () => {
    const sql = readFileSync(
      new URL("../migrations/0041_shiny_zombie.sql", import.meta.url),
      "utf8",
    );
    expect(sql).toContain(
      'ALTER TABLE "orders" ALTER COLUMN "customer_name_snapshot" DROP DEFAULT',
    );
  });
});
