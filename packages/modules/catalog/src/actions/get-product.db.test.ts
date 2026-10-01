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
import {
  productMedia,
  products,
  productVariants,
} from "@showzy/db/schema/catalog";
import { companyMembers } from "@showzy/db/schema/companies";
import { files } from "@showzy/db/schema/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getProduct } from "./get-product.js";

const fixtures = {
  productA: randomUUID(),
  productAEmpty: randomUUID(),
  productB: randomUUID(),
  variantLive: randomUUID(),
  variantArchived: randomUUID(),
  fileSecond: randomUUID(),
  fileFirst: randomUUID(),
  mediaSecond: randomUUID(),
  mediaFirst: randomUUID(),
};

const clerkUserId = randomUUID();

let kit: TestKit;

async function insertProduct(values: {
  id: string;
  companyId: string;
  name: string;
  basePriceMinor: bigint;
  status?: "active" | "archived";
}): Promise<void> {
  await kit.db.runtime.db.insert(products).values({
    id: values.id,
    companyId: values.companyId,
    name: values.name,
    basePriceMinor: values.basePriceMinor,
    status: values.status,
  });
}

async function insertVariant(values: {
  id: string;
  companyId: string;
  productId: string;
  name: string;
  status?: "active" | "archived";
  basePriceMinor?: bigint;
  currency?: string;
  createdAt: Date;
}): Promise<void> {
  await kit.db.runtime.db.insert(productVariants).values({
    id: values.id,
    companyId: values.companyId,
    productId: values.productId,
    name: values.name,
    status: values.status,
    basePriceMinor: values.basePriceMinor,
    currency: values.currency,
    createdAt: values.createdAt,
    updatedAt: values.createdAt,
  });
}

async function insertFile(values: {
  id: string;
  companyId: string;
}): Promise<void> {
  await kit.db.runtime.db.insert(files).values({
    id: values.id,
    companyId: values.companyId,
    uploadedByUserId: kitIdentities.users.anna,
    purpose: "catalog",
    objectKey: `${values.companyId}/catalog/${values.id}`,
    mimeType: "image/jpeg",
    byteSize: 128n,
    checksumSha256: "22".repeat(32),
    status: "ready",
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
    id: fixtures.productAEmpty,
    companyId: kitIdentities.companies.a,
    name: "Bare",
    basePriceMinor: 0n,
    status: "archived",
  });
  await insertProduct({
    id: fixtures.productB,
    companyId: kitIdentities.companies.b,
    name: "Bravo",
    basePriceMinor: 2200n,
  });

  await insertVariant({
    id: fixtures.variantArchived,
    companyId: kitIdentities.companies.a,
    productId: fixtures.productA,
    name: "Archived",
    status: "archived",
    createdAt: new Date("2026-01-02T00:00:00.000Z"),
  });
  await insertVariant({
    id: fixtures.variantLive,
    companyId: kitIdentities.companies.a,
    productId: fixtures.productA,
    name: "Override",
    basePriceMinor: 1800n,
    currency: "UAH",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  });

  await insertFile({
    id: fixtures.fileSecond,
    companyId: kitIdentities.companies.a,
  });
  await insertFile({
    id: fixtures.fileFirst,
    companyId: kitIdentities.companies.a,
  });
  await kit.db.runtime.db.insert(productMedia).values([
    {
      id: fixtures.mediaSecond,
      companyId: kitIdentities.companies.a,
      productId: fixtures.productA,
      fileId: fixtures.fileSecond,
      position: 2,
    },
    {
      id: fixtures.mediaFirst,
      companyId: kitIdentities.companies.a,
      productId: fixtures.productA,
      fileId: fixtures.fileFirst,
      position: 0,
    },
  ]);

  await kit.db.runtime.db.insert(user).values({
    id: clerkUserId,
    name: "Clerk",
    email: "clerk@catalog-get-kit.test",
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
      getProduct,
      { input: { productId: fixtures.productA } },
      { input: { productId: fixtures.productB } },
    ),
  ],
);

describe("catalog.getProduct", () => {
  it("returns the product with archived variants and images in position order", async () => {
    const result = await kit.invoke(getProduct, {
      productId: fixtures.productA,
    });

    expect(result.id).toBe(fixtures.productA);
    expect(result.name).toBe("Alpha");
    expect(result.basePriceMinor).toBe("1500");
    expect(result.currency).toBe("UAH");
    expect(result.status).toBe("active");
    expect(result.variants).toEqual([
      {
        id: fixtures.variantLive,
        name: "Override",
        status: "active",
        basePriceMinor: "1800",
        currency: "UAH",
      },
      {
        id: fixtures.variantArchived,
        name: "Archived",
        status: "archived",
        basePriceMinor: null,
        currency: null,
      },
    ]);
    expect(result.imageFileIds).toEqual([
      fixtures.fileFirst,
      fixtures.fileSecond,
    ]);
    expect(JSON.stringify(result)).not.toMatch(/https?:\/\//);
    expect(JSON.stringify(result)).not.toContain("/catalog/");
    expect(JSON.stringify(result)).not.toContain("objectKey");
  });

  it("returns an archived product with no variants or images", async () => {
    const result = await kit.invoke(getProduct, {
      productId: fixtures.productAEmpty,
    });
    expect(result).toMatchObject({
      id: fixtures.productAEmpty,
      name: "Bare",
      basePriceMinor: "0",
      status: "archived",
      variants: [],
      imageFileIds: [],
    });
  });

  it("denies staff without products:view", async () => {
    await expect(
      kit.invoke(
        getProduct,
        { productId: fixtures.productA },
        { userId: clerkUserId, companyId: kitIdentities.companies.a },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("rejects a malformed product id", async () => {
    await expect(
      kit.invoke(getProduct, { productId: "not-a-uuid" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("fails missing and foreign products with the same not-found", async () => {
    const missingId = randomUUID();
    const missingError = await kit
      .invoke(getProduct, { productId: missingId })
      .then(
        () => {
          throw new Error("expected NotFoundError for a missing product");
        },
        (error: unknown) => error,
      );
    const foreignError = await kit
      .invoke(getProduct, { productId: fixtures.productB })
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
  });
});
