import { randomUUID } from "node:crypto";

import { PermissionDeniedError, ValidationError } from "@showzy/core/errors";
import { sql } from "drizzle-orm";
import {
  createTestKit,
  crossTenantSuite,
  isolationCase,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import { user } from "@showzy/db/schema/auth";
import { companies, companyMembers } from "@showzy/db/schema/companies";
import {
  companyCustomers,
  counterparties,
  customerGroups,
} from "@showzy/db/schema/customers";
import { priceLists } from "@showzy/db/schema/pricing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { listCustomers } from "./list-customers.js";
import {
  formatListCustomersCursor,
  LIST_CUSTOMERS_MAX_LIMIT,
  LIST_CUSTOMERS_SEARCH_MAX,
} from "./list-customers.contract.js";

const fixtures = {
  newest: randomUUID(),
  alpha: randomUUID(),
  beta: randomUUID(),
  archived: randomUUID(),
  foreign: randomUUID(),
  tieCompany: randomUUID(),
  groupVip: randomUUID(),
  groupBare: randomUUID(),
  groupForeign: randomUUID(),
  listA: randomUUID(),
  partyA: randomUUID(),
};

const clerkUserId = randomUUID();

const stamps = {
  archived: new Date("2026-05-01T00:00:00.000Z"),
  newest: new Date("2026-04-01T00:00:00.000Z"),
  alpha: new Date("2026-03-01T00:00:00.000Z"),
  beta: new Date("2026-02-01T00:00:00.000Z"),
};

let kit: TestKit;

beforeAll(async () => {
  kit = await createTestKit();

  await kit.db.runtime.db.insert(priceLists).values({
    id: fixtures.listA,
    companyId: kitIdentities.companies.a,
    name: "Wholesale A",
  });

  await kit.db.runtime.db.insert(customerGroups).values([
    {
      id: fixtures.groupVip,
      companyId: kitIdentities.companies.a,
      name: "VIP",
      slug: "vip",
    },
    {
      id: fixtures.groupBare,
      companyId: kitIdentities.companies.a,
      name: "Bare",
      slug: "bare",
    },
    {
      id: fixtures.groupForeign,
      companyId: kitIdentities.companies.b,
      name: "VIP",
      slug: "vip",
    },
  ]);

  await kit.db.runtime.db.insert(companyCustomers).values([
    {
      id: fixtures.archived,
      companyId: kitIdentities.companies.a,
      name: "Old Thing",
      phone: "+380501000099",
      status: "archived",
      createdAt: stamps.archived,
      updatedAt: stamps.archived,
    },
    {
      id: fixtures.newest,
      companyId: kitIdentities.companies.a,
      name: "Zed Newest",
      email: `zed-${fixtures.newest}@kit.test`,
      createdAt: stamps.newest,
      updatedAt: stamps.newest,
    },
    {
      id: fixtures.alpha,
      companyId: kitIdentities.companies.a,
      name: "Alpha Cake",
      phone: "+380501111111",
      email: `alpha-${fixtures.alpha}@kit.test`,
      notes: "VIP baker",
      groupId: fixtures.groupVip,
      priceListId: fixtures.listA,
      createdAt: stamps.alpha,
      updatedAt: stamps.alpha,
    },
    {
      id: fixtures.beta,
      companyId: kitIdentities.companies.a,
      name: "Beta Bread",
      email: "beta-search@kit.test",
      createdAt: stamps.beta,
      updatedAt: stamps.beta,
    },
    {
      id: fixtures.foreign,
      companyId: kitIdentities.companies.b,
      name: "Alpha Foreign",
      email: `foreign-${fixtures.foreign}@kit.test`,
      groupId: fixtures.groupForeign,
      createdAt: stamps.newest,
      updatedAt: stamps.newest,
    },
  ]);

  await kit.db.runtime.db.insert(counterparties).values({
    id: fixtures.partyA,
    companyId: kitIdentities.companies.a,
    customerId: fixtures.alpha,
    name: "ТОВ Партнер",
  });

  await kit.db.runtime.db.insert(user).values({
    id: clerkUserId,
    name: "Clerk",
    email: "clerk@customers-list-customers.test",
  });
  await kit.db.runtime.db.insert(companyMembers).values({
    companyId: kitIdentities.companies.a,
    userId: clerkUserId,
    role: "employee",
    permissions: { granted: [], denied: ["customers:view"] },
  });

  await kit.db.runtime.db.insert(companies).values({
    id: fixtures.tieCompany,
    name: "Timestamp tie customers list",
    slug: "tie-customers-list-sho588",
    prefix: "C7",
  });
  await kit.db.runtime.db.insert(companyMembers).values({
    companyId: fixtures.tieCompany,
    userId: kitIdentities.users.anna,
    role: "owner",
    permissions: { granted: [], denied: [] },
  });
});

afterAll(async () => {
  await kit.db.close();
});

// Staff lists have no resource id: the inherited suite's foreign case is
// Anna selecting company B (membership deny). The handler's company_id
// filter is proven by "does not include another company's customers".
crossTenantSuite(
  () => kit,
  [
    isolationCase(
      listCustomers,
      { input: {} },
      {
        input: {},
        companyId: kitIdentities.companies.b,
        userId: kitIdentities.users.anna,
      },
    ),
  ],
);

describe("customers.listCustomers", () => {
  it("lists own-tenant active customers newest-updated-first with linked counterparties", async () => {
    const result = await kit.invoke(listCustomers, {});

    expect(result.items.map((row) => row.id)).toEqual([
      fixtures.newest,
      fixtures.alpha,
      fixtures.beta,
    ]);
    expect(result.nextCursor).toBeNull();

    const alpha = result.items[1];
    expect(alpha).toEqual({
      id: fixtures.alpha,
      name: "Alpha Cake",
      phone: "+380501111111",
      email: `alpha-${fixtures.alpha}@kit.test`,
      userId: null,
      notes: "VIP baker",
      groupId: fixtures.groupVip,
      priceListId: fixtures.listA,
      status: "active",
      linkedCounterpartyCount: 1,
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
    });

    expect(result.items[0]).toMatchObject({
      id: fixtures.newest,
      name: "Zed Newest",
      status: "active",
      linkedCounterpartyCount: 0,
    });
    expect(result.items[2]).toMatchObject({
      id: fixtures.beta,
      name: "Beta Bread",
      status: "active",
      linkedCounterpartyCount: 0,
    });
  });

  it("filters archived and all, hiding archived by default", async () => {
    const archived = await kit.invoke(listCustomers, { status: "archived" });
    expect(archived.items.map((row) => row.id)).toEqual([fixtures.archived]);
    expect(archived.items[0]?.status).toBe("archived");

    const all = await kit.invoke(listCustomers, { status: "all" });
    expect(all.items.map((row) => row.id)).toEqual([
      fixtures.archived,
      fixtures.newest,
      fixtures.alpha,
      fixtures.beta,
    ]);
  });

  it("searches name, phone, and email case-insensitively", async () => {
    const byName = await kit.invoke(listCustomers, { search: "aLpHa" });
    expect(byName.items.map((row) => row.id)).toEqual([fixtures.alpha]);
    expect(byName.items.map((row) => row.id)).not.toContain(fixtures.foreign);

    const byPhone = await kit.invoke(listCustomers, { search: "111111" });
    expect(byPhone.items.map((row) => row.id)).toEqual([fixtures.alpha]);

    const byEmail = await kit.invoke(listCustomers, {
      search: "BETA-SEARCH@",
    });
    expect(byEmail.items.map((row) => row.id)).toEqual([fixtures.beta]);
  });

  it("filters by own group and returns an empty page for missing or foreign groups", async () => {
    const vip = await kit.invoke(listCustomers, { groupId: fixtures.groupVip });
    expect(vip.items.map((row) => row.id)).toEqual([fixtures.alpha]);

    const bare = await kit.invoke(listCustomers, {
      groupId: fixtures.groupBare,
    });
    expect(bare).toEqual({ items: [], nextCursor: null });

    const foreignGroup = await kit.invoke(listCustomers, {
      groupId: fixtures.groupForeign,
    });
    expect(foreignGroup).toEqual({ items: [], nextCursor: null });
    expect(JSON.stringify(foreignGroup)).not.toContain(fixtures.foreign);

    const missing = await kit.invoke(listCustomers, { groupId: randomUUID() });
    expect(missing).toEqual({ items: [], nextCursor: null });
  });

  it("pages rows that share one millisecond without skipping any", async () => {
    const microsecondApart = [
      "2026-06-01T00:00:00.123000Z",
      "2026-06-01T00:00:00.123111Z",
      "2026-06-01T00:00:00.123222Z",
    ];
    const tiedCustomerIds = [randomUUID(), randomUUID(), randomUUID()];

    await kit.db.runtime.db.insert(companyCustomers).values(
      tiedCustomerIds.map((customerId, index) => ({
        id: customerId,
        companyId: fixtures.tieCompany,
        name: `Tie ${String(index)}`,
        phone: `+38077000000${String(index)}`,
        updatedAt: sql`${microsecondApart[index]}::timestamptz`,
      })),
    );

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < tiedCustomerIds.length; page += 1) {
      const listed = await kit.invoke(
        listCustomers,
        { limit: 1, cursor },
        { companyId: fixtures.tieCompany },
      );
      expect(listed.items).toHaveLength(1);
      seen.push(listed.items[0]?.id ?? "");
      cursor = listed.nextCursor ?? undefined;
    }

    expect(cursor).toBeUndefined();
    expect(seen).toEqual([...tiedCustomerIds].sort().reverse());
  });

  it("paginates on updatedAt/id and stops at the last page", async () => {
    const first = await kit.invoke(listCustomers, { limit: 2 });
    expect(first.items.map((row) => row.id)).toEqual([
      fixtures.newest,
      fixtures.alpha,
    ]);
    expect(first.nextCursor).toBe(
      formatListCustomersCursor(stamps.alpha, fixtures.alpha),
    );

    const second = await kit.invoke(listCustomers, {
      limit: 2,
      cursor: first.nextCursor ?? "",
    });
    expect(second.items.map((row) => row.id)).toEqual([fixtures.beta]);
    expect(second.nextCursor).toBeNull();
  });

  it("does not include another company's customers", async () => {
    const result = await kit.invoke(listCustomers, {
      status: "all",
      search: "Alpha",
    });
    expect(result.items.map((row) => row.id)).toEqual([fixtures.alpha]);
    const blob = JSON.stringify(result);
    expect(blob).not.toContain(fixtures.foreign);
    expect(blob).not.toContain(kitIdentities.companies.b);
  });

  it("denies staff without customers:view", async () => {
    await expect(
      kit.invoke(
        listCustomers,
        {},
        { userId: clerkUserId, companyId: kitIdentities.companies.a },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("rejects a bad cursor, oversized limit, and empty search", async () => {
    await expect(
      kit.invoke(listCustomers, { cursor: "not-a-cursor" }),
    ).rejects.toBeInstanceOf(ValidationError);

    await expect(
      kit.invoke(listCustomers, { limit: LIST_CUSTOMERS_MAX_LIMIT + 1 }),
    ).rejects.toBeInstanceOf(ValidationError);

    await expect(
      kit.invoke(listCustomers, { limit: 0 }),
    ).rejects.toBeInstanceOf(ValidationError);

    await expect(
      kit.invoke(listCustomers, { search: "   " }),
    ).rejects.toBeInstanceOf(ValidationError);

    await expect(
      kit.invoke(listCustomers, {
        search: "x".repeat(LIST_CUSTOMERS_SEARCH_MAX + 1),
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    await expect(
      kit.invoke(listCustomers, { groupId: "not-a-uuid" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("returns an empty page when the search is only LIKE metacharacters", async () => {
    const wildcards = await kit.invoke(listCustomers, { search: "%%" });
    const escaped = await kit.invoke(listCustomers, { search: "\\" });
    expect(wildcards).toEqual({ items: [], nextCursor: null });
    expect(escaped).toEqual({ items: [], nextCursor: null });
  });

  it("finds Катя Самбука by the inflected query Каті Самбуки in the same tenant", async () => {
    const katyaA = randomUUID();
    const katyaB = randomUUID();
    await kit.db.runtime.db.insert(companyCustomers).values([
      {
        id: katyaA,
        companyId: kitIdentities.companies.a,
        name: "Катя Самбука",
        email: `katya-a-${katyaA}@kit.test`,
      },
      {
        id: katyaB,
        companyId: kitIdentities.companies.b,
        name: "Катя Самбука",
        email: `katya-b-${katyaB}@kit.test`,
      },
    ]);

    const listed = await kit.invoke(listCustomers, {
      search: "Каті Самбуки",
    });
    expect(listed.items.map((row) => row.id)).toEqual([katyaA]);
    expect(listed.items[0]?.name).toBe("Катя Самбука");
    const blob = JSON.stringify(listed);
    expect(blob).not.toContain(katyaB);
    expect(blob).not.toContain(kitIdentities.companies.b);

    const otherTenant = await kit.invoke(
      listCustomers,
      { search: "Каті Самбуки" },
      {
        companyId: kitIdentities.companies.b,
        userId: kitIdentities.users.boris,
      },
    );
    expect(otherTenant.items.map((row) => row.id)).toEqual([katyaB]);
    expect(otherTenant.items.map((row) => row.id)).not.toContain(katyaA);
  });

  it("returns every similar name in the tenant instead of picking one", async () => {
    const sambuka = randomUUID();
    const sambukova = randomUUID();
    await kit.db.runtime.db.insert(companyCustomers).values([
      {
        id: sambuka,
        companyId: kitIdentities.companies.a,
        name: "Катя Самбука",
        email: `sambuka-${sambuka}@kit.test`,
      },
      {
        id: sambukova,
        companyId: kitIdentities.companies.a,
        name: "Катерина Самбукова",
        email: `sambukova-${sambukova}@kit.test`,
      },
    ]);

    const listed = await kit.invoke(listCustomers, {
      search: "Каті Самбуки",
    });
    expect(listed.items.map((row) => row.id)).toEqual(
      expect.arrayContaining([sambuka, sambukova]),
    );
    expect(
      new Set(listed.items.map((row) => row.id)).size,
    ).toBeGreaterThanOrEqual(2);
  });

  it("does not let a short token match inside another name word", async () => {
    const customerA = randomUUID();
    const customerExtra = randomUUID();
    await kit.db.runtime.db.insert(companyCustomers).values([
      {
        id: customerA,
        companyId: kitIdentities.companies.a,
        name: "Customer A",
        email: `customer-a-${customerA}@kit.test`,
      },
      {
        id: customerExtra,
        companyId: kitIdentities.companies.a,
        name: "Customer Extra",
        email: `customer-extra-${customerExtra}@kit.test`,
      },
    ]);

    const listed = await kit.invoke(listCustomers, { search: "Customer A" });
    expect(listed.items.map((row) => row.id)).toContain(customerA);
    expect(listed.items.map((row) => row.id)).not.toContain(customerExtra);
  });
});
