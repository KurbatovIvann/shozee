import { randomUUID } from "node:crypto";

import {
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
} from "@showzy/core/errors";
import {
  createTestKit,
  crossTenantSuite,
  isolationCase,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import {
  EntityLookupAmbiguousError,
  EntityLookupUnmatchedError,
} from "@showzy/module-kit/entity-lookup";
import { user } from "@showzy/db/schema/auth";
import { companyMembers } from "@showzy/db/schema/companies";
import {
  companyCustomers,
  counterparties,
  customerGroups,
} from "@showzy/db/schema/customers";
import { priceLists } from "@showzy/db/schema/pricing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getCustomer } from "./get-customer.js";

const fixtures = {
  customerA: randomUUID(),
  customerAEmpty: randomUUID(),
  customerArchived: randomUUID(),
  customerB: randomUUID(),
  customerBNearAlpha: randomUUID(),
  customerTwinPhone: randomUUID(),
  customerTwinEmail: randomUUID(),
  groupA: randomUUID(),
  listA: randomUUID(),
  partyA: randomUUID(),
};

const clerkUserId = randomUUID();

let kit: TestKit;

beforeAll(async () => {
  kit = await createTestKit();

  await kit.db.runtime.db.insert(priceLists).values({
    id: fixtures.listA,
    companyId: kitIdentities.companies.a,
    name: "Wholesale A",
  });

  await kit.db.runtime.db.insert(customerGroups).values({
    id: fixtures.groupA,
    companyId: kitIdentities.companies.a,
    name: "Alpha",
    slug: "alpha",
  });

  await kit.db.runtime.db.insert(companyCustomers).values([
    {
      id: fixtures.customerA,
      companyId: kitIdentities.companies.a,
      name: "Alpha Cake",
      phone: "+380501111111",
      email: "alpha@kit.test",
      notes: "VIP baker",
      groupId: fixtures.groupA,
      priceListId: fixtures.listA,
    },
    {
      id: fixtures.customerAEmpty,
      companyId: kitIdentities.companies.a,
      name: "Bare",
      email: "bare@kit.test",
    },
    {
      id: fixtures.customerArchived,
      companyId: kitIdentities.companies.a,
      name: "Old Thing",
      phone: "+380501000099",
      status: "archived",
    },
    {
      id: fixtures.customerTwinPhone,
      companyId: kitIdentities.companies.a,
      name: "Duo Twin",
      phone: "+380502222222",
    },
    {
      id: fixtures.customerTwinEmail,
      companyId: kitIdentities.companies.a,
      name: "Duo Twin",
      email: "twin@kit.test",
    },
    {
      id: fixtures.customerB,
      companyId: kitIdentities.companies.b,
      name: "Bravo",
      phone: "+380509999999",
      email: "bravo@kit.test",
    },
    {
      id: fixtures.customerBNearAlpha,
      companyId: kitIdentities.companies.b,
      name: "Alpha Bun",
      phone: "+380508888888",
      email: "alpha@other.test",
    },
  ]);

  await kit.db.runtime.db.insert(counterparties).values({
    id: fixtures.partyA,
    companyId: kitIdentities.companies.a,
    customerId: fixtures.customerA,
    name: "ТОВ Партнер",
  });

  await kit.db.runtime.db.insert(user).values({
    id: clerkUserId,
    name: "Clerk",
    email: "clerk@customers-get-customer.test",
  });
  await kit.db.runtime.db.insert(companyMembers).values({
    companyId: kitIdentities.companies.a,
    userId: clerkUserId,
    role: "employee",
    permissions: { granted: [], denied: ["customers:view"] },
  });
});

afterAll(async () => {
  await kit.db.close();
});

crossTenantSuite(
  () => kit,
  [
    isolationCase(
      getCustomer,
      { input: { id: fixtures.customerA } },
      { input: { id: fixtures.customerB } },
    ),
  ],
);

describe("customers.getCustomer", () => {
  it("returns the customer view including status and linked counterparties", async () => {
    const result = await kit.invoke(getCustomer, { id: fixtures.customerA });

    expect(result).toMatchObject({
      id: fixtures.customerA,
      name: "Alpha Cake",
      phone: "+380501111111",
      email: "alpha@kit.test",
      userId: null,
      notes: "VIP baker",
      groupId: fixtures.groupA,
      priceListId: fixtures.listA,
      status: "active",
      linkedCounterpartyCount: 1,
    });
    expect(typeof result.createdAt).toBe("string");
    expect(typeof result.updatedAt).toBe("string");
  });

  it("returns a customer with no counterparties as linkedCounterpartyCount 0", async () => {
    const result = await kit.invoke(getCustomer, {
      id: fixtures.customerAEmpty,
    });
    expect(result).toMatchObject({
      id: fixtures.customerAEmpty,
      name: "Bare",
      phone: null,
      email: "bare@kit.test",
      notes: null,
      groupId: null,
      priceListId: null,
      status: "active",
      linkedCounterpartyCount: 0,
    });
  });

  it("returns an archived customer without restoring", async () => {
    const result = await kit.invoke(getCustomer, {
      id: fixtures.customerArchived,
    });
    expect(result).toMatchObject({
      id: fixtures.customerArchived,
      name: "Old Thing",
      status: "archived",
      linkedCounterpartyCount: 0,
    });
  });

  it("denies staff without customers:view", async () => {
    await expect(
      kit.invoke(
        getCustomer,
        { id: fixtures.customerA },
        { userId: clerkUserId, companyId: kitIdentities.companies.a },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("rejects a malformed customer id", async () => {
    await expect(
      kit.invoke(getCustomer, { id: "not-a-uuid" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("fails missing and foreign customers with the same not-found", async () => {
    const missingId = randomUUID();
    const missingError = await kit.invoke(getCustomer, { id: missingId }).then(
      () => {
        throw new Error("expected NotFoundError for a missing customer");
      },
      (error: unknown) => error,
    );
    const foreignError = await kit
      .invoke(getCustomer, { id: fixtures.customerB })
      .then(
        () => {
          throw new Error("expected NotFoundError for a foreign customer");
        },
        (error: unknown) => error,
      );

    expect(missingError).toBeInstanceOf(NotFoundError);
    expect(foreignError).toBeInstanceOf(NotFoundError);
    if (
      missingError instanceof NotFoundError &&
      foreignError instanceof NotFoundError
    ) {
      expect(missingError.clientMessage).toBe(foreignError.clientMessage);
    }
  });
});

async function refusalOf(input: { readonly query: string }): Promise<unknown> {
  return await kit.invoke(getCustomer, input).then(
    () => {
      throw new Error(`expected a refusal for "${input.query}"`);
    },
    (error: unknown) => error,
  );
}

describe("customers.getCustomer by human reference", () => {
  it("resolves a unique name, phone, and email", async () => {
    await expect(
      kit.invoke(getCustomer, { query: "Alpha Cake" }),
    ).resolves.toMatchObject({ id: fixtures.customerA });
    await expect(
      kit.invoke(getCustomer, { query: "+380501111111" }),
    ).resolves.toMatchObject({ id: fixtures.customerA });
    await expect(
      kit.invoke(getCustomer, { query: "bare@kit.test" }),
    ).resolves.toMatchObject({ id: fixtures.customerAEmpty });
  });

  it("finds an archived customer by name", async () => {
    await expect(
      kit.invoke(getCustomer, { query: "Old Thing" }),
    ).resolves.toMatchObject({
      id: fixtures.customerArchived,
      status: "archived",
    });
  });

  it("refuses several exact matches with the matching customers as options", async () => {
    const error = await refusalOf({ query: "Duo Twin" });
    expect(error).toBeInstanceOf(EntityLookupAmbiguousError);
    if (!(error instanceof EntityLookupAmbiguousError)) {
      return;
    }
    expect(error.target).toEqual({ kind: "customer", query: "Duo Twin" });
    expect(error.options.map((option) => option.id).toSorted()).toEqual(
      [fixtures.customerTwinPhone, fixtures.customerTwinEmail].toSorted(),
    );
    expect(error.options.map((option) => option.label)).toContain(
      "Duo Twin (…2222)",
    );
    expect(error.optionsTruncated).toBe(false);
  });

  it("refuses a partial name as not found with the nearest customers", async () => {
    const error = await refusalOf({ query: "Alpha" });
    expect(error).toBeInstanceOf(EntityLookupUnmatchedError);
    if (!(error instanceof EntityLookupUnmatchedError)) {
      return;
    }
    expect(error.options.map((option) => option.id)).toEqual([
      fixtures.customerA,
    ]);
  });

  it("refuses an unknown name as not found with nothing near", async () => {
    const error = await refusalOf({ query: "Zzyzx Nobody" });
    expect(error).toBeInstanceOf(EntityLookupUnmatchedError);
    if (!(error instanceof EntityLookupUnmatchedError)) {
      return;
    }
    expect(error.options).toEqual([]);
  });

  it("refuses another company's name, phone, and email with no foreign options", async () => {
    for (const query of ["Bravo", "+380509999999", "bravo@kit.test"]) {
      const error = await refusalOf({ query });
      expect(error).toBeInstanceOf(EntityLookupUnmatchedError);
      if (!(error instanceof EntityLookupUnmatchedError)) {
        return;
      }
      expect(error.options).toEqual([]);
    }

    const nearError = await refusalOf({ query: "Alpha" });
    expect(nearError).toBeInstanceOf(EntityLookupUnmatchedError);
    if (!(nearError instanceof EntityLookupUnmatchedError)) {
      return;
    }
    expect(nearError.options.map((option) => option.id)).toEqual([
      fixtures.customerA,
    ]);
  });

  it("denies a query for staff without customers:view", async () => {
    await expect(
      kit.invoke(
        getCustomer,
        { query: "Alpha Cake" },
        { userId: clerkUserId, companyId: kitIdentities.companies.a },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("rejects an input with both references and one with neither", async () => {
    await expect(
      kit.invoke(getCustomer, { id: fixtures.customerA, query: "Alpha Cake" }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(kit.invoke(getCustomer, {})).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});
