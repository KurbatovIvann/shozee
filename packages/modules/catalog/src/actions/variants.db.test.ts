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
import { createVariant } from "./create-variant.js";
import { updateVariant } from "./update-variant.js";

const fixtures = {
  productA: randomUUID(),
  productAOther: randomUUID(),
  productB: randomUUID(),
  variantA: randomUUID(),
  variantAOther: randomUUID(),
  variantB: randomUUID(),
  variantIdem: randomUUID(),
};

const clerks = {
  noEdit: randomUUID(),
};

const createIsolationInput = {
  productId: fixtures.productA,
  name: "Isolation create A",
};

const updateIsolationOwn = {
  productId: fixtures.productA,
  variantId: fixtures.variantA,
  name: "Isolation updated A",
};

const updateIsolationForeign = {
  productId: fixtures.productB,
  variantId: fixtures.variantB,
  name: "Isolation updated B",
};

let kit: TestKit;

async function countCompanyVariants(companyId: string): Promise<number> {
  const rows = await kit.db.runtime.db
    .select({ id: productVariants.id })
    .from(productVariants)
    .where(eq(productVariants.companyId, companyId));
  return rows.length;
}

async function countUpdateAudits(variantId: string): Promise<number> {
  const rows = await kit.db.runtime.db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, "catalog.updateVariant"),
        eq(auditLog.targetId, variantId),
        eq(auditLog.outcome, "ok"),
      ),
    );
  return rows.length;
}

async function variantRow(variantId: string) {
  const rows = await kit.db.runtime.db
    .select()
    .from(productVariants)
    .where(eq(productVariants.id, variantId));
  return rows[0];
}

beforeAll(async () => {
  kit = await createTestKit();

  await kit.db.runtime.db.insert(products).values([
    {
      id: fixtures.productA,
      companyId: kitIdentities.companies.a,
      name: "Alpha",
      basePriceMinor: 1500n,
    },
    {
      id: fixtures.productAOther,
      companyId: kitIdentities.companies.a,
      name: "Other",
      basePriceMinor: 900n,
    },
    {
      id: fixtures.productB,
      companyId: kitIdentities.companies.b,
      name: "Bravo",
      basePriceMinor: 2200n,
    },
  ]);
  await kit.db.runtime.db.insert(productVariants).values([
    {
      id: fixtures.variantA,
      companyId: kitIdentities.companies.a,
      productId: fixtures.productA,
      name: "Keep me",
      basePriceMinor: 1250n,
      currency: "UAH",
    },
    {
      id: fixtures.variantAOther,
      companyId: kitIdentities.companies.a,
      productId: fixtures.productAOther,
      name: "Other variant",
    },
    {
      id: fixtures.variantB,
      companyId: kitIdentities.companies.b,
      productId: fixtures.productB,
      name: "Bravo variant",
      basePriceMinor: 2100n,
      currency: "UAH",
    },
    {
      id: fixtures.variantIdem,
      companyId: kitIdentities.companies.a,
      productId: fixtures.productA,
      name: "Idem Target",
      basePriceMinor: 800n,
      currency: "UAH",
    },
  ]);

  await kit.db.runtime.db.insert(user).values({
    id: clerks.noEdit,
    name: "Clerk",
    email: "clerk@catalog-variants.test",
  });
  await kit.db.runtime.db.insert(companyMembers).values({
    companyId: kitIdentities.companies.a,
    userId: clerks.noEdit,
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
      createVariant,
      { input: createIsolationInput },
      { input: createIsolationInput, companyId: kitIdentities.companies.b },
    ),
    isolationCase(
      updateVariant,
      { input: updateIsolationOwn },
      { input: updateIsolationForeign },
    ),
  ],
);

idempotencySuite(
  () => kit,
  [
    {
      action: createVariant,
      input: { productId: fixtures.productA, name: "Idem Create" },
      conflictingInput: {
        productId: fixtures.productA,
        name: "Idem Create Other",
      },
      readEffect: () => countCompanyVariants(kitIdentities.companies.a),
    },
    {
      action: updateVariant,
      input: {
        productId: fixtures.productA,
        variantId: fixtures.variantIdem,
        name: "Idem Updated",
        basePriceMinor: "3000",
        currency: "UAH",
      },
      conflictingInput: {
        productId: fixtures.productA,
        variantId: fixtures.variantIdem,
        name: "Idem Conflicting",
        basePriceMinor: "1",
        currency: "UAH",
      },
      readEffect: () => countUpdateAudits(fixtures.variantIdem),
    },
  ],
);

describe("catalog.createVariant", () => {
  it("creates a variant with an optional override and audits once", async () => {
    const requestId = randomUUID();
    const result = await kit.invoke(
      createVariant,
      {
        productId: fixtures.productA,
        name: "  Київський торт  ",
        basePriceMinor: "19900",
        currency: "UAH",
      },
      {},
      { request: { requestId } },
    );

    expect(result).toMatchObject({
      productId: fixtures.productA,
      name: "Київський торт",
      basePriceMinor: "19900",
      currency: "UAH",
    });
    expect(result.variantId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    const withoutOverride = await kit.invoke(createVariant, {
      productId: fixtures.productA,
      name: "Plain",
    });
    expect(withoutOverride).toMatchObject({
      productId: fixtures.productA,
      name: "Plain",
      basePriceMinor: null,
      currency: null,
    });

    const row = await variantRow(result.variantId);
    expect(row).toMatchObject({
      id: result.variantId,
      companyId: kitIdentities.companies.a,
      productId: fixtures.productA,
      name: "Київський торт",
      basePriceMinor: 19900n,
      currency: "UAH",
      status: "active",
    });

    const auditRows = await kit.db.runtime.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.requestId, requestId));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: "catalog.createVariant",
      companyId: kitIdentities.companies.a,
      actorType: "user",
      actorId: kitIdentities.users.anna,
      targetType: "variant",
      targetId: result.variantId,
      outcome: "ok",
      inputSnapshot: null,
    });

    const eventRows = await kit.db.runtime.db
      .select({ id: domainEvents.id })
      .from(domainEvents)
      .where(eq(domainEvents.requestId, requestId));
    expect(eventRows).toEqual([]);
  });

  it("denies staff without products:edit", async () => {
    await expect(
      kit.invoke(
        createVariant,
        { productId: fixtures.productA, name: "Denied" },
        { userId: clerks.noEdit, companyId: kitIdentities.companies.a },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("returns the same not-found for missing and foreign products", async () => {
    const missingId = randomUUID();
    const missingError = await kit
      .invoke(createVariant, { productId: missingId, name: "Ghost" })
      .catch((error: unknown) => error);
    const foreignError = await kit
      .invoke(createVariant, {
        productId: fixtures.productB,
        name: "Ghost",
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

    const foreignVariants = await kit.db.runtime.db
      .select({ id: productVariants.id })
      .from(productVariants)
      .where(eq(productVariants.productId, fixtures.productB));
    expect(foreignVariants).toHaveLength(1);
  });

  it("rejects blank names, unpaired override currency, and companyId", async () => {
    const before = await countCompanyVariants(kitIdentities.companies.a);
    const invalidInputs: unknown[] = [
      { productId: fixtures.productA, name: "   " },
      {
        productId: fixtures.productA,
        name: "x".repeat(PRODUCT_NAME_MAX + 1),
      },
      { productId: fixtures.productA, name: "Cake", currency: "UAH" },
      {
        productId: fixtures.productA,
        name: "Cake",
        basePriceMinor: "50",
      },
      {
        productId: fixtures.productA,
        name: "Cake",
        basePriceMinor: "-1",
        currency: "UAH",
      },
      {
        productId: fixtures.productA,
        name: "Cake",
        basePriceMinor: "50",
        currency: "USD",
      },
      {
        productId: "not-a-uuid",
        name: "Cake",
      },
      {
        productId: fixtures.productA,
        name: "Cake",
        companyId: kitIdentities.companies.a,
      },
    ];
    for (const input of invalidInputs) {
      await expect(kit.invoke(createVariant, input)).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
    expect(await countCompanyVariants(kitIdentities.companies.a)).toBe(before);
  });
});

describe("catalog.createVariant provenance (SHO-465)", () => {
  it("stores ctx.channel and leaves vouched columns null", async () => {
    const viaUi = await kit.invoke(
      createVariant,
      { productId: fixtures.productA, name: "Provenance UI variant" },
      {},
      { request: { channel: "ui" } },
    );
    const viaAi = await kit.invoke(
      createVariant,
      { productId: fixtures.productA, name: "Provenance AI variant" },
      {},
      { request: { channel: "ai", aiTraceId: "sho-465-variant" } },
    );
    expect(await variantRow(viaUi.variantId)).toMatchObject({
      createdVia: "ui",
      vouchedBy: null,
      vouchedAt: null,
    });
    expect(await variantRow(viaAi.variantId)).toMatchObject({
      createdVia: "ai",
      vouchedBy: null,
      vouchedAt: null,
    });
  });
});

describe("catalog.updateVariant", () => {
  it("updates name and override, can clear the override, and audits once", async () => {
    const created = await kit.invoke(createVariant, {
      productId: fixtures.productA,
      name: "Before",
      basePriceMinor: "800",
      currency: "UAH",
    });
    const requestId = randomUUID();
    const result = await kit.invoke(
      updateVariant,
      {
        productId: created.productId,
        variantId: created.variantId,
        name: "  After  ",
        basePriceMinor: "1800",
        currency: "UAH",
      },
      {},
      { request: { requestId } },
    );

    expect(result).toMatchObject({
      variantId: created.variantId,
      productId: created.productId,
      name: "After",
      basePriceMinor: "1800",
      currency: "UAH",
    });

    const cleared = await kit.invoke(updateVariant, {
      productId: created.productId,
      variantId: created.variantId,
      name: "After",
    });
    expect(cleared).toMatchObject({
      variantId: created.variantId,
      name: "After",
      basePriceMinor: null,
      currency: null,
    });

    const row = await variantRow(created.variantId);
    expect(row).toMatchObject({
      name: "After",
      basePriceMinor: null,
      currency: null,
      companyId: kitIdentities.companies.a,
    });

    const auditRows = await kit.db.runtime.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.requestId, requestId));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: "catalog.updateVariant",
      companyId: kitIdentities.companies.a,
      targetType: "variant",
      targetId: created.variantId,
      outcome: "ok",
      inputSnapshot: null,
    });
  });

  it("denies staff without products:edit", async () => {
    await expect(
      kit.invoke(
        updateVariant,
        {
          productId: fixtures.productA,
          variantId: fixtures.variantA,
          name: "Nope",
        },
        { userId: clerks.noEdit, companyId: kitIdentities.companies.a },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("returns the same not-found for missing, foreign, and product-mismatched variants", async () => {
    const missingId = randomUUID();
    const missingError = await kit
      .invoke(updateVariant, {
        productId: fixtures.productA,
        variantId: missingId,
        name: "Ghost",
      })
      .catch((error: unknown) => error);
    const foreignError = await kit
      .invoke(updateVariant, {
        productId: fixtures.productB,
        variantId: fixtures.variantB,
        name: "Ghost",
      })
      .catch((error: unknown) => error);
    const mismatchedError = await kit
      .invoke(updateVariant, {
        productId: fixtures.productA,
        variantId: fixtures.variantAOther,
        name: "Ghost",
      })
      .catch((error: unknown) => error);

    expect(missingError).toBeInstanceOf(NotFoundError);
    expect(foreignError).toBeInstanceOf(NotFoundError);
    expect(mismatchedError).toBeInstanceOf(NotFoundError);
    if (
      missingError instanceof NotFoundError &&
      foreignError instanceof NotFoundError &&
      mismatchedError instanceof NotFoundError
    ) {
      expect(missingError.clientMessage).toBe(foreignError.clientMessage);
      expect(missingError.clientMessage).toBe(mismatchedError.clientMessage);
    }

    const foreignRow = await variantRow(fixtures.variantB);
    expect(foreignRow?.name).toBe("Bravo variant");
    expect(foreignRow?.companyId).toBe(kitIdentities.companies.b);
    const mismatchedRow = await variantRow(fixtures.variantAOther);
    expect(mismatchedRow?.name).toBe("Other variant");
    expect(mismatchedRow?.productId).toBe(fixtures.productAOther);
  });

  it("rejects blank names, unpaired override currency, and companyId", async () => {
    const invalidInputs: unknown[] = [
      {
        productId: fixtures.productA,
        variantId: fixtures.variantA,
        name: "   ",
      },
      {
        productId: fixtures.productA,
        variantId: fixtures.variantA,
        name: "Cake",
        currency: "UAH",
      },
      {
        productId: fixtures.productA,
        variantId: fixtures.variantA,
        name: "Cake",
        basePriceMinor: "50",
      },
      {
        productId: fixtures.productA,
        variantId: fixtures.variantA,
        name: "Cake",
        basePriceMinor: "-1",
        currency: "UAH",
      },
      {
        productId: fixtures.productA,
        variantId: fixtures.variantA,
        name: "Cake",
        basePriceMinor: "50",
        currency: "USD",
      },
      {
        productId: "not-a-uuid",
        variantId: fixtures.variantA,
        name: "Cake",
      },
      {
        productId: fixtures.productA,
        variantId: fixtures.variantA,
        name: "Cake",
        companyId: kitIdentities.companies.a,
      },
    ];
    for (const input of invalidInputs) {
      await expect(kit.invoke(updateVariant, input)).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
  });
});
