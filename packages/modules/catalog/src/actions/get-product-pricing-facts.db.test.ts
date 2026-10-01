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
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getProductPricingFacts } from "./get-product-pricing-facts.js";
import { PRODUCT_PRICING_FACTS_MAX_ITEMS } from "./get-product-pricing-facts.contract.js";

const fixtures = {
  productA: randomUUID(),
  productAZero: randomUUID(),
  productAOther: randomUUID(),
  productB: randomUUID(),
  variantAOverride: randomUUID(),
  variantABase: randomUUID(),
  variantAOther: randomUUID(),
  variantB: randomUUID(),
};

const clerkUserId = randomUUID();

let kit: TestKit;

async function insertProduct(values: {
  id: string;
  companyId: string;
  name: string;
  basePriceMinor: bigint;
  currency?: string;
}): Promise<void> {
  await kit.db.runtime.db.insert(products).values({
    id: values.id,
    companyId: values.companyId,
    name: values.name,
    basePriceMinor: values.basePriceMinor,
    ...(values.currency === undefined ? {} : { currency: values.currency }),
  });
}

async function insertVariant(values: {
  id: string;
  companyId: string;
  productId: string;
  name: string;
  basePriceMinor?: bigint;
  currency?: string;
}): Promise<void> {
  await kit.db.runtime.db.insert(productVariants).values({
    id: values.id,
    companyId: values.companyId,
    productId: values.productId,
    name: values.name,
    ...(values.basePriceMinor === undefined
      ? {}
      : { basePriceMinor: values.basePriceMinor }),
    ...(values.currency === undefined ? {} : { currency: values.currency }),
  });
}

beforeAll(async () => {
  kit = await createTestKit();

  await insertProduct({
    id: fixtures.productA,
    companyId: kitIdentities.companies.a,
    name: "Alpha",
    basePriceMinor: 1500n,
  });
  await insertProduct({
    id: fixtures.productAZero,
    companyId: kitIdentities.companies.a,
    name: "Zero",
    basePriceMinor: 0n,
  });
  await insertProduct({
    id: fixtures.productAOther,
    companyId: kitIdentities.companies.a,
    name: "Other",
    basePriceMinor: 900n,
  });
  await insertProduct({
    id: fixtures.productB,
    companyId: kitIdentities.companies.b,
    name: "Bravo",
    basePriceMinor: 2200n,
  });

  await insertVariant({
    id: fixtures.variantAOverride,
    companyId: kitIdentities.companies.a,
    productId: fixtures.productA,
    name: "Override",
    basePriceMinor: 1250n,
    currency: "UAH",
  });
  await insertVariant({
    id: fixtures.variantABase,
    companyId: kitIdentities.companies.a,
    productId: fixtures.productA,
    name: "Base",
  });
  await insertVariant({
    id: fixtures.variantAOther,
    companyId: kitIdentities.companies.a,
    productId: fixtures.productAOther,
    name: "Other variant",
  });
  await insertVariant({
    id: fixtures.variantB,
    companyId: kitIdentities.companies.b,
    productId: fixtures.productB,
    name: "Bravo variant",
    basePriceMinor: 2100n,
    currency: "UAH",
  });

  await kit.db.runtime.db.insert(user).values({
    id: clerkUserId,
    name: "Clerk",
    email: "clerk@catalog-kit.test",
  });
  await kit.db.runtime.db.insert(companyMembers).values({
    companyId: kitIdentities.companies.a,
    userId: clerkUserId,
    role: "employee",
    permissions: { granted: [], denied: ["products:view"] },
  });
});

afterAll(async () => {
  await kit.db.close();
});

crossTenantSuite(
  () => kit,
  [
    isolationCase(
      getProductPricingFacts,
      { input: { items: [{ productId: fixtures.productA }] } },
      { input: { items: [{ productId: fixtures.productB }] } },
    ),
  ],
);

describe("catalog.getProductPricingFacts", () => {
  it("returns products with variants and nullable base-price overrides", async () => {
    const result = await kit.invoke(getProductPricingFacts, {
      items: [{ productId: fixtures.productA }],
    });

    expect(result).toEqual({
      products: [
        {
          productId: fixtures.productA,
          name: "Alpha",
          basePriceMinor: "1500",
          currency: "UAH",
          variants: [
            {
              variantId: fixtures.variantABase,
              name: "Base",
              basePriceMinor: null,
              currency: null,
            },
            {
              variantId: fixtures.variantAOverride,
              name: "Override",
              basePriceMinor: "1250",
              currency: "UAH",
            },
          ].sort((left, right) =>
            left.variantId < right.variantId
              ? -1
              : left.variantId > right.variantId
                ? 1
                : 0,
          ),
        },
      ],
    });
  });

  it("returns a product with no variants and accepts a zero base price", async () => {
    const result = await kit.invoke(getProductPricingFacts, {
      items: [{ productId: fixtures.productAZero }],
    });

    expect(result).toEqual({
      products: [
        {
          productId: fixtures.productAZero,
          name: "Zero",
          basePriceMinor: "0",
          currency: "UAH",
          variants: [],
        },
      ],
    });
  });

  it("returns unique products in first-seen input order", async () => {
    const result = await kit.invoke(getProductPricingFacts, {
      items: [
        { productId: fixtures.productAZero },
        { productId: fixtures.productA, variantId: fixtures.variantAOverride },
        { productId: fixtures.productAZero },
      ],
    });

    expect(result.products.map((product) => product.productId)).toEqual([
      fixtures.productAZero,
      fixtures.productA,
    ]);
  });

  it("denies staff without products:view", async () => {
    await expect(
      kit.invoke(
        getProductPricingFacts,
        { items: [{ productId: fixtures.productA }] },
        { userId: clerkUserId, companyId: kitIdentities.companies.a },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("rejects an empty batch, oversized batch, and malformed ids", async () => {
    await expect(
      kit.invoke(getProductPricingFacts, { items: [] }),
    ).rejects.toBeInstanceOf(ValidationError);

    const oversized = Array.from(
      { length: PRODUCT_PRICING_FACTS_MAX_ITEMS + 1 },
      () => ({ productId: randomUUID() }),
    );
    await expect(
      kit.invoke(getProductPricingFacts, { items: oversized }),
    ).rejects.toBeInstanceOf(ValidationError);

    await expect(
      kit.invoke(getProductPricingFacts, {
        items: [{ productId: "not-a-uuid" }],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("fails the whole batch for a missing or foreign product with the same not-found", async () => {
    const missingId = randomUUID();
    const missingError = await kit
      .invoke(getProductPricingFacts, {
        items: [{ productId: missingId }],
      })
      .then(
        () => {
          throw new Error("expected NotFoundError for a missing product");
        },
        (error: unknown) => error,
      );
    const foreignError = await kit
      .invoke(getProductPricingFacts, {
        items: [{ productId: fixtures.productB }],
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
      kit.invoke(getProductPricingFacts, {
        items: [{ productId: fixtures.productA }, { productId: missingId }],
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    const stillOwn = await kit.invoke(getProductPricingFacts, {
      items: [{ productId: fixtures.productA }],
    });
    expect(stillOwn.products).toHaveLength(1);
  });

  it("fails the whole batch when a variantId is foreign or not on the product", async () => {
    await expect(
      kit.invoke(getProductPricingFacts, {
        items: [{ productId: fixtures.productA, variantId: fixtures.variantB }],
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    await expect(
      kit.invoke(getProductPricingFacts, {
        items: [
          {
            productId: fixtures.productA,
            variantId: fixtures.variantAOther,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    await expect(
      kit.invoke(getProductPricingFacts, {
        items: [
          { productId: fixtures.productA },
          { productId: fixtures.productAZero, variantId: randomUUID() },
        ],
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
