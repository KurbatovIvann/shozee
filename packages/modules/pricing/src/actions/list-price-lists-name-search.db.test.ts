import { randomUUID } from "node:crypto";

import {
  createTestKit,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import { priceLists } from "@showzy/db/schema/pricing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { listPriceLists } from "./list-price-lists.js";

let kit: TestKit;

beforeAll(async () => {
  kit = await createTestKit();
  await kit.db.runtime.db.insert(priceLists).values([
    { id: randomUUID(), companyId: kitIdentities.companies.a, name: "Оптовий" },
    { id: randomUUID(), companyId: kitIdentities.companies.a, name: "Роздріб" },
    { id: randomUUID(), companyId: kitIdentities.companies.b, name: "Оптовий" },
  ]);
});

afterAll(async () => {
  await kit.db.close();
});

const names = async (query: string) =>
  (await kit.invoke(listPriceLists, { query })).items.map((row) => row.name);

describe("pricing.listPriceLists name search (db.md: one staff name matcher)", () => {
  it("finds a price list by an inflected name inside the tenant", async () => {
    expect(await names("оптового")).toEqual(["Оптовий"]);
    expect(await names("роздрібу")).toEqual(["Роздріб"]);
  });

  it("falls back to a typo match only when the strict match finds nothing", async () => {
    expect(await names("аптовий")).toEqual(["Оптовий"]);
    expect(await names("опт")).toEqual(["Оптовий"]);
    expect(await names("тови")).toEqual([]);
  });
});
