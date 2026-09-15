import { randomUUID } from "node:crypto";

import type { Tx } from "@showzy/db";
import { createTestDatabase, type TestDatabase } from "@showzy/db/testing";
import { eq } from "drizzle-orm";
import { integer, pgTable, uuid } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  bumpRevision,
  bumpRevisions,
  type RevisionBump,
  type RevisionRoot,
} from "./revision.js";

const alphaTable = pgTable("revision_probe_alpha", {
  id: uuid("id").primaryKey(),
  companyId: uuid("company_id").notNull(),
  revision: integer("revision").notNull().default(1),
});

const betaTable = pgTable("revision_probe_beta", {
  id: uuid("id").primaryKey(),
  companyId: uuid("company_id").notNull(),
  revision: integer("revision").notNull().default(1),
});

const gammaTable = pgTable("revision_probe_gamma", {
  id: uuid("id").primaryKey(),
  externalId: uuid("external_id").notNull(),
  companyId: uuid("company_id").notNull(),
  revision: integer("revision").notNull().default(1),
});

const alphaRoot: RevisionRoot<typeof alphaTable> = {
  table: alphaTable,
  keyColumn: alphaTable.id,
};
const betaRoot: RevisionRoot<typeof betaTable> = {
  table: betaTable,
  keyColumn: betaTable.id,
};

const companyId = randomUUID();
const foreignCompanyId = randomUUID();

let database: TestDatabase;

interface Gate {
  readonly opened: Promise<void>;
  open(): void;
}

function createGate(): Gate {
  let open = (): void => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

async function seed(
  table: typeof alphaTable | typeof betaTable,
  revision: number,
  id: string = randomUUID(),
): Promise<string> {
  await database.runtime.db.insert(table).values({ id, companyId, revision });
  return id;
}

async function revisionOf(
  table: typeof alphaTable | typeof betaTable,
  id: string,
): Promise<number | undefined> {
  const rows = await database.runtime.db
    .select({ revision: table.revision })
    .from(table)
    .where(eq(table.id, id));
  return rows[0]?.revision;
}

async function lockWaiters(): Promise<number> {
  const result = await database.admin.query<{ waiting: string }>(
    "SELECT count(*) AS waiting FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock'",
    [database.name],
  );
  return Number(result.rows[0]?.waiting ?? 0);
}

async function untilLockWaiters(expected: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await lockWaiters()) === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new RangeError(`expected ${String(expected)} lock waiters`);
}

function holdInTransaction<T>(
  work: (tx: Tx) => Promise<T>,
  release: Promise<void>,
  locked: Gate,
): Promise<T> {
  return database.runtime.db.transaction(async (tx) => {
    const result = await work(tx);
    locked.open();
    await release;
    return result;
  });
}

beforeAll(async () => {
  database = await createTestDatabase();
  for (const name of ["revision_probe_alpha", "revision_probe_beta"]) {
    await database.admin.query(
      `CREATE TABLE ${name} (id uuid PRIMARY KEY, company_id uuid NOT NULL, revision integer NOT NULL DEFAULT 1)`,
    );
  }
  await database.admin.query(
    "CREATE TABLE revision_probe_gamma (id uuid PRIMARY KEY, external_id uuid NOT NULL, company_id uuid NOT NULL, revision integer NOT NULL DEFAULT 1)",
  );
});

afterAll(async () => {
  await database.close();
});

describe("bumpRevision", () => {
  it("raises the revision by exactly one and returns it", async () => {
    const id = await seed(alphaTable, 1);

    const revision = await database.runtime.db.transaction((tx) =>
      bumpRevision(tx, alphaRoot, { companyId, key: id }),
    );

    expect(revision).toBe(2);
    expect(await revisionOf(alphaTable, id)).toBe(2);
  });

  it("returns undefined and changes nothing for a foreign company or an absent key", async () => {
    const id = await seed(alphaTable, 4);

    const [foreign, absent] = await database.runtime.db.transaction(
      async (tx) => [
        await bumpRevision(tx, alphaRoot, {
          companyId: foreignCompanyId,
          key: id,
        }),
        await bumpRevision(tx, alphaRoot, { companyId, key: randomUUID() }),
      ],
    );

    expect(foreign).toBeUndefined();
    expect(absent).toBeUndefined();
    expect(await revisionOf(alphaTable, id)).toBe(4);
  });
});

describe("bumpRevisions", () => {
  it("commits concurrent transactions over the same roots in opposite argument orders", async () => {
    const alphaId = await seed(alphaTable, 1);
    const betaId = await seed(betaTable, 1);
    const forward: (
      RevisionBump<typeof alphaTable> | RevisionBump<typeof betaTable>
    )[] = [
      { root: alphaRoot, companyId, key: alphaId },
      { root: betaRoot, companyId, key: betaId },
    ];
    const backward = [...forward].reverse();

    const outcomes = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) =>
        database.runtime.db.transaction((tx) =>
          bumpRevisions(tx, index % 2 === 0 ? forward : backward),
        ),
      ),
    );

    expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(
      true,
    );
    expect(await revisionOf(alphaTable, alphaId)).toBe(9);
    expect(await revisionOf(betaTable, betaId)).toBe(9);
  });

  it("makes the second transaction wait on the first and follow its commit order", async () => {
    const alphaId = await seed(alphaTable, 1);
    const betaId = await seed(betaTable, 5);
    const release = createGate();
    const locked = createGate();

    const first = holdInTransaction(
      (tx) =>
        bumpRevisions(tx, [
          { root: alphaRoot, companyId, key: alphaId },
          { root: betaRoot, companyId, key: betaId },
        ]),
      release.opened,
      locked,
    );
    await locked.opened;
    const second = database.runtime.db.transaction((tx) =>
      bumpRevisions(tx, [
        { root: betaRoot, companyId, key: betaId },
        { root: alphaRoot, companyId, key: alphaId },
      ]),
    );
    await untilLockWaiters(1);
    release.open();

    expect(await first).toEqual([2, 6]);
    expect(await second).toEqual([7, 3]);
  });

  it("locks roots by table name, then key, whatever the argument order", async () => {
    const alphaId = await seed(alphaTable, 1);
    const betaId = await seed(betaTable, 1);
    const release = createGate();
    const locked = createGate();

    const holder = holdInTransaction(
      (tx) => bumpRevision(tx, alphaRoot, { companyId, key: alphaId }),
      release.opened,
      locked,
    );
    await locked.opened;
    const waiting = database.runtime.db.transaction((tx) =>
      bumpRevisions(tx, [
        { root: betaRoot, companyId, key: betaId },
        { root: alphaRoot, companyId, key: alphaId },
      ]),
    );
    await untilLockWaiters(1);

    const betaBump = await database.runtime.db.transaction((tx) =>
      bumpRevision(tx, betaRoot, { companyId, key: betaId }),
    );
    release.open();

    expect(betaBump).toBe(2);
    expect(await holder).toBe(2);
    expect(await waiting).toEqual([3, 3]);
  });

  it("locks keys by their lower-cased value, whatever case each caller sends", async () => {
    const lowerId = await seed(alphaTable, 1, `a${randomUUID().slice(1)}`);
    const upperId = await seed(alphaTable, 1, `b${randomUUID().slice(1)}`);
    const release = createGate();
    const locked = createGate();

    const holder = holdInTransaction(
      (tx) => bumpRevision(tx, alphaRoot, { companyId, key: lowerId }),
      release.opened,
      locked,
    );
    await locked.opened;
    const waiting = database.runtime.db.transaction((tx) =>
      bumpRevisions(tx, [
        { root: alphaRoot, companyId, key: upperId.toUpperCase() },
        { root: alphaRoot, companyId, key: lowerId },
      ]),
    );
    await untilLockWaiters(1);

    const upperBump = await database.runtime.db.transaction((tx) =>
      bumpRevision(tx, alphaRoot, { companyId, key: upperId }),
    );
    release.open();

    expect(upperBump).toBe(2);
    expect(await holder).toBe(2);
    expect(await waiting).toEqual([3, 3]);
  });

  it("raises a root passed twice once and returns that revision at every matching index", async () => {
    const repeatedId = await seed(alphaTable, 4);
    const otherId = await seed(betaTable, 7);

    const revisions = await database.runtime.db.transaction((tx) =>
      bumpRevisions(tx, [
        { root: alphaRoot, companyId, key: repeatedId },
        { root: betaRoot, companyId, key: otherId },
        { root: alphaRoot, companyId, key: repeatedId.toUpperCase() },
        { root: alphaRoot, companyId, key: repeatedId },
      ]),
    );

    expect(revisions).toEqual([5, 8, 5, 5]);
    expect(await revisionOf(alphaTable, repeatedId)).toBe(5);
    expect(await revisionOf(betaTable, otherId)).toBe(8);
  });

  it("keeps a repeated key under a foreign company apart from the owned root", async () => {
    const id = await seed(alphaTable, 2);

    const revisions = await database.runtime.db.transaction((tx) =>
      bumpRevisions(tx, [
        { root: alphaRoot, companyId: foreignCompanyId, key: id },
        { root: alphaRoot, companyId, key: id },
      ]),
    );

    expect(revisions).toEqual([undefined, 3]);
    expect(await revisionOf(alphaTable, id)).toBe(3);
  });

  it("keeps roots on one table keyed by different columns apart when their keys are equal", async () => {
    const sharedKey = randomUUID();
    const byExternalId = randomUUID();
    await database.runtime.db.insert(gammaTable).values([
      { id: sharedKey, externalId: randomUUID(), companyId, revision: 1 },
      { id: byExternalId, externalId: sharedKey, companyId, revision: 5 },
    ]);

    const revisions = await database.runtime.db.transaction((tx) =>
      bumpRevisions(tx, [
        {
          root: { table: gammaTable, keyColumn: gammaTable.id },
          companyId,
          key: sharedKey,
        },
        {
          root: { table: gammaTable, keyColumn: gammaTable.externalId },
          companyId,
          key: sharedKey,
        },
      ]),
    );

    const rows = await database.runtime.db
      .select({ id: gammaTable.id, revision: gammaTable.revision })
      .from(gammaTable)
      .where(eq(gammaTable.companyId, companyId));
    expect(revisions).toEqual([2, 6]);
    expect(rows).toEqual(
      expect.arrayContaining([
        { id: sharedKey, revision: 2 },
        { id: byExternalId, revision: 6 },
      ]),
    );
  });
});
