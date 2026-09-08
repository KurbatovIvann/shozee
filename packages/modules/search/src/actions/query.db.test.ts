import { randomUUID } from "node:crypto";

import { PermissionDeniedError, ValidationError } from "@showzy/core/errors";
import {
  createTestKit,
  crossTenantSuite,
  isolationCase,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import { searchMatches as customersSearchMatches } from "@showzy/customers";
import { user } from "@showzy/db/schema/auth";
import { products, productVariants } from "@showzy/db/schema/catalog";
import { companyMembers } from "@showzy/db/schema/companies";
import {
  companyCustomers,
  counterparties,
  customerGroups,
} from "@showzy/db/schema/customers";
import { orders } from "@showzy/db/schema/orders";
import { priceLists } from "@showzy/db/schema/pricing";
import {
  GLOBAL_HIT_CAP,
  ORDER_CUSTOMER_LOOKUP_MAX,
  SEARCH_ENTITY_TYPES,
  SEARCH_QUERY_MAX,
  type SearchGroup,
  type SearchHit,
} from "@showzy/validation/search";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { query } from "./query.js";

const COMPANY_A_PREFIX = "KA";
const COMPANY_B_PREFIX = "MB";

const fixtures = {
  isoA: randomUUID(),
  isoB: randomUUID(),
  fanoutCustomer: randomUUID(),
  fanoutProduct: randomUUID(),
  fanoutVariant: randomUUID(),
  fanoutList: randomUUID(),
  numberOrder: randomUUID(),
  numberCustomer: randomUUID(),
  lookupCustomer: randomUUID(),
  lookupOrder: randomUUID(),
  foreignLookupCustomer: randomUUID(),
  foreignLookupOrder: randomUUID(),
};

const clerks = {
  noCompaniesView: randomUUID(),
  ordersOnly: randomUUID(),
};

let kit: TestKit;

async function insertCustomer(values: {
  id: string;
  companyId: string;
  name: string;
  email?: string;
  phone?: string;
}): Promise<void> {
  await kit.db.runtime.db.insert(companyCustomers).values({
    id: values.id,
    companyId: values.companyId,
    name: values.name,
    email: values.email ?? `${values.id}@kit.test`,
    phone: values.phone,
  });
}

async function insertOrder(values: {
  id: string;
  companyId: string;
  orderNumber: string;
  customerId: string | null;
  customerNameSnapshot: string;
}): Promise<void> {
  await kit.db.runtime.db.insert(orders).values({
    id: values.id,
    companyId: values.companyId,
    orderNumber: values.orderNumber,
    customerId: values.customerId,
    customerNameSnapshot: values.customerNameSnapshot,
    status: "new",
    totalNetMinor: 100n,
    totalTaxMinor: 0n,
    totalGrossMinor: 100n,
    currency: "UAH",
  });
}

async function insertNamedCustomers(
  prefix: string,
  count: number,
  companyId = kitIdentities.companies.a,
): Promise<string[]> {
  const ids = Array.from({ length: count }, () => randomUUID());
  await kit.db.runtime.db.insert(companyCustomers).values(
    ids.map((id, index) => ({
      id,
      companyId,
      name: `${prefix} ${String(index).padStart(2, "0")}`,
      email: `${prefix.toLowerCase()}-${String(index)}-${id}@kit.test`,
    })),
  );
  return ids;
}

function groupOf(
  result: { groups: readonly SearchGroup[] },
  type: SearchGroup["type"],
) {
  return result.groups.find((group) => group.type === type);
}

function hitIds(group: { hits: readonly SearchHit[] } | undefined): string[] {
  return group?.hits.map((hit) => hit.id) ?? [];
}

beforeAll(async () => {
  kit = await createTestKit();

  await insertCustomer({
    id: fixtures.isoA,
    companyId: kitIdentities.companies.a,
    name: "IsoQry534",
  });
  await insertCustomer({
    id: fixtures.isoB,
    companyId: kitIdentities.companies.b,
    name: "IsoQry534",
  });
  await insertCustomer({
    id: fixtures.fanoutCustomer,
    companyId: kitIdentities.companies.a,
    name: "FanoutHit",
  });
  await insertCustomer({
    id: fixtures.numberCustomer,
    companyId: kitIdentities.companies.a,
    name: "Number Only",
    email: "number-only-534@kit.test",
  });
  await insertCustomer({
    id: fixtures.lookupCustomer,
    companyId: kitIdentities.companies.a,
    name: "Olena534",
    phone: "+380671534000",
  });
  await insertCustomer({
    id: fixtures.foreignLookupCustomer,
    companyId: kitIdentities.companies.b,
    name: "Olena534",
    phone: "+380671534000",
  });

  await kit.db.runtime.db.insert(products).values({
    id: fixtures.fanoutProduct,
    companyId: kitIdentities.companies.a,
    name: "FanoutHit",
    basePriceMinor: 100n,
  });
  await kit.db.runtime.db.insert(productVariants).values({
    id: fixtures.fanoutVariant,
    companyId: kitIdentities.companies.a,
    productId: fixtures.fanoutProduct,
    name: "Fanout Flavor",
  });
  await kit.db.runtime.db.insert(priceLists).values({
    id: fixtures.fanoutList,
    companyId: kitIdentities.companies.a,
    name: "FanoutHit",
  });

  await insertOrder({
    id: fixtures.numberOrder,
    companyId: kitIdentities.companies.a,
    orderNumber: `${COMPANY_A_PREFIX}-534NUM1`,
    customerId: fixtures.numberCustomer,
    customerNameSnapshot: "Number Only",
  });
  await insertOrder({
    id: fixtures.lookupOrder,
    companyId: kitIdentities.companies.a,
    orderNumber: `${COMPANY_A_PREFIX}-534HID1`,
    customerId: fixtures.lookupCustomer,
    customerNameSnapshot: "Hidden Snapshot",
  });
  await insertOrder({
    id: fixtures.foreignLookupOrder,
    companyId: kitIdentities.companies.b,
    orderNumber: `${COMPANY_B_PREFIX}-534HID1`,
    customerId: fixtures.foreignLookupCustomer,
    customerNameSnapshot: "Hidden Snapshot",
  });

  const capIds = Array.from({ length: 10 }, () => ({
    customer: randomUUID(),
    group: randomUUID(),
    party: randomUUID(),
    product: randomUUID(),
    variant: randomUUID(),
  }));
  await kit.db.runtime.db.insert(companyCustomers).values(
    capIds.map((row, index) => ({
      id: row.customer,
      companyId: kitIdentities.companies.a,
      name: "CapExact",
      email: `cap-exact-${String(index)}-${row.customer}@kit.test`,
    })),
  );
  await kit.db.runtime.db.insert(customerGroups).values(
    capIds.map((row, index) => ({
      id: row.group,
      companyId: kitIdentities.companies.a,
      name: "CapExact",
      slug: `cap-exact-${String(index)}`,
    })),
  );
  await kit.db.runtime.db.insert(counterparties).values(
    capIds.map((row) => ({
      id: row.party,
      companyId: kitIdentities.companies.a,
      name: "CapExact",
    })),
  );
  await kit.db.runtime.db.insert(products).values(
    capIds.map((row) => ({
      id: row.product,
      companyId: kitIdentities.companies.a,
      name: "CapExact",
      basePriceMinor: 50n,
    })),
  );
  await kit.db.runtime.db.insert(productVariants).values(
    capIds.map((row) => ({
      id: row.variant,
      companyId: kitIdentities.companies.a,
      productId: row.product,
      name: "CapExact",
    })),
  );

  await kit.db.runtime.db.insert(user).values([
    {
      id: clerks.noCompaniesView,
      name: "No companies view",
      email: "no-companies-view-search@kit.test",
    },
    {
      id: clerks.ordersOnly,
      name: "Orders only",
      email: "orders-only-search@kit.test",
    },
  ]);
  await kit.db.runtime.db.insert(companyMembers).values([
    {
      companyId: kitIdentities.companies.a,
      userId: clerks.noCompaniesView,
      role: "employee",
      permissions: {
        granted: [
          "orders:view",
          "customers:view",
          "products:view",
          "pricing:view",
          "documents:view",
        ],
        denied: ["companies:view"],
      },
    },
    {
      companyId: kitIdentities.companies.a,
      userId: clerks.ordersOnly,
      role: "employee",
      permissions: {
        granted: ["orders:view", "companies:view"],
        denied: [
          "customers:view",
          "documents:view",
          "products:view",
          "pricing:view",
        ],
      },
    },
  ]);
});

afterAll(async () => {
  await kit.db.close();
});

crossTenantSuite(
  () => kit,
  [
    isolationCase(
      query,
      { input: { query: "IsoQry534" } },
      {
        input: { query: "IsoQry534" },
        companyId: kitIdentities.companies.b,
        userId: kitIdentities.users.anna,
      },
    ),
  ],
);

describe("search.query", () => {
  it("returns grouped hits for the active company and keeps variant productId", async () => {
    const listed = await kit.invoke(query, { query: "FanoutHit" });
    expect(listed.queryNormalized).toBe("FanoutHit");
    expect(hitIds(groupOf(listed, "customer"))).toContain(
      fixtures.fanoutCustomer,
    );
    expect(hitIds(groupOf(listed, "product"))).toContain(
      fixtures.fanoutProduct,
    );
    expect(hitIds(groupOf(listed, "priceList"))).toContain(fixtures.fanoutList);
    const variantGroup = groupOf(listed, "variant");
    expect(variantGroup?.type).toBe("variant");
    if (variantGroup?.type !== "variant") {
      return;
    }
    const variant = variantGroup.hits.find(
      (row) => row.id === fixtures.fanoutVariant,
    );
    expect(variant?.productId).toBe(fixtures.fanoutProduct);
    expect(listed.searchedTypes).toEqual([...SEARCH_ENTITY_TYPES]);
  });

  it("keeps company A hits out of company B results (Anna vs Boris)", async () => {
    const anna = await kit.invoke(query, { query: "IsoQry534" });
    const boris = await kit.invoke(
      query,
      { query: "IsoQry534" },
      {
        companyId: kitIdentities.companies.b,
        userId: kitIdentities.users.boris,
      },
    );
    expect(hitIds(groupOf(anna, "customer"))).toEqual([fixtures.isoA]);
    expect(hitIds(groupOf(anna, "customer"))).not.toContain(fixtures.isoB);
    expect(hitIds(groupOf(boris, "customer"))).toEqual([fixtures.isoB]);
    expect(hitIds(groupOf(boris, "customer"))).not.toContain(fixtures.isoA);
    expect(JSON.stringify(anna)).not.toContain(fixtures.isoB);
    expect(JSON.stringify(boris)).not.toContain(fixtures.isoA);
  });

  it("denies staff whose membership lacks companies:view", async () => {
    await expect(
      kit.invoke(
        query,
        { query: "FanoutHit" },
        {
          userId: clerks.noCompaniesView,
          companyId: kitIdentities.companies.a,
        },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("searches order numbers without customers:view or documents:view", async () => {
    const listed = await kit.invoke(
      query,
      {
        query: "534NUM1",
        types: [
          "order",
          "customer",
          "customerGroup",
          "counterparty",
          "document",
        ],
      },
      {
        userId: clerks.ordersOnly,
        companyId: kitIdentities.companies.a,
      },
    );
    expect(listed.searchedTypes).toEqual(["order"]);
    expect(hitIds(groupOf(listed, "order"))).toContain(fixtures.numberOrder);
    expect(groupOf(listed, "customer")).toBeUndefined();
    expect(groupOf(listed, "customerGroup")).toBeUndefined();
    expect(groupOf(listed, "counterparty")).toBeUndefined();
    expect(groupOf(listed, "document")).toBeUndefined();
  });

  it("runs internal customer lookup for types:[order] without listing customer", async () => {
    const listed = await kit.invoke(query, {
      query: "Olena534",
      types: ["order"],
    });
    expect(listed.searchedTypes).toEqual(["order"]);
    expect(groupOf(listed, "customer")).toBeUndefined();
    const orderHit = groupOf(listed, "order")?.hits.find(
      (row) => row.id === fixtures.lookupOrder,
    );
    expect(orderHit?.matchedOn).toBe("customer");
    expect(orderHit?.exact).toBe(false);
    expect(hitIds(groupOf(listed, "order"))).not.toContain(
      fixtures.foreignLookupOrder,
    );
  });

  it("returns empty groups without error for empty or punctuation-only queries", async () => {
    const empty = await kit.invoke(query, { query: "" });
    expect(empty.groups).toEqual([]);
    expect(empty.queryNormalized).toBe("");
    expect(empty.searchedTypes).toEqual([...SEARCH_ENTITY_TYPES]);
    expect(await kit.invoke(query, { query: "..." })).toEqual(empty);
    const ordersOnly = await kit.invoke(
      query,
      { query: "!!! ???", types: ["order", "customer", "document"] },
      {
        userId: clerks.ordersOnly,
        companyId: kitIdentities.companies.a,
      },
    );
    expect(ordersOnly).toEqual({
      groups: [],
      searchedTypes: ["order"],
      queryNormalized: "",
    });
  });

  it("keeps lookup complete when display limitPerType drops customer #6", async () => {
    const ids = await insertNamedCustomers("DisplaySix", 6);
    const crm = await kit.invoke(customersSearchMatches, {
      query: "DisplaySix",
      limitPerType: 5,
    });
    expect(crm.orderCustomerLookup.truncated).toBe(false);
    expect(crm.orderCustomerLookup.ids).toHaveLength(6);
    const displayIds = hitIds(
      crm.groups.find((group) => group.type === "customer"),
    );
    expect(displayIds).toHaveLength(5);
    const sixth = ids.find((id) => !displayIds.includes(id));
    expect(sixth).toBeDefined();
    if (sixth === undefined) {
      return;
    }
    const sixthOrder = randomUUID();
    await insertOrder({
      id: sixthOrder,
      companyId: kitIdentities.companies.a,
      orderNumber: `${COMPANY_A_PREFIX}-534SIX6`,
      customerId: sixth,
      customerNameSnapshot: "Unrelated Snapshot",
    });

    const listed = await kit.invoke(query, {
      query: "DisplaySix",
      types: ["customer", "order"],
    });
    expect(groupOf(listed, "customer")?.truncated).toBe(true);
    expect(hitIds(groupOf(listed, "customer"))).toHaveLength(5);
    expect(hitIds(groupOf(listed, "customer"))).not.toContain(sixth);
    expect(hitIds(groupOf(listed, "order"))).toContain(sixthOrder);
    expect(
      groupOf(listed, "order")?.hits.find((row) => row.id === sixthOrder)
        ?.matchedOn,
    ).toBe("customer");
  });

  it("marks an empty order group truncated when lookup drops the only ordered customer", async () => {
    const ids = await insertNamedCustomers("OverTwenty", 21);
    const crm = await kit.invoke(customersSearchMatches, {
      query: "OverTwenty",
      limitPerType: 5,
    });
    expect(crm.orderCustomerLookup.truncated).toBe(true);
    expect(crm.orderCustomerLookup.ids).toHaveLength(ORDER_CUSTOMER_LOOKUP_MAX);
    const dropped = ids.filter(
      (id) => !crm.orderCustomerLookup.ids.includes(id),
    );
    expect(dropped).toHaveLength(1);
    const onlyOrdered = dropped[0];
    expect(onlyOrdered).toBeDefined();
    if (onlyOrdered === undefined) {
      return;
    }
    await insertOrder({
      id: randomUUID(),
      companyId: kitIdentities.companies.a,
      orderNumber: `${COMPANY_A_PREFIX}-534TW21`,
      customerId: onlyOrdered,
      customerNameSnapshot: "Unrelated Snapshot",
    });

    const listed = await kit.invoke(query, {
      query: "OverTwenty",
      types: ["order", "customer"],
    });
    const orderGroup = groupOf(listed, "order");
    expect(orderGroup).toEqual({ type: "order", hits: [], truncated: true });
    expect(groupOf(listed, "customer")?.truncated).toBe(true);
    expect(hitIds(groupOf(listed, "customer"))).toHaveLength(5);
  });

  it("applies the global hit cap with exact hits first in type-enum order", async () => {
    const listed = await kit.invoke(query, {
      query: "CapExact",
      limitPerType: 10,
    });
    expect(listed.groups.flatMap((group) => group.hits)).toHaveLength(
      GLOBAL_HIT_CAP,
    );
    expect(
      listed.groups.flatMap((group) => group.hits).every((row) => row.exact),
    ).toBe(true);
    expect(
      listed.groups.map((group) => ({
        type: group.type,
        count: group.hits.length,
        truncated: group.truncated,
      })),
    ).toEqual([
      { type: "customer", count: 10, truncated: false },
      { type: "customerGroup", count: 10, truncated: false },
      { type: "counterparty", count: 10, truncated: false },
      { type: "product", count: 10, truncated: false },
      { type: "variant", count: 0, truncated: true },
    ]);
  });

  it("rejects oversize query and companyId in input", async () => {
    await expect(
      kit.invoke(query, { query: "x".repeat(SEARCH_QUERY_MAX + 1) }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      kit.invoke(query, {
        query: "FanoutHit",
        companyId: kitIdentities.companies.b,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
