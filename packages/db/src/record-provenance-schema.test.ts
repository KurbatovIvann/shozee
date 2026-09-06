/**
 * SHO-465: provenance columns on the nine AI-create tables. Catalog
 * checks only — no query filters, totals, or UI reads.
 */
import assert from "node:assert/strict";

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
import { user } from "./schema/auth.js";
import { products, productVariants } from "./schema/catalog.js";
import { companies } from "./schema/companies.js";
import {
  companyCustomers,
  counterparties,
  customerGroups,
} from "./schema/customers.js";
import { documents } from "./schema/documents.js";
import { companyCustomerInvites } from "./schema/invites.js";
import { orders } from "./schema/orders.js";
import { priceLists } from "./schema/pricing.js";
import {
  RECORD_CREATED_VIA_CHANNELS,
  type RecordCreatedVia,
} from "./schema/tenant-columns.js";
import { createTestDatabase, type TestDatabase } from "./testing/harness.js";

const PROVENANCE_TABLES = [
  "orders",
  "company_customers",
  "counterparties",
  "customer_groups",
  "products",
  "product_variants",
  "price_lists",
  "documents",
  "company_customer_invites",
] as const;

const EXCLUDED_TABLES = ["companies", "files"] as const;

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
      name: `Provenance Co ${String(sequence)}`,
      slug: `prov-co-${String(sequence)}`,
      prefix: `P${String(sequence)}`,
    })
    .returning();
  const row = rows[0];
  assert.ok(row);
  return row;
}

describe("record provenance schema (SHO-465)", () => {
  it("adds nullable created_via plus the vouched pair on the nine tables only", async () => {
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
         AND table_name = ANY($1::text[])
         AND column_name IN ('created_via', 'vouched_by', 'vouched_at')
       ORDER BY table_name, column_name`,
      [[...PROVENANCE_TABLES, ...EXCLUDED_TABLES]],
    );

    const byTable = new Map<string, string[]>();
    for (const row of result.rows) {
      const names = byTable.get(row.table_name) ?? [];
      names.push(row.column_name);
      byTable.set(row.table_name, names);
      expect(row.is_nullable).toBe("YES");
      expect(row.column_default).toBeNull();
      if (
        row.column_name === "created_via" ||
        row.column_name === "vouched_by"
      ) {
        expect(row.data_type).toBe("text");
      }
      if (row.column_name === "vouched_at") {
        expect(row.data_type).toBe("timestamp with time zone");
      }
    }

    for (const table of PROVENANCE_TABLES) {
      expect(byTable.get(table)).toEqual([
        "created_via",
        "vouched_at",
        "vouched_by",
      ]);
    }
    for (const table of EXCLUDED_TABLES) {
      expect(byTable.get(table)).toBeUndefined();
    }
  });

  it("declares created_via CHECK and vouched pair CHECK on each of the nine tables", async () => {
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
         AND rel.relname = ANY($1::text[])`,
      [[...PROVENANCE_TABLES]],
    );
    const byName = new Map(
      checks.rows.map((row) => [row.conname, row.definition]),
    );
    for (const table of PROVENANCE_TABLES) {
      const createdVia = byName.get(`${table}_created_via_check`);
      expect(createdVia).toBeDefined();
      for (const channel of RECORD_CREATED_VIA_CHANNELS) {
        expect(createdVia).toContain(`'${channel}'`);
      }
      const vouched = byName.get(`${table}_vouched_pair_check`);
      expect(vouched).toContain("vouched_by");
      expect(vouched).toContain("vouched_at");
      expect(vouched).toContain("IS NULL");
    }
  });

  it("types createdVia as the four channels or null", () => {
    expectTypeOf<
      (typeof orders.$inferSelect)["createdVia"]
    >().toEqualTypeOf<RecordCreatedVia | null>();
    expectTypeOf<(typeof orders.$inferSelect)["vouchedBy"]>().toEqualTypeOf<
      string | null
    >();
    expectTypeOf<
      (typeof orders.$inferSelect)["vouchedAt"]
    >().toEqualTypeOf<Date | null>();
  });

  it("rejects a created_via outside the four channels and requires the vouched pair together", async () => {
    const company = await insertCompany();
    sequence += 1;
    const userId = `prov_user_${String(sequence)}`;
    await dbClient.db.insert(user).values({
      id: userId,
      name: `Provenance User ${String(sequence)}`,
      email: `prov-user-${String(sequence)}@example.com`,
    });

    const group = (
      await dbClient.db
        .insert(customerGroups)
        .values({
          companyId: company.id,
          name: "Provenance group",
          slug: `prov-group-${String(sequence)}`,
        })
        .returning({ id: customerGroups.id })
    )[0];
    assert.ok(group);

    const customer = (
      await dbClient.db
        .insert(companyCustomers)
        .values({
          companyId: company.id,
          name: "Provenance customer",
          phone: `+38050${String(1000000 + sequence)}`,
        })
        .returning({ id: companyCustomers.id })
    )[0];
    assert.ok(customer);

    const party = (
      await dbClient.db
        .insert(counterparties)
        .values({ companyId: company.id, name: "Provenance party" })
        .returning({ id: counterparties.id })
    )[0];
    assert.ok(party);

    const product = (
      await dbClient.db
        .insert(products)
        .values({
          companyId: company.id,
          name: "Provenance product",
          basePriceMinor: 100n,
        })
        .returning({ id: products.id })
    )[0];
    assert.ok(product);

    const variant = (
      await dbClient.db
        .insert(productVariants)
        .values({
          companyId: company.id,
          productId: product.id,
          name: "Provenance variant",
        })
        .returning({ id: productVariants.id })
    )[0];
    assert.ok(variant);

    const list = (
      await dbClient.db
        .insert(priceLists)
        .values({ companyId: company.id, name: "Provenance list" })
        .returning({ id: priceLists.id })
    )[0];
    assert.ok(list);

    const order = (
      await dbClient.db
        .insert(orders)
        .values({
          companyId: company.id,
          orderNumber: `P-${String(sequence)}`,
          customerNameSnapshot: "unlinked",
          totalNetMinor: 100n,
          totalTaxMinor: 0n,
          totalGrossMinor: 100n,
        })
        .returning({ id: orders.id })
    )[0];
    assert.ok(order);

    const document = (
      await dbClient.db
        .insert(documents)
        .values({
          companyId: company.id,
          orderId: order.id,
          type: "payment_invoice",
          documentNumber: `PROV-${String(sequence)}`,
          issuedOn: "2026-09-06",
          supplierDetails: { legalName: "Fixture" },
          buyerDetails: { kind: "customer", displayName: "Buyer" },
          totalNetMinor: 100n,
          totalTaxMinor: 0n,
          totalGrossMinor: 100n,
          templateName: "Payment invoice",
        })
        .returning({ id: documents.id })
    )[0];
    assert.ok(document);

    const invite = (
      await dbClient.db
        .insert(companyCustomerInvites)
        .values({
          companyId: company.id,
          invitedBy: userId,
          tokenHash: sequence.toString(16).padStart(64, "b"),
          isReusable: true,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        })
        .returning({ id: companyCustomerInvites.id })
    )[0];
    assert.ok(invite);

    const rows: { table: (typeof PROVENANCE_TABLES)[number]; id: string }[] = [
      { table: "orders", id: order.id },
      { table: "company_customers", id: customer.id },
      { table: "counterparties", id: party.id },
      { table: "customer_groups", id: group.id },
      { table: "products", id: product.id },
      { table: "product_variants", id: variant.id },
      { table: "price_lists", id: list.id },
      { table: "documents", id: document.id },
      { table: "company_customer_invites", id: invite.id },
    ];

    for (const row of rows) {
      const stored = await admin.query<{
        created_via: string | null;
        vouched_by: string | null;
        vouched_at: Date | null;
      }>(
        `SELECT created_via, vouched_by, vouched_at
         FROM ${row.table}
         WHERE id = $1`,
        [row.id],
      );
      expect(stored.rows[0]).toEqual({
        created_via: null,
        vouched_by: null,
        vouched_at: null,
      });

      await admin.query(
        `UPDATE ${row.table} SET created_via = 'ui' WHERE id = $1`,
        [row.id],
      );
      await expectSqlState(
        admin.query(
          `UPDATE ${row.table} SET created_via = 'email' WHERE id = $1`,
          [row.id],
        ),
        "23514",
      );
      await expectSqlState(
        admin.query(
          `UPDATE ${row.table} SET vouched_by = 'actor-1' WHERE id = $1`,
          [row.id],
        ),
        "23514",
      );
      await expectSqlState(
        admin.query(
          `UPDATE ${row.table}
           SET vouched_by = NULL, vouched_at = now()
           WHERE id = $1`,
          [row.id],
        ),
        "23514",
      );
      await admin.query(
        `UPDATE ${row.table}
         SET vouched_by = 'actor-1', vouched_at = now()
         WHERE id = $1`,
        [row.id],
      );
      await admin.query(
        `UPDATE ${row.table}
         SET vouched_by = NULL, vouched_at = NULL
         WHERE id = $1`,
        [row.id],
      );
    }
  });
});
