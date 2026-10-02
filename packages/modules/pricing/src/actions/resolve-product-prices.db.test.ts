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
import { user } from "@showzy/db/schema/auth";
import { products, productVariants } from "@showzy/db/schema/catalog";
import { companyMembers } from "@showzy/db/schema/companies";
import { companyCustomers, customerGroups } from "@showzy/db/schema/customers";
import {
  personalPrices,
  priceListEntries,
  priceLists,
} from "@showzy/db/schema/pricing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveProductPrices } from "./resolve-product-prices.js";
import {
  PRICING_RESOLVER_VERSION,
  RESOLVE_PRODUCT_PRICES_MAX_ITEMS,
} from "./resolve-product-prices.contract.js";

const fixtures = {
  listCustomer: randomUUID(),
  listGroup: randomUUID(),
  listDefault: randomUUID(),
  listInactive: randomUUID(),
  groupA: randomUUID(),
  customerA: randomUUID(),
  customerInactive: randomUUID(),
  customerBare: randomUUID(),
  customerB: randomUUID(),
  pPersonal: randomUUID(),
  pCustomerList: randomUUID(),
  pGroupList: randomUUID(),
  pDefault: randomUUID(),
  pBase: randomUUID(),
  pZero: randomUUID(),
  pWithinLevel: randomUUID(),
  pCrossLevel: randomUUID(),
  pInactiveSkip: randomUUID(),
  pB: randomUUID(),
  vWithin: randomUUID(),
  vCross: randomUUID(),
  vOverride: randomUUID(),
  vBase: randomUUID(),
  vB: randomUUID(),
  personalPPersonal: randomUUID(),
  personalCross: randomUUID(),
  entryCustomerPersonal: randomUUID(),
  entryCustomerCustomerList: randomUUID(),
  entryCustomerDefault: randomUUID(),
  entryCustomerWithinProduct: randomUUID(),
  entryCustomerWithinVariant: randomUUID(),
  entryCustomerCrossVariant: randomUUID(),
  entryGroupPersonal: randomUUID(),
  entryGroupCustomerList: randomUUID(),
  entryGroupGroupList: randomUUID(),
  entryGroupInactiveSkip: randomUUID(),
  entryDefaultPersonal: randomUUID(),
  entryDefaultCustomerList: randomUUID(),
  entryDefaultGroupList: randomUUID(),
  entryDefaultDefault: randomUUID(),
  entryInactiveSkip: randomUUID(),
};

const clerks = {
  noPricing: randomUUID(),
  noProducts: randomUUID(),
  noCustomers: randomUUID(),
};

let kit: TestKit;

async function insertProduct(values: {
  id: string;
  companyId: string;
  name?: string;
  basePriceMinor: bigint;
}): Promise<void> {
  await kit.db.runtime.db.insert(products).values({
    id: values.id,
    companyId: values.companyId,
    name: values.name ?? "Fixture product",
    basePriceMinor: values.basePriceMinor,
  });
}

async function insertVariant(values: {
  id: string;
  companyId: string;
  productId: string;
  name?: string;
  basePriceMinor?: bigint;
  currency?: string;
}): Promise<void> {
  await kit.db.runtime.db.insert(productVariants).values({
    id: values.id,
    companyId: values.companyId,
    productId: values.productId,
    name: values.name ?? "Fixture variant",
    ...(values.basePriceMinor === undefined
      ? {}
      : { basePriceMinor: values.basePriceMinor }),
    ...(values.currency === undefined ? {} : { currency: values.currency }),
  });
}

async function insertList(values: {
  id: string;
  companyId: string;
  isDefault?: boolean;
  isActive?: boolean;
}): Promise<void> {
  await kit.db.runtime.db.insert(priceLists).values({
    id: values.id,
    companyId: values.companyId,
    name: values.isDefault === true ? "Default" : "Price list",
    ...(values.isDefault === undefined ? {} : { isDefault: values.isDefault }),
    ...(values.isActive === undefined ? {} : { isActive: values.isActive }),
  });
}

async function insertEntry(values: {
  id: string;
  companyId: string;
  priceListId: string;
  productId: string;
  variantId?: string;
  priceMinor: bigint;
}): Promise<void> {
  await kit.db.runtime.db.insert(priceListEntries).values({
    id: values.id,
    companyId: values.companyId,
    priceListId: values.priceListId,
    productId: values.productId,
    priceMinor: values.priceMinor,
    ...(values.variantId === undefined ? {} : { variantId: values.variantId }),
  });
}

async function insertPersonal(values: {
  id: string;
  companyId: string;
  customerId: string;
  productId: string;
  variantId?: string;
  priceMinor: bigint;
}): Promise<void> {
  await kit.db.runtime.db.insert(personalPrices).values({
    id: values.id,
    companyId: values.companyId,
    customerId: values.customerId,
    productId: values.productId,
    priceMinor: values.priceMinor,
    ...(values.variantId === undefined ? {} : { variantId: values.variantId }),
  });
}

beforeAll(async () => {
  kit = await createTestKit();
  const companyA = kitIdentities.companies.a;
  const companyB = kitIdentities.companies.b;

  await insertList({ id: fixtures.listCustomer, companyId: companyA });
  await insertList({ id: fixtures.listGroup, companyId: companyA });
  await insertList({
    id: fixtures.listDefault,
    companyId: companyA,
    isDefault: true,
  });
  await insertList({
    id: fixtures.listInactive,
    companyId: companyA,
    isActive: false,
  });

  await kit.db.runtime.db.insert(customerGroups).values({
    id: fixtures.groupA,
    companyId: companyA,
    name: "Group A",
    slug: `group-${fixtures.groupA}`,
    priceListId: fixtures.listGroup,
  });
  await kit.db.runtime.db.insert(companyCustomers).values([
    {
      id: fixtures.customerA,
      companyId: companyA,
      name: "Customer A",
      email: `customer-${fixtures.customerA}@example.com`,
      groupId: fixtures.groupA,
      priceListId: fixtures.listCustomer,
    },
    {
      id: fixtures.customerInactive,
      companyId: companyA,
      name: "Customer inactive list",
      email: `customer-${fixtures.customerInactive}@example.com`,
      groupId: fixtures.groupA,
      priceListId: fixtures.listInactive,
    },
    {
      id: fixtures.customerBare,
      companyId: companyA,
      name: "Customer bare",
      email: `customer-${fixtures.customerBare}@example.com`,
    },
    {
      id: fixtures.customerB,
      companyId: companyB,
      name: "Customer B",
      email: `customer-${fixtures.customerB}@example.com`,
    },
  ]);

  await insertProduct({
    id: fixtures.pPersonal,
    companyId: companyA,
    basePriceMinor: 9000n,
  });
  await insertProduct({
    id: fixtures.pCustomerList,
    companyId: companyA,
    basePriceMinor: 9000n,
  });
  await insertProduct({
    id: fixtures.pGroupList,
    companyId: companyA,
    basePriceMinor: 9000n,
  });
  await insertProduct({
    id: fixtures.pDefault,
    companyId: companyA,
    basePriceMinor: 9000n,
  });
  await insertProduct({
    id: fixtures.pBase,
    companyId: companyA,
    basePriceMinor: 1500n,
  });
  await insertProduct({
    id: fixtures.pZero,
    companyId: companyA,
    basePriceMinor: 0n,
  });
  await insertProduct({
    id: fixtures.pWithinLevel,
    companyId: companyA,
    basePriceMinor: 8000n,
  });
  await insertProduct({
    id: fixtures.pCrossLevel,
    companyId: companyA,
    basePriceMinor: 8000n,
  });
  await insertProduct({
    id: fixtures.pInactiveSkip,
    companyId: companyA,
    basePriceMinor: 9000n,
  });
  await insertProduct({
    id: fixtures.pB,
    companyId: companyB,
    basePriceMinor: 2200n,
  });

  await insertVariant({
    id: fixtures.vWithin,
    companyId: companyA,
    productId: fixtures.pWithinLevel,
  });
  await insertVariant({
    id: fixtures.vCross,
    companyId: companyA,
    productId: fixtures.pCrossLevel,
  });
  await insertVariant({
    id: fixtures.vOverride,
    companyId: companyA,
    productId: fixtures.pBase,
    basePriceMinor: 1250n,
    currency: "UAH",
  });
  await insertVariant({
    id: fixtures.vBase,
    companyId: companyA,
    productId: fixtures.pBase,
  });
  await insertVariant({
    id: fixtures.vB,
    companyId: companyB,
    productId: fixtures.pB,
  });

  await insertPersonal({
    id: fixtures.personalPPersonal,
    companyId: companyA,
    customerId: fixtures.customerA,
    productId: fixtures.pPersonal,
    priceMinor: 100n,
  });
  await insertPersonal({
    id: fixtures.personalCross,
    companyId: companyA,
    customerId: fixtures.customerA,
    productId: fixtures.pCrossLevel,
    priceMinor: 100n,
  });

  await insertEntry({
    id: fixtures.entryCustomerPersonal,
    companyId: companyA,
    priceListId: fixtures.listCustomer,
    productId: fixtures.pPersonal,
    priceMinor: 200n,
  });
  await insertEntry({
    id: fixtures.entryCustomerCustomerList,
    companyId: companyA,
    priceListId: fixtures.listCustomer,
    productId: fixtures.pCustomerList,
    priceMinor: 200n,
  });
  await insertEntry({
    id: fixtures.entryCustomerDefault,
    companyId: companyA,
    priceListId: fixtures.listCustomer,
    productId: fixtures.pDefault,
    priceMinor: 200n,
  });
  await insertEntry({
    id: fixtures.entryCustomerWithinProduct,
    companyId: companyA,
    priceListId: fixtures.listCustomer,
    productId: fixtures.pWithinLevel,
    priceMinor: 500n,
  });
  await insertEntry({
    id: fixtures.entryCustomerWithinVariant,
    companyId: companyA,
    priceListId: fixtures.listCustomer,
    productId: fixtures.pWithinLevel,
    variantId: fixtures.vWithin,
    priceMinor: 400n,
  });
  await insertEntry({
    id: fixtures.entryCustomerCrossVariant,
    companyId: companyA,
    priceListId: fixtures.listCustomer,
    productId: fixtures.pCrossLevel,
    variantId: fixtures.vCross,
    priceMinor: 40n,
  });

  await insertEntry({
    id: fixtures.entryGroupPersonal,
    companyId: companyA,
    priceListId: fixtures.listGroup,
    productId: fixtures.pPersonal,
    priceMinor: 300n,
  });
  await insertEntry({
    id: fixtures.entryGroupCustomerList,
    companyId: companyA,
    priceListId: fixtures.listGroup,
    productId: fixtures.pCustomerList,
    priceMinor: 300n,
  });
  await insertEntry({
    id: fixtures.entryGroupGroupList,
    companyId: companyA,
    priceListId: fixtures.listGroup,
    productId: fixtures.pGroupList,
    priceMinor: 300n,
  });
  await insertEntry({
    id: fixtures.entryGroupInactiveSkip,
    companyId: companyA,
    priceListId: fixtures.listGroup,
    productId: fixtures.pInactiveSkip,
    priceMinor: 300n,
  });

  await insertEntry({
    id: fixtures.entryDefaultPersonal,
    companyId: companyA,
    priceListId: fixtures.listDefault,
    productId: fixtures.pPersonal,
    priceMinor: 400n,
  });
  await insertEntry({
    id: fixtures.entryDefaultCustomerList,
    companyId: companyA,
    priceListId: fixtures.listDefault,
    productId: fixtures.pCustomerList,
    priceMinor: 400n,
  });
  await insertEntry({
    id: fixtures.entryDefaultGroupList,
    companyId: companyA,
    priceListId: fixtures.listDefault,
    productId: fixtures.pGroupList,
    priceMinor: 400n,
  });
  await insertEntry({
    id: fixtures.entryDefaultDefault,
    companyId: companyA,
    priceListId: fixtures.listDefault,
    productId: fixtures.pDefault,
    priceMinor: 400n,
  });
  await insertEntry({
    id: fixtures.entryInactiveSkip,
    companyId: companyA,
    priceListId: fixtures.listInactive,
    productId: fixtures.pInactiveSkip,
    priceMinor: 111n,
  });

  await kit.db.runtime.db.insert(user).values([
    {
      id: clerks.noPricing,
      name: "No pricing",
      email: "nopricing@pricing-kit.test",
    },
    {
      id: clerks.noProducts,
      name: "No products",
      email: "noproducts@pricing-kit.test",
    },
    {
      id: clerks.noCustomers,
      name: "No customers",
      email: "nocustomers@pricing-kit.test",
    },
  ]);
  await kit.db.runtime.db.insert(companyMembers).values([
    {
      companyId: companyA,
      userId: clerks.noPricing,
      role: "employee",
      permissions: { granted: [], denied: ["pricing:view"] },
    },
    {
      companyId: companyA,
      userId: clerks.noProducts,
      role: "employee",
      permissions: {
        granted: ["pricing:view"],
        denied: ["products:view"],
      },
    },
    {
      companyId: companyA,
      userId: clerks.noCustomers,
      role: "employee",
      permissions: {
        granted: ["pricing:view", "products:view"],
        denied: ["customers:view"],
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
      resolveProductPrices,
      { input: { items: [{ productId: fixtures.pBase }] } },
      { input: { items: [{ productId: fixtures.pB }] } },
    ),
  ],
);

describe("pricing.resolveProductPrices", () => {
  it("hits personal and ignores lower-level prices for the same product", async () => {
    const result = await kit.invoke(resolveProductPrices, {
      items: [{ productId: fixtures.pPersonal }],
      customerId: fixtures.customerA,
    });
    expect(result).toEqual({
      prices: [
        {
          productId: fixtures.pPersonal,
          variantId: null,
          unitPriceMinor: "100",
          currency: "UAH",
          source: "personal",
          matchLevel: "product",
          sourceIds: { personalPriceId: fixtures.personalPPersonal },
          resolverVersion: PRICING_RESOLVER_VERSION,
        },
      ],
    });
  });

  it("falls through to the customer list when personal misses", async () => {
    const result = await kit.invoke(resolveProductPrices, {
      items: [{ productId: fixtures.pCustomerList }],
      customerId: fixtures.customerA,
    });
    expect(result.prices[0]).toMatchObject({
      productId: fixtures.pCustomerList,
      unitPriceMinor: "200",
      source: "customer_price_list",
      matchLevel: "product",
      sourceIds: {
        priceListId: fixtures.listCustomer,
        entryId: fixtures.entryCustomerCustomerList,
      },
    });
  });

  it("falls through to the group list when personal and customer list miss", async () => {
    const result = await kit.invoke(resolveProductPrices, {
      items: [{ productId: fixtures.pGroupList }],
      customerId: fixtures.customerA,
    });
    expect(result.prices[0]).toMatchObject({
      unitPriceMinor: "300",
      source: "group_price_list",
      sourceIds: {
        priceListId: fixtures.listGroup,
        entryId: fixtures.entryGroupGroupList,
      },
    });
  });

  it("falls through to the company default list when levels 1–3 miss", async () => {
    const result = await kit.invoke(resolveProductPrices, {
      items: [{ productId: fixtures.pDefault }],
      customerId: fixtures.customerBare,
    });
    expect(result.prices[0]).toMatchObject({
      unitPriceMinor: "400",
      source: "default_price_list",
      sourceIds: {
        priceListId: fixtures.listDefault,
        entryId: fixtures.entryDefaultDefault,
      },
    });
  });

  it("uses the catalog base when every list misses, including a zero price", async () => {
    const result = await kit.invoke(resolveProductPrices, {
      items: [{ productId: fixtures.pBase }, { productId: fixtures.pZero }],
      customerId: fixtures.customerBare,
    });
    expect(result.prices).toEqual([
      {
        productId: fixtures.pBase,
        variantId: null,
        unitPriceMinor: "1500",
        currency: "UAH",
        source: "base",
        matchLevel: "product",
        sourceIds: {},
        resolverVersion: PRICING_RESOLVER_VERSION,
      },
      {
        productId: fixtures.pZero,
        variantId: null,
        unitPriceMinor: "0",
        currency: "UAH",
        source: "base",
        matchLevel: "product",
        sourceIds: {},
        resolverVersion: PRICING_RESOLVER_VERSION,
      },
    ]);
  });

  it("omitted customerId uses default then base and ignores personal prices", async () => {
    const result = await kit.invoke(resolveProductPrices, {
      items: [{ productId: fixtures.pPersonal }, { productId: fixtures.pBase }],
    });
    expect(result.prices.map((price) => price.source)).toEqual([
      "default_price_list",
      "base",
    ]);
    expect(result.prices[0]?.unitPriceMinor).toBe("400");
    expect(result.prices[1]?.unitPriceMinor).toBe("1500");
  });

  it("returns per-item results in input order, including duplicates", async () => {
    const result = await kit.invoke(resolveProductPrices, {
      items: [
        { productId: fixtures.pZero },
        { productId: fixtures.pPersonal },
        { productId: fixtures.pZero },
      ],
      customerId: fixtures.customerA,
    });
    expect(result.prices.map((price) => price.productId)).toEqual([
      fixtures.pZero,
      fixtures.pPersonal,
      fixtures.pZero,
    ]);
    expect(result.prices.map((price) => price.source)).toEqual([
      "base",
      "personal",
      "base",
    ]);
  });

  it("uses a variant list entry over a product entry at the same level", async () => {
    const withVariant = await kit.invoke(resolveProductPrices, {
      items: [
        {
          productId: fixtures.pWithinLevel,
          variantId: fixtures.vWithin,
        },
      ],
      customerId: fixtures.customerA,
    });
    expect(withVariant.prices[0]).toMatchObject({
      variantId: fixtures.vWithin,
      unitPriceMinor: "400",
      source: "customer_price_list",
      matchLevel: "variant",
      sourceIds: {
        priceListId: fixtures.listCustomer,
        entryId: fixtures.entryCustomerWithinVariant,
      },
    });

    const productOnly = await kit.invoke(resolveProductPrices, {
      items: [{ productId: fixtures.pWithinLevel }],
      customerId: fixtures.customerA,
    });
    expect(productOnly.prices[0]).toMatchObject({
      variantId: null,
      unitPriceMinor: "500",
      matchLevel: "product",
      sourceIds: { entryId: fixtures.entryCustomerWithinProduct },
    });
  });

  it("keeps a product-level personal price over a variant hit at a lower level", async () => {
    const result = await kit.invoke(resolveProductPrices, {
      items: [
        {
          productId: fixtures.pCrossLevel,
          variantId: fixtures.vCross,
        },
      ],
      customerId: fixtures.customerA,
    });
    expect(result.prices[0]).toMatchObject({
      unitPriceMinor: "100",
      source: "personal",
      matchLevel: "product",
      sourceIds: { personalPriceId: fixtures.personalCross },
    });
  });

  it("uses a variant base-price override at level 5, else the product base", async () => {
    const override = await kit.invoke(resolveProductPrices, {
      items: [{ productId: fixtures.pBase, variantId: fixtures.vOverride }],
    });
    expect(override.prices[0]).toMatchObject({
      unitPriceMinor: "1250",
      source: "base",
      matchLevel: "variant",
      sourceIds: {},
    });

    const fallback = await kit.invoke(resolveProductPrices, {
      items: [{ productId: fixtures.pBase, variantId: fixtures.vBase }],
    });
    expect(fallback.prices[0]).toMatchObject({
      unitPriceMinor: "1500",
      source: "base",
      matchLevel: "product",
    });
  });

  it("skips an inactive customer list and falls through to the group list", async () => {
    const result = await kit.invoke(resolveProductPrices, {
      items: [{ productId: fixtures.pInactiveSkip }],
      customerId: fixtures.customerInactive,
    });
    expect(result.prices[0]).toMatchObject({
      unitPriceMinor: "300",
      source: "group_price_list",
      sourceIds: {
        priceListId: fixtures.listGroup,
        entryId: fixtures.entryGroupInactiveSkip,
      },
    });
  });

  it("denies staff without pricing:view, products:view, or customers:view", async () => {
    await expect(
      kit.invoke(
        resolveProductPrices,
        { items: [{ productId: fixtures.pBase }] },
        { userId: clerks.noPricing, companyId: kitIdentities.companies.a },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);

    await expect(
      kit.invoke(
        resolveProductPrices,
        { items: [{ productId: fixtures.pBase }] },
        { userId: clerks.noProducts, companyId: kitIdentities.companies.a },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);

    await expect(
      kit.invoke(
        resolveProductPrices,
        {
          items: [{ productId: fixtures.pBase }],
          customerId: fixtures.customerA,
        },
        { userId: clerks.noCustomers, companyId: kitIdentities.companies.a },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);

    await expect(
      kit.invoke(
        resolveProductPrices,
        { items: [{ productId: fixtures.pBase }] },
        { userId: clerks.noCustomers, companyId: kitIdentities.companies.a },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("rejects an empty batch, oversized batch, and malformed ids", async () => {
    await expect(
      kit.invoke(resolveProductPrices, { items: [] }),
    ).rejects.toBeInstanceOf(ValidationError);

    const oversized = Array.from(
      { length: RESOLVE_PRODUCT_PRICES_MAX_ITEMS + 1 },
      () => ({ productId: randomUUID() }),
    );
    await expect(
      kit.invoke(resolveProductPrices, { items: oversized }),
    ).rejects.toBeInstanceOf(ValidationError);

    await expect(
      kit.invoke(resolveProductPrices, {
        items: [{ productId: "not-a-uuid" }],
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    await expect(
      kit.invoke(resolveProductPrices, {
        items: [{ productId: fixtures.pBase }],
        customerId: "not-a-uuid",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("fails the whole batch for a missing or foreign product with the same not-found", async () => {
    const missingId = randomUUID();
    const missingError = await kit
      .invoke(resolveProductPrices, {
        items: [{ productId: missingId }],
      })
      .then(
        () => {
          throw new Error("expected NotFoundError for a missing product");
        },
        (error: unknown) => error,
      );
    const foreignError = await kit
      .invoke(resolveProductPrices, {
        items: [{ productId: fixtures.pB }],
      })
      .then(
        () => {
          throw new Error("expected NotFoundError for a foreign product");
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

    await expect(
      kit.invoke(resolveProductPrices, {
        items: [{ productId: fixtures.pBase }, { productId: missingId }],
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("fails the whole batch when a variantId or customer is foreign or mismatched", async () => {
    await expect(
      kit.invoke(resolveProductPrices, {
        items: [{ productId: fixtures.pBase, variantId: fixtures.vB }],
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    await expect(
      kit.invoke(resolveProductPrices, {
        items: [{ productId: fixtures.pBase, variantId: fixtures.vWithin }],
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    const missingCustomer = randomUUID();
    const missingError = await kit
      .invoke(resolveProductPrices, {
        items: [{ productId: fixtures.pBase }],
        customerId: missingCustomer,
      })
      .then(
        () => {
          throw new Error("expected NotFoundError for a missing customer");
        },
        (error: unknown) => error,
      );
    const foreignError = await kit
      .invoke(resolveProductPrices, {
        items: [{ productId: fixtures.pBase }],
        customerId: fixtures.customerB,
      })
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
