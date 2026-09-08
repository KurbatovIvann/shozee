/**
 * SHO-170 (customers-T2) verification for CRM columns, counterparties,
 * customer_legal_profiles, and permission seed. Data-path assertions use
 * Drizzle through the runtime role; raw SQL is limited to PostgreSQL
 * catalog structure checks.
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
import type { UserId } from "./schema/auth-ids.js";
import { user } from "./schema/auth.js";
import { companies } from "./schema/companies.js";
import {
  companyCustomers,
  counterparties,
  customerGroups,
  customerLegalProfiles,
} from "./schema/customers.js";
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
  const id = `crm_user_${String(sequence)}`;
  await dbClient.db.insert(user).values({
    id,
    name: `CRM User ${String(sequence)}`,
    email: `crm-user-${String(sequence)}@example.com`,
  });
  return id;
}

async function insertCompany() {
  sequence += 1;
  const rows = await dbClient.db
    .insert(companies)
    .values({
      name: `CRM Co ${String(sequence)}`,
      slug: `crm-co-${String(sequence)}`,
      prefix: `R${String(sequence)}`,
    })
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
      email: `crm-customer-${String(sequence)}@example.com`,
      ...overrides,
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

describe("customers CRM schema slice", () => {
  it("adds CRM columns and the counterparty / legal-profile tables", async () => {
    const groups = await admin.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'customer_groups'
       ORDER BY ordinal_position`,
    );
    expect(groups.rows.map((row) => row.column_name)).toEqual([
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

    const customers = await admin.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'company_customers'
       ORDER BY ordinal_position`,
    );
    expect(customers.rows.map((row) => row.column_name)).toEqual([
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
    const status = customers.rows.find((row) => row.column_name === "status");
    expect(status?.data_type).toBe("text");
    expect(status?.is_nullable).toBe("NO");
    expect(status?.column_default).toContain("active");
    const userId = customers.rows.find((row) => row.column_name === "user_id");
    expect(userId?.data_type).toBe("text");
    expect(userId?.is_nullable).toBe("YES");

    const legal = await admin.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'customer_legal_profiles'
       ORDER BY ordinal_position`,
    );
    expect(legal.rows.map((row) => row.column_name)).toEqual([
      "id",
      "user_id",
      "entity_type",
      "legal_name",
      "edrpou",
      "legal_address",
      "iban",
      "bank_name",
      "bank_mfo",
      "phone",
      "email",
      "created_at",
      "updated_at",
    ]);
    expect(legal.rows.map((row) => row.column_name)).not.toContain(
      "company_id",
    );

    const faces = await admin.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'counterparties'
       ORDER BY ordinal_position`,
    );
    expect(faces.rows.map((row) => row.column_name)).toEqual([
      "id",
      "company_id",
      "customer_id",
      "name",
      "edrpou",
      "legal_address",
      "iban",
      "bank_name",
      "bank_mfo",
      "phone",
      "email",
      "notes",
      "created_at",
      "updated_at",
      "created_via",
      "vouched_by",
      "vouched_at",
      "name_fts",
    ]);
    expect(faces.rows.map((row) => row.column_name)).not.toContain("user_id");
    expect(faces.rows.map((row) => row.column_name)).not.toContain("group_id");
    expect(faces.rows.map((row) => row.column_name)).not.toContain(
      "price_list_id",
    );

    expectTypeOf<
      (typeof companyCustomers.$inferSelect)["status"]
    >().toEqualTypeOf<string>();
    expectTypeOf<
      (typeof customerLegalProfiles.$inferSelect)["entityType"]
    >().toEqualTypeOf<string>();
    expectTypeOf<
      (typeof counterparties.$inferSelect)["customerId"]
    >().toEqualTypeOf<string | null>();
  });

  it("declares CHECKs, uniques, and list indexes", async () => {
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
         AND rel.relname IN
           ('company_customers', 'customer_legal_profiles')`,
    );
    const checkDefs = new Map(
      checks.rows.map((row) => [row.conname, row.definition]),
    );
    expect(checkDefs.get("company_customers_status_check")).toContain("active");
    expect(checkDefs.get("company_customers_status_check")).toContain(
      "archived",
    );
    expect(checkDefs.get("company_customers_contact_check")).toContain("phone");
    expect(checkDefs.get("company_customers_contact_check")).toContain("email");
    expect(checkDefs.get("company_customers_contact_check")).toContain(
      "user_id",
    );
    expect(
      checkDefs.get("customer_legal_profiles_entity_type_check"),
    ).toContain("fop");
    expect(
      checkDefs.get("customer_legal_profiles_entity_type_check"),
    ).toContain("tov");

    const indexes = await admin.query<{
      indexname: string;
      indexdef: string;
    }>(
      `SELECT indexname, indexdef
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename IN
           ('customer_groups', 'company_customers', 'counterparties',
            'customer_legal_profiles')`,
    );
    const indexDefs = new Map(
      indexes.rows.map((row) => [row.indexname, row.indexdef]),
    );
    expect(indexDefs.get("customer_groups_company_slug_uq")).toContain(
      "UNIQUE",
    );
    expect(indexDefs.get("customer_groups_company_slug_uq")).toContain(
      "(company_id, slug)",
    );
    expect(indexDefs.get("company_customers_company_user_uq")).toContain(
      "UNIQUE",
    );
    expect(indexDefs.get("company_customers_company_user_uq")).toContain(
      "(company_id, user_id)",
    );
    expect(indexDefs.get("company_customers_company_user_uq")).toContain(
      "WHERE (user_id IS NOT NULL)",
    );
    expect(indexDefs.get("company_customers_company_status_idx")).toContain(
      "(company_id, status)",
    );
    const customersUpdatedAt = indexDefs.get(
      "company_customers_company_updated_at_id_idx",
    );
    expect(customersUpdatedAt).toContain("(company_id");
    expect(customersUpdatedAt).toMatch(/updated_at.*DESC/i);
    expect(customersUpdatedAt).toMatch(/id.*DESC/i);
    expect(indexDefs.get("company_customers_company_group_idx")).toContain(
      "(company_id, group_id)",
    );
    expect(indexDefs.get("company_customers_company_group_idx")).toContain(
      "WHERE (group_id IS NOT NULL)",
    );
    expect(indexDefs.has("company_customers_group_idx")).toBe(false);
    expect(indexDefs.has("company_customers_company_idx")).toBe(false);
    expect(indexDefs.has("customer_groups_company_idx")).toBe(false);
    expect(indexDefs.has("counterparties_company_idx")).toBe(false);
    const counterpartiesUpdatedAt = indexDefs.get(
      "counterparties_company_updated_at_id_idx",
    );
    expect(counterpartiesUpdatedAt).toContain("(company_id");
    expect(counterpartiesUpdatedAt).toMatch(/updated_at.*DESC/i);
    expect(counterpartiesUpdatedAt).toMatch(/id.*DESC/i);
    expect(
      indexDefs.get("company_customers_company_phone_unlinked_idx"),
    ).toContain("(company_id, phone)");
    expect(
      indexDefs.get("company_customers_company_phone_unlinked_idx"),
    ).toContain("WHERE (user_id IS NULL)");
    expect(
      indexDefs.get("company_customers_company_email_unlinked_idx"),
    ).toContain("(company_id, email)");
    expect(
      indexDefs.get("company_customers_company_email_unlinked_idx"),
    ).toContain("WHERE (user_id IS NULL)");
    const nameTrgm = indexDefs.get("company_customers_name_trgm_idx");
    expect(nameTrgm).toMatch(/USING gin/i);
    expect(nameTrgm).toContain("gin_trgm_ops");
    expect(nameTrgm).toMatch(/\bname\b/);
    expect(indexDefs.get("company_customers_name_fts_gin_idx")).toMatch(
      /USING gin/i,
    );
    expect(indexDefs.get("company_customers_name_fts_gin_idx")).toContain(
      "name_fts",
    );
    const groupTrgm = indexDefs.get("customer_groups_name_trgm_idx");
    expect(groupTrgm).toMatch(/USING gin/i);
    expect(groupTrgm).toContain("gin_trgm_ops");
    expect(indexDefs.get("customer_groups_name_fts_gin_idx")).toContain(
      "name_fts",
    );
    const faceTrgm = indexDefs.get("counterparties_name_trgm_idx");
    expect(faceTrgm).toMatch(/USING gin/i);
    expect(faceTrgm).toContain("gin_trgm_ops");
    expect(indexDefs.get("counterparties_name_fts_gin_idx")).toContain(
      "name_fts",
    );
    expect(indexDefs.get("counterparties_company_id_id_uq")).toContain(
      "UNIQUE",
    );
    expect(indexDefs.get("counterparties_company_id_id_uq")).toContain(
      "(company_id, id)",
    );
    expect(indexDefs.get("counterparties_company_edrpou_uq")).toContain(
      "UNIQUE",
    );
    expect(indexDefs.get("counterparties_company_edrpou_uq")).toContain(
      "WHERE (edrpou IS NOT NULL)",
    );
    expect(indexDefs.get("counterparties_company_customer_idx")).toContain(
      "(company_id, customer_id)",
    );
    expect(indexDefs.get("customer_legal_profiles_user_id_uq")).toContain(
      "UNIQUE",
    );
    expect(indexDefs.has("customer_legal_profiles_company_id_id_uq")).toBe(
      false,
    );
  });

  it("declares composite same-tenant FKs and user FKs", async () => {
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
           ('company_customers', 'counterparties', 'customer_legal_profiles')`,
    );
    const defs = new Map(
      result.rows.map((row) => [row.conname, row.definition]),
    );

    expect(defs.get("counterparties_company_customers_company_fk")).toContain(
      "(company_id, customer_id) REFERENCES company_customers(company_id, id)",
    );
    expect(defs.get("counterparties_company_customers_company_fk")).toContain(
      "ON DELETE SET NULL (customer_id)",
    );
    expect(defs.get("company_customers_user_id_user_id_fk")).toContain(
      'FOREIGN KEY (user_id) REFERENCES "user"(id)',
    );
    expect(defs.get("company_customers_user_id_user_id_fk")).toContain(
      "ON DELETE SET NULL",
    );
    expect(defs.get("customer_legal_profiles_user_id_user_id_fk")).toContain(
      'FOREIGN KEY (user_id) REFERENCES "user"(id)',
    );
    expect(defs.get("customer_legal_profiles_user_id_user_id_fk")).toContain(
      "ON DELETE CASCADE",
    );
    expect(defs.get("counterparties_company_id_companies_id_fk")).toContain(
      "FOREIGN KEY (company_id) REFERENCES companies(id)",
    );
    expect(defs.get("counterparties_company_id_companies_id_fk")).toContain(
      "ON DELETE CASCADE",
    );
  });

  it("defaults status/sort_order/entity_type and rejects illegal values", async () => {
    const company = await insertCompany();
    const group = await insertGroup(company.id);
    expect(group.sortOrder).toBe(0);

    const customer = await insertCustomer(company.id);
    expect(customer.status).toBe("active");

    const archived = await insertCustomer(company.id, { status: "archived" });
    expect(archived.status).toBe("archived");

    await expectSqlState(
      insertCustomer(company.id, { status: "draft" }),
      "23514",
    );
    await expectSqlState(
      dbClient.db.insert(companyCustomers).values({
        companyId: company.id,
        name: "No contact",
      }),
      "23514",
    );

    const userId = await insertUser();
    const phoneOnly = await insertCustomer(company.id, {
      phone: "+380501112233",
      email: null,
      userId,
    });
    expect(phoneOnly.phone).toBe("+380501112233");
    expect(phoneOnly.email).toBeNull();

    const profile = await dbClient.db
      .insert(customerLegalProfiles)
      .values({ userId })
      .returning();
    expect(profile[0]?.entityType).toBe("fop");

    await expectSqlState(
      dbClient.db.insert(customerLegalProfiles).values({
        userId: await insertUser(),
        entityType: "llc",
      }),
      "23514",
    );
  });

  it("enforces unique slug, linked user, edrpou, and legal profile", async () => {
    const companyA = await insertCompany();
    const companyB = await insertCompany();
    await insertGroup(companyA.id, { slug: "wholesale" });
    await expectSqlState(
      insertGroup(companyA.id, { slug: "wholesale" }),
      "23505",
    );
    const otherSlug = await insertGroup(companyB.id, { slug: "wholesale" });
    expect(otherSlug.slug).toBe("wholesale");

    const linkedUser = await insertUser();
    await insertCustomer(companyA.id, { userId: linkedUser, email: null });
    await expectSqlState(
      insertCustomer(companyA.id, { userId: linkedUser, email: null }),
      "23505",
    );
    const otherTenant = await insertCustomer(companyB.id, {
      userId: linkedUser,
      email: null,
    });
    expect(otherTenant.userId).toBe(linkedUser);

    await insertCounterparty(companyA.id, { edrpou: "12345678" });
    await expectSqlState(
      insertCounterparty(companyA.id, { edrpou: "12345678" }),
      "23505",
    );
    await insertCounterparty(companyA.id, { edrpou: null });
    await insertCounterparty(companyA.id, { edrpou: null });

    const legalUser = await insertUser();
    await dbClient.db.insert(customerLegalProfiles).values({
      userId: legalUser,
    });
    await expectSqlState(
      dbClient.db.insert(customerLegalProfiles).values({
        userId: legalUser,
      }),
      "23505",
    );
  });

  it("rejects a counterparty that points at another tenant's customer", async () => {
    const companyA = await insertCompany();
    const companyB = await insertCompany();
    const customerB = await insertCustomer(companyB.id);
    await expectSqlState(
      insertCounterparty(companyA.id, { customerId: customerB.id }),
      "23503",
    );
  });

  it("allows standalone counterparties and 0..N per customer; delete unlinks", async () => {
    const company = await insertCompany();
    const customer = await insertCustomer(company.id);
    const standalone = await insertCounterparty(company.id);
    expect(standalone.customerId).toBeNull();
    const first = await insertCounterparty(company.id, {
      customerId: customer.id,
    });
    const second = await insertCounterparty(company.id, {
      customerId: customer.id,
    });
    expect(first.customerId).toBe(customer.id);
    expect(second.customerId).toBe(customer.id);

    await dbClient.db
      .delete(companyCustomers)
      .where(eq(companyCustomers.id, customer.id));
    const remaining = await dbClient.db
      .select()
      .from(counterparties)
      .where(eq(counterparties.companyId, company.id));
    expect(remaining).toHaveLength(3);
    expect(remaining.every((row) => row.customerId === null)).toBe(true);
    expect(remaining.every((row) => row.companyId === company.id)).toBe(true);
  });

  it("SET NULLs user_id when the user is deleted if another contact remains", async () => {
    const company = await insertCompany();
    const userId = await insertUser();
    const customer = await insertCustomer(company.id, {
      userId,
      phone: "+380501112233",
    });
    await dbClient.db.delete(user).where(eq(user.id, userId));
    const rows = await dbClient.db
      .select()
      .from(companyCustomers)
      .where(eq(companyCustomers.id, customer.id));
    expect(rows[0]?.userId).toBeNull();
    expect(rows[0]?.phone).toBe("+380501112233");
    expect(rows[0]?.email).toBe(customer.email);
  });

  it("stamps a placeholder email so user delete can SET NULL the only contact", async () => {
    const company = await insertCompany();
    const userId = await insertUser();
    const customer = await insertCustomer(company.id, {
      userId,
      email: null,
    });
    expect(customer.email).toBeNull();
    expect(customer.phone).toBeNull();
    await dbClient.db.delete(user).where(eq(user.id, userId));
    const rows = await dbClient.db
      .select()
      .from(companyCustomers)
      .where(eq(companyCustomers.id, customer.id));
    expect(rows[0]?.userId).toBeNull();
    expect(rows[0]?.email).toBe(`legacy.${customer.id}@invalid.local`);
  });

  it("still rejects an update that clears every contact", async () => {
    const company = await insertCompany();
    const customer = await insertCustomer(company.id);
    await expectSqlState(
      dbClient.db
        .update(companyCustomers)
        .set({ email: null, phone: null, userId: null })
        .where(eq(companyCustomers.id, customer.id)),
      "23514",
    );
  });

  it("cascades legal profiles when the user is deleted", async () => {
    const userId = await insertUser();
    await dbClient.db.insert(customerLegalProfiles).values({ userId });
    await dbClient.db.delete(user).where(eq(user.id, userId));
    const rows = await dbClient.db
      .select()
      .from(customerLegalProfiles)
      .where(eq(customerLegalProfiles.userId, userId));
    expect(rows).toEqual([]);
  });

  it("attaches updated_at triggers to counterparties and legal profiles", async () => {
    const result = await admin.query<{ tgname: string }>(
      `SELECT t.tgname
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       WHERE NOT t.tgisinternal
         AND t.tgname LIKE '%_set_updated_at'
         AND c.relname IN ('counterparties', 'customer_legal_profiles')`,
    );
    const names = new Set(result.rows.map((row) => row.tgname));
    expect(names).toContain("counterparties_set_updated_at");
    expect(names).toContain("customer_legal_profiles_set_updated_at");

    const company = await insertCompany();
    const row = await insertCounterparty(company.id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const updated = await dbClient.db
      .update(counterparties)
      .set({ notes: "touched" })
      .where(eq(counterparties.id, row.id))
      .returning();
    expect(updated[0]?.updatedAt.getTime()).toBeGreaterThan(
      row.updatedAt.getTime(),
    );
  });

  it("seeds customers create/edit/delete for admin and manager, view for employee", () => {
    const keys = new Set(
      rolePermissionDefaultRows.map((row) => `${row.role}:${row.permission}`),
    );
    expect(keys.has("admin:customers:view")).toBe(true);
    expect(keys.has("admin:customers:create")).toBe(true);
    expect(keys.has("admin:customers:edit")).toBe(true);
    expect(keys.has("admin:customers:delete")).toBe(true);
    expect(keys.has("manager:customers:view")).toBe(true);
    expect(keys.has("manager:customers:create")).toBe(true);
    expect(keys.has("manager:customers:edit")).toBe(true);
    expect(keys.has("manager:customers:delete")).toBe(false);
    expect(keys.has("employee:customers:view")).toBe(true);
    expect(keys.has("employee:customers:create")).toBe(false);
    expect(keys.has("employee:customers:edit")).toBe(false);
    expect(keys.has("employee:customers:delete")).toBe(false);
    expect(keys.has("owner:customers:create")).toBe(false);
  });

  it("rejects a negative customer_groups.sort_order", async () => {
    const company = await insertCompany();
    await expectSqlState(insertGroup(company.id, { sortOrder: -1 }), "23514");
  });
});
