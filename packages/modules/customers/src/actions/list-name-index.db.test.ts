import { randomUUID } from "node:crypto";

import { PermissionDeniedError, ValidationError } from "@showzy/core/errors";
import {
  createTestKit,
  crossTenantSuite,
  isolationCase,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import { user } from "@showzy/db/schema/auth";
import { companyMembers } from "@showzy/db/schema/companies";
import {
  companyCustomers,
  counterparties,
  customerGroups,
} from "@showzy/db/schema/customers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readCustomersNameIndex } from "../services/name-index.js";
import { listNameIndex } from "./list-name-index.js";

const fixtures = {
  active: randomUUID(),
  secondActive: randomUUID(),
  archived: randomUUID(),
  foreign: randomUUID(),
  group: randomUUID(),
  secondGroup: randomUUID(),
  foreignGroup: randomUUID(),
  counterparty: randomUUID(),
  secondCounterparty: randomUUID(),
  foreignCounterparty: randomUUID(),
};

const requisites = {
  edrpou: "14360570",
  iban: "UA213223130000026007233566001",
  bankName: "Монобанк",
  bankMfo: "322313",
  legalAddress: "вулиця Бджолина 8",
  phone: "+380501000005",
  email: "counterparty@kit.test",
  notes: "платить із затримкою",
};

const clerkUserId = randomUUID();

let kit: TestKit;

beforeAll(async () => {
  kit = await createTestKit();

  await kit.db.runtime.db.insert(companyCustomers).values([
    {
      id: fixtures.active,
      companyId: kitIdentities.companies.a,
      name: "Index Alpha",
      phone: "+380501000001",
      email: `index-alpha-${fixtures.active}@kit.test`,
    },
    {
      id: fixtures.secondActive,
      companyId: kitIdentities.companies.a,
      name: "Index Beta",
      phone: "+380501000004",
      email: `index-beta-${fixtures.secondActive}@kit.test`,
    },
    {
      id: fixtures.archived,
      companyId: kitIdentities.companies.a,
      name: "Index Archived",
      phone: "+380501000002",
      status: "archived",
    },
    {
      id: fixtures.foreign,
      companyId: kitIdentities.companies.b,
      name: "Index Foreign",
      phone: "+380501000003",
    },
  ]);

  await kit.db.runtime.db.insert(customerGroups).values([
    {
      id: fixtures.group,
      companyId: kitIdentities.companies.a,
      name: "Index Group",
      slug: `index-group-${fixtures.group}`,
    },
    {
      id: fixtures.secondGroup,
      companyId: kitIdentities.companies.a,
      name: "Index Group Two",
      slug: `index-group-two-${fixtures.secondGroup}`,
    },
    {
      id: fixtures.foreignGroup,
      companyId: kitIdentities.companies.b,
      name: "Index Foreign Group",
      slug: `index-foreign-group-${fixtures.foreignGroup}`,
    },
  ]);

  await kit.db.runtime.db.insert(counterparties).values([
    {
      id: fixtures.counterparty,
      companyId: kitIdentities.companies.a,
      name: "ТОВ Ранок",
      ...requisites,
    },
    {
      id: fixtures.secondCounterparty,
      companyId: kitIdentities.companies.a,
      name: "ФОП Нечипорук",
    },
    {
      id: fixtures.foreignCounterparty,
      companyId: kitIdentities.companies.b,
      name: "ТОВ Чужий Ранок",
    },
  ]);

  await kit.db.runtime.db.insert(user).values({
    id: clerkUserId,
    name: "Clerk",
    email: "clerk@customers-list-name-index.test",
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
      listNameIndex,
      { input: {} },
      {
        input: {},
        companyId: kitIdentities.companies.b,
        userId: kitIdentities.users.anna,
      },
    ),
  ],
);

describe("customers.listNameIndex", () => {
  it("returns active customers and groups as ids and names", async () => {
    const listed = await kit.invoke(listNameIndex, {});

    const customerIds = listed.customers.items.map((entry) => entry.id);
    expect(customerIds).toContain(fixtures.active);
    expect(listed.customers.truncated).toBe(false);
    expect(
      listed.customers.items.find((entry) => entry.id === fixtures.active)
        ?.name,
    ).toBe("Index Alpha");

    const groupIds = listed.groups.items.map((entry) => entry.id);
    expect(groupIds).toContain(fixtures.group);
    expect(listed.groups.truncated).toBe(false);
  });

  it("cuts each list at its cap and sets truncated", async () => {
    const capped = await readCustomersNameIndex({
      db: kit.db.runtime.db,
      companyId: kitIdentities.companies.a,
      caps: { customers: 1, groups: 1, counterparties: 1 },
    });

    expect(capped.customers.items).toHaveLength(1);
    expect(capped.customers.truncated).toBe(true);
    expect(capped.groups.items).toHaveLength(1);
    expect(capped.groups.truncated).toBe(true);
    expect(capped.counterparties.items).toHaveLength(1);
    expect(capped.counterparties.truncated).toBe(true);
  });

  it("leaves a list whose rows exactly fill the cap untruncated", async () => {
    const own = await readCustomersNameIndex({
      db: kit.db.runtime.db,
      companyId: kitIdentities.companies.a,
      caps: { customers: 1_000, groups: 1_000, counterparties: 1_000 },
    });
    const atTheCap = await readCustomersNameIndex({
      db: kit.db.runtime.db,
      companyId: kitIdentities.companies.a,
      caps: {
        customers: own.customers.items.length,
        groups: own.groups.items.length,
        counterparties: own.counterparties.items.length,
      },
    });

    expect(atTheCap.counterparties.items).toHaveLength(
      own.counterparties.items.length,
    );
    expect(atTheCap.counterparties.truncated).toBe(false);
    expect(atTheCap.customers.truncated).toBe(false);
    expect(atTheCap.groups.truncated).toBe(false);
  });

  it("excludes archived customers", async () => {
    const listed = await kit.invoke(listNameIndex, {});
    expect(listed.customers.items.map((entry) => entry.id)).not.toContain(
      fixtures.archived,
    );
  });

  it("returns no phone, email, or other contact field", async () => {
    const listed = await kit.invoke(listNameIndex, {});
    for (const entry of [
      ...listed.customers.items,
      ...listed.groups.items,
      ...listed.counterparties.items,
    ]) {
      expect(Object.keys(entry).sort()).toEqual(["id", "name"]);
    }
  });

  it("returns counterparties as ids and names without their requisites", async () => {
    const listed = await kit.invoke(listNameIndex, {});

    expect(
      listed.counterparties.items.find(
        (entry) => entry.id === fixtures.counterparty,
      ),
    ).toEqual({ id: fixtures.counterparty, name: "ТОВ Ранок" });
    expect(listed.counterparties.items.map((entry) => entry.id)).toContain(
      fixtures.secondCounterparty,
    );
    expect(listed.counterparties.truncated).toBe(false);

    const wire = JSON.stringify(listed.counterparties);
    for (const leaked of Object.values(requisites)) {
      expect(wire).not.toContain(leaked);
    }
  });

  it("does not leak another tenant's customers or groups", async () => {
    const listed = await kit.invoke(listNameIndex, {});
    expect(listed.customers.items.map((entry) => entry.id)).not.toContain(
      fixtures.foreign,
    );
    expect(listed.groups.items.map((entry) => entry.id)).not.toContain(
      fixtures.foreignGroup,
    );
    expect(listed.counterparties.items.map((entry) => entry.id)).not.toContain(
      fixtures.foreignCounterparty,
    );

    const otherTenant = await kit.invoke(
      listNameIndex,
      {},
      {
        companyId: kitIdentities.companies.b,
        userId: kitIdentities.users.boris,
      },
    );
    expect(otherTenant.customers.items.map((entry) => entry.id)).toContain(
      fixtures.foreign,
    );
    expect(otherTenant.customers.items.map((entry) => entry.id)).not.toContain(
      fixtures.active,
    );
    expect(otherTenant.counterparties.items.map((entry) => entry.id)).toContain(
      fixtures.foreignCounterparty,
    );
    expect(
      otherTenant.counterparties.items.map((entry) => entry.id),
    ).not.toContain(fixtures.counterparty);
  });

  it("denies staff without customers:view", async () => {
    await expect(
      kit.invoke(
        listNameIndex,
        {},
        { userId: clerkUserId, companyId: kitIdentities.companies.a },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("rejects an input that names a company", async () => {
    await expect(
      kit.invoke(listNameIndex, { companyId: kitIdentities.companies.b }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
