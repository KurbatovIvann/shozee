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
import { priceListEntries, priceLists } from "@showzy/db/schema/pricing";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { listPriceListEntries } from "./list-price-list-entries.js";
import {
  formatListPriceListEntriesCursor,
  LIST_PRICE_LIST_ENTRIES_MAX_LIMIT,
} from "./list-price-list-entries.contract.js";
import { removePriceListEntries } from "./remove-price-list-entries.js";
import { resolveProductPrices } from "./resolve-product-prices.js";
import { PRICING_RESOLVER_VERSION } from "./resolve-product-prices.contract.js";
import { SET_PRICE_LIST_ENTRIES_MAX_ITEMS } from "./set-price-list-entries.contract.js";
import { setPriceListEntries } from "./set-price-list-entries.js";

const fixtures = {
  listA: randomUUID(),
  listB: randomUUID(),
  listWrite: randomUUID(),
  listIso: randomUUID(),
  listIdemSet: randomUUID(),
  listIdemRemove: randomUUID(),
  listResolve: randomUUID(),
  productA: randomUUID(),
  productA2: randomUUID(),
  productB: randomUUID(),
  productIsoA: randomUUID(),
  productIsoB: randomUUID(),
  productIdemSet: randomUUID(),
  productIdemRemove: randomUUID(),
  productResolve: randomUUID(),
  variantA: randomUUID(),
  variantA2: randomUUID(),
  variantB: randomUUID(),
  variantResolve: randomUUID(),
  entryAProduct: randomUUID(),
  entryAVariant: randomUUID(),
  entryA2: randomUUID(),
  entryIdemRemove: randomUUID(),
};

const dates = {
  entryAProduct: new Date("2026-03-01T00:00:00.000Z"),
  entryAVariant: new Date("2026-03-02T00:00:00.000Z"),
  entryA2: new Date("2026-03-03T00:00:00.000Z"),
};

const clerks = {
  noView: randomUUID(),
  viewOnly: randomUUID(),
  manageOnly: randomUUID(),
};

const listManage = randomUUID();

let kit: TestKit;

async function countEntries(priceListId: string): Promise<number> {
  const rows = await kit.db.runtime.db
    .select({ id: priceListEntries.id })
    .from(priceListEntries)
    .where(eq(priceListEntries.priceListId, priceListId));
  return rows.length;
}

async function countAudits(action: string, targetId: string): Promise<number> {
  const rows = await kit.db.runtime.db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, action),
        eq(auditLog.targetId, targetId),
        eq(auditLog.outcome, "ok"),
      ),
    );
  return rows.length;
}

async function entryRow(entryId: string) {
  const rows = await kit.db.runtime.db
    .select()
    .from(priceListEntries)
    .where(eq(priceListEntries.id, entryId));
  return rows[0];
}

async function expectSameNotFound(
  missing: () => Promise<unknown>,
  foreign: () => Promise<unknown>,
): Promise<void> {
  const missingError = await missing().then(
    () => {
      throw new Error("expected NotFoundError for a missing resource");
    },
    (error: unknown) => error,
  );
  const foreignError = await foreign().then(
    () => {
      throw new Error("expected NotFoundError for a foreign resource");
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

beforeAll(async () => {
  kit = await createTestKit();
  const companyA = kitIdentities.companies.a;
  const companyB = kitIdentities.companies.b;

  await kit.db.runtime.db.insert(priceLists).values([
    { id: fixtures.listA, companyId: companyA, name: "List A" },
    { id: fixtures.listB, companyId: companyB, name: "List B" },
    { id: fixtures.listWrite, companyId: companyA, name: "List Write" },
    { id: listManage, companyId: companyA, name: "List Manage" },
    { id: fixtures.listIso, companyId: companyA, name: "List Iso" },
    { id: fixtures.listIdemSet, companyId: companyA, name: "List Idem Set" },
    {
      id: fixtures.listIdemRemove,
      companyId: companyA,
      name: "List Idem Remove",
    },
    {
      id: fixtures.listResolve,
      companyId: companyA,
      name: "List Resolve",
      isDefault: true,
    },
  ]);

  await kit.db.runtime.db.insert(products).values([
    {
      id: fixtures.productA,
      companyId: companyA,
      name: "Cake",
      basePriceMinor: 1500n,
    },
    {
      id: fixtures.productA2,
      companyId: companyA,
      name: "Pie",
      basePriceMinor: 800n,
    },
    {
      id: fixtures.productB,
      companyId: companyB,
      name: "Foreign cake",
      basePriceMinor: 1500n,
    },
    {
      id: fixtures.productIsoA,
      companyId: companyA,
      name: "Iso A",
      basePriceMinor: 100n,
    },
    {
      id: fixtures.productIsoB,
      companyId: companyB,
      name: "Iso B",
      basePriceMinor: 100n,
    },
    {
      id: fixtures.productIdemSet,
      companyId: companyA,
      name: "Idem set",
      basePriceMinor: 100n,
    },
    {
      id: fixtures.productIdemRemove,
      companyId: companyA,
      name: "Idem remove",
      basePriceMinor: 100n,
    },
    {
      id: fixtures.productResolve,
      companyId: companyA,
      name: "Resolve",
      basePriceMinor: 900n,
    },
  ]);

  await kit.db.runtime.db.insert(productVariants).values([
    {
      id: fixtures.variantA,
      companyId: companyA,
      productId: fixtures.productA,
      name: "Slice",
    },
    {
      id: fixtures.variantA2,
      companyId: companyA,
      productId: fixtures.productA2,
      name: "Slice pie",
    },
    {
      id: fixtures.variantB,
      companyId: companyB,
      productId: fixtures.productB,
      name: "Foreign slice",
    },
    {
      id: fixtures.variantResolve,
      companyId: companyA,
      productId: fixtures.productResolve,
      name: "Resolve slice",
    },
  ]);

  await kit.db.runtime.db.insert(priceListEntries).values([
    {
      id: fixtures.entryAProduct,
      companyId: companyA,
      priceListId: fixtures.listA,
      productId: fixtures.productA,
      priceMinor: 1200n,
      createdAt: dates.entryAProduct,
      updatedAt: dates.entryAProduct,
    },
    {
      id: fixtures.entryAVariant,
      companyId: companyA,
      priceListId: fixtures.listA,
      productId: fixtures.productA,
      variantId: fixtures.variantA,
      priceMinor: 1100n,
      createdAt: dates.entryAVariant,
      updatedAt: dates.entryAVariant,
    },
    {
      id: fixtures.entryA2,
      companyId: companyA,
      priceListId: fixtures.listA,
      productId: fixtures.productA2,
      priceMinor: 700n,
      createdAt: dates.entryA2,
      updatedAt: dates.entryA2,
    },
    {
      id: fixtures.entryIdemRemove,
      companyId: companyA,
      priceListId: fixtures.listIdemRemove,
      productId: fixtures.productIdemRemove,
      priceMinor: 400n,
    },
  ]);

  await kit.db.runtime.db.insert(user).values([
    {
      id: clerks.noView,
      name: "No view",
      email: "noview@pricing-entries.test",
    },
    {
      id: clerks.viewOnly,
      name: "Viewer",
      email: "viewer@pricing-entries.test",
    },
    {
      id: clerks.manageOnly,
      name: "Pricer",
      email: "pricer@pricing-entries.test",
    },
  ]);
  await kit.db.runtime.db.insert(companyMembers).values([
    {
      companyId: companyA,
      userId: clerks.noView,
      role: "employee",
      permissions: { granted: [], denied: ["pricing:view"] },
    },
    {
      companyId: companyA,
      userId: clerks.viewOnly,
      role: "employee",
      permissions: { granted: ["pricing:view"], denied: [] },
    },
    {
      companyId: companyA,
      userId: clerks.manageOnly,
      role: "employee",
      permissions: {
        granted: ["pricing:manage"],
        denied: ["orders:create", "orders:view", "documents:view"],
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
      listPriceListEntries,
      { input: { priceListId: fixtures.listA } },
      { input: { priceListId: fixtures.listB } },
    ),
    isolationCase(
      setPriceListEntries,
      {
        input: {
          priceListId: fixtures.listIso,
          entries: [{ productId: fixtures.productIsoA, priceMinor: "250" }],
        },
      },
      {
        input: {
          priceListId: fixtures.listB,
          entries: [{ productId: fixtures.productIsoB, priceMinor: "250" }],
        },
      },
      {
        missing: {
          input: {
            priceListId: randomUUID(),
            entries: [{ productId: fixtures.productIsoA, priceMinor: "250" }],
          },
        },
      },
    ),
    isolationCase(
      removePriceListEntries,
      {
        input: {
          priceListId: fixtures.listA,
          entries: [{ productId: fixtures.productIsoA }],
        },
      },
      {
        input: {
          priceListId: fixtures.listB,
          entries: [{ productId: fixtures.productIsoB }],
        },
      },
      {
        missing: {
          input: {
            priceListId: randomUUID(),
            entries: [{ productId: fixtures.productIsoA }],
          },
        },
      },
    ),
  ],
);

idempotencySuite(
  () => kit,
  [
    {
      action: setPriceListEntries,
      input: {
        priceListId: fixtures.listIdemSet,
        entries: [{ productId: fixtures.productIdemSet, priceMinor: "310" }],
      },
      conflictingInput: {
        priceListId: fixtures.listIdemSet,
        entries: [{ productId: fixtures.productIdemSet, priceMinor: "311" }],
      },
      readEffect: () =>
        countAudits("pricing.setPriceListEntries", fixtures.listIdemSet),
    },
    {
      action: removePriceListEntries,
      input: {
        priceListId: fixtures.listIdemRemove,
        entries: [{ productId: fixtures.productIdemRemove }],
      },
      conflictingInput: {
        priceListId: fixtures.listIdemRemove,
        entries: [{ productId: fixtures.productA }],
      },
      readEffect: () =>
        countAudits("pricing.removePriceListEntries", fixtures.listIdemRemove),
    },
  ],
);

describe("pricing.listPriceListEntries", () => {
  it("lists entries for a list newest-first and filters by product", async () => {
    const listed = await kit.invoke(listPriceListEntries, {
      priceListId: fixtures.listA,
    });
    expect(listed.items.map((row) => row.id)).toEqual([
      fixtures.entryA2,
      fixtures.entryAVariant,
      fixtures.entryAProduct,
    ]);
    expect(listed.nextCursor).toBeNull();
    expect(listed.items[1]).toEqual({
      id: fixtures.entryAVariant,
      priceListId: fixtures.listA,
      productId: fixtures.productA,
      variantId: fixtures.variantA,
      priceMinor: "1100",
      currency: "UAH",
    });
    expect(listed.items[2]).toEqual({
      id: fixtures.entryAProduct,
      priceListId: fixtures.listA,
      productId: fixtures.productA,
      variantId: null,
      priceMinor: "1200",
      currency: "UAH",
    });

    const byProduct = await kit.invoke(listPriceListEntries, {
      priceListId: fixtures.listA,
      productId: fixtures.productA,
    });
    expect(byProduct.items.map((row) => row.id)).toEqual([
      fixtures.entryAVariant,
      fixtures.entryAProduct,
    ]);
    expect(byProduct.nextCursor).toBeNull();
  });

  it("paginates with a created-at cursor", async () => {
    const first = await kit.invoke(listPriceListEntries, {
      priceListId: fixtures.listA,
      limit: 2,
    });
    expect(first.items.map((row) => row.id)).toEqual([
      fixtures.entryA2,
      fixtures.entryAVariant,
    ]);
    expect(first.nextCursor).toBe(
      formatListPriceListEntriesCursor(
        dates.entryAVariant,
        fixtures.entryAVariant,
      ),
    );

    const second = await kit.invoke(listPriceListEntries, {
      priceListId: fixtures.listA,
      limit: 2,
      cursor: first.nextCursor ?? "",
    });
    expect(second.items.map((row) => row.id)).toEqual([fixtures.entryAProduct]);
    expect(second.nextCursor).toBeNull();
  });

  it("denies staff without pricing:view", async () => {
    await expect(
      kit.invoke(
        listPriceListEntries,
        { priceListId: fixtures.listA },
        { userId: clerks.noView, companyId: kitIdentities.companies.a },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("allows staff with only pricing:view", async () => {
    const result = await kit.invoke(
      listPriceListEntries,
      { priceListId: fixtures.listA },
      { userId: clerks.viewOnly, companyId: kitIdentities.companies.a },
    );
    expect(result.items.map((row) => row.id)).toContain(fixtures.entryAProduct);
  });

  it("returns the same not-found for missing and foreign lists", async () => {
    await expectSameNotFound(
      () => kit.invoke(listPriceListEntries, { priceListId: randomUUID() }),
      () => kit.invoke(listPriceListEntries, { priceListId: fixtures.listB }),
    );
  });

  it("rejects a malformed id, oversized limit, and bad cursor", async () => {
    const invalidInputs: unknown[] = [
      { priceListId: "not-a-uuid" },
      {
        priceListId: fixtures.listA,
        limit: LIST_PRICE_LIST_ENTRIES_MAX_LIMIT + 1,
      },
      { priceListId: fixtures.listA, cursor: "nope" },
    ];
    for (const input of invalidInputs) {
      await expect(
        kit.invoke(listPriceListEntries, input),
      ).rejects.toBeInstanceOf(ValidationError);
    }
  });
});

describe("pricing.setPriceListEntries", () => {
  it("upserts product-level and variant-level rows, stores 0, and updates on duplicate", async () => {
    const requestId = randomUUID();
    const created = await kit.invoke(
      setPriceListEntries,
      {
        priceListId: fixtures.listWrite,
        entries: [
          { productId: fixtures.productA, priceMinor: "0" },
          {
            productId: fixtures.productA,
            variantId: fixtures.variantA,
            priceMinor: "1300",
          },
        ],
      },
      {},
      { request: { requestId } },
    );

    expect(created.items).toHaveLength(2);
    const productRow = created.items.find((row) => row.variantId === null);
    const variantRow = created.items.find(
      (row) => row.variantId === fixtures.variantA,
    );
    expect(productRow).toMatchObject({
      priceListId: fixtures.listWrite,
      productId: fixtures.productA,
      variantId: null,
      priceMinor: "0",
      currency: "UAH",
    });
    expect(variantRow).toMatchObject({
      priceListId: fixtures.listWrite,
      productId: fixtures.productA,
      variantId: fixtures.variantA,
      priceMinor: "1300",
      currency: "UAH",
    });

    const storedZero = await entryRow(productRow?.id ?? "");
    expect(storedZero).toMatchObject({
      companyId: kitIdentities.companies.a,
      priceMinor: 0n,
    });

    const updated = await kit.invoke(setPriceListEntries, {
      priceListId: fixtures.listWrite,
      entries: [{ productId: fixtures.productA, priceMinor: "1400" }],
    });
    expect(updated.items).toEqual([
      {
        id: productRow?.id,
        priceListId: fixtures.listWrite,
        productId: fixtures.productA,
        variantId: null,
        priceMinor: "1400",
        currency: "UAH",
      },
    ]);
    expect(await countEntries(fixtures.listWrite)).toBe(2);

    const auditRows = await kit.db.runtime.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.requestId, requestId));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: "pricing.setPriceListEntries",
      companyId: kitIdentities.companies.a,
      actorType: "user",
      actorId: kitIdentities.users.anna,
      targetType: "price_list",
      targetId: fixtures.listWrite,
      outcome: "ok",
      inputSnapshot: null,
    });

    const eventRows = await kit.db.runtime.db
      .select({ id: domainEvents.id })
      .from(domainEvents)
      .where(eq(domainEvents.requestId, requestId));
    expect(eventRows).toEqual([]);
  });

  it("denies staff without pricing:manage", async () => {
    await expect(
      kit.invoke(
        setPriceListEntries,
        {
          priceListId: fixtures.listWrite,
          entries: [{ productId: fixtures.productA, priceMinor: "1" }],
        },
        { userId: clerks.viewOnly, companyId: kitIdentities.companies.a },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("returns the same not-found for missing and foreign lists, products, and variants", async () => {
    await expectSameNotFound(
      () =>
        kit.invoke(setPriceListEntries, {
          priceListId: randomUUID(),
          entries: [{ productId: fixtures.productA, priceMinor: "1" }],
        }),
      () =>
        kit.invoke(setPriceListEntries, {
          priceListId: fixtures.listB,
          entries: [{ productId: fixtures.productA, priceMinor: "1" }],
        }),
    );
    await expectSameNotFound(
      () =>
        kit.invoke(setPriceListEntries, {
          priceListId: fixtures.listWrite,
          entries: [{ productId: randomUUID(), priceMinor: "1" }],
        }),
      () =>
        kit.invoke(setPriceListEntries, {
          priceListId: fixtures.listWrite,
          entries: [{ productId: fixtures.productB, priceMinor: "1" }],
        }),
    );
    await expectSameNotFound(
      () =>
        kit.invoke(setPriceListEntries, {
          priceListId: fixtures.listWrite,
          entries: [
            {
              productId: fixtures.productA,
              variantId: randomUUID(),
              priceMinor: "1",
            },
          ],
        }),
      () =>
        kit.invoke(setPriceListEntries, {
          priceListId: fixtures.listWrite,
          entries: [
            {
              productId: fixtures.productA,
              variantId: fixtures.variantA2,
              priceMinor: "1",
            },
          ],
        }),
    );
  });

  it("rejects empty batches, oversize batches, negative prices, non-UAH currency, and companyId", async () => {
    const before = await countEntries(fixtures.listWrite);
    const invalidInputs: unknown[] = [
      { priceListId: fixtures.listWrite, entries: [] },
      {
        priceListId: fixtures.listWrite,
        entries: Array.from(
          { length: SET_PRICE_LIST_ENTRIES_MAX_ITEMS + 1 },
          (_, index) => ({
            productId: `55555555-5555-4555-8555-${String(index).padStart(12, "0")}`,
            priceMinor: "1",
          }),
        ),
      },
      {
        priceListId: fixtures.listWrite,
        entries: [{ productId: fixtures.productA, priceMinor: "-1" }],
      },
      {
        priceListId: fixtures.listWrite,
        entries: [
          { productId: fixtures.productA, priceMinor: "1", currency: "USD" },
        ],
      },
      {
        priceListId: fixtures.listWrite,
        entries: [{ productId: fixtures.productA, priceMinor: "1" }],
        companyId: kitIdentities.companies.a,
      },
    ];
    for (const input of invalidInputs) {
      await expect(
        kit.invoke(setPriceListEntries, input),
      ).rejects.toBeInstanceOf(ValidationError);
    }
    expect(await countEntries(fixtures.listWrite)).toBe(before);
  });
});

describe("pricing.removePriceListEntries", () => {
  it("removes one entry, ignores missing keys, and audits once", async () => {
    const requestId = randomUUID();
    const before = await kit.invoke(listPriceListEntries, {
      priceListId: fixtures.listWrite,
    });
    const variant = before.items.find(
      (row) => row.variantId === fixtures.variantA,
    );
    expect(variant).toBeDefined();

    const result = await kit.invoke(
      removePriceListEntries,
      {
        priceListId: fixtures.listWrite,
        entries: [
          {
            productId: fixtures.productA,
            variantId: fixtures.variantA,
          },
          { productId: randomUUID() },
        ],
      },
      {},
      { request: { requestId } },
    );
    expect(result).toEqual({ priceListId: fixtures.listWrite });

    const after = await kit.invoke(listPriceListEntries, {
      priceListId: fixtures.listWrite,
    });
    expect(after.items.map((row) => row.variantId)).toEqual([null]);
    expect(after.items[0]?.priceMinor).toBe("1400");

    const auditRows = await kit.db.runtime.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.requestId, requestId));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: "pricing.removePriceListEntries",
      targetType: "price_list",
      targetId: fixtures.listWrite,
      outcome: "ok",
    });
  });

  it("denies staff without pricing:manage", async () => {
    await expect(
      kit.invoke(
        removePriceListEntries,
        {
          priceListId: fixtures.listWrite,
          entries: [{ productId: fixtures.productA }],
        },
        { userId: clerks.viewOnly, companyId: kitIdentities.companies.a },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("returns the same not-found for missing and foreign lists", async () => {
    await expectSameNotFound(
      () =>
        kit.invoke(removePriceListEntries, {
          priceListId: randomUUID(),
          entries: [{ productId: fixtures.productA }],
        }),
      () =>
        kit.invoke(removePriceListEntries, {
          priceListId: fixtures.listB,
          entries: [{ productId: fixtures.productA }],
        }),
    );
  });

  it("rejects empty batches, oversize batches, and companyId", async () => {
    const invalidInputs: unknown[] = [
      { priceListId: fixtures.listWrite, entries: [] },
      {
        priceListId: fixtures.listWrite,
        entries: Array.from(
          { length: SET_PRICE_LIST_ENTRIES_MAX_ITEMS + 1 },
          (_, index) => ({
            productId: `66666666-6666-4666-8666-${String(index).padStart(12, "0")}`,
          }),
        ),
      },
      {
        priceListId: fixtures.listWrite,
        entries: [{ productId: fixtures.productA }],
        companyId: kitIdentities.companies.a,
      },
    ];
    for (const input of invalidInputs) {
      await expect(
        kit.invoke(removePriceListEntries, input),
      ).rejects.toBeInstanceOf(ValidationError);
    }
  });
});

describe("pricing set/remove at the 200-entry cap", () => {
  const cap = SET_PRICE_LIST_ENTRIES_MAX_ITEMS;
  const listBatch = randomUUID();
  const catalog = Array.from({ length: cap }, () => ({
    productId: randomUUID(),
    variantId: randomUUID(),
  }));
  const existingProductEntryIds = Array.from({ length: 50 }, () =>
    randomUUID(),
  );
  const existingVariantEntryIds = Array.from({ length: 50 }, () =>
    randomUUID(),
  );

  function catalogAt(index: number): {
    productId: string;
    variantId: string;
  } {
    const row = catalog[index];
    if (row === undefined) {
      throw new Error(`cap catalog missing index ${String(index)}`);
    }
    return row;
  }

  function existingProductEntryId(index: number): string {
    const id = existingProductEntryIds[index];
    if (id === undefined) {
      throw new Error(`cap product entry id missing ${String(index)}`);
    }
    return id;
  }

  function existingVariantEntryId(index: number): string {
    const id = existingVariantEntryIds[index];
    if (id === undefined) {
      throw new Error(`cap variant entry id missing ${String(index)}`);
    }
    return id;
  }

  beforeAll(async () => {
    const companyA = kitIdentities.companies.a;
    await kit.db.runtime.db.insert(priceLists).values({
      id: listBatch,
      companyId: companyA,
      name: "List Batch Cap",
    });
    await kit.db.runtime.db.insert(products).values(
      catalog.map((item, index) => ({
        id: item.productId,
        companyId: companyA,
        name: `Batch ${String(index).padStart(3, "0")}`,
        basePriceMinor: 100n,
      })),
    );
    await kit.db.runtime.db.insert(productVariants).values(
      catalog.map((item, index) => ({
        id: item.variantId,
        companyId: companyA,
        productId: item.productId,
        name: `Batch variant ${String(index).padStart(3, "0")}`,
      })),
    );
    await kit.db.runtime.db.insert(priceListEntries).values([
      ...existingProductEntryIds.map((id, index) => ({
        id,
        companyId: companyA,
        priceListId: listBatch,
        productId: catalogAt(index).productId,
        priceMinor: 1000n + BigInt(index),
      })),
      ...existingVariantEntryIds.map((id, index) => ({
        id,
        companyId: companyA,
        priceListId: listBatch,
        productId: catalogAt(50 + index).productId,
        variantId: catalogAt(50 + index).variantId,
        priceMinor: 2000n + BigInt(index),
      })),
    ]);
  });

  it("upserts 200 mixed insert+update rows, then deletes those 200 keys", async () => {
    const setEntries = [
      ...Array.from({ length: 50 }, (_, index) => ({
        productId: catalogAt(index).productId,
        priceMinor: String(10_000 + index),
      })),
      ...Array.from({ length: 50 }, (_, index) => ({
        productId: catalogAt(50 + index).productId,
        variantId: catalogAt(50 + index).variantId,
        priceMinor: String(20_000 + index),
      })),
      ...Array.from({ length: 50 }, (_, index) => ({
        productId: catalogAt(100 + index).productId,
        priceMinor: String(30_000 + index),
      })),
      ...Array.from({ length: 50 }, (_, index) => ({
        productId: catalogAt(150 + index).productId,
        variantId: catalogAt(150 + index).variantId,
        priceMinor: String(40_000 + index),
      })),
    ];
    expect(setEntries).toHaveLength(cap);

    const created = await kit.invoke(setPriceListEntries, {
      priceListId: listBatch,
      entries: setEntries,
    });
    expect(created.items).toHaveLength(cap);

    const sortedItems = [...created.items].toSorted((left, right) => {
      if (left.productId !== right.productId) {
        return left.productId < right.productId ? -1 : 1;
      }
      const leftVariant = left.variantId ?? "";
      const rightVariant = right.variantId ?? "";
      if (leftVariant === rightVariant) {
        return 0;
      }
      return leftVariant < rightVariant ? -1 : 1;
    });
    expect(created.items).toEqual(sortedItems);

    const byKey = new Map(
      created.items.map((row) => [
        `${row.productId}|${row.variantId ?? ""}`,
        row,
      ]),
    );

    for (let index = 0; index < 50; index += 1) {
      expect(byKey.get(`${catalogAt(index).productId}|`)).toEqual({
        id: existingProductEntryId(index),
        priceListId: listBatch,
        productId: catalogAt(index).productId,
        variantId: null,
        priceMinor: String(10_000 + index),
        currency: "UAH",
      });
      expect(
        byKey.get(
          `${catalogAt(50 + index).productId}|${catalogAt(50 + index).variantId}`,
        ),
      ).toEqual({
        id: existingVariantEntryId(index),
        priceListId: listBatch,
        productId: catalogAt(50 + index).productId,
        variantId: catalogAt(50 + index).variantId,
        priceMinor: String(20_000 + index),
        currency: "UAH",
      });
      const insertedProduct = byKey.get(`${catalogAt(100 + index).productId}|`);
      expect(insertedProduct).toMatchObject({
        priceListId: listBatch,
        productId: catalogAt(100 + index).productId,
        variantId: null,
        priceMinor: String(30_000 + index),
        currency: "UAH",
      });
      expect(insertedProduct?.id).toEqual(expect.any(String));
      const insertedVariant = byKey.get(
        `${catalogAt(150 + index).productId}|${catalogAt(150 + index).variantId}`,
      );
      expect(insertedVariant).toMatchObject({
        priceListId: listBatch,
        productId: catalogAt(150 + index).productId,
        variantId: catalogAt(150 + index).variantId,
        priceMinor: String(40_000 + index),
        currency: "UAH",
      });
      expect(insertedVariant?.id).toEqual(expect.any(String));
    }

    const stored = await kit.db.runtime.db
      .select({
        id: priceListEntries.id,
        productId: priceListEntries.productId,
        variantId: priceListEntries.variantId,
        priceMinor: priceListEntries.priceMinor,
        currency: priceListEntries.currency,
      })
      .from(priceListEntries)
      .where(eq(priceListEntries.priceListId, listBatch));
    expect(stored).toHaveLength(cap);
    expect(
      stored.map((row) => `${row.productId}|${row.variantId ?? ""}`).toSorted(),
    ).toEqual(
      created.items
        .map((row) => `${row.productId}|${row.variantId ?? ""}`)
        .toSorted(),
    );
    const storedById = new Map(stored.map((row) => [row.id, row]));
    for (const item of created.items) {
      expect(storedById.get(item.id)).toEqual({
        id: item.id,
        productId: item.productId,
        variantId: item.variantId,
        priceMinor: BigInt(item.priceMinor),
        currency: item.currency,
      });
    }

    const removeKeys = setEntries.map((entry) =>
      "variantId" in entry
        ? { productId: entry.productId, variantId: entry.variantId }
        : { productId: entry.productId },
    );
    expect(removeKeys).toHaveLength(cap);

    const removed = await kit.invoke(removePriceListEntries, {
      priceListId: listBatch,
      entries: removeKeys,
    });
    expect(removed).toEqual({ priceListId: listBatch });
    expect(await countEntries(listBatch)).toBe(0);
  });
});

describe("pricing:manage implies the catalog read it needs", () => {
  const actor = () => ({
    userId: clerks.manageOnly,
    companyId: kitIdentities.companies.a,
  });

  it("lets a pricing:manage-only member read the price list", async () => {
    const result = await kit.invoke(
      listPriceListEntries,
      { priceListId: fixtures.listA },
      actor(),
    );
    expect(result.items.map((row) => row.id)).toContain(fixtures.entryAProduct);
  });

  it("lets a pricing:manage-only member set entries", async () => {
    await kit.invoke(
      setPriceListEntries,
      {
        priceListId: listManage,
        entries: [{ productId: fixtures.productA, priceMinor: "999" }],
      },
      actor(),
    );
    expect(await countEntries(listManage)).toBe(1);
  });

  it("lets a pricing:manage-only member remove entries", async () => {
    await kit.invoke(
      removePriceListEntries,
      {
        priceListId: listManage,
        entries: [{ productId: fixtures.productA }],
      },
      actor(),
    );
    expect(await countEntries(listManage)).toBe(0);
  });
});

describe("price-list entries and resolveProductPrices", () => {
  it("prefers the variant entry then falls through to the product entry after remove", async () => {
    await kit.invoke(setPriceListEntries, {
      priceListId: fixtures.listResolve,
      entries: [
        { productId: fixtures.productResolve, priceMinor: "500" },
        {
          productId: fixtures.productResolve,
          variantId: fixtures.variantResolve,
          priceMinor: "200",
        },
      ],
    });

    const withVariant = await kit.invoke(resolveProductPrices, {
      items: [
        {
          productId: fixtures.productResolve,
          variantId: fixtures.variantResolve,
        },
      ],
    });
    expect(withVariant.prices[0]).toMatchObject({
      productId: fixtures.productResolve,
      variantId: fixtures.variantResolve,
      unitPriceMinor: "200",
      currency: "UAH",
      source: "default_price_list",
      matchLevel: "variant",
      sourceIds: { priceListId: fixtures.listResolve },
      resolverVersion: PRICING_RESOLVER_VERSION,
    });

    await kit.invoke(removePriceListEntries, {
      priceListId: fixtures.listResolve,
      entries: [
        {
          productId: fixtures.productResolve,
          variantId: fixtures.variantResolve,
        },
      ],
    });

    const afterRemove = await kit.invoke(resolveProductPrices, {
      items: [
        {
          productId: fixtures.productResolve,
          variantId: fixtures.variantResolve,
        },
      ],
    });
    expect(afterRemove.prices[0]).toMatchObject({
      productId: fixtures.productResolve,
      variantId: fixtures.variantResolve,
      unitPriceMinor: "500",
      source: "default_price_list",
      matchLevel: "product",
      sourceIds: { priceListId: fixtures.listResolve },
      resolverVersion: PRICING_RESOLVER_VERSION,
    });
  });
});
