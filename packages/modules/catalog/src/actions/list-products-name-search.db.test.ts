import { randomUUID } from "node:crypto";

import {
  createTestKit,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import { products } from "@showzy/db/schema/catalog";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { listProducts } from "./list-products.js";

let kit: TestKit;

beforeAll(async () => {
  kit = await createTestKit();
  await kit.db.runtime.db.insert(products).values(
    [
      ["Капучино", kitIdentities.companies.a],
      ["Капучино велике", kitIdentities.companies.a],
      ["Какао", kitIdentities.companies.a],
      ["Круасан з шоколадом", kitIdentities.companies.a],
      ["Чізкейк Нью-Йорк", kitIdentities.companies.a],
      ["Капучино", kitIdentities.companies.b],
    ].map(([name, companyId]) => ({
      id: randomUUID(),
      companyId: companyId ?? kitIdentities.companies.a,
      name: name ?? "",
      basePriceMinor: 100n,
    })),
  );
});

afterAll(async () => {
  await kit.db.close();
});

const names = async (query: string) =>
  (await kit.invoke(listProducts, { query })).items
    .map((row) => row.name)
    .toSorted();

describe("catalog.listProducts name search (db.md: one staff name matcher)", () => {
  it("finds inflected and hyphenated names inside the tenant", async () => {
    expect(await names("круасанів з шоколадом")).toEqual([
      "Круасан з шоколадом",
    ]);
    expect(await names("чізкейк нью йорк")).toEqual(["Чізкейк Нью-Йорк"]);
    expect(await names("капучино")).toEqual(["Капучино", "Капучино велике"]);
  });

  it("falls back to a typo match only when the strict match finds nothing", async () => {
    expect(await names("капучіно")).toEqual(["Капучино", "Капучино велике"]);
    expect(await names("капучіно велике")).toEqual(["Капучино велике"]);
  });

  it("keeps a short token strict", async () => {
    expect(await names("кап")).toEqual(["Капучино", "Капучино велике"]);
    expect(await names("као")).toEqual([]);
  });
});
