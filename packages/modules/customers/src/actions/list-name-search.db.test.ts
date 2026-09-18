import { randomUUID } from "node:crypto";

import {
  createTestKit,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import {
  companyCustomers,
  counterparties,
  customerGroups,
} from "@showzy/db/schema/customers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { listCounterparties } from "./list-counterparties.js";
import { listCustomers } from "./list-customers.js";
import { listGroups } from "./list-groups.js";
import { listMatchingIds } from "./list-matching-ids.js";

const A = kitIdentities.companies.a;
const B = kitIdentities.companies.b;

let kit: TestKit;

beforeAll(async () => {
  kit = await createTestKit();
  await kit.db.runtime.db.insert(customerGroups).values([
    { id: randomUUID(), companyId: A, name: "Оптовики", slug: "optovyky" },
    { id: randomUUID(), companyId: A, name: "Ресторани", slug: "restorany" },
    { id: randomUUID(), companyId: A, name: "Кав'ярні", slug: "kaviarni" },
    { id: randomUUID(), companyId: B, name: "Оптовики", slug: "optovyky" },
  ]);
  await kit.db.runtime.db.insert(companyCustomers).values([
    {
      id: randomUUID(),
      companyId: A,
      name: "Олена Петренко",
      phone: "0671000001",
    },
    {
      id: randomUUID(),
      companyId: A,
      name: "Олена Петрук",
      phone: "0671000002",
    },
    {
      id: randomUUID(),
      companyId: A,
      name: "Ігор Шевчук",
      phone: "0671000003",
    },
    {
      id: randomUUID(),
      companyId: B,
      name: "Олена Петренко",
      phone: "0671000004",
    },
  ]);
  await kit.db.runtime.db.insert(counterparties).values([
    { id: randomUUID(), companyId: A, name: "ТОВ Ромашка", edrpou: "12345678" },
    { id: randomUUID(), companyId: A, name: "ТОВ Дністер Трейд" },
    { id: randomUUID(), companyId: B, name: "ТОВ Ромашка" },
  ]);
});

afterAll(async () => {
  await kit.db.close();
});

const groupNames = async (search: string) =>
  (await kit.invoke(listGroups, { search })).items.map((row) => row.name);
const customerNames = async (search: string) =>
  (await kit.invoke(listCustomers, { search })).items
    .map((row) => row.name)
    .toSorted();
const counterpartyNames = async (search: string) =>
  (await kit.invoke(listCounterparties, { search })).items.map(
    (row) => row.name,
  );

describe("customers list name search (db.md: one staff name matcher)", () => {
  it("finds a group by an inflected name, inside the tenant only", async () => {
    expect(await groupNames("оптовиків")).toEqual(["Оптовики"]);
    expect(await groupNames("в ресторанах")).toEqual([]);
    expect(await groupNames("ресторанах")).toEqual(["Ресторани"]);
    expect(await groupNames("кав'ярень")).toEqual(["Кав'ярні"]);
  });

  it("falls back to a typo match only when the strict match finds nothing", async () => {
    expect(await customerNames("петренко")).toEqual(["Олена Петренко"]);
    expect(await customerNames("питренко")).toEqual(["Олена Петренко"]);
    expect(await customerNames("олени петр")).toEqual([
      "Олена Петренко",
      "Олена Петрук",
    ]);
    expect(await groupNames("оптавики")).toEqual(["Оптовики"]);
  });

  it("matches inside a word only when no word starts with the token", async () => {
    expect(await groupNames("опт")).toEqual(["Оптовики"]);
    expect(await customerNames("пет")).toEqual([
      "Олена Петренко",
      "Олена Петрук",
    ]);
    expect(await customerNames("тренк")).toEqual(["Олена Петренко"]);
    expect(await customerNames("ре")).toEqual([]);
  });

  it("still finds a customer by phone and a counterparty by ЄДРПОУ", async () => {
    expect(await customerNames("0671000003")).toEqual(["Ігор Шевчук"]);
    expect(await counterpartyNames("12345678")).toEqual(["ТОВ Ромашка"]);
    expect(await counterpartyNames("ромашки")).toEqual(["ТОВ Ромашка"]);
    expect(await counterpartyNames("дністра")).toEqual(["ТОВ Дністер Трейд"]);
  });

  it("gives listMatchingIds the same answer as the customer list", async () => {
    const strict = await kit.invoke(listMatchingIds, {
      query: "олени петренко",
    });
    const typo = await kit.invoke(listMatchingIds, { query: "олена питренко" });
    expect(strict.ids).toHaveLength(1);
    expect(typo.ids).toEqual(strict.ids);
  });
});
