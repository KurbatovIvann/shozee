import { randomUUID } from "node:crypto";

import { NotFoundError } from "@showzy/core/errors";
import {
  createTestKit,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import { companyCustomers } from "@showzy/db/schema/customers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CustomerReferenceConflictError } from "../services/reference-resolution-conflict.js";
import { resolveCustomerReference } from "./resolve-customer-reference.js";

const A = kitIdentities.companies.a;
const B = kitIdentities.companies.b;
const ids = {
  petrenko: randomUUID(),
  petruk: randomUUID(),
  shevchun: randomUUID(),
  kovalA: randomUUID(),
  kovalB: randomUUID(),
  foreign: randomUUID(),
};

let kit: TestKit;

beforeAll(async () => {
  kit = await createTestKit();
  await kit.db.runtime.db.insert(companyCustomers).values([
    {
      id: ids.petrenko,
      companyId: A,
      name: "Олена Петренко",
      phone: "0671000001",
    },
    { id: ids.petruk, companyId: A, name: "Олена Петрук", phone: "0671000002" },
    {
      id: ids.shevchun,
      companyId: A,
      name: "Ігор Шевчун",
      phone: "0671000003",
    },
    { id: ids.kovalA, companyId: A, name: "Марія Коваль", phone: "0671000004" },
    { id: ids.kovalB, companyId: A, name: "Марія Коваль", phone: "0671000005" },
    {
      id: ids.foreign,
      companyId: B,
      name: "Тарас Мельник",
      phone: "0671000006",
    },
  ]);
});

afterAll(async () => {
  await kit.db.close();
});

const resolve = (value: string) =>
  kit.invoke(resolveCustomerReference, { by: "query", value });

async function conflictOptionIds(value: string): Promise<string[]> {
  try {
    await resolve(value);
  } catch (error) {
    if (error instanceof CustomerReferenceConflictError) {
      return error.options.map((option) => option.id).toSorted();
    }
    throw error;
  }
  return ["resolved"];
}

describe("customers.resolveCustomerReference inflected and typo queries", () => {
  it("resolves a unique inflected full name", async () => {
    expect(await resolve("Олени Петренко")).toEqual({
      customerId: ids.petrenko,
      name: "Олена Петренко",
    });
    expect(await resolve("петренко олені")).toMatchObject({
      customerId: ids.petrenko,
    });
  });

  it("opens a picker when the inflected name fits two customers", async () => {
    expect(await conflictOptionIds("Марії Коваль")).toEqual(
      [ids.kovalA, ids.kovalB].toSorted(),
    );
  });

  it("never auto-chooses a different surname, a partial name or a typo", async () => {
    expect(await conflictOptionIds("Ігоря Шевчука")).toEqual([ids.shevchun]);
    expect(await conflictOptionIds("петренка")).toEqual([ids.petrenko]);
    expect(await conflictOptionIds("олена питренко")).toEqual([ids.petrenko]);
  });

  it("does not see another tenant's customer", async () => {
    await expect(resolve("Тараса Мельника")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});
