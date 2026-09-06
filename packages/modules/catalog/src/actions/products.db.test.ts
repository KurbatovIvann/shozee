import { randomUUID } from "node:crypto";

import {
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
} from "@showzy/core/errors";
import {
  createTestKit,
  crossTenantSuite,
  idempotencySuite,
  isolationCase,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import { auditLog, domainEvents } from "@showzy/db";
import { user } from "@showzy/db/schema/auth";
import { products, productVariants } from "@showzy/db/schema/catalog";
import { companyMembers } from "@showzy/db/schema/companies";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PRODUCT_NAME_MAX } from "../wire.contract.js";
import { CREATE_PRODUCT_MAX_VARIANTS } from "./create-product.contract.js";
import { createProduct } from "./create-product.js";
import { updateProduct } from "./update-product.js";

const fixtures = {
  productUpdateA: randomUUID(),
  productUpdateB: randomUUID(),
  productIdem: randomUUID(),
  variantUpdateA: randomUUID(),
};

const clerks = {
  noWrite: randomUUID(),
};

const createIsolationInput = {
  name: "Isolation create A",
  basePriceMinor: "100",
};

const updateIsolationOwn = {
  productId: fixtures.productUpdateA,
  name: "Isolation updated A",
  basePriceMinor: "2500",
  currency: "UAH",
};

const updateIsolationForeign = {
  productId: fixtures.productUpdateB,
  name: "Isolation updated B",
  basePriceMinor: "2500",
  currency: "UAH",
};

let kit: TestKit;

async function countCompanyProducts(companyId: string): Promise<number> {
  const rows = await kit.db.runtime.db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.companyId, companyId));
  return rows.length;
}

async function countUpdateAudits(productId: string): Promise<number> {
  const rows = await kit.db.runtime.db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, "catalog.updateProduct"),
        eq(auditLog.targetId, productId),
        eq(auditLog.outcome, "ok"),
      ),
    );
  return rows.length;
}

async function productRow(productId: string) {
  const rows = await kit.db.runtime.db
    .select()
    .from(products)
    .where(eq(products.id, productId));
  return rows[0];
}

async function variantRowsFor(productId: string) {
  return kit.db.runtime.db
    .select()
    .from(productVariants)
    .where(eq(productVariants.productId, productId));
}

beforeAll(async () => {
  kit = await createTestKit();

  await kit.db.runtime.db.insert(products).values([
    {
      id: fixtures.productUpdateA,
      companyId: kitIdentities.companies.a,
      name: "Update Alpha",
      basePriceMinor: 1500n,
    },
    {
      id: fixtures.productUpdateB,
      companyId: kitIdentities.companies.b,
      name: "Update Bravo",
      basePriceMinor: 2200n,
    },
    {
      id: fixtures.productIdem,
      companyId: kitIdentities.companies.a,
      name: "Idem Target",
      basePriceMinor: 900n,
    },
  ]);
  await kit.db.runtime.db.insert(productVariants).values({
    id: fixtures.variantUpdateA,
    companyId: kitIdentities.companies.a,
    productId: fixtures.productUpdateA,
    name: "Keep me",
    basePriceMinor: 1250n,
    currency: "UAH",
  });

  await kit.db.runtime.db.insert(user).values({
    id: clerks.noWrite,
    name: "Clerk",
    email: "clerk@catalog-writes.test",
  });
  await kit.db.runtime.db.insert(companyMembers).values({
    companyId: kitIdentities.companies.a,
    userId: clerks.noWrite,
    role: "employee",
    permissions: { granted: [], denied: [] },
  });
});

afterAll(async () => {
  await kit.db.close();
});

crossTenantSuite(
  () => kit,
  [
    isolationCase(
      createProduct,
      { input: createIsolationInput },
      { input: createIsolationInput, companyId: kitIdentities.companies.b },
    ),
    isolationCase(
      updateProduct,
      { input: updateIsolationOwn },
      { input: updateIsolationForeign },
    ),
  ],
);

idempotencySuite(
  () => kit,
  [
    {
      action: createProduct,
      input: { name: "Idem Create", basePriceMinor: "1500" },
      conflictingInput: { name: "Idem Create Other", basePriceMinor: "1600" },
      readEffect: () => countCompanyProducts(kitIdentities.companies.a),
    },
    {
      action: updateProduct,
      input: {
        productId: fixtures.productIdem,
        name: "Idem Updated",
        basePriceMinor: "3000",
        currency: "UAH",
      },
      conflictingInput: {
        productId: fixtures.productIdem,
        name: "Idem Conflicting",
        basePriceMinor: "1",
        currency: "UAH",
      },
      readEffect: () => countUpdateAudits(fixtures.productIdem),
    },
  ],
);

describe("catalog.createProduct", () => {
  it("creates a product with optional variants in one transaction and audits once", async () => {
    const requestId = randomUUID();
    const result = await kit.invoke(
      createProduct,
      {
        name: "  Київський торт  ",
        basePriceMinor: "0",
        variants: [
          { name: "  Slice  " },
          { name: "Box", basePriceMinor: "19900", currency: "UAH" },
        ],
      },
      {},
      { request: { requestId } },
    );

    expect(result.name).toBe("Київський торт");
    expect(result.basePriceMinor).toBe("0");
    expect(result.currency).toBe("UAH");
    expect(result.variants).toHaveLength(2);
    const byName = new Map(
      result.variants.map((variant) => [variant.name, variant]),
    );
    expect(byName.get("Slice")).toMatchObject({
      name: "Slice",
      basePriceMinor: null,
      currency: null,
    });
    expect(byName.get("Box")).toMatchObject({
      name: "Box",
      basePriceMinor: "19900",
      currency: "UAH",
    });

    const row = await productRow(result.productId);
    expect(row).toMatchObject({
      id: result.productId,
      companyId: kitIdentities.companies.a,
      name: "Київський торт",
      basePriceMinor: 0n,
      currency: "UAH",
      status: "active",
    });
    const variants = await variantRowsFor(result.productId);
    expect(variants).toHaveLength(2);
    expect(variants.every((variant) => variant.status === "active")).toBe(true);
    expect(
      variants.every((variant) => variant.companyId === row?.companyId),
    ).toBe(true);

    const auditRows = await kit.db.runtime.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.requestId, requestId));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: "catalog.createProduct",
      companyId: kitIdentities.companies.a,
      actorType: "user",
      actorId: kitIdentities.users.anna,
      targetType: "product",
      targetId: result.productId,
      outcome: "ok",
      inputSnapshot: null,
    });

    const eventRows = await kit.db.runtime.db
      .select({ id: domainEvents.id })
      .from(domainEvents)
      .where(eq(domainEvents.requestId, requestId));
    expect(eventRows).toEqual([]);
  });

  it("denies staff without products:create", async () => {
    await expect(
      kit.invoke(
        createProduct,
        { name: "Denied", basePriceMinor: "1" },
        { userId: clerks.noWrite, companyId: kitIdentities.companies.a },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("rejects blank names, negative prices, unpaired variant currency, and companyId", async () => {
    const before = await countCompanyProducts(kitIdentities.companies.a);
    const invalidInputs: unknown[] = [
      { name: "   ", basePriceMinor: "100" },
      { name: "x".repeat(PRODUCT_NAME_MAX + 1), basePriceMinor: "100" },
      { name: "Cake", basePriceMinor: "-1" },
      { name: "Cake", basePriceMinor: "9223372036854775808" },
      { name: "Cake", basePriceMinor: "100", currency: "USD" },
      { name: "Cake", basePriceMinor: "100", currency: "uah" },
      {
        name: "Cake",
        basePriceMinor: "100",
        variants: [{ name: "Slice", currency: "UAH" }],
      },
      {
        name: "Cake",
        basePriceMinor: "100",
        variants: [{ name: "Slice", basePriceMinor: "50" }],
      },
      {
        name: "Cake",
        basePriceMinor: "100",
        companyId: kitIdentities.companies.a,
      },
      {
        name: "Cake",
        basePriceMinor: "100",
        variants: Array.from(
          { length: CREATE_PRODUCT_MAX_VARIANTS + 1 },
          (_, index) => ({ name: `V${String(index)}` }),
        ),
      },
    ];
    for (const input of invalidInputs) {
      await expect(kit.invoke(createProduct, input)).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
    expect(await countCompanyProducts(kitIdentities.companies.a)).toBe(before);
  });
});

describe("catalog.createProduct provenance (SHO-465)", () => {
  it("stores ctx.channel on the product and nested variants", async () => {
    const viaUi = await kit.invoke(
      createProduct,
      {
        name: "Provenance UI product",
        basePriceMinor: "100",
        variants: [{ name: "UI nested" }],
      },
      {},
      { request: { channel: "ui" } },
    );
    const viaAi = await kit.invoke(
      createProduct,
      {
        name: "Provenance AI product",
        basePriceMinor: "100",
        variants: [{ name: "AI nested" }],
      },
      {},
      { request: { channel: "ai", aiTraceId: "sho-465-product" } },
    );
    expect(await productRow(viaUi.productId)).toMatchObject({
      createdVia: "ui",
      vouchedBy: null,
      vouchedAt: null,
    });
    expect(await productRow(viaAi.productId)).toMatchObject({
      createdVia: "ai",
      vouchedBy: null,
      vouchedAt: null,
    });
    const uiVariants = await variantRowsFor(viaUi.productId);
    const aiVariants = await variantRowsFor(viaAi.productId);
    expect(uiVariants).toHaveLength(1);
    expect(aiVariants).toHaveLength(1);
    expect(uiVariants[0]).toMatchObject({
      createdVia: "ui",
      vouchedBy: null,
      vouchedAt: null,
    });
    expect(aiVariants[0]).toMatchObject({
      createdVia: "ai",
      vouchedBy: null,
      vouchedAt: null,
    });
  });
});

describe("catalog.updateProduct", () => {
  it("updates name and base price, leaves variants in place, and audits once", async () => {
    const created = await kit.invoke(createProduct, {
      name: "Before",
      basePriceMinor: "1000",
      currency: "UAH",
      variants: [{ name: "Stay", basePriceMinor: "800", currency: "UAH" }],
    });
    const requestId = randomUUID();
    const result = await kit.invoke(
      updateProduct,
      {
        productId: created.productId,
        name: "  After  ",
        basePriceMinor: "1800",
        currency: "UAH",
      },
      {},
      { request: { requestId } },
    );

    expect(result).toMatchObject({
      productId: created.productId,
      name: "After",
      basePriceMinor: "1800",
      currency: "UAH",
    });
    expect(result.variants).toEqual(created.variants);

    const row = await productRow(created.productId);
    expect(row).toMatchObject({
      name: "After",
      basePriceMinor: 1800n,
      currency: "UAH",
    });
    const variants = await variantRowsFor(created.productId);
    expect(variants).toHaveLength(1);
    expect(variants[0]?.name).toBe("Stay");

    const auditRows = await kit.db.runtime.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.requestId, requestId));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: "catalog.updateProduct",
      companyId: kitIdentities.companies.a,
      targetType: "product",
      targetId: created.productId,
      outcome: "ok",
      inputSnapshot: null,
    });
  });

  it("denies staff without products:edit", async () => {
    await expect(
      kit.invoke(
        updateProduct,
        {
          productId: fixtures.productUpdateA,
          name: "Nope",
          basePriceMinor: "1",
          currency: "UAH",
        },
        { userId: clerks.noWrite, companyId: kitIdentities.companies.a },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("returns the same not-found for missing and foreign products", async () => {
    const missingId = randomUUID();
    const missingError = await kit
      .invoke(updateProduct, {
        productId: missingId,
        name: "Ghost",
        basePriceMinor: "1",
        currency: "UAH",
      })
      .catch((error: unknown) => error);
    const foreignError = await kit
      .invoke(updateProduct, {
        productId: fixtures.productUpdateB,
        name: "Ghost",
        basePriceMinor: "1",
        currency: "UAH",
      })
      .catch((error: unknown) => error);

    expect(missingError).toBeInstanceOf(NotFoundError);
    expect(foreignError).toBeInstanceOf(NotFoundError);
    if (
      missingError instanceof NotFoundError &&
      foreignError instanceof NotFoundError
    ) {
      expect(missingError.clientMessage).toBe(foreignError.clientMessage);
    }

    const foreignRow = await productRow(fixtures.productUpdateB);
    expect(foreignRow?.name).toBe("Update Bravo");
    expect(foreignRow?.companyId).toBe(kitIdentities.companies.b);
  });

  it("rejects blank names, negative prices, and companyId", async () => {
    const invalidInputs: unknown[] = [
      {
        productId: fixtures.productUpdateA,
        name: "   ",
        basePriceMinor: "100",
        currency: "UAH",
      },
      {
        productId: fixtures.productUpdateA,
        name: "Cake",
        basePriceMinor: "-1",
        currency: "UAH",
      },
      {
        productId: fixtures.productUpdateA,
        name: "Cake",
        basePriceMinor: "9223372036854775808",
        currency: "UAH",
      },
      {
        productId: fixtures.productUpdateA,
        name: "Cake",
        basePriceMinor: "100",
        currency: "USD",
      },
      {
        productId: "not-a-uuid",
        name: "Cake",
        basePriceMinor: "100",
        currency: "UAH",
      },
      {
        productId: fixtures.productUpdateA,
        name: "Cake",
        basePriceMinor: "100",
        currency: "UAH",
        companyId: kitIdentities.companies.a,
      },
    ];
    for (const input of invalidInputs) {
      await expect(kit.invoke(updateProduct, input)).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
  });
});
