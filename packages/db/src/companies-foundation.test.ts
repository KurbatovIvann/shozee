/**
 * fnd-T7 verification for the minimal tenant/RBAC prerequisite in
 * companies-foundation.md. Data-path assertions use Drizzle through the
 * runtime role; raw SQL is limited to PostgreSQL catalog structure checks.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { and, count, eq } from "drizzle-orm";
import pg from "pg";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  expectTypeOf,
  inject,
  it,
} from "vitest";

import {
  devShoBakeryCompany,
  devShoBakeryCompanyId,
  devShoBakeryCustomers,
  devShoBakeryId,
  devShoBakeryOwner,
  rolePermissionDefaultRows,
  seedDevShoBakery,
  seedRolePermissionDefaults,
} from "../seed/index.js";
import type { DbClient } from "./client.js";
import type { UserId } from "./schema/auth-ids.js";
import { user } from "./schema/auth.js";
import { products, productVariants } from "./schema/catalog.js";
import {
  companies,
  companyMembers,
  rolePermissionDefaults,
} from "./schema/companies.js";
import { companyCustomers, customerGroups } from "./schema/customers.js";
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
  it("ships exactly the seeds db.md §9 names", async () => {
    const seedDir = path.resolve(import.meta.dirname, "../seed");
    const names = (await readdir(seedDir)).filter((name) =>
      name.endsWith(".ts"),
    );
    expect(names.sort()).toEqual([
      "dev-sho-bakery-cli.ts",
      "dev-sho-bakery.ts",
      "index.ts",
      "role-permission-defaults.ts",
    ]);
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

describe("dev bakery fixture seed", () => {
  interface DevBakeryLayout {
    readonly products: number;
    readonly variants: number;
    readonly customers: number;
    readonly groups: number;
    readonly priceLists: number;
  }

  async function readLayout(companyId: string): Promise<DevBakeryLayout> {
    const [productRow] = await dbClient.db
      .select({ value: count() })
      .from(products)
      .where(eq(products.companyId, companyId));
    const [variantRow] = await dbClient.db
      .select({ value: count() })
      .from(productVariants)
      .where(eq(productVariants.companyId, companyId));
    const [customerRow] = await dbClient.db
      .select({ value: count() })
      .from(companyCustomers)
      .where(eq(companyCustomers.companyId, companyId));
    const [groupRow] = await dbClient.db
      .select({ value: count() })
      .from(customerGroups)
      .where(eq(customerGroups.companyId, companyId));
    const [priceListRow] = await dbClient.db
      .select({ value: count() })
      .from(priceLists)
      .where(eq(priceLists.companyId, companyId));
    return {
      products: productRow?.value ?? 0,
      variants: variantRow?.value ?? 0,
      customers: customerRow?.value ?? 0,
      groups: groupRow?.value ?? 0,
      priceLists: priceListRow?.value ?? 0,
    };
  }

  function runSeedCliUnderProduction() {
    const url = new URL(inject("dbHarness").adminUrl);
    url.pathname = `/${database.name}`;
    return spawnSync(
      process.execPath,
      [
        "--import",
        new URL("../scripts/ts-resolve-register.mjs", import.meta.url).href,
        fileURLToPath(
          new URL("../seed/dev-sho-bakery-cli.ts", import.meta.url),
        ),
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_ENV: "production",
          DATABASE_URL: url.toString(),
        },
      },
    );
  }

  async function readSystemLayout(companyId: string): Promise<DevBakeryLayout> {
    const [productRow] = await dbClient.db
      .select({ value: count() })
      .from(products)
      .where(
        and(
          eq(products.companyId, companyId),
          eq(products.createdVia, "system"),
        ),
      );
    const [variantRow] = await dbClient.db
      .select({ value: count() })
      .from(productVariants)
      .where(
        and(
          eq(productVariants.companyId, companyId),
          eq(productVariants.createdVia, "system"),
        ),
      );
    const [customerRow] = await dbClient.db
      .select({ value: count() })
      .from(companyCustomers)
      .where(
        and(
          eq(companyCustomers.companyId, companyId),
          eq(companyCustomers.createdVia, "system"),
        ),
      );
    const [groupRow] = await dbClient.db
      .select({ value: count() })
      .from(customerGroups)
      .where(
        and(
          eq(customerGroups.companyId, companyId),
          eq(customerGroups.createdVia, "system"),
        ),
      );
    const [priceListRow] = await dbClient.db
      .select({ value: count() })
      .from(priceLists)
      .where(
        and(
          eq(priceLists.companyId, companyId),
          eq(priceLists.createdVia, "system"),
        ),
      );
    return {
      products: productRow?.value ?? 0,
      variants: variantRow?.value ?? 0,
      customers: customerRow?.value ?? 0,
      groups: groupRow?.value ?? 0,
      priceLists: priceListRow?.value ?? 0,
    };
  }

  async function withProductionNodeEnv(
    body: () => Promise<void>,
  ): Promise<void> {
    const previous = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "production";
    try {
      await body();
    } finally {
      if (previous === undefined) {
        delete process.env["NODE_ENV"];
      } else {
        process.env["NODE_ENV"] = previous;
      }
    }
  }

  it("refuses to run under NODE_ENV=production and writes nothing (db.md §9)", async () => {
    await seedDevShoBakery(dbClient.db);
    const before = await readLayout(devShoBakeryCompanyId);
    expect(before.products).toBeGreaterThan(0);

    const refused = runSeedCliUnderProduction();

    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("refuses to run with NODE_ENV=production");
    expect(refused.stdout).not.toContain(devShoBakeryCompany.name);

    await withProductionNodeEnv(async () => {
      await expect(seedDevShoBakery(dbClient.db)).rejects.toThrow(
        "refuses to run with NODE_ENV=production",
      );
    });

    expect(await readLayout(devShoBakeryCompanyId)).toEqual(before);
  });

  it("seeds the dictated catalogue and repeats without duplicating it", async () => {
    const first = await seedDevShoBakery(dbClient.db);
    const afterFirst = await readLayout(first.companyId);

    expect(afterFirst).toEqual({
      products: 15,
      variants: 38,
      customers: 12,
      groups: 3,
      priceLists: 3,
    });
    expect(first.productCount).toBe(afterFirst.products);
    expect(first.variantCount).toBe(afterFirst.variants);
    expect(first.customerCount).toBe(afterFirst.customers);

    const cakeVariants = await dbClient.db
      .select({ name: productVariants.name })
      .from(productVariants)
      .where(eq(productVariants.productId, devShoBakeryId("product", "Торт")));
    expect(cakeVariants).toHaveLength(8);

    const second = await seedDevShoBakery(dbClient.db);
    expect(second).toEqual(first);
    expect(await readLayout(first.companyId)).toEqual(afterFirst);
  });

  it("names every customer the recorded speech refers to", async () => {
    await seedDevShoBakery(dbClient.db);
    const seeded = await dbClient.db
      .select({ name: companyCustomers.name })
      .from(companyCustomers)
      .where(eq(companyCustomers.companyId, devShoBakeryCompanyId));
    expect(seeded.map((row) => row.name).sort()).toEqual(
      [...devShoBakeryCustomers].sort(),
    );
  });

  it("stamps every fixture row with created_via=system (SHO-465)", async () => {
    await seedDevShoBakery(dbClient.db);
    const layout = await readLayout(devShoBakeryCompanyId);
    expect(await readSystemLayout(devShoBakeryCompanyId)).toEqual(layout);
  });

  it("gives customer groups the slugs a Cyrillic name really produces", async () => {
    await seedDevShoBakery(dbClient.db);
    const groups = await dbClient.db
      .select({ name: customerGroups.name, slug: customerGroups.slug })
      .from(customerGroups)
      .where(eq(customerGroups.companyId, devShoBakeryCompanyId));
    expect(groups.map((row) => row.slug).sort()).toEqual([
      "optovi",
      "rozdrib",
      "vip",
    ]);
    expect(groups.every((row) => !row.slug.startsWith("group-"))).toBe(true);
  });

  it("adopts the earliest signed-up user matching the fixture phone or email", async () => {
    const fresh = await createTestDatabase();
    try {
      const signedUpOwnerId = "phone-first-owner-id";
      const signedUpOwnerEmail = `${devShoBakeryOwner.phone}@phone.sho-dev.local`;
      await fresh.runtime.db.insert(user).values([
        {
          id: signedUpOwnerId,
          name: "Phone first",
          email: signedUpOwnerEmail,
          emailVerified: false,
          phoneNumber: devShoBakeryOwner.phone,
          phoneNumberVerified: true,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        },
        {
          id: "email-holder-id",
          name: "Email holder",
          email: devShoBakeryOwner.email,
          emailVerified: false,
          createdAt: new Date("2026-02-01T00:00:00.000Z"),
        },
      ]);

      const seeded = await seedDevShoBakery(fresh.runtime.db);
      expect(seeded.ownerUserId).toBe(signedUpOwnerId);
      expect(seeded.ownerEmail).toBe(signedUpOwnerEmail);
      expect(seeded.ownerPhone).toBe(devShoBakeryOwner.phone);

      const members = await fresh.runtime.db
        .select({ userId: companyMembers.userId, role: companyMembers.role })
        .from(companyMembers)
        .where(eq(companyMembers.companyId, seeded.companyId));
      expect(members).toEqual([{ userId: signedUpOwnerId, role: "owner" }]);

      const again = await seedDevShoBakery(fresh.runtime.db);
      expect(again).toEqual(seeded);
    } finally {
      await fresh.close();
    }
  });
});
