import { randomUUID } from "node:crypto";

import {
  createTestKit,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import { products } from "@showzy/db/schema/catalog";
import { SEARCH_GOLDEN_NAME_CASES } from "@showzy/validation/search";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { searchMatches } from "./search-matches.js";

const NAMES = [
  "Капучино",
  "Капучино велике",
  "Какао",
  "Наполеон",
  "Чізкейк Нью-Йорк",
  "Кав'ярня суміш",
] as const;

const ids = new Map<string, string>(NAMES.map((name) => [name, randomUUID()]));

let kit: TestKit;

beforeAll(async () => {
  kit = await createTestKit();
  await kit.db.runtime.db.insert(products).values(
    NAMES.map((name) => ({
      id: ids.get(name) ?? randomUUID(),
      companyId: kitIdentities.companies.a,
      name,
      basePriceMinor: 100n,
    })),
  );
});

afterAll(async () => {
  await kit.db.close();
});

async function productNames(query: string): Promise<string[]> {
  const result = await kit.invoke(searchMatches, { query, types: ["product"] });
  const byId = new Map([...ids].map(([name, id]) => [id, name]));
  return result.groups
    .flatMap((group) => group.hits)
    .map((hit) => byId.get(hit.id) ?? hit.id);
}

describe("catalog.searchMatches name matching (db.md: one staff name matcher)", () => {
  it("applies the product goldens: typo on a long token, short token stays strict", async () => {
    for (const golden of SEARCH_GOLDEN_NAME_CASES) {
      const isProduct = (row: { readonly type: string }) =>
        row.type === "product";
      const wanted = golden.positives.filter(isProduct);
      const unwanted = golden.negatives.filter(isProduct);
      if (
        [...wanted, ...unwanted].some(
          (row) => !NAMES.some((name) => name === row.name),
        )
      ) {
        continue;
      }
      const found = await productNames(golden.query);
      for (const row of wanted) {
        expect(found, golden.id).toContain(row.name);
      }
      for (const row of unwanted) {
        expect(found, golden.id).not.toContain(row.name);
      }
    }
  });

  it("finds a name by an inflected query", async () => {
    expect(await productNames("наполеона")).toEqual(["Наполеон"]);
    expect(await productNames("наполеонів")).toEqual(["Наполеон"]);
  });

  it("orders exact first, then strict matches, then fuzzy-only ones", async () => {
    expect(await productNames("капучино")).toEqual([
      "Капучино",
      "Капучино велике",
    ]);
    expect((await productNames("капучіно")).slice(0, 2).toSorted()).toEqual([
      "Капучино",
      "Капучино велике",
    ]);
  });

  it("matches the parts of a hyphen or apostrophe token as a phrase", async () => {
    expect(await productNames("нью-йорк")).toEqual(["Чізкейк Нью-Йорк"]);
    expect(await productNames("нью йорк")).toEqual(["Чізкейк Нью-Йорк"]);
    expect(await productNames("кав'ярні")).toEqual(["Кав'ярня суміш"]);
    expect(await productNames("кав’ярня")).toEqual(["Кав'ярня суміш"]);
  });
});
