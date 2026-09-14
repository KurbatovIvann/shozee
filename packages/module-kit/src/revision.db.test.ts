import { randomUUID } from "node:crypto";

import { createTestDatabase, type TestDatabase } from "@showzy/db/testing";
import { and, eq } from "drizzle-orm";
import { integer, pgTable, text } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bumpRevision, bumpRevisions, type RevisionRoot } from "./revision.js";

const revisionRoots = pgTable("revision_kit_roots", {
  id: text("id").primaryKey(),
  companyId: text("company_id").notNull(),
  revision: integer("revision").notNull(),
});

const revisionKitOrder = pgTable("revision_kit_order", {
  id: text("id").primaryKey(),
  companyId: text("company_id").notNull(),
  revision: integer("revision").notNull(),
});

const revisionKitOrders = pgTable("revision_kit_orders", {
  id: text("id").primaryKey(),
  companyId: text("company_id").notNull(),
  revision: integer("revision").notNull(),
});

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
  await database.admin.query(`
    CREATE TABLE revision_kit_roots (
      id text PRIMARY KEY,
      company_id text NOT NULL,
      revision integer NOT NULL
    )
  `);
  await database.admin.query(`
    CREATE TABLE revision_kit_order (
      id text PRIMARY KEY,
      company_id text NOT NULL,
      revision integer NOT NULL
    )
  `);
  await database.admin.query(`
    CREATE TABLE revision_kit_orders (
      id text PRIMARY KEY,
      company_id text NOT NULL,
      revision integer NOT NULL
    )
  `);
});

afterAll(async () => {
  await database.close();
});

async function insertRoot(
  table: "revision_kit_roots" | "revision_kit_order" | "revision_kit_orders",
  id: string,
  companyId: string,
  revision = 1,
) {
  await database.admin.query(
    `INSERT INTO ${table} (id, company_id, revision) VALUES ($1, $2, $3)`,
    [id, companyId, revision],
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForUngrantedLock(): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const result = await database.admin.query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM pg_locks WHERE NOT granted",
    );
    if ((result.rows[0]?.n ?? 0) > 0) {
      return;
    }
    await sleep(20);
  }
  throw new Error("timed out waiting for the second transaction to wait");
}

describe("bumpRevision", () => {
  it("raises the revision by exactly one and returns it", async () => {
    const id = randomUUID();
    const companyId = randomUUID();
    await insertRoot("revision_kit_roots", id, companyId, 4);

    const revision = await database.runtime.db.transaction((tx) =>
      bumpRevision(tx, revisionRoots, {
        companyId,
        key: { column: revisionRoots.id, value: id },
      }),
    );

    expect(revision).toBe(5);
    const row = await database.admin.query<{ revision: number }>(
      `SELECT revision FROM revision_kit_roots WHERE id = $1`,
      [id],
    );
    expect(row.rows[0]?.revision).toBe(5);
  });

  it("returns undefined and changes nothing for a foreign company", async () => {
    const id = randomUUID();
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    await insertRoot("revision_kit_roots", id, companyId, 1);

    const revision = await database.runtime.db.transaction((tx) =>
      bumpRevision(tx, revisionRoots, {
        companyId: otherCompanyId,
        key: { column: revisionRoots.id, value: id },
      }),
    );

    expect(revision).toBeUndefined();
    const row = await database.admin.query<{ revision: number }>(
      `SELECT revision FROM revision_kit_roots WHERE id = $1`,
      [id],
    );
    expect(row.rows[0]?.revision).toBe(1);
  });

  it("returns undefined for an absent key", async () => {
    const companyId = randomUUID();
    const revision = await database.runtime.db.transaction((tx) =>
      bumpRevision(tx, revisionRoots, {
        companyId,
        key: { column: revisionRoots.id, value: randomUUID() },
      }),
    );

    expect(revision).toBeUndefined();
  });

  it("makes the second transaction wait on the first transaction's row lock", async () => {
    const id = randomUUID();
    const companyId = randomUUID();
    await insertRoot("revision_kit_roots", id, companyId, 1);

    let secondPromise: Promise<number | undefined> | undefined;

    await database.runtime.db.transaction(async (tx) => {
      const locked = await tx
        .select({ id: revisionRoots.id })
        .from(revisionRoots)
        .where(
          and(eq(revisionRoots.companyId, companyId), eq(revisionRoots.id, id)),
        )
        .for("update");
      expect(locked).toHaveLength(1);

      secondPromise = database.runtime.db.transaction((secondTx) =>
        bumpRevision(secondTx, revisionRoots, {
          companyId,
          key: { column: revisionRoots.id, value: id },
        }),
      );
      await waitForUngrantedLock();

      await bumpRevision(tx, revisionRoots, {
        companyId,
        key: { column: revisionRoots.id, value: id },
      });
    });

    if (secondPromise === undefined) {
      throw new Error("the second transaction was never started");
    }
    expect(await secondPromise).toBe(3);
  });
});

describe("bumpRevisions", () => {
  it("commits both orders without deadlock and follows commit order", async () => {
    const companyId = randomUUID();
    const idA = randomUUID();
    const idB = randomUUID();
    await insertRoot("revision_kit_roots", idA, companyId, 1);
    await insertRoot("revision_kit_roots", idB, companyId, 1);

    const rootA = {
      table: revisionRoots,
      companyId,
      key: { column: revisionRoots.id, value: idA },
    };
    const rootB = {
      table: revisionRoots,
      companyId,
      key: { column: revisionRoots.id, value: idB },
    };

    const commitOrder: Array<ReadonlyArray<number | undefined>> = [];

    const runOrder = async (roots: readonly [typeof rootA, typeof rootB]) => {
      const result = await database.runtime.db.transaction((tx) =>
        bumpRevisions(tx, roots),
      );
      commitOrder.push(result);
      return result;
    };

    await Promise.all([runOrder([rootA, rootB]), runOrder([rootB, rootA])]);

    expect(commitOrder).toHaveLength(2);
    expect(commitOrder[0]).toEqual([2, 2]);
    expect(commitOrder[1]).toEqual([3, 3]);

    const rows = await database.admin.query<{
      id: string;
      revision: number;
    }>(`SELECT id, revision FROM revision_kit_roots WHERE id = ANY($1)`, [
      [idA, idB],
    ]);
    expect(new Set(rows.rows.map((row) => row.revision))).toEqual(new Set([3]));
  });

  it("orders by table name before key, never by their NUL-joined concatenation", async () => {
    const companyId = randomUUID();
    const ordersKeyValue = randomUUID();
    const orderKeyValue = `s${ordersKeyValue}`;
    await insertRoot("revision_kit_order", orderKeyValue, companyId, 1);
    await insertRoot("revision_kit_orders", ordersKeyValue, companyId, 1);

    const orderRoot = {
      table: revisionKitOrder,
      companyId,
      key: { column: revisionKitOrder.id, value: orderKeyValue },
    };
    const ordersRoot = {
      table: revisionKitOrders,
      companyId,
      key: { column: revisionKitOrders.id, value: ordersKeyValue },
    };

    const commitOrder: Array<ReadonlyArray<number | undefined>> = [];

    const runOrder = async (roots: readonly [RevisionRoot, RevisionRoot]) => {
      const result = await database.runtime.db.transaction((tx) =>
        bumpRevisions(tx, roots),
      );
      commitOrder.push(result);
      return result;
    };

    await Promise.all([
      runOrder([orderRoot, ordersRoot]),
      runOrder([ordersRoot, orderRoot]),
    ]);

    expect(commitOrder).toHaveLength(2);
    expect(commitOrder[0]).toEqual([2, 2]);
    expect(commitOrder[1]).toEqual([3, 3]);
  });
});
