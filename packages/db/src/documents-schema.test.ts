/**
 * SHO-228 (documents-T1) verification for the documents schema slice.
 * Data-path assertions use Drizzle through the runtime role; raw SQL is
 * limited to PostgreSQL catalog structure checks.
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
import { products, productVariants } from "./schema/catalog.js";
import { companies } from "./schema/companies.js";
import { counterparties } from "./schema/customers.js";
import {
  documentItems,
  documentNumberCounters,
  documents,
  documentShareTokens,
} from "./schema/documents.js";
import { orders } from "./schema/orders.js";
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

const supplierDetails = { legalName: "ФОП Fixture", edrpou: "12345678" };
const buyerDetails = { kind: "customer", displayName: "Fixture buyer" };

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

function nextTokenHash(): string {
  sequence += 1;
  return sequence.toString(16).padStart(64, "a");
}

async function insertCompany() {
  sequence += 1;
  const rows = await dbClient.db
    .insert(companies)
    .values({
      name: `Docs Co ${String(sequence)}`,
      slug: `docs-co-${String(sequence)}`,
      prefix: `D${String(sequence)}`,
    })
    .returning();
  const row = rows[0];
  assert.ok(row);
  return row;
}

async function insertCounterparty(
  companyId: string,
  overrides: Partial<typeof counterparties.$inferInsert> = {},
) {
  sequence += 1;
  const rows = await dbClient.db
    .insert(counterparties)
    .values({
      companyId,
      name: `Fixture counterparty ${String(sequence)}`,
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
  const next = (nextOrderNumberByCompany.get(values.companyId) ?? 0) + 1;
  nextOrderNumberByCompany.set(values.companyId, next);
  const rows = await dbClient.db
    .insert(orders)
    .values({
      totalNetMinor: 10_000n,
      totalTaxMinor: 0n,
      totalGrossMinor: 10_000n,
      orderNumber: `T-${String(next)}`,
      customerNameSnapshot: "unlinked",
      ...values,
    })
    .returning();
  const row = rows[0];
  assert.ok(row);
  return row;
}

async function insertDocument(
  values: Omit<
    typeof documents.$inferInsert,
    | "type"
    | "documentNumber"
    | "issuedOn"
    | "supplierDetails"
    | "buyerDetails"
    | "totalNetMinor"
    | "totalTaxMinor"
    | "totalGrossMinor"
    | "templateName"
  > &
    Partial<typeof documents.$inferInsert>,
) {
  sequence += 1;
  const rows = await dbClient.db
    .insert(documents)
    .values({
      type: "payment_invoice",
      documentNumber: `INV-${String(sequence)}`,
      issuedOn: "2026-08-29",
      supplierDetails,
      buyerDetails,
      totalNetMinor: 10_000n,
      totalTaxMinor: 0n,
      totalGrossMinor: 10_000n,
      templateName: "Payment invoice",
      ...values,
    })
    .returning();
  const row = rows[0];
  assert.ok(row);
  return row;
}

async function insertItem(
  values: Omit<
    typeof documentItems.$inferInsert,
    | "titleSnapshot"
    | "quantityMilli"
    | "unitPriceMinor"
    | "taxTreatment"
    | "netAmountMinor"
    | "grossAmountMinor"
  > &
    Partial<typeof documentItems.$inferInsert>,
) {
  const rows = await dbClient.db
    .insert(documentItems)
    .values({
      titleSnapshot: "Fixture product",
      quantityMilli: 1000n,
      unitPriceMinor: 10_000n,
      taxTreatment: "exempt",
      netAmountMinor: 10_000n,
      grossAmountMinor: 10_000n,
      ...values,
    })
    .returning();
  const row = rows[0];
  assert.ok(row);
  return row;
}

async function insertShareToken(
  values: Omit<
    typeof documentShareTokens.$inferInsert,
    "tokenHash" | "expiresAt"
  > &
    Partial<typeof documentShareTokens.$inferInsert>,
) {
  const rows = await dbClient.db
    .insert(documentShareTokens)
    .values({
      tokenHash: nextTokenHash(),
      expiresAt: new Date("2026-11-27T00:00:00.000Z"),
      ...values,
    })
    .returning();
  const row = rows[0];
  assert.ok(row);
  return row;
}

describe("documents schema slice", () => {
  it("creates only the card-named columns and omits templates / year / pdf / signatures", async () => {
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
         AND table_name IN (
           'documents',
           'document_items',
           'document_number_counters',
           'document_share_tokens'
         )
       ORDER BY table_name, ordinal_position`,
    );
    const columns = new Map<string, string[]>();
    const byTableColumn = new Map<
      string,
      {
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }
    >();
    for (const row of result.rows) {
      const names = columns.get(row.table_name) ?? [];
      names.push(row.column_name);
      columns.set(row.table_name, names);
      byTableColumn.set(`${row.table_name}.${row.column_name}`, row);
      if (row.column_name.endsWith("_at")) {
        expect(row.data_type).toBe("timestamp with time zone");
      }
      if (
        row.column_name.endsWith("_minor") ||
        row.column_name.endsWith("_milli") ||
        row.column_name === "discount_value" ||
        row.column_name === "last_number"
      ) {
        expect(row.data_type).toBe("bigint");
      }
    }

    expect(columns.get("documents")).toEqual([
      "id",
      "company_id",
      "order_id",
      "counterparty_id",
      "type",
      "status",
      "document_number",
      "issued_on",
      "supplier_details",
      "buyer_details",
      "total_net_minor",
      "total_tax_minor",
      "total_gross_minor",
      "currency",
      "template_source",
      "template_name",
      "created_at",
      "updated_at",
      "sign_requested_at",
      "basis",
      "created_via",
      "vouched_by",
      "vouched_at",
    ]);
    expect(byTableColumn.get("documents.sign_requested_at")?.data_type).toBe(
      "timestamp with time zone",
    );
    expect(byTableColumn.get("documents.sign_requested_at")?.is_nullable).toBe(
      "YES",
    );
    expect(byTableColumn.get("documents.basis")?.data_type).toBe("text");
    expect(byTableColumn.get("documents.basis")?.is_nullable).toBe("YES");
    expect(byTableColumn.get("documents.basis")?.column_default).toBeNull();
    for (const forbidden of [
      "template_id",
      "pdf_url",
      "signed_at",
      "signed_by",
      "signature",
      "order_status",
    ]) {
      expect(columns.get("documents")).not.toContain(forbidden);
    }
    expect(byTableColumn.get("documents.issued_on")?.data_type).toBe("date");
    expect(byTableColumn.get("documents.issued_on")?.is_nullable).toBe("NO");
    expect(byTableColumn.get("documents.issued_on")?.column_default).toBeNull();
    expect(byTableColumn.get("documents.counterparty_id")?.is_nullable).toBe(
      "YES",
    );
    expect(byTableColumn.get("documents.supplier_details")?.data_type).toBe(
      "jsonb",
    );
    expect(byTableColumn.get("documents.buyer_details")?.data_type).toBe(
      "jsonb",
    );
    expect(byTableColumn.get("documents.status")?.column_default).toContain(
      "issued",
    );
    expect(
      byTableColumn.get("documents.template_source")?.column_default,
    ).toContain("system");

    expect(columns.get("document_items")).toEqual([
      "id",
      "company_id",
      "document_id",
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
      "created_at",
    ]);
    expect(columns.get("document_items")).not.toContain("updated_at");

    expect(columns.get("document_number_counters")).toEqual([
      "company_id",
      "type",
      "last_number",
    ]);
    expect(columns.get("document_number_counters")).not.toContain("year");
    expect(columns.get("document_number_counters")).not.toContain("id");

    // information_schema ordinal_position: ADD COLUMN appends after
    // existing created_at (SHO-259).
    expect(columns.get("document_share_tokens")).toEqual([
      "id",
      "company_id",
      "document_id",
      "token_hash",
      "expires_at",
      "revoked_at",
      "pdf_download_url",
      "pdf_download_expires_at",
      "created_at",
      "signed_download_url",
      "signed_download_expires_at",
    ]);
    expect(columns.get("document_share_tokens")).not.toContain("updated_at");
    expect(
      byTableColumn.get("document_share_tokens.revoked_at")?.is_nullable,
    ).toBe("YES");
    expect(
      byTableColumn.get("document_share_tokens.pdf_download_url")?.is_nullable,
    ).toBe("YES");
    expect(
      byTableColumn.get("document_share_tokens.pdf_download_expires_at")
        ?.is_nullable,
    ).toBe("YES");
    expect(
      byTableColumn.get("document_share_tokens.signed_download_url")
        ?.is_nullable,
    ).toBe("YES");
    expect(
      byTableColumn.get("document_share_tokens.signed_download_expires_at")
        ?.is_nullable,
    ).toBe("YES");

    const extra = await admin.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = 'default_document_templates'`,
    );
    expect(extra.rows).toEqual([]);
  });

  it("represents money as bigint and issued_on as a calendar-day string", () => {
    expectTypeOf<
      (typeof documents.$inferSelect)["totalNetMinor"]
    >().toEqualTypeOf<bigint>();
    expectTypeOf<
      (typeof documents.$inferSelect)["totalTaxMinor"]
    >().toEqualTypeOf<bigint>();
    expectTypeOf<
      (typeof documents.$inferSelect)["totalGrossMinor"]
    >().toEqualTypeOf<bigint>();
    expectTypeOf<
      (typeof documents.$inferSelect)["issuedOn"]
    >().toEqualTypeOf<string>();
    expectTypeOf<
      (typeof documents.$inferSelect)["signRequestedAt"]
    >().toEqualTypeOf<Date | null>();
    expectTypeOf<(typeof documents.$inferSelect)["basis"]>().toEqualTypeOf<
      string | null
    >();
    expectTypeOf<
      (typeof documentItems.$inferSelect)["quantityMilli"]
    >().toEqualTypeOf<bigint>();
    expectTypeOf<
      (typeof documentNumberCounters.$inferSelect)["lastNumber"]
    >().toEqualTypeOf<bigint>();
  });

  it("declares UNIQUE (company_id, id), number unique, live partial unique, and indexes", async () => {
    const result = await admin.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename IN (
           'documents',
           'document_items',
           'document_number_counters',
           'document_share_tokens'
         )`,
    );
    const indexes = new Map(
      result.rows.map((row) => [row.indexname, row.indexdef]),
    );

    for (const name of [
      "documents_company_id_id_uq",
      "document_items_company_id_id_uq",
      "document_share_tokens_company_id_id_uq",
    ]) {
      expect(indexes.get(name)).toContain("UNIQUE");
      expect(indexes.get(name)).toContain("(company_id, id)");
    }

    expect(indexes.get("documents_company_type_document_number_uq")).toContain(
      "UNIQUE",
    );
    expect(indexes.get("documents_company_type_document_number_uq")).toContain(
      "(company_id, type, document_number)",
    );
    expect(
      indexes.get("documents_company_type_document_number_uq"),
    ).not.toMatch(/WHERE/i);
    expect(
      indexes.get("documents_company_type_document_number_uq"),
    ).not.toContain("text_pattern_ops");
    const numberPattern = indexes.get(
      "documents_company_id_document_number_pattern_idx",
    );
    expect(numberPattern).toMatch(/USING btree/i);
    expect(numberPattern).toContain("text_pattern_ops");
    expect(numberPattern).toMatch(/company_id/);
    expect(numberPattern).toMatch(/document_number/);
    expect(numberPattern).not.toContain("UNIQUE");
    expect(numberPattern).not.toMatch(/gin_trgm_ops|USING gin/i);

    const live = indexes.get("documents_company_order_type_live_uq");
    expect(live).toContain("UNIQUE");
    expect(live).toContain("(company_id, order_id, type)");
    expect(live).toMatch(/status.*<>.*cancelled/i);

    const createdAt = indexes.get("documents_company_created_at_idx");
    expect(createdAt).toContain("(company_id");
    expect(createdAt).toMatch(/created_at.*DESC/i);
    expect(createdAt).toMatch(/id.*DESC/i);
    expect(indexes.has("document_items_company_idx")).toBe(false);
    expect(indexes.get("documents_company_status_idx")).toContain(
      "(company_id, status)",
    );
    expect(indexes.get("documents_company_type_idx")).toContain(
      "(company_id, type)",
    );
    expect(indexes.get("documents_order_idx")).toContain("(order_id)");
    expect(indexes.get("documents_counterparty_idx")).toContain(
      "(counterparty_id)",
    );
    expect(indexes.get("document_items_document_idx")).toContain(
      "(document_id)",
    );
    expect(indexes.get("document_share_tokens_token_hash_uq")).toContain(
      "UNIQUE",
    );
    expect(indexes.get("document_share_tokens_token_hash_uq")).toContain(
      "(token_hash)",
    );
    const active = indexes.get("document_share_tokens_document_id_active_uq");
    expect(active).toContain("UNIQUE");
    expect(active).toContain("(document_id)");
    expect(active).toMatch(/revoked_at IS NULL/i);

    expect(indexes.get("document_number_counters_pk")).toContain(
      "(company_id, type)",
    );
    expect(indexes.get("document_number_counters_pk")).not.toMatch(/year/i);
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
         AND rel.relname IN (
           'documents',
           'document_items',
           'document_number_counters',
           'document_share_tokens'
         )
       ORDER BY con.conname`,
    );
    const defs = new Map(
      result.rows.map((row) => [row.conname, row.definition]),
    );

    expect(defs.get("documents_orders_company_fk")).toContain(
      "(company_id, order_id) REFERENCES orders(company_id, id)",
    );
    expect(defs.get("documents_orders_company_fk")).toContain(
      "ON DELETE RESTRICT",
    );
    expect(defs.get("documents_counterparties_company_fk")).toContain(
      "(company_id, counterparty_id) REFERENCES counterparties(company_id, id)",
    );
    expect(defs.get("documents_counterparties_company_fk")).toContain(
      "ON DELETE RESTRICT",
    );
    expect(defs.get("documents_company_id_companies_id_fk")).toContain(
      "FOREIGN KEY (company_id) REFERENCES companies(id)",
    );
    expect(defs.get("documents_company_id_companies_id_fk")).toContain(
      "ON DELETE CASCADE",
    );

    expect(defs.get("document_items_documents_company_fk")).toContain(
      "(company_id, document_id) REFERENCES documents(company_id, id)",
    );
    expect(defs.get("document_items_documents_company_fk")).toContain(
      "ON DELETE CASCADE",
    );
    expect(defs.get("document_items_products_company_fk")).toContain(
      "(company_id, product_id) REFERENCES products(company_id, id)",
    );
    expect(defs.get("document_items_products_company_fk")).toContain(
      "ON DELETE RESTRICT",
    );
    expect(defs.get("document_items_product_variants_company_fk")).toContain(
      "(company_id, variant_id) REFERENCES product_variants(company_id, id)",
    );
    expect(defs.get("document_items_product_variants_company_fk")).toContain(
      "ON DELETE RESTRICT",
    );

    expect(defs.get("document_share_tokens_documents_company_fk")).toContain(
      "(company_id, document_id) REFERENCES documents(company_id, id)",
    );
    expect(defs.get("document_share_tokens_documents_company_fk")).toContain(
      "ON DELETE CASCADE",
    );
    expect(
      defs.get("document_number_counters_company_id_companies_id_fk"),
    ).toContain("ON DELETE CASCADE");
  });

  it("rejects illegal type, status, template source, money, and quantity", async () => {
    const company = await insertCompany();
    const product = await insertProduct(company.id);
    const order = await insertOrder({ companyId: company.id });
    const document = await insertDocument({
      companyId: company.id,
      orderId: order.id,
    });
    expect(document.basis).toBeNull();

    await expectSqlState(
      insertDocument({
        companyId: company.id,
        orderId: order.id,
        type: "agreement",
      }),
      "23514",
    );
    await expectSqlState(
      insertDocument({
        companyId: company.id,
        orderId: order.id,
        status: "draft",
      }),
      "23514",
    );
    await expectSqlState(
      insertDocument({
        companyId: company.id,
        orderId: order.id,
        templateSource: "custom",
      }),
      "23514",
    );
    await expectSqlState(
      insertDocument({
        companyId: company.id,
        orderId: order.id,
        totalNetMinor: -1n,
      }),
      "23514",
    );
    await expectSqlState(
      insertDocument({
        companyId: company.id,
        orderId: order.id,
        totalTaxMinor: -1n,
      }),
      "23514",
    );
    await expectSqlState(
      insertDocument({
        companyId: company.id,
        orderId: order.id,
        totalGrossMinor: -1n,
      }),
      "23514",
    );
    await expectSqlState(
      insertDocument({
        companyId: company.id,
        orderId: order.id,
        basis: "",
      }),
      "23514",
    );
    await expectSqlState(
      insertDocument({
        companyId: company.id,
        orderId: order.id,
        basis: "x".repeat(501),
      }),
      "23514",
    );
    await expectSqlState(
      insertItem({
        companyId: company.id,
        documentId: document.id,
        productId: product.id,
        quantityMilli: 0n,
      }),
      "23514",
    );
    await expectSqlState(
      insertItem({
        companyId: company.id,
        documentId: document.id,
        productId: product.id,
        unitPriceMinor: -1n,
      }),
      "23514",
    );
    await expectSqlState(
      insertItem({
        companyId: company.id,
        documentId: document.id,
        productId: product.id,
        discountAmountMinor: -1n,
      }),
      "23514",
    );
    await expectSqlState(
      insertItem({
        companyId: company.id,
        documentId: document.id,
        productId: product.id,
        taxAmountMinor: -1n,
      }),
      "23514",
    );
    await expectSqlState(
      insertItem({
        companyId: company.id,
        documentId: document.id,
        productId: product.id,
        netAmountMinor: -1n,
      }),
      "23514",
    );
    await expectSqlState(
      insertItem({
        companyId: company.id,
        documentId: document.id,
        productId: product.id,
        grossAmountMinor: -1n,
      }),
      "23514",
    );
    await expectSqlState(
      insertItem({
        companyId: company.id,
        documentId: document.id,
        productId: product.id,
        taxRateBp: -1,
      }),
      "23514",
    );
    await expectSqlState(
      insertItem({
        companyId: company.id,
        documentId: document.id,
        productId: product.id,
        discountKind: "percent",
      }),
      "23514",
    );
    await expectSqlState(
      insertItem({
        companyId: company.id,
        documentId: document.id,
        productId: product.id,
        taxTreatment: "vat",
      }),
      "23514",
    );

    const free = await insertDocument({
      companyId: company.id,
      orderId: order.id,
      type: "delivery_note",
      totalNetMinor: 0n,
      totalTaxMinor: 0n,
      totalGrossMinor: 0n,
    });
    expect(free.status).toBe("issued");
    expect(free.templateSource).toBe("system");
    expect(free.issuedOn).toBe("2026-08-29");
    expect(free.totalGrossMinor).toBe(0n);
  });

  it("stores a nullable basis snapshot of at most 500 characters", async () => {
    const company = await insertCompany();
    const order = await insertOrder({ companyId: company.id });
    const withBasis = await insertDocument({
      companyId: company.id,
      orderId: order.id,
      type: "delivery_note",
      basis: "Договір поставки № 1",
    });
    expect(withBasis.basis).toBe("Договір поставки № 1");
    expect(withBasis.basis?.length).toBeLessThanOrEqual(500);
  });

  it("enforces unique document numbers and one live row per order+type", async () => {
    const company = await insertCompany();
    const order = await insertOrder({ companyId: company.id });
    const otherOrder = await insertOrder({ companyId: company.id });

    await insertDocument({
      companyId: company.id,
      orderId: order.id,
      documentNumber: "RX-000001",
    });
    await expectSqlState(
      insertDocument({
        companyId: company.id,
        orderId: otherOrder.id,
        documentNumber: "RX-000001",
      }),
      "23505",
    );

    await expectSqlState(
      insertDocument({
        companyId: company.id,
        orderId: order.id,
        documentNumber: "RX-000002",
      }),
      "23505",
    );

    await dbClient.db
      .update(documents)
      .set({ status: "cancelled" })
      .where(eq(documents.orderId, order.id));

    await expectSqlState(
      insertDocument({
        companyId: company.id,
        orderId: otherOrder.id,
        documentNumber: "RX-000001",
      }),
      "23505",
    );

    const replacement = await insertDocument({
      companyId: company.id,
      orderId: order.id,
      documentNumber: "RX-000003",
    });
    expect(replacement.status).toBe("issued");

    const note = await insertDocument({
      companyId: company.id,
      orderId: order.id,
      type: "delivery_note",
      documentNumber: "VN-000001",
    });
    expect(note.type).toBe("delivery_note");
  });

  it("rejects a child row that points at another tenant's parent", async () => {
    const companyA = await insertCompany();
    const companyB = await insertCompany();
    const counterpartyB = await insertCounterparty(companyB.id);
    const productA = await insertProduct(companyA.id);
    const productB = await insertProduct(companyB.id);
    const variantB = await insertVariant(companyB.id, productB.id);
    const orderA = await insertOrder({ companyId: companyA.id });
    const orderB = await insertOrder({ companyId: companyB.id });
    const documentA = await insertDocument({
      companyId: companyA.id,
      orderId: orderA.id,
    });
    const documentB = await insertDocument({
      companyId: companyB.id,
      orderId: orderB.id,
    });

    await expectSqlState(
      insertDocument({
        companyId: companyA.id,
        orderId: orderB.id,
      }),
      "23503",
    );
    await expectSqlState(
      insertDocument({
        companyId: companyA.id,
        orderId: orderA.id,
        type: "delivery_note",
        counterpartyId: counterpartyB.id,
      }),
      "23503",
    );
    await expectSqlState(
      insertItem({
        companyId: companyA.id,
        documentId: documentB.id,
        productId: productA.id,
      }),
      "23503",
    );
    await expectSqlState(
      insertItem({
        companyId: companyA.id,
        documentId: documentA.id,
        productId: productB.id,
      }),
      "23503",
    );
    await expectSqlState(
      insertItem({
        companyId: companyA.id,
        documentId: documentA.id,
        productId: productA.id,
        variantId: variantB.id,
      }),
      "23503",
    );
    await expectSqlState(
      insertShareToken({
        companyId: companyA.id,
        documentId: documentB.id,
      }),
      "23503",
    );
  });

  it("restricts order and counterparty deletes while documents exist", async () => {
    const company = await insertCompany();
    const counterparty = await insertCounterparty(company.id);
    const order = await insertOrder({ companyId: company.id });
    await insertDocument({
      companyId: company.id,
      orderId: order.id,
      counterpartyId: counterparty.id,
    });

    await expectSqlState(
      dbClient.db.delete(orders).where(eq(orders.id, order.id)),
      "23503",
    );
    await expectSqlState(
      dbClient.db
        .delete(counterparties)
        .where(eq(counterparties.id, counterparty.id)),
      "23503",
    );
  });

  it("restricts product and variant deletes while document lines exist", async () => {
    const company = await insertCompany();
    const product = await insertProduct(company.id);
    const variant = await insertVariant(company.id, product.id);
    const order = await insertOrder({ companyId: company.id });
    const document = await insertDocument({
      companyId: company.id,
      orderId: order.id,
    });
    await insertItem({
      companyId: company.id,
      documentId: document.id,
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

  it("cascades document deletion to items and tokens, and company deletion to all four tables", async () => {
    const company = await insertCompany();
    const product = await insertProduct(company.id);
    const order = await insertOrder({ companyId: company.id });
    const document = await insertDocument({
      companyId: company.id,
      orderId: order.id,
    });
    await insertItem({
      companyId: company.id,
      documentId: document.id,
      productId: product.id,
    });
    await insertShareToken({
      companyId: company.id,
      documentId: document.id,
    });
    await dbClient.db.insert(documentNumberCounters).values({
      companyId: company.id,
      type: "payment_invoice",
    });

    await dbClient.db.delete(documents).where(eq(documents.id, document.id));
    expect(
      await dbClient.db
        .select()
        .from(documentItems)
        .where(eq(documentItems.documentId, document.id)),
    ).toEqual([]);
    expect(
      await dbClient.db
        .select()
        .from(documentShareTokens)
        .where(eq(documentShareTokens.documentId, document.id)),
    ).toEqual([]);
    expect(
      await dbClient.db.select().from(orders).where(eq(orders.id, order.id)),
    ).toHaveLength(1);

    const surviving = await insertDocument({
      companyId: company.id,
      orderId: order.id,
    });
    await insertItem({
      companyId: company.id,
      documentId: surviving.id,
      productId: product.id,
    });
    await insertShareToken({
      companyId: company.id,
      documentId: surviving.id,
    });
    await dbClient.db.delete(companies).where(eq(companies.id, company.id));
    expect(
      await dbClient.db
        .select()
        .from(documents)
        .where(eq(documents.companyId, company.id)),
    ).toEqual([]);
    expect(
      await dbClient.db
        .select()
        .from(documentItems)
        .where(eq(documentItems.companyId, company.id)),
    ).toEqual([]);
    expect(
      await dbClient.db
        .select()
        .from(documentShareTokens)
        .where(eq(documentShareTokens.companyId, company.id)),
    ).toEqual([]);
    expect(
      await dbClient.db
        .select()
        .from(documentNumberCounters)
        .where(eq(documentNumberCounters.companyId, company.id)),
    ).toEqual([]);
  });

  it("stores counters without a year and rejects negative last_number", async () => {
    const company = await insertCompany();
    const pk = await admin.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(con.oid) AS definition
       FROM pg_constraint con
       JOIN pg_class rel ON rel.oid = con.conrelid
       JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
       WHERE nsp.nspname = 'public'
         AND con.contype = 'p'
         AND rel.relname = 'document_number_counters'`,
    );
    expect(pk.rows).toHaveLength(1);
    expect(pk.rows[0]?.definition).toBe("PRIMARY KEY (company_id, type)");
    expect(pk.rows[0]?.definition).not.toMatch(/year/i);

    const row = await dbClient.db
      .insert(documentNumberCounters)
      .values({ companyId: company.id, type: "payment_invoice" })
      .returning();
    expect(row[0]?.lastNumber).toBe(0n);

    await expectSqlState(
      dbClient.db.insert(documentNumberCounters).values({
        companyId: company.id,
        type: "payment_invoice",
        lastNumber: 1n,
      }),
      "23505",
    );
    await expectSqlState(
      dbClient.db.insert(documentNumberCounters).values({
        companyId: company.id,
        type: "delivery_note",
        lastNumber: -1n,
      }),
      "23514",
    );
    await expectSqlState(
      dbClient.db.insert(documentNumberCounters).values({
        companyId: company.id,
        type: "agreement",
      }),
      "23514",
    );
  });

  it("enforces SHA-256 hex token_hash and one active token per document", async () => {
    const company = await insertCompany();
    const order = await insertOrder({ companyId: company.id });
    const document = await insertDocument({
      companyId: company.id,
      orderId: order.id,
    });
    const other = await insertDocument({
      companyId: company.id,
      orderId: order.id,
      type: "delivery_note",
    });

    await expectSqlState(
      insertShareToken({
        companyId: company.id,
        documentId: document.id,
        tokenHash: "abc",
      }),
      "23514",
    );
    await expectSqlState(
      insertShareToken({
        companyId: company.id,
        documentId: document.id,
        tokenHash: "A".repeat(64),
      }),
      "23514",
    );

    const first = await insertShareToken({
      companyId: company.id,
      documentId: document.id,
    });
    await expectSqlState(
      insertShareToken({
        companyId: company.id,
        documentId: document.id,
      }),
      "23505",
    );

    await dbClient.db
      .update(documentShareTokens)
      .set({ revokedAt: new Date("2026-08-29T12:00:00.000Z") })
      .where(eq(documentShareTokens.id, first.id));

    const rotated = await insertShareToken({
      companyId: company.id,
      documentId: document.id,
    });
    expect(rotated.revokedAt).toBeNull();

    const otherToken = await insertShareToken({
      companyId: company.id,
      documentId: other.id,
    });
    expect(otherToken.documentId).toBe(other.id);
  });

  it("rejects the same token_hash across two documents", async () => {
    const company = await insertCompany();
    const order = await insertOrder({ companyId: company.id });
    const document = await insertDocument({
      companyId: company.id,
      orderId: order.id,
    });
    const other = await insertDocument({
      companyId: company.id,
      orderId: order.id,
      type: "delivery_note",
    });
    const sharedHash = nextTokenHash();
    await insertShareToken({
      companyId: company.id,
      documentId: document.id,
      tokenHash: sharedHash,
    });
    await expectSqlState(
      insertShareToken({
        companyId: company.id,
        documentId: other.id,
        tokenHash: sharedHash,
      }),
      "23505",
    );
  });

  it("attaches the shared updated_at trigger to documents only", async () => {
    const result = await admin.query<{ tgname: string; relname: string }>(
      `SELECT t.tgname, c.relname
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       WHERE NOT t.tgisinternal
         AND t.tgname LIKE '%_set_updated_at'
         AND c.relname IN (
           'documents',
           'document_items',
           'document_number_counters',
           'document_share_tokens'
         )`,
    );
    const byTable = new Map(
      result.rows.map((row) => [row.relname, row.tgname]),
    );
    expect(byTable.get("documents")).toBe("documents_set_updated_at");
    expect(byTable.has("document_items")).toBe(false);
    expect(byTable.has("document_number_counters")).toBe(false);
    expect(byTable.has("document_share_tokens")).toBe(false);

    const company = await insertCompany();
    const order = await insertOrder({ companyId: company.id });
    const document = await insertDocument({
      companyId: company.id,
      orderId: order.id,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const updated = await dbClient.db
      .update(documents)
      .set({ templateName: "touched" })
      .where(eq(documents.id, document.id))
      .returning();
    expect(updated[0]?.updatedAt.getTime()).toBeGreaterThan(
      document.updatedAt.getTime(),
    );
  });

  it("seeds documents view/create/edit for admin and manager, view for employee", () => {
    const keys = new Set(
      rolePermissionDefaultRows.map((row) => `${row.role}:${row.permission}`),
    );
    for (const role of ["admin", "manager"] as const) {
      for (const permission of [
        "documents:view",
        "documents:create",
        "documents:edit",
      ] as const) {
        expect(keys.has(`${role}:${permission}`)).toBe(true);
      }
    }
    expect(keys.has("employee:documents:view")).toBe(true);
    expect(keys.has("employee:documents:create")).toBe(false);
    expect(keys.has("employee:documents:edit")).toBe(false);
    expect(keys.has("admin:documents:delete")).toBe(false);
    expect(keys.has("admin:documents:manage")).toBe(false);
    expect(keys.has("manager:documents:delete")).toBe(false);
    expect(keys.has("manager:documents:manage")).toBe(false);
    expect(keys.has("owner:documents:view")).toBe(false);
  });

  it("rejects non-ISO document currency", async () => {
    const company = await insertCompany();
    const product = await insertProduct(company.id);
    const headerOrder = await insertOrder({ companyId: company.id });
    const itemOrder = await insertOrder({ companyId: company.id });
    const document = await insertDocument({
      companyId: company.id,
      orderId: itemOrder.id,
    });

    await expectSqlState(
      insertDocument({
        companyId: company.id,
        orderId: headerOrder.id,
        currency: "uah",
      }),
      "23514",
    );
    await expectSqlState(
      insertDocument({
        companyId: company.id,
        orderId: headerOrder.id,
        currency: "US",
      }),
      "23514",
    );
    await expectSqlState(
      insertItem({
        companyId: company.id,
        documentId: document.id,
        productId: product.id,
        currency: "uah",
      }),
      "23514",
    );
  });
});
