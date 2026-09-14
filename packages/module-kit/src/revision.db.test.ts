import { randomUUID } from "node:crypto";

import { createTestDatabase, type TestDatabase } from "@showzy/db/testing";
import { integer, pgTable, text } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bumpRevision, bumpRevisions } from "./revision.js";

const revisionRoots = pgTable("revision_kit_roots", {
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
});

afterAll(async () => {
  await database.close();
});

async function insertRoot(id: string, companyId: string, revision = 1) {
  await database.admin.query(
    `INSERT INTO revision_kit_roots (id, company_id, revision) VALUES ($1, $2, $3)`,
    [id, companyId, revision],
  );
}

describe("bumpRevision", () => {
  it("raises the revision by exactly one and returns it", async () => {
    const id = randomUUID();
    const companyId = randomUUID();
    await insertRoot(id, companyId, 4);

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
    await insertRoot(id, companyId, 1);

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
});

describe("bumpRevisions", () => {
  it("commits both orders without deadlock and follows commit order", async () => {
    const companyId = randomUUID();
    const idA = randomUUID();
    const idB = randomUUID();
    await insertRoot(idA, companyId, 1);
    await insertRoot(idB, companyId, 1);

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
});
