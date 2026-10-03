import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { and, count, eq, max } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "../client.js";
import { products, productVariants } from "../schema/catalog.js";
import { companies } from "../schema/companies.js";
import {
  companyCustomers,
  counterparties,
  customerGroups,
} from "../schema/customers.js";
import { priceLists } from "../schema/pricing.js";
import { createTestDatabase, type TestDatabase } from "../testing/harness.js";

const ACTIVE_PRODUCTS = 10_000;
const ARCHIVED_PRODUCTS = 500;
const VARIANTS_PER_PRODUCT = 4;
const ACTIVE_CUSTOMERS = 5_000;
const ARCHIVED_CUSTOMERS = 250;
const CUSTOMER_GROUPS = 20;
const PRICE_LISTS = 10;
const COUNTERPARTIES = 50;
const OTHER_TENANT_ROWS = 100;
const TIMED_ATTEMPTS = 5;

const NOUNS = ["Кава", "Чай", "Цукор", "Борошно", "Олія", "Сіль"];

interface ListMeasurement {
  readonly list: string;
  readonly rows: number;
  readonly readMs: number;
  readonly readServerMs: number;
  readonly bytes: number;
  readonly fingerprintMs: number;
  readonly fingerprintServerMs: number;
  readonly fingerprintIndexedMs: number;
  readonly indexed: boolean;
  readonly plan: string;
  readonly indexedPlan: string;
}

interface WriteProbeOutcome {
  readonly list: string;
  readonly kind: string;
  readonly visible: boolean;
}

const measurements: ListMeasurement[] = [];
const probeOutcomes: WriteProbeOutcome[] = [];
let totalReadMs = 0;
let totalFingerprintMs = 0;
let totalBytes = 0;

function* chunks<T>(rows: readonly T[], size: number): Generator<T[]> {
  for (let index = 0; index < rows.length; index += size) {
    yield rows.slice(index, index + size);
  }
}

function label(index: number): string {
  return `${NOUNS[index % NOUNS.length] ?? "Товар"} ${String(index)}`;
}

async function seedCompany(
  db: Database,
  slug: string,
  prefix: string,
): Promise<string> {
  const [row] = await db
    .insert(companies)
    .values({ name: slug, slug, prefix })
    .returning({ id: companies.id });
  if (row === undefined) {
    throw new Error(`company ${slug} was not inserted`);
  }
  return row.id;
}

async function seedTenant(
  db: Database,
  companyId: string,
  scale: {
    activeProducts: number;
    archivedProducts: number;
    activeCustomers: number;
    archivedCustomers: number;
    groups: number;
    lists: number;
    parties: number;
  },
  namePrefix: string,
): Promise<{ firstProductId: string }> {
  const productRows = Array.from(
    { length: scale.activeProducts + scale.archivedProducts },
    (_, index) => ({
      id: randomUUID(),
      companyId,
      name: `${namePrefix}${label(index)}`,
      basePriceMinor: BigInt(1000 + index),
      status: index < scale.activeProducts ? "active" : "archived",
    }),
  );
  for (const batch of chunks(productRows, 1000)) {
    await db.insert(products).values(batch);
  }

  const variantRows = productRows.flatMap((product) =>
    Array.from({ length: VARIANTS_PER_PRODUCT }, (_, slot) => ({
      id: randomUUID(),
      companyId,
      productId: product.id,
      name: `${product.name} / ${String(slot)}`,
      status: product.status,
    })),
  );
  for (const batch of chunks(variantRows, 1000)) {
    await db.insert(productVariants).values(batch);
  }

  const listRows = Array.from({ length: scale.lists }, (_, index) => ({
    id: randomUUID(),
    companyId,
    name: `${namePrefix}Прайс ${String(index)}`,
    isActive: index > 0,
    isDefault: index === 1,
  }));
  await db.insert(priceLists).values(listRows);

  const groupRows = Array.from({ length: scale.groups }, (_, index) => ({
    id: randomUUID(),
    companyId,
    name: `${namePrefix}Група ${String(index)}`,
    slug: `group-${String(index)}`,
  }));
  await db.insert(customerGroups).values(groupRows);

  const customerRows = Array.from(
    { length: scale.activeCustomers + scale.archivedCustomers },
    (_, index) => ({
      id: randomUUID(),
      companyId,
      name: `${namePrefix}Клієнт ${String(index)}`,
      phone: `+3805${String(index).padStart(7, "0")}`,
      status: index < scale.activeCustomers ? "active" : "archived",
    }),
  );
  for (const batch of chunks(customerRows, 1000)) {
    await db.insert(companyCustomers).values(batch);
  }

  const partyRows = Array.from({ length: scale.parties }, (_, index) => ({
    id: randomUUID(),
    companyId,
    name: `${namePrefix}ТОВ ${String(index)}`,
  }));
  await db.insert(counterparties).values(partyRows);

  const firstProductId = productRows[0]?.id;
  if (firstProductId === undefined) {
    throw new Error("seed produced no products");
  }
  return { firstProductId };
}

type Explainable<T> = {
  toSQL(): { sql: string; params: unknown[] };
} & PromiseLike<T>;

interface ContextList {
  readonly list: string;
  readonly indexed: boolean;
  read(): Explainable<readonly Record<string, unknown>[]>;
  fingerprint(): Explainable<{ rows: number; updatedAt: Date | null }[]>;
  probes(probeId: string): { kind: string; apply: () => Promise<void> }[];
}

function contextLists(
  db: Database,
  companyId: string,
  productId: string,
): ContextList[] {
  return [
    {
      list: "products",
      indexed: false,
      read: () =>
        db
          .select({ id: products.id, name: products.name })
          .from(products)
          .where(
            and(
              eq(products.companyId, companyId),
              eq(products.status, "active"),
            ),
          ),
      fingerprint: () =>
        db
          .select({ rows: count(), updatedAt: max(products.updatedAt) })
          .from(products)
          .where(eq(products.companyId, companyId)),
      probes: (probeId) => [
        {
          kind: "create",
          apply: async () => {
            await db.insert(products).values({
              id: probeId,
              companyId,
              name: "probe",
              basePriceMinor: 1n,
            });
          },
        },
        {
          kind: "update",
          apply: async () => {
            await db
              .update(products)
              .set({ name: "probe renamed" })
              .where(
                and(
                  eq(products.companyId, companyId),
                  eq(products.id, probeId),
                ),
              );
          },
        },
        {
          kind: "archive",
          apply: async () => {
            await db
              .update(products)
              .set({ status: "archived" })
              .where(
                and(
                  eq(products.companyId, companyId),
                  eq(products.id, probeId),
                ),
              );
          },
        },
        {
          kind: "restore",
          apply: async () => {
            await db
              .update(products)
              .set({ status: "active" })
              .where(
                and(
                  eq(products.companyId, companyId),
                  eq(products.id, probeId),
                ),
              );
          },
        },
        {
          kind: "hard delete",
          apply: async () => {
            await db
              .delete(products)
              .where(
                and(
                  eq(products.companyId, companyId),
                  eq(products.id, probeId),
                ),
              );
          },
        },
      ],
    },
    {
      list: "product_variants",
      indexed: false,
      read: () =>
        db
          .select({
            id: productVariants.id,
            productId: productVariants.productId,
            name: productVariants.name,
          })
          .from(productVariants)
          .where(
            and(
              eq(productVariants.companyId, companyId),
              eq(productVariants.status, "active"),
            ),
          ),
      fingerprint: () =>
        db
          .select({ rows: count(), updatedAt: max(productVariants.updatedAt) })
          .from(productVariants)
          .where(eq(productVariants.companyId, companyId)),
      probes: (probeId) => [
        {
          kind: "create",
          apply: async () => {
            await db
              .insert(productVariants)
              .values({ id: probeId, companyId, productId, name: "probe" });
          },
        },
        {
          kind: "update",
          apply: async () => {
            await db
              .update(productVariants)
              .set({ name: "probe renamed" })
              .where(
                and(
                  eq(productVariants.companyId, companyId),
                  eq(productVariants.id, probeId),
                ),
              );
          },
        },
        {
          kind: "archive",
          apply: async () => {
            await db
              .update(productVariants)
              .set({ status: "archived" })
              .where(
                and(
                  eq(productVariants.companyId, companyId),
                  eq(productVariants.id, probeId),
                ),
              );
          },
        },
        {
          kind: "restore",
          apply: async () => {
            await db
              .update(productVariants)
              .set({ status: "active" })
              .where(
                and(
                  eq(productVariants.companyId, companyId),
                  eq(productVariants.id, probeId),
                ),
              );
          },
        },
        {
          kind: "hard delete",
          apply: async () => {
            await db
              .delete(productVariants)
              .where(
                and(
                  eq(productVariants.companyId, companyId),
                  eq(productVariants.id, probeId),
                ),
              );
          },
        },
      ],
    },
    {
      list: "company_customers",
      indexed: true,
      read: () =>
        db
          .select({ id: companyCustomers.id, name: companyCustomers.name })
          .from(companyCustomers)
          .where(
            and(
              eq(companyCustomers.companyId, companyId),
              eq(companyCustomers.status, "active"),
            ),
          ),
      fingerprint: () =>
        db
          .select({ rows: count(), updatedAt: max(companyCustomers.updatedAt) })
          .from(companyCustomers)
          .where(eq(companyCustomers.companyId, companyId)),
      probes: (probeId) => [
        {
          kind: "create",
          apply: async () => {
            await db.insert(companyCustomers).values({
              id: probeId,
              companyId,
              name: "probe",
              phone: "+380500000000",
            });
          },
        },
        {
          kind: "update",
          apply: async () => {
            await db
              .update(companyCustomers)
              .set({ name: "probe renamed" })
              .where(
                and(
                  eq(companyCustomers.companyId, companyId),
                  eq(companyCustomers.id, probeId),
                ),
              );
          },
        },
        {
          kind: "archive",
          apply: async () => {
            await db
              .update(companyCustomers)
              .set({ status: "archived" })
              .where(
                and(
                  eq(companyCustomers.companyId, companyId),
                  eq(companyCustomers.id, probeId),
                ),
              );
          },
        },
        {
          kind: "restore",
          apply: async () => {
            await db
              .update(companyCustomers)
              .set({ status: "active" })
              .where(
                and(
                  eq(companyCustomers.companyId, companyId),
                  eq(companyCustomers.id, probeId),
                ),
              );
          },
        },
        {
          kind: "hard delete",
          apply: async () => {
            await db
              .delete(companyCustomers)
              .where(
                and(
                  eq(companyCustomers.companyId, companyId),
                  eq(companyCustomers.id, probeId),
                ),
              );
          },
        },
      ],
    },
    {
      list: "customer_groups",
      indexed: false,
      read: () =>
        db
          .select({ id: customerGroups.id, name: customerGroups.name })
          .from(customerGroups)
          .where(eq(customerGroups.companyId, companyId)),
      fingerprint: () =>
        db
          .select({ rows: count(), updatedAt: max(customerGroups.updatedAt) })
          .from(customerGroups)
          .where(eq(customerGroups.companyId, companyId)),
      probes: (probeId) => [
        {
          kind: "create",
          apply: async () => {
            await db.insert(customerGroups).values({
              id: probeId,
              companyId,
              name: "probe",
              slug: "probe-group",
            });
          },
        },
        {
          kind: "update",
          apply: async () => {
            await db
              .update(customerGroups)
              .set({ name: "probe renamed" })
              .where(
                and(
                  eq(customerGroups.companyId, companyId),
                  eq(customerGroups.id, probeId),
                ),
              );
          },
        },
        {
          kind: "hard delete",
          apply: async () => {
            await db
              .delete(customerGroups)
              .where(
                and(
                  eq(customerGroups.companyId, companyId),
                  eq(customerGroups.id, probeId),
                ),
              );
          },
        },
      ],
    },
    {
      list: "price_lists",
      indexed: false,
      read: () =>
        db
          .select({ id: priceLists.id, name: priceLists.name })
          .from(priceLists)
          .where(
            and(
              eq(priceLists.companyId, companyId),
              eq(priceLists.isActive, true),
            ),
          ),
      fingerprint: () =>
        db
          .select({ rows: count(), updatedAt: max(priceLists.updatedAt) })
          .from(priceLists)
          .where(eq(priceLists.companyId, companyId)),
      probes: (probeId) => [
        {
          kind: "create",
          apply: async () => {
            await db
              .insert(priceLists)
              .values({ id: probeId, companyId, name: "probe" });
          },
        },
        {
          kind: "update",
          apply: async () => {
            await db
              .update(priceLists)
              .set({ name: "probe renamed" })
              .where(
                and(
                  eq(priceLists.companyId, companyId),
                  eq(priceLists.id, probeId),
                ),
              );
          },
        },
        {
          kind: "archive",
          apply: async () => {
            await db
              .update(priceLists)
              .set({ isActive: false })
              .where(
                and(
                  eq(priceLists.companyId, companyId),
                  eq(priceLists.id, probeId),
                ),
              );
          },
        },
        {
          kind: "restore",
          apply: async () => {
            await db
              .update(priceLists)
              .set({ isActive: true })
              .where(
                and(
                  eq(priceLists.companyId, companyId),
                  eq(priceLists.id, probeId),
                ),
              );
          },
        },
        {
          kind: "hard delete",
          apply: async () => {
            await db
              .delete(priceLists)
              .where(
                and(
                  eq(priceLists.companyId, companyId),
                  eq(priceLists.id, probeId),
                ),
              );
          },
        },
      ],
    },
    {
      list: "counterparties",
      indexed: true,
      read: () =>
        db
          .select({ id: counterparties.id, name: counterparties.name })
          .from(counterparties)
          .where(eq(counterparties.companyId, companyId)),
      fingerprint: () =>
        db
          .select({ rows: count(), updatedAt: max(counterparties.updatedAt) })
          .from(counterparties)
          .where(eq(counterparties.companyId, companyId)),
      probes: (probeId) => [
        {
          kind: "create",
          apply: async () => {
            await db
              .insert(counterparties)
              .values({ id: probeId, companyId, name: "probe" });
          },
        },
        {
          kind: "update",
          apply: async () => {
            await db
              .update(counterparties)
              .set({ name: "probe renamed" })
              .where(
                and(
                  eq(counterparties.companyId, companyId),
                  eq(counterparties.id, probeId),
                ),
              );
          },
        },
        {
          kind: "hard delete",
          apply: async () => {
            await db
              .delete(counterparties)
              .where(
                and(
                  eq(counterparties.companyId, companyId),
                  eq(counterparties.id, probeId),
                ),
              );
          },
        },
      ],
    },
  ];
}

let database: TestDatabase;
let lists: ContextList[];
let otherLists: ContextList[];

async function explain(
  query: Explainable<unknown>,
  sequentialScans: boolean,
): Promise<{ plan: string; executionMs: number }> {
  const { sql: text, params } = query.toSQL();
  const client = await database.runtime.pool.connect();
  try {
    if (!sequentialScans) {
      await client.query("SET enable_seqscan = off");
    }
    const result = await client.query<{ "QUERY PLAN": string }>({
      text: `EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF) ${text}`,
      values: params,
    });
    const plan = result.rows.map((row) => row["QUERY PLAN"]).join("\n");
    const executionTime = /Execution Time: ([\d.]+) ms/.exec(plan)?.[1];
    return { plan, executionMs: Number(executionTime ?? Number.NaN) };
  } finally {
    if (!sequentialScans) {
      await client.query("SET enable_seqscan = on");
    }
    client.release();
  }
}

beforeAll(async () => {
  database = await createTestDatabase();
  const db = database.runtime.db;
  const primary = await seedCompany(db, "sho-primary", "SHOA");
  const other = await seedCompany(db, "sho-other", "SHOB");
  const seeded = await seedTenant(
    db,
    primary,
    {
      activeProducts: ACTIVE_PRODUCTS,
      archivedProducts: ARCHIVED_PRODUCTS,
      activeCustomers: ACTIVE_CUSTOMERS,
      archivedCustomers: ARCHIVED_CUSTOMERS,
      groups: CUSTOMER_GROUPS,
      lists: PRICE_LISTS,
      parties: COUNTERPARTIES,
    },
    "",
  );
  const otherSeeded = await seedTenant(
    db,
    other,
    {
      activeProducts: OTHER_TENANT_ROWS,
      archivedProducts: 0,
      activeCustomers: OTHER_TENANT_ROWS,
      archivedCustomers: 0,
      groups: 5,
      lists: 3,
      parties: 5,
    },
    "OTHER ",
  );
  await database.admin.query("VACUUM ANALYZE");
  lists = contextLists(db, primary, seeded.firstProductId);
  otherLists = contextLists(db, other, otherSeeded.firstProductId);
});

afterAll(async () => {
  const sum = (pick: (row: ListMeasurement) => number): string =>
    measurements.reduce((total, row) => total + pick(row), 0).toFixed(2);
  const table = [
    "| list | rows | read ms client | read ms server | bytes | fp ms client | fp ms server | fp ms server, seqscan off | (company_id, updated_at, id) index |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    ...measurements.map(
      (row) =>
        `| ${row.list} | ${String(row.rows)} | ${row.readMs.toFixed(1)} | ${row.readServerMs.toFixed(2)} | ${String(row.bytes)} | ${row.fingerprintMs.toFixed(2)} | ${row.fingerprintServerMs.toFixed(2)} | ${row.fingerprintIndexedMs.toFixed(2)} | ${row.indexed ? "yes" : "no"} |`,
    ),
    `| **total** | ${String(measurements.reduce((total, row) => total + row.rows, 0))} | ${totalReadMs.toFixed(1)} | ${sum((row) => row.readServerMs)} | ${String(totalBytes)} | ${totalFingerprintMs.toFixed(2)} | ${sum((row) => row.fingerprintServerMs)} | ${sum((row) => row.fingerprintIndexedMs)} | |`,
  ].join("\n");
  const plans = measurements
    .map(
      (row) =>
        `### ${row.list}\n${row.plan}\n-- enable_seqscan = off --\n${row.indexedPlan}`,
    )
    .join("\n\n");
  const probes = probeOutcomes
    .map(
      (row) => `${row.list} / ${row.kind}: ${row.visible ? "seen" : "MISSED"}`,
    )
    .join("\n");
  process.stdout.write(
    `\nSHO-732 RESULTS\n${table}\n\nFINGERPRINT PLANS\n${plans}\n\nWRITE PROBES\n${probes}\n\n`,
  );
  await database.close();
});

describe("Шо context bulk read", () => {
  it("reads every list of one company in a single query each", async () => {
    const context: Record<string, readonly Record<string, unknown>[]> = {};
    for (const entry of lists) {
      await entry.read();
    }
    for (const entry of lists) {
      let readMs = Number.POSITIVE_INFINITY;
      let rows: readonly Record<string, unknown>[] = [];
      for (let attempt = 0; attempt < TIMED_ATTEMPTS; attempt += 1) {
        const started = performance.now();
        rows = await entry.read();
        readMs = Math.min(readMs, performance.now() - started);
      }
      context[entry.list] = rows;
      const bytes = Buffer.byteLength(JSON.stringify(rows), "utf8");
      totalReadMs += readMs;
      totalBytes += bytes;
      const explained = await explain(entry.read(), true);
      measurements.push({
        list: entry.list,
        rows: rows.length,
        readMs,
        readServerMs: explained.executionMs,
        bytes,
        fingerprintMs: 0,
        fingerprintServerMs: 0,
        fingerprintIndexedMs: 0,
        indexed: entry.indexed,
        plan: "",
        indexedPlan: "",
      });
    }

    expect(context["products"]).toHaveLength(ACTIVE_PRODUCTS);
    expect(context["product_variants"]).toHaveLength(
      ACTIVE_PRODUCTS * VARIANTS_PER_PRODUCT,
    );
    expect(context["company_customers"]).toHaveLength(ACTIVE_CUSTOMERS);
    expect(context["customer_groups"]).toHaveLength(CUSTOMER_GROUPS);
    expect(context["price_lists"]).toHaveLength(PRICE_LISTS - 1);
    expect(context["counterparties"]).toHaveLength(COUNTERPARTIES);
  });

  it("fingerprints every list from count and max(updated_at)", async () => {
    for (const measurement of measurements) {
      const entry = lists.find((item) => item.list === measurement.list);
      if (entry === undefined) {
        throw new Error(`no list for ${measurement.list}`);
      }
      await entry.fingerprint();
      let fingerprintMs = Number.POSITIVE_INFINITY;
      let fingerprint: { rows: number; updatedAt: Date | null } | undefined;
      for (let attempt = 0; attempt < TIMED_ATTEMPTS; attempt += 1) {
        const started = performance.now();
        [fingerprint] = await entry.fingerprint();
        fingerprintMs = Math.min(fingerprintMs, performance.now() - started);
      }
      expect(fingerprint?.updatedAt).toBeInstanceOf(Date);
      totalFingerprintMs += fingerprintMs;

      const sequential = await explain(entry.fingerprint(), true);
      const indexed = await explain(entry.fingerprint(), false);
      const index = measurements.indexOf(measurement);
      measurements[index] = {
        ...measurement,
        fingerprintMs,
        fingerprintServerMs: sequential.executionMs,
        fingerprintIndexedMs: indexed.executionMs,
        plan: sequential.plan,
        indexedPlan: indexed.plan,
      };
    }
  });

  it("never returns another company's rows", async () => {
    for (const entry of lists) {
      const rows = await entry.read();
      expect(
        rows.filter((row) => String(row["name"]).startsWith("OTHER ")),
      ).toEqual([]);
    }
    for (const entry of otherLists) {
      const rows = await entry.read();
      expect(rows.length).toBeGreaterThan(0);
      expect(
        rows.every((row) => String(row["name"]).startsWith("OTHER ")),
      ).toBe(true);
    }
  });

  it("changes the fingerprint on every kind of write", async () => {
    for (const entry of lists) {
      const probeId = randomUUID();
      let [previous] = await entry.fingerprint();
      for (const probe of entry.probes(probeId)) {
        await delay(3);
        await probe.apply();
        const [next] = await entry.fingerprint();
        const visible =
          next?.rows !== previous?.rows ||
          next?.updatedAt?.getTime() !== previous?.updatedAt?.getTime();
        probeOutcomes.push({ list: entry.list, kind: probe.kind, visible });
        expect({ list: entry.list, kind: probe.kind, visible }).toEqual({
          list: entry.list,
          kind: probe.kind,
          visible: true,
        });
        previous = next;
      }
    }
  });
});
