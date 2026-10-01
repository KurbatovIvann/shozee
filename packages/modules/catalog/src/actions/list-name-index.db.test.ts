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
import { products, productVariants } from "@showzy/db/schema/catalog";
import { companyMembers } from "@showzy/db/schema/companies";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readCatalogNameIndex } from "../services/name-index.js";
import { listNameIndex } from "./list-name-index.js";

const fixtures = {
  activeProduct: randomUUID(),
  secondActiveProduct: randomUUID(),
  archivedProduct: randomUUID(),
  foreignProduct: randomUUID(),
  activeVariant: randomUUID(),
  secondActiveVariant: randomUUID(),
  archivedVariant: randomUUID(),
  variantOfArchivedProduct: randomUUID(),
  foreignVariant: randomUUID(),
};

const clerkUserId = randomUUID();

let kit: TestKit;

beforeAll(async () => {
  kit = await createTestKit();

  await kit.db.runtime.db.insert(products).values([
    {
      id: fixtures.activeProduct,
      companyId: kitIdentities.companies.a,
      name: "Index Кава",
      basePriceMinor: 1000n,
    },
    {
      id: fixtures.secondActiveProduct,
      companyId: kitIdentities.companies.a,
      name: "Index Чай",
      basePriceMinor: 1050n,
    },
    {
      id: fixtures.archivedProduct,
      companyId: kitIdentities.companies.a,
      name: "Index Старий Чай",
      basePriceMinor: 1100n,
      status: "archived",
    },
    {
      id: fixtures.foreignProduct,
      companyId: kitIdentities.companies.b,
      name: "Index Чужа Кава",
      basePriceMinor: 1200n,
    },
  ]);

  await kit.db.runtime.db.insert(productVariants).values([
    {
      id: fixtures.activeVariant,
      companyId: kitIdentities.companies.a,
      productId: fixtures.activeProduct,
      name: "Index Кава / 1 кг",
    },
    {
      id: fixtures.secondActiveVariant,
      companyId: kitIdentities.companies.a,
      productId: fixtures.secondActiveProduct,
      name: "Index Чай / 500 г",
    },
    {
      id: fixtures.archivedVariant,
      companyId: kitIdentities.companies.a,
      productId: fixtures.activeProduct,
      name: "Index Кава / знята",
      status: "archived",
    },
    {
      id: fixtures.variantOfArchivedProduct,
      companyId: kitIdentities.companies.a,
      productId: fixtures.archivedProduct,
      name: "Index Старий Чай / 1 кг",
    },
    {
      id: fixtures.foreignVariant,
      companyId: kitIdentities.companies.b,
      productId: fixtures.foreignProduct,
      name: "Index Чужа Кава / 1 кг",
    },
  ]);

  await kit.db.runtime.db.insert(user).values({
    id: clerkUserId,
    name: "Clerk",
    email: "clerk@catalog-list-name-index.test",
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

describe("catalog.listNameIndex", () => {
  it("returns active products and variants as ids and names", async () => {
    const listed = await kit.invoke(listNameIndex, {});

    expect(listed.products.items.map((entry) => entry.id)).toContain(
      fixtures.activeProduct,
    );
    expect(listed.products.truncated).toBe(false);

    const variant = listed.variants.items.find(
      (entry) => entry.id === fixtures.activeVariant,
    );
    expect(variant?.productId).toBe(fixtures.activeProduct);
    expect(variant?.name).toBe("Index Кава / 1 кг");
    expect(listed.variants.truncated).toBe(false);
  });

  it("excludes archived products and variants", async () => {
    const listed = await kit.invoke(listNameIndex, {});
    expect(listed.products.items.map((entry) => entry.id)).not.toContain(
      fixtures.archivedProduct,
    );
    expect(listed.variants.items.map((entry) => entry.id)).not.toContain(
      fixtures.archivedVariant,
    );
  });

  it("excludes an active variant whose parent product is archived", async () => {
    const listed = await kit.invoke(listNameIndex, {});
    expect(listed.variants.items.map((entry) => entry.id)).not.toContain(
      fixtures.variantOfArchivedProduct,
    );
    const listedProductIds = new Set(
      listed.products.items.map((entry) => entry.id),
    );
    for (const variant of listed.variants.items) {
      expect(listedProductIds.has(variant.productId)).toBe(true);
    }
  });

  it("cuts each list at its cap and sets truncated", async () => {
    const capped = await readCatalogNameIndex({
      db: kit.db.runtime.db,
      companyId: kitIdentities.companies.a,
      caps: { products: 1, variants: 1 },
    });

    expect(capped.products.items).toHaveLength(1);
    expect(capped.products.truncated).toBe(true);
    expect(capped.variants.items).toHaveLength(1);
    expect(capped.variants.truncated).toBe(true);
  });

  it("returns ids and names only", async () => {
    const listed = await kit.invoke(listNameIndex, {});
    for (const entry of listed.products.items) {
      expect(Object.keys(entry).sort()).toEqual(["id", "name"]);
    }
    for (const entry of listed.variants.items) {
      expect(Object.keys(entry).sort()).toEqual(["id", "name", "productId"]);
    }
  });

  it("does not leak another tenant's catalog", async () => {
    const listed = await kit.invoke(listNameIndex, {});
    expect(listed.products.items.map((entry) => entry.id)).not.toContain(
      fixtures.foreignProduct,
    );
    expect(listed.variants.items.map((entry) => entry.id)).not.toContain(
      fixtures.foreignVariant,
    );

    const otherTenant = await kit.invoke(
      listNameIndex,
      {},
      {
        companyId: kitIdentities.companies.b,
        userId: kitIdentities.users.boris,
      },
    );
    expect(otherTenant.products.items.map((entry) => entry.id)).toContain(
      fixtures.foreignProduct,
    );
    expect(otherTenant.products.items.map((entry) => entry.id)).not.toContain(
      fixtures.activeProduct,
    );
  });

  it("denies staff without products:view", async () => {
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
