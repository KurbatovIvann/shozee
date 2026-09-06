/**
 * SHO-465 / SHO-487: 0047 adds provenance columns and backfills
 * created_via from the earliest successful attesting create audit_log
 * row per (target_type, target_id). Unmatched rows stay NULL. Empty-DB
 * apply is the harness template; this file proves SQL shape and a
 * pre-0047 database with fixture rows.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { createDbClient } from "./client.js";
import { createTestDatabase, type TestDatabase } from "./testing/harness.js";

const migrationsFolder = fileURLToPath(
  new URL("../migrations", import.meta.url),
);
const provenanceMigrationSql = readFileSync(
  path.join(migrationsFolder, "0047_stiff_marten_broadcloak.sql"),
  "utf8",
);

const BACKFILL_TARGETS = [
  { table: "orders", targetType: "order" },
  { table: "company_customers", targetType: "customer" },
  { table: "counterparties", targetType: "counterparty" },
  { table: "customer_groups", targetType: "customer_group" },
  { table: "products", targetType: "product" },
  { table: "product_variants", targetType: "variant" },
  { table: "price_lists", targetType: "price_list" },
  { table: "documents", targetType: "document" },
  { table: "company_customer_invites", targetType: "invite" },
] as const;

const ATTESTING_ACTIONS = {
  order: ["orders.create"],
  customer: ["customers.createCustomer", "customers.applyInviteCrm"],
  counterparty: ["customers.createCounterparty"],
  customer_group: ["customers.createGroup"],
  product: ["catalog.createProduct"],
  variant: ["catalog.createVariant"],
  price_list: ["pricing.createPriceList"],
  document: ["documents.createFromOrder"],
  invite: ["invites.create"],
} as const satisfies Record<
  (typeof BACKFILL_TARGETS)[number]["targetType"],
  readonly string[]
>;

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.close();
});

function databaseUrl(source: string, databaseName: string): string {
  const url = new URL(source);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function statementsOf(sql: string): string[] {
  return sql
    .split("--> statement-breakpoint")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function backfillCteBodies(sql: string): string[] {
  const bodies: string[] = [];
  const startToken = "WITH earliest AS (";
  const endToken = "\n)\nUPDATE";
  let from = 0;
  let start = sql.indexOf(startToken, from);
  while (start >= 0) {
    const selectStart = start + startToken.length;
    const end = sql.indexOf(endToken, selectStart);
    assert.ok(end >= 0, "backfill CTE is missing its UPDATE closer");
    bodies.push(sql.slice(selectStart, end));
    from = end;
    start = sql.indexOf(startToken, from);
  }
  return bodies;
}

async function insertAudit(
  probe: pg.Client,
  values: {
    targetType: string;
    targetId: string;
    channel: "ui" | "ai" | "system" | "webhook";
    createdAt: string;
    action: string;
    outcome: string;
  },
): Promise<void> {
  await probe.query(
    `INSERT INTO audit_log (
       id, request_id, correlation_id, action, actor_type, actor_id,
       channel, target_type, target_id, input_hash, outcome, duration_ms,
       created_at
     ) VALUES (
       $1, $2, $3, $4, 'user', 'actor-1',
       $5, $6, $7, 'hash', $8, 1, $9
     )`,
    [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      values.action,
      values.channel,
      values.targetType,
      values.targetId,
      values.outcome,
      values.createdAt,
    ],
  );
}

describe("record provenance migration (0047)", () => {
  it("adds nullable columns and CHECKs, backfills from the earliest successful create, and does not guess ui", () => {
    expect(provenanceMigrationSql).toContain(
      `ALTER TABLE "orders" ADD COLUMN "created_via" text;`,
    );
    expect(provenanceMigrationSql).toContain(
      `ALTER TABLE "orders" ADD COLUMN "vouched_by" text;`,
    );
    expect(provenanceMigrationSql).toContain(
      `ALTER TABLE "orders" ADD COLUMN "vouched_at" timestamp with time zone;`,
    );
    expect(provenanceMigrationSql).not.toMatch(
      /ADD COLUMN "created_via" text NOT NULL/,
    );
    expect(provenanceMigrationSql).not.toMatch(
      /SET\s+"created_via"\s*=\s*'ui'/,
    );
    expect(provenanceMigrationSql).not.toMatch(/SET\s+"vouched_by"/);
    expect(provenanceMigrationSql).not.toMatch(/CREATE\s+INDEX/i);
    expect(provenanceMigrationSql).not.toContain('ALTER TABLE "companies"');
    expect(provenanceMigrationSql).not.toContain('ALTER TABLE "files"');
    expect(provenanceMigrationSql).toContain("DISTINCT ON");
    expect(provenanceMigrationSql).toContain(
      'ORDER BY "target_type", "target_id", "created_at" ASC, "id" ASC',
    );
    const cteBodies = backfillCteBodies(provenanceMigrationSql);
    expect(cteBodies).toHaveLength(BACKFILL_TARGETS.length);
    for (const [index, target] of BACKFILL_TARGETS.entries()) {
      expect(provenanceMigrationSql).toContain(`UPDATE "${target.table}" AS t`);
      expect(provenanceMigrationSql).toContain(
        `earliest."target_type" = '${target.targetType}'`,
      );
      const cte = cteBodies[index];
      assert.ok(cte !== undefined);
      const whereAt = cte.indexOf(
        `WHERE "target_type" = '${target.targetType}'`,
      );
      const actionList = ATTESTING_ACTIONS[target.targetType]
        .map((action) => `'${action}'`)
        .join(", ");
      const actionAt = cte.indexOf(`AND "action" IN (${actionList})`);
      const outcomeAt = cte.indexOf(`AND "outcome" = 'ok'`);
      const orderAt = cte.indexOf(
        'ORDER BY "target_type", "target_id", "created_at" ASC, "id" ASC',
      );
      expect(whereAt).toBeGreaterThan(-1);
      expect(actionAt).toBeGreaterThan(whereAt);
      expect(outcomeAt).toBeGreaterThan(actionAt);
      expect(orderAt).toBeGreaterThan(outcomeAt);
    }
    expect(provenanceMigrationSql).toContain("'customers.applyInviteCrm'");
    expect(provenanceMigrationSql).toContain("DROP CONSTRAINT");
    expect(provenanceMigrationSql).toContain("DROP COLUMN");
  });

  it("maps ai and ui audit rows and leaves unmatched rows NULL, reporting fixture counts", async () => {
    const context = inject("dbHarness");
    const name = `prov_migrate_${randomUUID().replaceAll("-", "")}`;
    const control = new pg.Client({
      connectionString: databaseUrl(context.adminUrl, "postgres"),
    });
    await control.connect();
    const workspace = await mkdtemp(path.join(tmpdir(), "sho-465-migrate-"));
    let probe: pg.Client | undefined;
    let migrator: ReturnType<typeof createDbClient> | undefined;
    try {
      await control.query(`CREATE DATABASE "${name}"`);
      const priorMigrations = path.join(workspace, "migrations");
      await cp(migrationsFolder, priorMigrations, { recursive: true });
      await rm(path.join(priorMigrations, "0047_stiff_marten_broadcloak.sql"));
      await rm(path.join(priorMigrations, "meta/0047_snapshot.json"));
      const journalPath = path.join(priorMigrations, "meta/_journal.json");
      const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
        entries: { idx: number }[];
      };
      journal.entries = journal.entries.filter((entry) => entry.idx < 47);
      await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);

      migrator = createDbClient({
        databaseUrl: databaseUrl(context.adminUrl, name),
      });
      await migrate(migrator.db, { migrationsFolder: priorMigrations });
      await migrator.pool.end();
      migrator = undefined;

      probe = new pg.Client({
        connectionString: databaseUrl(context.adminUrl, name),
      });
      await probe.connect();

      const suffix = name.slice(-8).toLowerCase();
      const company = await probe.query<{ id: string }>(
        `INSERT INTO companies (name, slug, prefix)
         VALUES ('Provenance Co', 'prov-${suffix}', 'P${suffix.slice(0, 4).toUpperCase()}')
         RETURNING id`,
      );
      const companyId = company.rows[0]?.id;
      assert.ok(companyId);

      await probe.query(
        `INSERT INTO "user" (id, name, email)
         VALUES ($1, 'Provenance User', $2)`,
        [`prov-user-${suffix}`, `prov-${suffix}@example.com`],
      );
      const userId = `prov-user-${suffix}`;

      const ids = {
        orders: { ai: randomUUID(), ui: randomUUID(), none: randomUUID() },
        customers: { ai: randomUUID(), ui: randomUUID(), none: randomUUID() },
        counterparties: {
          ai: randomUUID(),
          ui: randomUUID(),
          none: randomUUID(),
        },
        groups: { ai: randomUUID(), ui: randomUUID(), none: randomUUID() },
        products: { ai: randomUUID(), ui: randomUUID(), none: randomUUID() },
        variants: { ai: randomUUID(), ui: randomUUID(), none: randomUUID() },
        lists: { ai: randomUUID(), ui: randomUUID(), none: randomUUID() },
        documents: { ai: randomUUID(), ui: randomUUID(), none: randomUUID() },
        invites: { ai: randomUUID(), ui: randomUUID(), none: randomUUID() },
        earliest: randomUUID(),
        deniedCreate: randomUUID(),
        filterWins: randomUUID(),
        updateOnlyVariant: randomUUID(),
        inviteCrm: randomUUID(),
      };

      for (const [kind, id] of Object.entries(ids.groups)) {
        await probe.query(
          `INSERT INTO customer_groups (id, company_id, name, slug)
           VALUES ($1, $2, $3, $4)`,
          [id, companyId, `Group ${kind}`, `group-${kind}-${suffix}`],
        );
      }
      for (const [kind, id] of Object.entries(ids.customers)) {
        await probe.query(
          `INSERT INTO company_customers (id, company_id, name, phone)
           VALUES ($1, $2, $3, $4)`,
          [
            id,
            companyId,
            `Customer ${kind}`,
            `+38050${kind === "ai" ? "1" : kind === "ui" ? "2" : "3"}000001`,
          ],
        );
      }
      for (const [kind, id] of Object.entries(ids.counterparties)) {
        await probe.query(
          `INSERT INTO counterparties (id, company_id, name)
           VALUES ($1, $2, $3)`,
          [id, companyId, `Party ${kind}`],
        );
      }
      for (const [kind, id] of Object.entries(ids.products)) {
        await probe.query(
          `INSERT INTO products (id, company_id, name, base_price_minor)
           VALUES ($1, $2, $3, 100)`,
          [id, companyId, `Product ${kind}`],
        );
      }
      for (const extraProduct of [
        { id: ids.deniedCreate, name: "Product denied-create" },
        { id: ids.filterWins, name: "Product filter-wins" },
      ]) {
        await probe.query(
          `INSERT INTO products (id, company_id, name, base_price_minor)
           VALUES ($1, $2, $3, 100)`,
          [extraProduct.id, companyId, extraProduct.name],
        );
      }
      await probe.query(
        `INSERT INTO company_customers (id, company_id, name, phone)
         VALUES ($1, $2, $3, $4)`,
        [ids.inviteCrm, companyId, "Customer invite-crm", "+380504000001"],
      );
      let variantIndex = 0;
      for (const [kind, id] of Object.entries(ids.variants)) {
        variantIndex += 1;
        await probe.query(
          `INSERT INTO product_variants (id, company_id, product_id, name)
           VALUES ($1, $2, $3, $4)`,
          [
            id,
            companyId,
            ids.products.ai,
            `Variant ${kind}-${String(variantIndex)}`,
          ],
        );
      }
      await probe.query(
        `INSERT INTO product_variants (id, company_id, product_id, name)
         VALUES ($1, $2, $3, $4)`,
        [
          ids.updateOnlyVariant,
          companyId,
          ids.products.ai,
          "Variant update-only",
        ],
      );
      for (const [kind, id] of Object.entries(ids.lists)) {
        await probe.query(
          `INSERT INTO price_lists (id, company_id, name)
           VALUES ($1, $2, $3)`,
          [id, companyId, `List ${kind}`],
        );
      }

      const orderRows: { id: string; number: string }[] = [
        { id: ids.orders.ai, number: "T-1" },
        { id: ids.orders.ui, number: "T-2" },
        { id: ids.orders.none, number: "T-3" },
        { id: ids.earliest, number: "T-4" },
      ];
      for (const row of orderRows) {
        await probe.query(
          `INSERT INTO orders (
             id, company_id, order_number, customer_name_snapshot,
             total_net_minor, total_tax_minor, total_gross_minor
           ) VALUES ($1, $2, $3, 'unlinked', 100, 0, 100)`,
          [row.id, companyId, row.number],
        );
      }

      const documentRows: { id: string; orderId: string; number: string }[] = [
        { id: ids.documents.ai, orderId: ids.orders.ai, number: "INV-1" },
        { id: ids.documents.ui, orderId: ids.orders.ui, number: "INV-2" },
        { id: ids.documents.none, orderId: ids.orders.none, number: "INV-3" },
      ];
      for (const row of documentRows) {
        await probe.query(
          `INSERT INTO documents (
             id, company_id, order_id, type, document_number, issued_on,
             supplier_details, buyer_details,
             total_net_minor, total_tax_minor, total_gross_minor, template_name
           ) VALUES (
             $1, $2, $3, 'payment_invoice', $4, '2026-09-06',
             '{"legalName":"Fixture"}'::jsonb, '{"kind":"customer"}'::jsonb,
             100, 0, 100, 'Payment invoice'
           )`,
          [row.id, companyId, row.orderId, row.number],
        );
      }

      let inviteIndex = 0;
      for (const id of Object.values(ids.invites)) {
        inviteIndex += 1;
        await probe.query(
          `INSERT INTO company_customer_invites (
             id, company_id, invited_by, token_hash, is_reusable, expires_at
           ) VALUES ($1, $2, $3, $4, true, now() + interval '7 days')`,
          [id, companyId, userId, inviteIndex.toString(16).padStart(64, "c")],
        );
      }

      const auditCases: {
        targetType: keyof typeof ATTESTING_ACTIONS;
        ai: string;
        ui: string;
      }[] = [
        { targetType: "order", ai: ids.orders.ai, ui: ids.orders.ui },
        { targetType: "customer", ai: ids.customers.ai, ui: ids.customers.ui },
        {
          targetType: "counterparty",
          ai: ids.counterparties.ai,
          ui: ids.counterparties.ui,
        },
        {
          targetType: "customer_group",
          ai: ids.groups.ai,
          ui: ids.groups.ui,
        },
        { targetType: "product", ai: ids.products.ai, ui: ids.products.ui },
        { targetType: "variant", ai: ids.variants.ai, ui: ids.variants.ui },
        { targetType: "price_list", ai: ids.lists.ai, ui: ids.lists.ui },
        { targetType: "document", ai: ids.documents.ai, ui: ids.documents.ui },
        { targetType: "invite", ai: ids.invites.ai, ui: ids.invites.ui },
      ];
      for (const row of auditCases) {
        const [action] = ATTESTING_ACTIONS[row.targetType];
        assert.ok(action);
        await insertAudit(probe, {
          targetType: row.targetType,
          targetId: row.ai,
          channel: "ai",
          createdAt: "2026-01-02T00:00:00.000Z",
          action,
          outcome: "ok",
        });
        await insertAudit(probe, {
          targetType: row.targetType,
          targetId: row.ui,
          channel: "ui",
          createdAt: "2026-01-02T00:00:00.000Z",
          action,
          outcome: "ok",
        });
      }
      await insertAudit(probe, {
        targetType: "order",
        targetId: ids.earliest,
        channel: "ai",
        createdAt: "2026-01-01T00:00:00.000Z",
        action: "orders.create",
        outcome: "ok",
      });
      await insertAudit(probe, {
        targetType: "order",
        targetId: ids.earliest,
        channel: "ui",
        createdAt: "2026-01-03T00:00:00.000Z",
        action: "orders.create",
        outcome: "ok",
      });
      await insertAudit(probe, {
        targetType: "product",
        targetId: ids.deniedCreate,
        channel: "ai",
        createdAt: "2026-01-02T00:00:00.000Z",
        action: "catalog.createProduct",
        outcome: "PERMISSION_DENIED",
      });
      await insertAudit(probe, {
        targetType: "product",
        targetId: ids.filterWins,
        channel: "ai",
        createdAt: "2026-01-01T00:00:00.000Z",
        action: "catalog.updateProduct",
        outcome: "PERMISSION_DENIED",
      });
      await insertAudit(probe, {
        targetType: "product",
        targetId: ids.filterWins,
        channel: "ui",
        createdAt: "2026-01-03T00:00:00.000Z",
        action: "catalog.createProduct",
        outcome: "ok",
      });
      await insertAudit(probe, {
        targetType: "variant",
        targetId: ids.updateOnlyVariant,
        channel: "ai",
        createdAt: "2026-01-02T00:00:00.000Z",
        action: "catalog.updateVariant",
        outcome: "ok",
      });
      await insertAudit(probe, {
        targetType: "customer",
        targetId: ids.inviteCrm,
        channel: "ui",
        createdAt: "2026-01-02T00:00:00.000Z",
        action: "customers.applyInviteCrm",
        outcome: "ok",
      });

      for (const statement of statementsOf(provenanceMigrationSql)) {
        await probe.query(statement);
      }

      const expected: {
        table: string;
        id: string;
        createdVia: string | null;
      }[] = [
        { table: "orders", id: ids.orders.ai, createdVia: "ai" },
        { table: "orders", id: ids.orders.ui, createdVia: "ui" },
        { table: "orders", id: ids.orders.none, createdVia: null },
        { table: "orders", id: ids.earliest, createdVia: "ai" },
        {
          table: "company_customers",
          id: ids.customers.ai,
          createdVia: "ai",
        },
        {
          table: "company_customers",
          id: ids.customers.ui,
          createdVia: "ui",
        },
        {
          table: "company_customers",
          id: ids.customers.none,
          createdVia: null,
        },
        {
          table: "company_customers",
          id: ids.inviteCrm,
          createdVia: "ui",
        },
        {
          table: "counterparties",
          id: ids.counterparties.ai,
          createdVia: "ai",
        },
        {
          table: "counterparties",
          id: ids.counterparties.ui,
          createdVia: "ui",
        },
        {
          table: "counterparties",
          id: ids.counterparties.none,
          createdVia: null,
        },
        { table: "customer_groups", id: ids.groups.ai, createdVia: "ai" },
        { table: "customer_groups", id: ids.groups.ui, createdVia: "ui" },
        { table: "customer_groups", id: ids.groups.none, createdVia: null },
        { table: "products", id: ids.products.ai, createdVia: "ai" },
        { table: "products", id: ids.products.ui, createdVia: "ui" },
        { table: "products", id: ids.products.none, createdVia: null },
        { table: "products", id: ids.deniedCreate, createdVia: null },
        { table: "products", id: ids.filterWins, createdVia: "ui" },
        { table: "product_variants", id: ids.variants.ai, createdVia: "ai" },
        { table: "product_variants", id: ids.variants.ui, createdVia: "ui" },
        { table: "product_variants", id: ids.variants.none, createdVia: null },
        {
          table: "product_variants",
          id: ids.updateOnlyVariant,
          createdVia: null,
        },
        { table: "price_lists", id: ids.lists.ai, createdVia: "ai" },
        { table: "price_lists", id: ids.lists.ui, createdVia: "ui" },
        { table: "price_lists", id: ids.lists.none, createdVia: null },
        { table: "documents", id: ids.documents.ai, createdVia: "ai" },
        { table: "documents", id: ids.documents.ui, createdVia: "ui" },
        { table: "documents", id: ids.documents.none, createdVia: null },
        {
          table: "company_customer_invites",
          id: ids.invites.ai,
          createdVia: "ai",
        },
        {
          table: "company_customer_invites",
          id: ids.invites.ui,
          createdVia: "ui",
        },
        {
          table: "company_customer_invites",
          id: ids.invites.none,
          createdVia: null,
        },
      ];

      for (const row of expected) {
        const got = await probe.query<{
          created_via: string | null;
          vouched_by: string | null;
          vouched_at: Date | null;
        }>(
          `SELECT created_via, vouched_by, vouched_at
           FROM ${row.table}
           WHERE id = $1`,
          [row.id],
        );
        expect(got.rows[0]?.created_via ?? null).toBe(row.createdVia);
        expect(got.rows[0]?.vouched_by).toBeNull();
        expect(got.rows[0]?.vouched_at).toBeNull();
      }

      const counts: Record<string, { ui: number; ai: number; null: number }> =
        {};
      for (const target of BACKFILL_TARGETS) {
        const grouped = await probe.query<{
          created_via: string | null;
          n: string;
        }>(
          `SELECT created_via, count(*)::text AS n
           FROM ${target.table}
           GROUP BY created_via`,
        );
        const summary = { ui: 0, ai: 0, null: 0 };
        for (const row of grouped.rows) {
          const n = Number(row.n);
          if (row.created_via === "ui") summary.ui = n;
          else if (row.created_via === "ai") summary.ai = n;
          else if (row.created_via === null) summary.null = n;
        }
        counts[target.table] = summary;
      }
      expect(counts).toEqual({
        orders: { ui: 1, ai: 2, null: 1 },
        company_customers: { ui: 2, ai: 1, null: 1 },
        counterparties: { ui: 1, ai: 1, null: 1 },
        customer_groups: { ui: 1, ai: 1, null: 1 },
        products: { ui: 2, ai: 1, null: 2 },
        product_variants: { ui: 1, ai: 1, null: 2 },
        price_lists: { ui: 1, ai: 1, null: 1 },
        documents: { ui: 1, ai: 1, null: 1 },
        company_customer_invites: { ui: 1, ai: 1, null: 1 },
      });

      const indexes = await probe.query<{ indexname: string }>(
        `SELECT indexname
         FROM pg_indexes
         WHERE schemaname = 'public'
           AND tablename = 'audit_log'`,
      );
      expect(indexes.rows.map((row) => row.indexname)).not.toContain(
        "audit_log_target_type_target_id_idx",
      );
      expect(
        indexes.rows.some(
          (row) =>
            row.indexname.includes("target_type") &&
            row.indexname.includes("target_id"),
        ),
      ).toBe(false);

      for (const target of BACKFILL_TARGETS) {
        await probe.query(
          `ALTER TABLE ${target.table} DROP CONSTRAINT ${target.table}_created_via_check`,
        );
        await probe.query(
          `ALTER TABLE ${target.table} DROP CONSTRAINT ${target.table}_vouched_pair_check`,
        );
        await probe.query(
          `ALTER TABLE ${target.table}
           DROP COLUMN created_via, DROP COLUMN vouched_by, DROP COLUMN vouched_at`,
        );
      }
      const remaining = await probe.query<{ n: string }>(
        `SELECT count(*)::text AS n
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND column_name IN ('created_via', 'vouched_by', 'vouched_at')`,
      );
      expect(remaining.rows[0]?.n).toBe("0");
    } finally {
      if (probe !== undefined) {
        await probe.end();
      }
      if (migrator !== undefined) {
        await migrator.pool.end();
      }
      await control.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await control.end();
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
