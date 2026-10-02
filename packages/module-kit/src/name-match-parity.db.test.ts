import { randomUUID } from "node:crypto";

import { createTestDatabase, type TestDatabase } from "@showzy/db/testing";
import { SEARCH_GOLDEN_NAME_CASES } from "@showzy/validation/search";
import { sql, type SQL } from "drizzle-orm";
import { customType, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  matchNameTiers,
  pickListNameSearch,
  referenceNameSearch,
} from "./name-match.js";

const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

const probe = pgTable("name_match_parity_probe", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  nameFts: tsvector("name_fts")
    .notNull()
    .generatedAlwaysAs(
      sql`setweight(to_tsvector('simple'::regconfig, coalesce("name", '')), 'A')`,
    ),
});

const columns = { name: probe.name, nameFts: probe.nameFts };

const GOLDEN_NAMES = SEARCH_GOLDEN_NAME_CASES.flatMap((one) =>
  [...one.positives, ...one.negatives]
    .filter((row) => !("productName" in row))
    .map((row) => row.name),
);

export const NAME_MATCH_PARITY_NAMES: readonly string[] = [
  ...new Set([
    ...GOLDEN_NAMES,
    "Савчук Іван",
    "Савчук Олена",
    "Петренко Марія",
    "Коваленко Олег",
    "Ковальчук Тарас",
    "Ніна Сергіївна",
  ]),
];

export const NAME_MATCH_PARITY_QUERIES: readonly string[] = [
  ...SEARCH_GOLDEN_NAME_CASES.map((one) => one.query),
  "савчук",
  "савчук олена",
  "коваленко олег",
  "ковал",
  "чук",
  "ніна",
  "коволенко",
  "петренк",
  "нема такого",
];

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
  await database.admin.query(
    `CREATE TABLE name_match_parity_probe (
       id uuid PRIMARY KEY,
       name text NOT NULL,
       name_fts tsvector NOT NULL GENERATED ALWAYS AS (setweight(to_tsvector('simple'::regconfig, coalesce("name", '')), 'A')) STORED
     )`,
  );
  await database.runtime.db
    .insert(probe)
    .values(
      NAME_MATCH_PARITY_NAMES.map((name) => ({ id: randomUUID(), name })),
    );
}, 120_000);

afterAll(async () => {
  await database.close();
});

async function selectedBySql(query: string): Promise<string[]> {
  const search = referenceNameSearch(columns, query);
  if (search === undefined) {
    return [];
  }
  const where = await pickListNameSearch(search, async (strict: SQL) => {
    const rows = await database.runtime.db
      .select({ name: probe.name })
      .from(probe)
      .where(strict)
      .limit(1);
    return rows.length > 0;
  });
  const rows = await database.runtime.db
    .select({ name: probe.name })
    .from(probe)
    .where(where);
  return rows.map((row) => row.name).sort();
}

function selectedInMemory(query: string): string[] {
  return matchNameTiers(query, NAME_MATCH_PARITY_NAMES)
    .flatMap((index) => {
      const name = NAME_MATCH_PARITY_NAMES[index];
      return name === undefined ? [] : [name];
    })
    .sort();
}

describe("the in-memory ladder answers what the SQL ladder answers", () => {
  it.each(NAME_MATCH_PARITY_QUERIES)(
    "selects the same names for %s",
    async (query) => {
      expect(selectedInMemory(query)).toEqual(await selectedBySql(query));
    },
  );
});
