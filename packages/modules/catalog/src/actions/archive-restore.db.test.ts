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
  type SuiteAction,
  type TestKit,
} from "@showzy/core/testing";
import { auditLog, domainEvents } from "@showzy/db";
import { user } from "@showzy/db/schema/auth";
import { products, productVariants } from "@showzy/db/schema/catalog";
import { companyMembers } from "@showzy/db/schema/companies";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { archiveProduct } from "./archive-product.js";
import { archiveVariant } from "./archive-variant.js";
import { getProductOrderFacts } from "./get-product-order-facts.js";
import { getProductPricingFacts } from "./get-product-pricing-facts.js";
import { restoreProduct } from "./restore-product.js";
import { restoreVariant } from "./restore-variant.js";

const fixtures = {
  productHappy: randomUUID(),
  productRestore: randomUUID(),
  productColumns: randomUUID(),
  productIsolationArchiveA: randomUUID(),
  productIsolationArchiveB: randomUUID(),
  productIsolationRestoreA: randomUUID(),
  productIsolationRestoreB: randomUUID(),
  productIdempotencyArchive: randomUUID(),
  productIdempotencyArchiveFresh: randomUUID(),
  productIdempotencyRestore: randomUUID(),
  productIdempotencyRestoreFresh: randomUUID(),
  productFacts: randomUUID(),
  productWorkbenchA: randomUUID(),
  productWorkbenchB: randomUUID(),
  variantHappy: randomUUID(),
  variantRestore: randomUUID(),
  variantColumns: randomUUID(),
  variantIsolationArchiveA: randomUUID(),
  variantIsolationArchiveB: randomUUID(),
  variantIsolationRestoreA: randomUUID(),
  variantIsolationRestoreB: randomUUID(),
  variantIdempotencyArchive: randomUUID(),
  variantIdempotencyArchiveFresh: randomUUID(),
  variantIdempotencyRestore: randomUUID(),
  variantIdempotencyRestoreFresh: randomUUID(),
  variantFacts: randomUUID(),
  variantUnchangedOnProductArchive: randomUUID(),
  variantStayArchivedOnProductRestore: randomUUID(),
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
    ...(values.status === undefined ? {} : { status: values.status }),
  });
}

async function insertVariant(values: {
  id: string;
  companyId: string;
  productId: string;
  name: string;
  status?: "active" | "archived";
}): Promise<void> {
  await kit.db.runtime.db.insert(productVariants).values({
    id: values.id,
    companyId: values.companyId,
    productId: values.productId,
    name: values.name,
    ...(values.status === undefined ? {} : { status: values.status }),
  });
}

async function productRow(id: string) {
  const rows = await kit.db.runtime.db
    .select()
    .from(products)
    .where(eq(products.id, id));
  return rows[0];
}

async function variantRow(id: string) {
  const rows = await kit.db.runtime.db
    .select()
    .from(productVariants)
    .where(eq(productVariants.id, id));
  return rows[0];
}

async function countProductIdsWithStatus(
  ids: readonly string[],
  status: "active" | "archived",
): Promise<number> {
  const rows = await kit.db.runtime.db
    .select({ id: products.id })
    .from(products)
    .where(and(inArray(products.id, [...ids]), eq(products.status, status)));
  return rows.length;
}

async function countVariantIdsWithStatus(
  ids: readonly string[],
  status: "active" | "archived",
): Promise<number> {
  const rows = await kit.db.runtime.db
    .select({ id: productVariants.id })
    .from(productVariants)
    .where(
      and(
        inArray(productVariants.id, [...ids]),
        eq(productVariants.status, status),
      ),
    );
  return rows.length;
}

beforeAll(async () => {
  kit = await createTestKit();

  await insertProduct({
    id: fixtures.productHappy,
    companyId: kitIdentities.companies.a,
    name: "Happy archive",
    basePriceMinor: 1100n,
  });
  await insertProduct({
    id: fixtures.productRestore,
    companyId: kitIdentities.companies.a,
    name: "Happy restore",
    basePriceMinor: 1200n,
    status: "archived",
  });
  await insertProduct({
    id: fixtures.productColumns,
    companyId: kitIdentities.companies.a,
    name: "Columns stay",
    basePriceMinor: 1300n,
  });
  await insertProduct({
    id: fixtures.productIsolationArchiveA,
    companyId: kitIdentities.companies.a,
    name: "Isolation archive A",
    basePriceMinor: 1400n,
  });
  await insertProduct({
    id: fixtures.productIsolationArchiveB,
    companyId: kitIdentities.companies.b,
    name: "Isolation archive B",
    basePriceMinor: 1500n,
  });
  await insertProduct({
    id: fixtures.productIsolationRestoreA,
    companyId: kitIdentities.companies.a,
    name: "Isolation restore A",
    basePriceMinor: 1600n,
    status: "archived",
  });
  await insertProduct({
    id: fixtures.productIsolationRestoreB,
    companyId: kitIdentities.companies.b,
    name: "Isolation restore B",
    basePriceMinor: 1700n,
    status: "archived",
  });
  await insertProduct({
    id: fixtures.productIdempotencyArchive,
    companyId: kitIdentities.companies.a,
    name: "Idempotency archive",
    basePriceMinor: 1800n,
  });
  await insertProduct({
    id: fixtures.productIdempotencyArchiveFresh,
    companyId: kitIdentities.companies.a,
    name: "Idempotency archive fresh",
    basePriceMinor: 1900n,
  });
  await insertProduct({
    id: fixtures.productIdempotencyRestore,
    companyId: kitIdentities.companies.a,
    name: "Idempotency restore",
    basePriceMinor: 2000n,
    status: "archived",
  });
  await insertProduct({
    id: fixtures.productIdempotencyRestoreFresh,
    companyId: kitIdentities.companies.a,
    name: "Idempotency restore fresh",
    basePriceMinor: 2100n,
    status: "archived",
  });
  await insertProduct({
    id: fixtures.productFacts,
    companyId: kitIdentities.companies.a,
    name: "Facts stay visible",
    basePriceMinor: 2200n,
  });
  await insertProduct({
    id: fixtures.productWorkbenchA,
    companyId: kitIdentities.companies.a,
    name: "Variant workbench A",
    basePriceMinor: 2300n,
  });
  await insertProduct({
    id: fixtures.productWorkbenchB,
    companyId: kitIdentities.companies.b,
    name: "Variant workbench B",
    basePriceMinor: 2400n,
  });

  await insertVariant({
    id: fixtures.variantUnchangedOnProductArchive,
    companyId: kitIdentities.companies.a,
    productId: fixtures.productHappy,
    name: "Stays active when product archives",
  });
  await insertVariant({
    id: fixtures.variantStayArchivedOnProductRestore,
    companyId: kitIdentities.companies.a,
    productId: fixtures.productRestore,
    name: "Stays archived when product restores",
    status: "archived",
  });
  await insertVariant({
    id: fixtures.variantHappy,
    companyId: kitIdentities.companies.a,
    productId: fixtures.productWorkbenchA,
    name: "Happy archive variant",
  });
  await insertVariant({
    id: fixtures.variantRestore,
    companyId: kitIdentities.companies.a,
    productId: fixtures.productWorkbenchA,
    name: "Happy restore variant",
    status: "archived",
  });
  await insertVariant({
    id: fixtures.variantColumns,
    companyId: kitIdentities.companies.a,
    productId: fixtures.productWorkbenchA,
    name: "Variant columns stay",
  });
  await insertVariant({
    id: fixtures.variantIsolationArchiveA,
    companyId: kitIdentities.companies.a,
    productId: fixtures.productWorkbenchA,
    name: "Isolation archive variant A",
  });
  await insertVariant({
    id: fixtures.variantIsolationArchiveB,
    companyId: kitIdentities.companies.b,
    productId: fixtures.productWorkbenchB,
    name: "Isolation archive variant B",
  });
  await insertVariant({
    id: fixtures.variantIsolationRestoreA,
    companyId: kitIdentities.companies.a,
    productId: fixtures.productWorkbenchA,
    name: "Isolation restore variant A",
    status: "archived",
  });
  await insertVariant({
    id: fixtures.variantIsolationRestoreB,
    companyId: kitIdentities.companies.b,
    productId: fixtures.productWorkbenchB,
    name: "Isolation restore variant B",
    status: "archived",
  });
  await insertVariant({
    id: fixtures.variantIdempotencyArchive,
    companyId: kitIdentities.companies.a,
    productId: fixtures.productWorkbenchA,
    name: "Idempotency archive variant",
  });
  await insertVariant({
    id: fixtures.variantIdempotencyArchiveFresh,
    companyId: kitIdentities.companies.a,
    productId: fixtures.productWorkbenchA,
    name: "Idempotency archive variant fresh",
  });
  await insertVariant({
    id: fixtures.variantIdempotencyRestore,
    companyId: kitIdentities.companies.a,
    productId: fixtures.productWorkbenchA,
    name: "Idempotency restore variant",
    status: "archived",
  });
  await insertVariant({
    id: fixtures.variantIdempotencyRestoreFresh,
    companyId: kitIdentities.companies.a,
    productId: fixtures.productWorkbenchA,
    name: "Idempotency restore variant fresh",
    status: "archived",
  });
  await insertVariant({
    id: fixtures.variantFacts,
    companyId: kitIdentities.companies.a,
    productId: fixtures.productFacts,
    name: "Facts variant",
  });

  await kit.db.runtime.db.insert(user).values({
    id: clerkUserId,
    name: "Clerk",
    email: "clerk@catalog-archive-kit.test",
  });
  await kit.db.runtime.db.insert(companyMembers).values({
    companyId: kitIdentities.companies.a,
    userId: clerkUserId,
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
      archiveProduct,
      { input: { productId: fixtures.productIsolationArchiveA } },
      { input: { productId: fixtures.productIsolationArchiveB } },
      { missing: { input: { productId: randomUUID() } } },
    ),
    isolationCase(
      restoreProduct,
      { input: { productId: fixtures.productIsolationRestoreA } },
      { input: { productId: fixtures.productIsolationRestoreB } },
      { missing: { input: { productId: randomUUID() } } },
    ),
    isolationCase(
      archiveVariant,
      { input: { variantId: fixtures.variantIsolationArchiveA } },
      { input: { variantId: fixtures.variantIsolationArchiveB } },
      { missing: { input: { variantId: randomUUID() } } },
    ),
    isolationCase(
      restoreVariant,
      { input: { variantId: fixtures.variantIsolationRestoreA } },
      { input: { variantId: fixtures.variantIsolationRestoreB } },
      { missing: { input: { variantId: randomUUID() } } },
    ),
  ],
);

idempotencySuite(
  () => kit,
  [
    {
      action: archiveProduct,
      input: { productId: fixtures.productIdempotencyArchive },
      conflictingInput: {
        productId: fixtures.productIdempotencyArchiveFresh,
      },
      freshInput: () => ({
        productId: fixtures.productIdempotencyArchiveFresh,
      }),
      readEffect: () =>
        countProductIdsWithStatus(
          [
            fixtures.productIdempotencyArchive,
            fixtures.productIdempotencyArchiveFresh,
          ],
          "archived",
        ),
    },
    {
      action: restoreProduct,
      input: { productId: fixtures.productIdempotencyRestore },
      conflictingInput: {
        productId: fixtures.productIdempotencyRestoreFresh,
      },
      freshInput: () => ({
        productId: fixtures.productIdempotencyRestoreFresh,
      }),
      readEffect: () =>
        countProductIdsWithStatus(
          [
            fixtures.productIdempotencyRestore,
            fixtures.productIdempotencyRestoreFresh,
          ],
          "active",
        ),
    },
    {
      action: archiveVariant,
      input: { variantId: fixtures.variantIdempotencyArchive },
      conflictingInput: {
        variantId: fixtures.variantIdempotencyArchiveFresh,
      },
      freshInput: () => ({
        variantId: fixtures.variantIdempotencyArchiveFresh,
      }),
      readEffect: () =>
        countVariantIdsWithStatus(
          [
            fixtures.variantIdempotencyArchive,
            fixtures.variantIdempotencyArchiveFresh,
          ],
          "archived",
        ),
    },
    {
      action: restoreVariant,
      input: { variantId: fixtures.variantIdempotencyRestore },
      conflictingInput: {
        variantId: fixtures.variantIdempotencyRestoreFresh,
      },
      freshInput: () => ({
        variantId: fixtures.variantIdempotencyRestoreFresh,
      }),
      readEffect: () =>
        countVariantIdsWithStatus(
          [
            fixtures.variantIdempotencyRestore,
            fixtures.variantIdempotencyRestoreFresh,
          ],
          "active",
        ),
    },
  ],
);

describe("catalog archive/restore", () => {
  it("archives and restores a product without cascading to variants", async () => {
    const requestId = randomUUID();
    const archived = await kit.invoke(
      archiveProduct,
      { productId: fixtures.productHappy },
      {},
      { request: { requestId } },
    );
    expect(archived).toEqual({
      productId: fixtures.productHappy,
      status: "archived",
    });
    expect((await productRow(fixtures.productHappy))?.status).toBe("archived");
    expect(
      (await variantRow(fixtures.variantUnchangedOnProductArchive))?.status,
    ).toBe("active");

    const auditRows = await kit.db.runtime.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.requestId, requestId));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: "catalog.archiveProduct",
      companyId: kitIdentities.companies.a,
      actorType: "user",
      targetType: "product",
      targetId: fixtures.productHappy,
      outcome: "ok",
      inputSnapshot: null,
    });

    const eventRows = await kit.db.runtime.db
      .select({ id: domainEvents.id })
      .from(domainEvents)
      .where(eq(domainEvents.requestId, requestId));
    expect(eventRows).toEqual([]);

    const restored = await kit.invoke(restoreProduct, {
      productId: fixtures.productHappy,
    });
    expect(restored).toEqual({
      productId: fixtures.productHappy,
      status: "active",
    });
    expect((await productRow(fixtures.productHappy))?.status).toBe("active");
  });

  it("restores an archived product and archives/restores a variant", async () => {
    const requestId = randomUUID();
    const restored = await kit.invoke(
      restoreProduct,
      { productId: fixtures.productRestore },
      {},
      { request: { requestId } },
    );
    expect(restored).toEqual({
      productId: fixtures.productRestore,
      status: "active",
    });
    expect(
      (await variantRow(fixtures.variantStayArchivedOnProductRestore))?.status,
    ).toBe("archived");

    const restoreAudit = await kit.db.runtime.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.requestId, requestId));
    expect(restoreAudit).toHaveLength(1);
    expect(restoreAudit[0]).toMatchObject({
      action: "catalog.restoreProduct",
      targetType: "product",
      targetId: fixtures.productRestore,
      outcome: "ok",
    });
    const restoreEvents = await kit.db.runtime.db
      .select({ id: domainEvents.id })
      .from(domainEvents)
      .where(eq(domainEvents.requestId, requestId));
    expect(restoreEvents).toEqual([]);

    const archivedVariant = await kit.invoke(archiveVariant, {
      variantId: fixtures.variantHappy,
    });
    expect(archivedVariant).toEqual({
      variantId: fixtures.variantHappy,
      status: "archived",
    });
    expect((await productRow(fixtures.productWorkbenchA))?.status).toBe(
      "active",
    );

    const restoredVariant = await kit.invoke(restoreVariant, {
      variantId: fixtures.variantRestore,
    });
    expect(restoredVariant).toEqual({
      variantId: fixtures.variantRestore,
      status: "active",
    });
  });

  it("treats a repeat archive or restore as an idempotent no-op", async () => {
    const first = await kit.invoke(archiveProduct, {
      productId: fixtures.productColumns,
    });
    const beforeRepeat = await productRow(fixtures.productColumns);
    expect(first.status).toBe("archived");
    expect(beforeRepeat?.name).toBe("Columns stay");
    expect(beforeRepeat?.basePriceMinor).toBe(1300n);
    expect(beforeRepeat?.currency).toBe("UAH");

    const second = await kit.invoke(archiveProduct, {
      productId: fixtures.productColumns,
    });
    const afterRepeat = await productRow(fixtures.productColumns);
    expect(second).toEqual(first);
    expect(afterRepeat?.name).toBe(beforeRepeat?.name);
    expect(afterRepeat?.basePriceMinor).toBe(beforeRepeat?.basePriceMinor);
    expect(afterRepeat?.currency).toBe(beforeRepeat?.currency);
    expect(afterRepeat?.updatedAt.getTime()).toBe(
      beforeRepeat?.updatedAt.getTime(),
    );

    const firstVariant = await kit.invoke(archiveVariant, {
      variantId: fixtures.variantColumns,
    });
    const variantBefore = await variantRow(fixtures.variantColumns);
    const secondVariant = await kit.invoke(archiveVariant, {
      variantId: fixtures.variantColumns,
    });
    const variantAfter = await variantRow(fixtures.variantColumns);
    expect(secondVariant).toEqual(firstVariant);
    expect(variantAfter?.name).toBe(variantBefore?.name);
    expect(variantAfter?.updatedAt.getTime()).toBe(
      variantBefore?.updatedAt.getTime(),
    );

    const restoredOnce = await kit.invoke(restoreProduct, {
      productId: fixtures.productColumns,
    });
    const restoredBeforeRepeat = await productRow(fixtures.productColumns);
    const restoreAgain = await kit.invoke(restoreProduct, {
      productId: fixtures.productColumns,
    });
    const restoredAfterRepeat = await productRow(fixtures.productColumns);
    expect(restoreAgain).toEqual(restoredOnce);
    expect(restoredAfterRepeat?.name).toBe(restoredBeforeRepeat?.name);
    expect(restoredAfterRepeat?.basePriceMinor).toBe(
      restoredBeforeRepeat?.basePriceMinor,
    );
    expect(restoredAfterRepeat?.updatedAt.getTime()).toBe(
      restoredBeforeRepeat?.updatedAt.getTime(),
    );

    const restoredVariantOnce = await kit.invoke(restoreVariant, {
      variantId: fixtures.variantColumns,
    });
    const restoredVariantBefore = await variantRow(fixtures.variantColumns);
    const restoredVariantAgain = await kit.invoke(restoreVariant, {
      variantId: fixtures.variantColumns,
    });
    const restoredVariantAfter = await variantRow(fixtures.variantColumns);
    expect(restoredVariantAgain).toEqual(restoredVariantOnce);
    expect(restoredVariantAfter?.name).toBe(restoredVariantBefore?.name);
    expect(restoredVariantAfter?.updatedAt.getTime()).toBe(
      restoredVariantBefore?.updatedAt.getTime(),
    );
  });

  it("keeps archived rows visible to pricing and order facts", async () => {
    await kit.invoke(archiveProduct, { productId: fixtures.productFacts });
    await kit.invoke(archiveVariant, { variantId: fixtures.variantFacts });

    const pricing = await kit.invoke(getProductPricingFacts, {
      items: [
        { productId: fixtures.productFacts, variantId: fixtures.variantFacts },
      ],
    });
    expect(pricing.products).toEqual([
      {
        productId: fixtures.productFacts,
        name: "Facts stay visible",
        basePriceMinor: "2200",
        currency: "UAH",
        variants: [
          {
            variantId: fixtures.variantFacts,
            name: "Facts variant",
            basePriceMinor: null,
            currency: null,
          },
        ],
      },
    ]);

    const orderFacts = await kit.invoke(getProductOrderFacts, {
      items: [
        { productId: fixtures.productFacts, variantId: fixtures.variantFacts },
      ],
    });
    expect(orderFacts.products).toEqual([
      {
        productId: fixtures.productFacts,
        name: "Facts stay visible",
        variants: [{ variantId: fixtures.variantFacts, name: "Facts variant" }],
      },
    ]);
  });

  it("denies staff without products:edit", async () => {
    const actor = {
      userId: clerkUserId,
      companyId: kitIdentities.companies.a,
    };
    await expect(
      kit.invoke(archiveProduct, { productId: fixtures.productHappy }, actor),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      kit.invoke(restoreProduct, { productId: fixtures.productRestore }, actor),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      kit.invoke(archiveVariant, { variantId: fixtures.variantHappy }, actor),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      kit.invoke(restoreVariant, { variantId: fixtures.variantRestore }, actor),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("rejects malformed ids and a missing idempotency key", async () => {
    await expect(
      kit.invoke(archiveProduct, { productId: "not-a-uuid" }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      kit.invoke(restoreProduct, { productId: "not-a-uuid" }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      kit.invoke(archiveVariant, { variantId: "not-a-uuid" }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      kit.invoke(restoreVariant, { variantId: "not-a-uuid" }),
    ).rejects.toBeInstanceOf(ValidationError);

    await expect(
      kit.invoke(
        archiveProduct,
        { productId: fixtures.productHappy },
        {},
        { request: { idempotencyKey: "" } },
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      kit.invoke(
        restoreProduct,
        { productId: fixtures.productRestore },
        {},
        { request: { idempotencyKey: "" } },
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      kit.invoke(
        archiveVariant,
        { variantId: fixtures.variantHappy },
        {},
        { request: { idempotencyKey: "" } },
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      kit.invoke(
        restoreVariant,
        { variantId: fixtures.variantRestore },
        {},
        { request: { idempotencyKey: "" } },
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("returns the same not-found for missing and foreign rows", async () => {
    const missing = randomUUID();
    await expectSameNotFound(
      archiveProduct,
      { productId: missing },
      { productId: fixtures.productIsolationArchiveB },
    );
    await expectSameNotFound(
      restoreProduct,
      { productId: missing },
      { productId: fixtures.productIsolationRestoreB },
    );
    await expectSameNotFound(
      archiveVariant,
      { variantId: missing },
      { variantId: fixtures.variantIsolationArchiveB },
    );
    await expectSameNotFound(
      restoreVariant,
      { variantId: missing },
      { variantId: fixtures.variantIsolationRestoreB },
    );
  });
});

async function expectSameNotFound(
  action: SuiteAction,
  missingInput: unknown,
  foreignInput: unknown,
): Promise<void> {
  const missingError = await kit.invoke(action, missingInput).then(
    () => {
      throw new Error(`expected NotFoundError for ${action.contract.name}`);
    },
    (error: unknown) => error,
  );
  const foreignError = await kit.invoke(action, foreignInput).then(
    () => {
      throw new Error(
        `expected NotFoundError for foreign ${action.contract.name}`,
      );
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
}
