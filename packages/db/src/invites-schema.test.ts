/**
 * SHO-202 (invites-T1) verification for invite tokens, redemptions, and
 * the `customers:invite` seed. Data-path assertions use Drizzle through
 * the runtime role; raw SQL is limited to PostgreSQL catalog structure.
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
import { companyCustomers, customerGroups } from "./schema/customers.js";
import {
  companyCustomerInviteRedemptions,
  companyCustomerInvites,
} from "./schema/invites.js";
import { priceLists } from "./schema/pricing.js";
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

function nextTokenHash(): string {
  sequence += 1;
  return sequence.toString(16).padStart(64, "a");
}

function futureExpiry(): Date {
  return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
}

async function insertUser(): Promise<UserId> {
  sequence += 1;
  const id = `invites_user_${String(sequence)}`;
  await dbClient.db.insert(user).values({
    id,
    name: `Invites User ${String(sequence)}`,
    email: `invites-user-${String(sequence)}@example.com`,
  });
  return id;
}

async function insertCompany() {
  sequence += 1;
  const rows = await dbClient.db
    .insert(companies)
    .values({
      name: `Invites Co ${String(sequence)}`,
      slug: `invites-co-${String(sequence)}`,
      prefix: `I${String(sequence)}`,
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
      name: `Invite group ${String(sequence)}`,
      slug: `invite-group-${String(sequence)}`,
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
  sequence += 1;
  const rows = await dbClient.db
    .insert(priceLists)
    .values({
      companyId,
      name: `Invite list ${String(sequence)}`,
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
      name: `Invite customer ${String(sequence)}`,
      email: `invite-customer-${String(sequence)}@example.com`,
      ...overrides,
    })
    .returning();
  const row = rows[0];
  assert.ok(row);
  return row;
}

async function insertInvite(
  values: Pick<typeof companyCustomerInvites.$inferInsert, "companyId"> &
    Partial<typeof companyCustomerInvites.$inferInsert>,
) {
  const invitedBy = values.invitedBy ?? (await insertUser());
  const rows = await dbClient.db
    .insert(companyCustomerInvites)
    .values({
      invitedBy,
      tokenHash: nextTokenHash(),
      isReusable: false,
      maxUses: 1,
      expiresAt: futureExpiry(),
      ...values,
    })
    .returning();
  const row = rows[0];
  assert.ok(row);
  return row;
}

async function insertRedemption(
  values: Pick<
    typeof companyCustomerInviteRedemptions.$inferInsert,
    "companyId" | "inviteId" | "userId" | "companyCustomerId"
  > &
    Partial<typeof companyCustomerInviteRedemptions.$inferInsert>,
) {
  const rows = await dbClient.db
    .insert(companyCustomerInviteRedemptions)
    .values({
      acceptedAt: new Date(),
      ...values,
    })
    .returning();
  const row = rows[0];
  assert.ok(row);
  return row;
}

describe("customer invite schema slice", () => {
  it("creates only the card-named columns with timestamptz timestamps", async () => {
    const invites = await admin.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'company_customer_invites'
       ORDER BY ordinal_position`,
    );
    expect(invites.rows.map((row) => row.column_name)).toEqual([
      "id",
      "company_id",
      "invited_by",
      "token_hash",
      "is_reusable",
      "max_uses",
      "uses_count",
      "expires_at",
      "status",
      "group_id",
      "price_list_id",
      "name",
      "phone",
      "email",
      "created_at",
      "updated_at",
      "created_via",
      "vouched_by",
      "vouched_at",
    ]);
    for (const row of invites.rows) {
      if (row.column_name.endsWith("_at")) {
        expect(row.data_type).toBe("timestamp with time zone");
      }
    }
    const tokenHash = invites.rows.find(
      (row) => row.column_name === "token_hash",
    );
    expect(tokenHash?.data_type).toBe("text");
    expect(tokenHash?.is_nullable).toBe("NO");
    const maxUses = invites.rows.find((row) => row.column_name === "max_uses");
    expect(maxUses?.is_nullable).toBe("YES");
    const usesCount = invites.rows.find(
      (row) => row.column_name === "uses_count",
    );
    expect(usesCount?.is_nullable).toBe("NO");
    expect(usesCount?.column_default).toContain("0");
    const status = invites.rows.find((row) => row.column_name === "status");
    expect(status?.column_default).toContain("pending");
    expect(invites.rows.map((row) => row.column_name)).not.toContain("token");
    expect(invites.rows.map((row) => row.column_name)).not.toContain(
      "company_customer_id",
    );

    const redemptions = await admin.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'company_customer_invite_redemptions'
       ORDER BY ordinal_position`,
    );
    expect(redemptions.rows.map((row) => row.column_name)).toEqual([
      "id",
      "invite_id",
      "company_id",
      "user_id",
      "company_customer_id",
      "accepted_at",
    ]);
    expect(redemptions.rows.map((row) => row.column_name)).not.toContain(
      "updated_at",
    );
    const acceptedAt = redemptions.rows.find(
      (row) => row.column_name === "accepted_at",
    );
    expect(acceptedAt?.data_type).toBe("timestamp with time zone");
    expect(acceptedAt?.is_nullable).toBe("NO");

    expectTypeOf<
      (typeof companyCustomerInvites.$inferInsert)["invitedBy"]
    >().toEqualTypeOf<UserId>();
    expectTypeOf<
      (typeof companyCustomerInviteRedemptions.$inferInsert)["userId"]
    >().toEqualTypeOf<UserId>();
  });

  it("does not add invite_id to company_customers", async () => {
    const result = await admin.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'company_customers'
         AND column_name = 'invite_id'`,
    );
    expect(result.rows).toEqual([]);
  });

  it("declares UNIQUE (company_id, id), global token_hash, and named indexes", async () => {
    const result = await admin.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename IN
           ('company_customer_invites', 'company_customer_invite_redemptions')`,
    );
    const indexes = new Map(
      result.rows.map((row) => [row.indexname, row.indexdef]),
    );

    expect(indexes.get("company_customer_invites_company_id_id_uq")).toContain(
      "UNIQUE",
    );
    expect(indexes.get("company_customer_invites_company_id_id_uq")).toContain(
      "(company_id, id)",
    );
    expect(indexes.get("company_customer_invites_token_hash_uq")).toContain(
      "UNIQUE",
    );
    expect(indexes.get("company_customer_invites_token_hash_uq")).toContain(
      "(token_hash)",
    );
    expect(indexes.has("company_customer_invites_company_idx")).toBe(false);
    const invitesUpdatedAt = indexes.get(
      "company_customer_invites_company_updated_at_id_idx",
    );
    expect(invitesUpdatedAt).toContain("(company_id");
    expect(invitesUpdatedAt).toMatch(/updated_at.*DESC/i);
    expect(invitesUpdatedAt).toMatch(/id.*DESC/i);
    expect(
      indexes.get("company_customer_invites_company_status_idx"),
    ).toContain("(company_id, status)");
    expect(indexes.get("company_customer_invites_company_group_idx")).toContain(
      "(company_id, group_id)",
    );
    expect(indexes.get("company_customer_invites_company_group_idx")).toContain(
      "WHERE (group_id IS NOT NULL)",
    );
    expect(
      indexes.get("company_customer_invites_company_price_list_idx"),
    ).toContain("(company_id, price_list_id)");
    expect(
      indexes.get("company_customer_invites_company_price_list_idx"),
    ).toContain("WHERE (price_list_id IS NOT NULL)");
    const pendingExpiry = indexes.get(
      "company_customer_invites_pending_expires_at_idx",
    );
    expect(pendingExpiry).toContain("(expires_at)");
    expect(pendingExpiry).toMatch(/status = 'pending'/);
    expect(pendingExpiry).not.toContain("UNIQUE");

    expect(
      indexes.get("company_customer_invite_redemptions_company_id_id_uq"),
    ).toContain("UNIQUE");
    expect(
      indexes.get("company_customer_invite_redemptions_company_id_id_uq"),
    ).toContain("(company_id, id)");
    expect(
      indexes.get("company_customer_invite_redemptions_invite_user_uq"),
    ).toContain("UNIQUE");
    expect(
      indexes.get("company_customer_invite_redemptions_invite_user_uq"),
    ).toContain("(invite_id, user_id)");
    expect(
      indexes.get("company_customer_invite_redemptions_company_customer_idx"),
    ).toContain("(company_id, company_customer_id)");
  });

  it("declares CHECKs for status, uses, and personal vs reusable", async () => {
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
         AND con.contype = 'c'
         AND rel.relname = 'company_customer_invites'`,
    );
    const defs = new Map(
      result.rows.map((row) => [row.conname, row.definition]),
    );
    expect(defs.get("company_customer_invites_status_check")).toContain(
      "pending",
    );
    expect(defs.get("company_customer_invites_status_check")).toContain(
      "revoked",
    );
    expect(defs.get("company_customer_invites_uses_count_check")).toContain(
      "uses_count",
    );
    expect(defs.get("company_customer_invites_max_uses_check")).toContain(
      "max_uses",
    );
    expect(defs.get("company_customer_invites_personal_check")).toContain(
      "is_reusable",
    );
  });

  it("declares company CASCADE, inviter RESTRICT, and composite FKs", async () => {
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
           ('company_customer_invites', 'company_customer_invite_redemptions')
       ORDER BY con.conname`,
    );
    const defs = new Map(
      result.rows.map((row) => [row.conname, row.definition]),
    );

    expect(
      defs.get("company_customer_invites_company_id_companies_id_fk"),
    ).toContain("FOREIGN KEY (company_id) REFERENCES companies(id)");
    expect(
      defs.get("company_customer_invites_company_id_companies_id_fk"),
    ).toContain("ON DELETE CASCADE");
    expect(
      defs.get("company_customer_invites_invited_by_user_id_fk"),
    ).toContain('FOREIGN KEY (invited_by) REFERENCES "user"(id)');
    expect(
      defs.get("company_customer_invites_invited_by_user_id_fk"),
    ).toContain("ON DELETE RESTRICT");
    expect(
      defs.get("company_customer_invites_customer_groups_company_fk"),
    ).toContain(
      "(company_id, group_id) REFERENCES customer_groups(company_id, id)",
    );
    expect(
      defs.get("company_customer_invites_customer_groups_company_fk"),
    ).toContain("ON DELETE SET NULL (group_id)");
    expect(
      defs.get("company_customer_invites_price_lists_company_fk"),
    ).toContain(
      "(company_id, price_list_id) REFERENCES price_lists(company_id, id)",
    );
    expect(
      defs.get("company_customer_invites_price_lists_company_fk"),
    ).toContain("ON DELETE SET NULL (price_list_id)");

    expect(
      defs.get("company_customer_invite_redemptions_invites_company_fk"),
    ).toContain(
      "(company_id, invite_id) REFERENCES company_customer_invites(company_id, id)",
    );
    expect(
      defs.get("company_customer_invite_redemptions_invites_company_fk"),
    ).toContain("ON DELETE CASCADE");
    expect(
      defs.get("company_customer_invite_redemptions_customers_company_fk"),
    ).toContain(
      "(company_id, company_customer_id) REFERENCES company_customers(company_id, id)",
    );
    expect(
      defs.get("company_customer_invite_redemptions_customers_company_fk"),
    ).toContain("ON DELETE CASCADE");
    expect(
      defs.get("company_customer_invite_redemptions_user_id_user_id_fk"),
    ).toContain("ON DELETE RESTRICT");
  });

  it("defaults personal pending invites and rejects illegal status", async () => {
    const company = await insertCompany();
    const personal = await insertInvite({ companyId: company.id });
    expect(personal.status).toBe("pending");
    expect(personal.usesCount).toBe(0);
    expect(personal.isReusable).toBe(false);
    expect(personal.maxUses).toBe(1);

    const revoked = await insertInvite({
      companyId: company.id,
      status: "revoked",
    });
    expect(revoked.status).toBe("revoked");

    await expectSqlState(
      insertInvite({ companyId: company.id, status: "expired" }),
      "23514",
    );
    await expectSqlState(
      insertInvite({ companyId: company.id, status: "exhausted" }),
      "23514",
    );
    await expectSqlState(
      insertInvite({ companyId: company.id, status: "accepted" }),
      "23514",
    );
  });

  it("enforces personal vs reusable CHECKs", async () => {
    const company = await insertCompany();

    const personal = await insertInvite({
      companyId: company.id,
      isReusable: false,
      maxUses: 1,
    });
    expect(personal.isReusable).toBe(false);
    expect(personal.maxUses).toBe(1);

    const reusableLimited = await insertInvite({
      companyId: company.id,
      isReusable: true,
      maxUses: 1,
    });
    expect(reusableLimited.isReusable).toBe(true);
    expect(reusableLimited.maxUses).toBe(1);

    const reusableUnlimited = await insertInvite({
      companyId: company.id,
      isReusable: true,
      maxUses: null,
    });
    expect(reusableUnlimited.maxUses).toBeNull();

    await expectSqlState(
      insertInvite({
        companyId: company.id,
        isReusable: false,
        maxUses: 2,
      }),
      "23514",
    );
    await expectSqlState(
      insertInvite({
        companyId: company.id,
        isReusable: false,
        maxUses: null,
      }),
      "23514",
    );
    await expectSqlState(
      insertInvite({
        companyId: company.id,
        isReusable: true,
        maxUses: 0,
      }),
      "23514",
    );
    await expectSqlState(
      insertInvite({
        companyId: company.id,
        usesCount: -1,
      }),
      "23514",
    );
  });

  it("rejects the same token_hash across two companies", async () => {
    const companyA = await insertCompany();
    const companyB = await insertCompany();
    const sharedHash = nextTokenHash();
    await insertInvite({ companyId: companyA.id, tokenHash: sharedHash });
    await expectSqlState(
      insertInvite({ companyId: companyB.id, tokenHash: sharedHash }),
      "23505",
    );
  });

  it("rejects an invite that points at another tenant's group or price list", async () => {
    const companyA = await insertCompany();
    const companyB = await insertCompany();
    const groupB = await insertGroup(companyB.id);
    const listB = await insertPriceList(companyB.id);

    await expectSqlState(
      insertInvite({ companyId: companyA.id, groupId: groupB.id }),
      "23503",
    );
    await expectSqlState(
      insertInvite({ companyId: companyA.id, priceListId: listB.id }),
      "23503",
    );
  });

  it("SET NULLs group_id and price_list_id only when those rows are deleted", async () => {
    const company = await insertCompany();
    const group = await insertGroup(company.id);
    const list = await insertPriceList(company.id);
    const invite = await insertInvite({
      companyId: company.id,
      isReusable: true,
      maxUses: null,
      groupId: group.id,
      priceListId: list.id,
    });
    expect(invite.groupId).toBe(group.id);
    expect(invite.priceListId).toBe(list.id);
    expect(invite.companyId).toBe(company.id);

    await dbClient.db
      .delete(customerGroups)
      .where(eq(customerGroups.id, group.id));
    const afterGroup = await dbClient.db
      .select()
      .from(companyCustomerInvites)
      .where(eq(companyCustomerInvites.id, invite.id));
    expect(afterGroup[0]?.groupId).toBeNull();
    expect(afterGroup[0]?.priceListId).toBe(list.id);
    expect(afterGroup[0]?.companyId).toBe(company.id);

    await dbClient.db.delete(priceLists).where(eq(priceLists.id, list.id));
    const afterList = await dbClient.db
      .select()
      .from(companyCustomerInvites)
      .where(eq(companyCustomerInvites.id, invite.id));
    expect(afterList[0]?.groupId).toBeNull();
    expect(afterList[0]?.priceListId).toBeNull();
    expect(afterList[0]?.companyId).toBe(company.id);
  });

  it("enforces UNIQUE (invite_id, user_id) on redemptions", async () => {
    const company = await insertCompany();
    const invite = await insertInvite({
      companyId: company.id,
      isReusable: true,
      maxUses: null,
    });
    const userA = await insertUser();
    const userB = await insertUser();
    const customerA = await insertCustomer(company.id, { userId: userA });
    const customerB = await insertCustomer(company.id, { userId: userB });

    await insertRedemption({
      companyId: company.id,
      inviteId: invite.id,
      userId: userA,
      companyCustomerId: customerA.id,
    });
    await expectSqlState(
      insertRedemption({
        companyId: company.id,
        inviteId: invite.id,
        userId: userA,
        companyCustomerId: customerA.id,
      }),
      "23505",
    );
    const second = await insertRedemption({
      companyId: company.id,
      inviteId: invite.id,
      userId: userB,
      companyCustomerId: customerB.id,
    });
    expect(second.userId).toBe(userB);
  });

  it("rejects a redemption that points at another tenant's invite or customer", async () => {
    const companyA = await insertCompany();
    const companyB = await insertCompany();
    const inviteA = await insertInvite({ companyId: companyA.id });
    const inviteB = await insertInvite({ companyId: companyB.id });
    const userA = await insertUser();
    const customerA = await insertCustomer(companyA.id, { userId: userA });
    const customerB = await insertCustomer(companyB.id);

    await expectSqlState(
      insertRedemption({
        companyId: companyA.id,
        inviteId: inviteB.id,
        userId: userA,
        companyCustomerId: customerA.id,
      }),
      "23503",
    );
    await expectSqlState(
      insertRedemption({
        companyId: companyA.id,
        inviteId: inviteA.id,
        userId: userA,
        companyCustomerId: customerB.id,
      }),
      "23503",
    );
  });

  it("cascades invite deletion to redemptions and restricts deleting an inviter", async () => {
    const company = await insertCompany();
    const inviter = await insertUser();
    const invite = await insertInvite({
      companyId: company.id,
      invitedBy: inviter,
    });
    const acceptor = await insertUser();
    const customer = await insertCustomer(company.id, { userId: acceptor });
    const redemption = await insertRedemption({
      companyId: company.id,
      inviteId: invite.id,
      userId: acceptor,
      companyCustomerId: customer.id,
    });

    await expectSqlState(
      dbClient.db.delete(user).where(eq(user.id, inviter)),
      "23503",
    );

    await dbClient.db
      .delete(companyCustomerInvites)
      .where(eq(companyCustomerInvites.id, invite.id));
    expect(
      await dbClient.db
        .select()
        .from(companyCustomerInviteRedemptions)
        .where(eq(companyCustomerInviteRedemptions.id, redemption.id)),
    ).toEqual([]);

    await dbClient.db.delete(user).where(eq(user.id, inviter));
  });

  it("attaches the shared updated_at trigger to company_customer_invites", async () => {
    const result = await admin.query<{ tgname: string; relname: string }>(
      `SELECT t.tgname, c.relname
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       WHERE NOT t.tgisinternal
         AND t.tgname LIKE '%_set_updated_at'
         AND c.relname IN
           ('company_customer_invites', 'company_customer_invite_redemptions')`,
    );
    expect(result.rows.map((row) => row.tgname)).toEqual([
      "company_customer_invites_set_updated_at",
    ]);

    const company = await insertCompany();
    const row = await insertInvite({ companyId: company.id });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const updated = await dbClient.db
      .update(companyCustomerInvites)
      .set({ status: "revoked" })
      .where(eq(companyCustomerInvites.id, row.id))
      .returning();
    expect(updated[0]?.updatedAt.getTime()).toBeGreaterThan(
      row.updatedAt.getTime(),
    );
  });

  it("seeds customers:invite for admin and manager, not employee", () => {
    const keys = new Set(
      rolePermissionDefaultRows.map((row) => `${row.role}:${row.permission}`),
    );
    expect(keys.has("admin:customers:invite")).toBe(true);
    expect(keys.has("manager:customers:invite")).toBe(true);
    expect(keys.has("employee:customers:invite")).toBe(false);
    expect(keys.has("owner:customers:invite")).toBe(false);
    expect(keys.has("admin:invites:create")).toBe(false);
    expect(keys.has("manager:invites:create")).toBe(false);
  });

  it("rejects uses_count above max_uses", async () => {
    const company = await insertCompany();
    await expectSqlState(
      insertInvite({
        companyId: company.id,
        isReusable: true,
        maxUses: 1,
        usesCount: 2,
      }),
      "23514",
    );
    const unlimited = await insertInvite({
      companyId: company.id,
      isReusable: true,
      maxUses: null,
      usesCount: 99,
    });
    expect(unlimited.maxUses).toBeNull();
    expect(unlimited.usesCount).toBe(99);
  });
});
