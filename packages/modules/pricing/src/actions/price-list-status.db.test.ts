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
import { products } from "@showzy/db/schema/catalog";
import { companyMembers } from "@showzy/db/schema/companies";
import { priceListEntries, priceLists } from "@showzy/db/schema/pricing";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { activatePriceList } from "./activate-price-list.js";
import { deactivatePriceList } from "./deactivate-price-list.js";
import { resolveProductPrices } from "./resolve-product-prices.js";
import { setDefaultPriceList } from "./set-default-price-list.js";

const fixtures = {
  listSetDefaultA: randomUUID(),
  listSetDefaultB: randomUUID(),
  listActivateA: randomUUID(),
  listActivateB: randomUUID(),
  listDeactivateA: randomUUID(),
  listDeactivateB: randomUUID(),
  listIdemSet: randomUUID(),
  listIdemSetConflict: randomUUID(),
  listIdemActivate: randomUUID(),
  listIdemDeactivate: randomUUID(),
  listIdemClearConflict: randomUUID(),
  productResolve: randomUUID(),
  entryResolve: randomUUID(),
};

const clerks = {
  viewOnly: randomUUID(),
};

let kit: TestKit;

async function countDefaultLists(companyId: string): Promise<number> {
  const rows = await kit.db.runtime.db
    .select({ id: priceLists.id })
    .from(priceLists)
    .where(
      and(eq(priceLists.companyId, companyId), eq(priceLists.isDefault, true)),
    );
  return rows.length;
}

async function countAudits(action: string): Promise<number> {
  const rows = await kit.db.runtime.db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(and(eq(auditLog.action, action), eq(auditLog.outcome, "ok")));
  return rows.length;
}

async function listRow(listId: string) {
  const rows = await kit.db.runtime.db
    .select()
    .from(priceLists)
    .where(eq(priceLists.id, listId));
  return rows[0];
}

async function insertList(values: {
  id: string;
  companyId: string;
  name: string;
  isDefault?: boolean;
  isActive?: boolean;
}): Promise<void> {
  await kit.db.runtime.db.insert(priceLists).values({
    id: values.id,
    companyId: values.companyId,
    name: values.name,
    ...(values.isDefault === undefined ? {} : { isDefault: values.isDefault }),
    ...(values.isActive === undefined ? {} : { isActive: values.isActive }),
  });
}

async function forceClearDefaults(companyId: string): Promise<void> {
  await kit.db.runtime.db
    .update(priceLists)
    .set({ isDefault: false })
    .where(
      and(eq(priceLists.companyId, companyId), eq(priceLists.isDefault, true)),
    );
}

beforeAll(async () => {
  kit = await createTestKit();

  await insertList({
    id: fixtures.listSetDefaultA,
    companyId: kitIdentities.companies.a,
    name: "Set default A",
    isActive: false,
  });
  await insertList({
    id: fixtures.listSetDefaultB,
    companyId: kitIdentities.companies.b,
    name: "Set default B",
  });
  await insertList({
    id: fixtures.listActivateA,
    companyId: kitIdentities.companies.a,
    name: "Activate A",
    isActive: false,
  });
  await insertList({
    id: fixtures.listActivateB,
    companyId: kitIdentities.companies.b,
    name: "Activate B",
    isActive: false,
  });
  await insertList({
    id: fixtures.listDeactivateA,
    companyId: kitIdentities.companies.a,
    name: "Deactivate A",
  });
  await insertList({
    id: fixtures.listDeactivateB,
    companyId: kitIdentities.companies.b,
    name: "Deactivate B",
  });
  await insertList({
    id: fixtures.listIdemSet,
    companyId: kitIdentities.companies.a,
    name: "Idem set",
  });
  await insertList({
    id: fixtures.listIdemSetConflict,
    companyId: kitIdentities.companies.a,
    name: "Idem set conflict",
  });
  await insertList({
    id: fixtures.listIdemActivate,
    companyId: kitIdentities.companies.a,
    name: "Idem activate",
    isActive: false,
  });
  await insertList({
    id: fixtures.listIdemDeactivate,
    companyId: kitIdentities.companies.a,
    name: "Idem deactivate",
  });
  await insertList({
    id: fixtures.listIdemClearConflict,
    companyId: kitIdentities.companies.a,
    name: "Idem clear conflict",
  });

  await kit.db.runtime.db.insert(products).values({
    id: fixtures.productResolve,
    companyId: kitIdentities.companies.a,
    name: "Resolve cake",
    basePriceMinor: 1500n,
  });
  await kit.db.runtime.db.insert(priceListEntries).values({
    id: fixtures.entryResolve,
    companyId: kitIdentities.companies.a,
    priceListId: fixtures.listIdemSet,
    productId: fixtures.productResolve,
    priceMinor: 400n,
  });

  await kit.db.runtime.db.insert(user).values({
    id: clerks.viewOnly,
    name: "Viewer",
    email: "viewer@pricing-status.test",
  });
  await kit.db.runtime.db.insert(companyMembers).values({
    companyId: kitIdentities.companies.a,
    userId: clerks.viewOnly,
    role: "employee",
    permissions: { granted: ["pricing:view"], denied: [] },
  });
});

afterAll(async () => {
  await kit.db.close();
});

crossTenantSuite(
  () => kit,
  [
    isolationCase(
      setDefaultPriceList,
      { input: { priceListId: fixtures.listSetDefaultA } },
      { input: { priceListId: fixtures.listSetDefaultB } },
      { missing: { input: { priceListId: randomUUID() } } },
    ),
    isolationCase(
      activatePriceList,
      { input: { id: fixtures.listActivateA } },
      { input: { id: fixtures.listActivateB } },
      { missing: { input: { id: randomUUID() } } },
    ),
    isolationCase(
      deactivatePriceList,
      { input: { id: fixtures.listDeactivateA } },
      { input: { id: fixtures.listDeactivateB } },
      { missing: { input: { id: randomUUID() } } },
    ),
  ],
);

idempotencySuite(
  () => kit,
  [
    {
      action: setDefaultPriceList,
      input: { priceListId: fixtures.listIdemSet },
      conflictingInput: { priceListId: fixtures.listIdemSetConflict },
      readEffect: () => countAudits("pricing.setDefaultPriceList"),
    },
    {
      action: setDefaultPriceList,
      input: { priceListId: null },
      conflictingInput: { priceListId: fixtures.listIdemClearConflict },
      readEffect: () => countAudits("pricing.setDefaultPriceList"),
    },
    {
      action: activatePriceList,
      input: { id: fixtures.listIdemActivate },
      conflictingInput: { id: fixtures.listIdemSet },
      readEffect: () => countAudits("pricing.activatePriceList"),
    },
    {
      action: deactivatePriceList,
      input: { id: fixtures.listIdemDeactivate },
      conflictingInput: { id: fixtures.listDeactivateA },
      readEffect: () => countAudits("pricing.deactivatePriceList"),
    },
  ],
);

describe("pricing.setDefaultPriceList", () => {
  it("activates an inactive target, unsets the previous default, and audits once", async () => {
    await forceClearDefaults(kitIdentities.companies.a);
    const previous = (
      await kit.db.runtime.db
        .insert(priceLists)
        .values({
          id: randomUUID(),
          companyId: kitIdentities.companies.a,
          name: "Previous default",
          isDefault: true,
        })
        .returning()
    )[0];
    if (previous === undefined) {
      throw new Error("expected previous default insert");
    }
    const targetId = randomUUID();
    await insertList({
      id: targetId,
      companyId: kitIdentities.companies.a,
      name: "Next default",
      isActive: false,
    });

    const requestId = randomUUID();
    const result = await kit.invoke(
      setDefaultPriceList,
      { priceListId: targetId },
      {},
      { request: { requestId } },
    );

    expect(result).toMatchObject({
      id: targetId,
      name: "Next default",
      isDefault: true,
      isActive: true,
      entryCount: 0,
    });

    expect(await listRow(targetId)).toMatchObject({
      isDefault: true,
      isActive: true,
      companyId: kitIdentities.companies.a,
    });
    expect(await listRow(previous.id)).toMatchObject({
      isDefault: false,
      isActive: true,
    });
    expect(await countDefaultLists(kitIdentities.companies.a)).toBe(1);

    const auditRows = await kit.db.runtime.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.requestId, requestId));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: "pricing.setDefaultPriceList",
      companyId: kitIdentities.companies.a,
      actorType: "user",
      actorId: kitIdentities.users.anna,
      targetType: "price_list",
      targetId: targetId,
      outcome: "ok",
      inputSnapshot: null,
    });

    const eventRows = await kit.db.runtime.db
      .select({ id: domainEvents.id })
      .from(domainEvents)
      .where(eq(domainEvents.requestId, requestId));
    expect(eventRows).toEqual([]);
  });

  it("clears the company default with null and leaves zero defaults", async () => {
    await forceClearDefaults(kitIdentities.companies.a);
    const currentId = randomUUID();
    await insertList({
      id: currentId,
      companyId: kitIdentities.companies.a,
      name: "To clear",
      isDefault: true,
    });
    expect(await countDefaultLists(kitIdentities.companies.a)).toBe(1);

    const cleared = await kit.invoke(setDefaultPriceList, {
      priceListId: null,
    });
    expect(cleared).toMatchObject({
      id: currentId,
      isDefault: false,
      isActive: true,
    });
    expect(await listRow(currentId)).toMatchObject({
      isDefault: false,
      isActive: true,
    });
    expect(await countDefaultLists(kitIdentities.companies.a)).toBe(0);

    const again = await kit.invoke(setDefaultPriceList, { priceListId: null });
    expect(again).toBeNull();
    expect(await countDefaultLists(kitIdentities.companies.a)).toBe(0);
  });

  it("denies staff without pricing:manage", async () => {
    await expect(
      kit.invoke(
        setDefaultPriceList,
        { priceListId: fixtures.listIdemSetConflict },
        { userId: clerks.viewOnly, companyId: kitIdentities.companies.a },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("returns the same not-found for missing and foreign lists", async () => {
    const missingId = randomUUID();
    const missingError = await kit
      .invoke(setDefaultPriceList, { priceListId: missingId })
      .then(
        () => {
          throw new Error("expected NotFoundError for a missing price list");
        },
        (error: unknown) => error,
      );
    const foreignError = await kit
      .invoke(setDefaultPriceList, {
        priceListId: fixtures.listSetDefaultB,
      })
      .then(
        () => {
          throw new Error("expected NotFoundError for a foreign price list");
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

    const foreignRow = await listRow(fixtures.listSetDefaultB);
    expect(foreignRow).toMatchObject({
      isDefault: false,
      companyId: kitIdentities.companies.b,
    });
  });

  it("rejects companyId on input", async () => {
    await expect(
      kit.invoke(setDefaultPriceList, {
        priceListId: fixtures.listIdemSetConflict,
        companyId: kitIdentities.companies.a,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("pricing.activatePriceList", () => {
  it("activates an inactive list, no-ops when already active, and audits once", async () => {
    const targetId = randomUUID();
    await insertList({
      id: targetId,
      companyId: kitIdentities.companies.a,
      name: "Activate target",
      isActive: false,
    });

    const requestId = randomUUID();
    const result = await kit.invoke(
      activatePriceList,
      { id: targetId },
      {},
      { request: { requestId } },
    );
    expect(result).toMatchObject({
      id: targetId,
      isActive: true,
      isDefault: false,
      entryCount: 0,
    });
    expect(await listRow(targetId)).toMatchObject({ isActive: true });

    const beforeRepeat = await listRow(targetId);
    const again = await kit.invoke(activatePriceList, { id: targetId });
    const afterRepeat = await listRow(targetId);
    expect(again).toMatchObject({ id: targetId, isActive: true });
    expect(afterRepeat?.updatedAt.getTime()).toBe(
      beforeRepeat?.updatedAt.getTime(),
    );

    const auditRows = await kit.db.runtime.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.requestId, requestId));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: "pricing.activatePriceList",
      targetType: "price_list",
      targetId: targetId,
      outcome: "ok",
    });
  });

  it("denies staff without pricing:manage", async () => {
    await expect(
      kit.invoke(
        activatePriceList,
        { id: fixtures.listIdemSetConflict },
        { userId: clerks.viewOnly, companyId: kitIdentities.companies.a },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("returns the same not-found for missing and foreign lists", async () => {
    const missingId = randomUUID();
    const missingError = await kit
      .invoke(activatePriceList, { id: missingId })
      .then(
        () => {
          throw new Error("expected NotFoundError for a missing price list");
        },
        (error: unknown) => error,
      );
    const foreignError = await kit
      .invoke(activatePriceList, { id: fixtures.listActivateB })
      .then(
        () => {
          throw new Error("expected NotFoundError for a foreign price list");
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
    expect(await listRow(fixtures.listActivateB)).toMatchObject({
      isActive: false,
      companyId: kitIdentities.companies.b,
    });
  });
});

describe("pricing.deactivatePriceList", () => {
  it("deactivates a non-default list and no-ops when already inactive", async () => {
    const targetId = randomUUID();
    await insertList({
      id: targetId,
      companyId: kitIdentities.companies.a,
      name: "Deactivate target",
    });

    const requestId = randomUUID();
    const result = await kit.invoke(
      deactivatePriceList,
      { id: targetId },
      {},
      { request: { requestId } },
    );
    expect(result).toMatchObject({
      id: targetId,
      isActive: false,
      isDefault: false,
    });
    expect(await listRow(targetId)).toMatchObject({
      isActive: false,
      isDefault: false,
    });

    const beforeRepeat = await listRow(targetId);
    const again = await kit.invoke(deactivatePriceList, { id: targetId });
    const afterRepeat = await listRow(targetId);
    expect(again).toMatchObject({ id: targetId, isActive: false });
    expect(afterRepeat?.updatedAt.getTime()).toBe(
      beforeRepeat?.updatedAt.getTime(),
    );

    const auditRows = await kit.db.runtime.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.requestId, requestId));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: "pricing.deactivatePriceList",
      targetId: targetId,
      outcome: "ok",
    });
  });

  it("fails validation when deactivating the default and leaves it default and active", async () => {
    await forceClearDefaults(kitIdentities.companies.a);
    const defaultId = randomUUID();
    await insertList({
      id: defaultId,
      companyId: kitIdentities.companies.a,
      name: "Protected default",
      isDefault: true,
    });

    const error = await kit.invoke(deactivatePriceList, { id: defaultId }).then(
      () => {
        throw new Error("expected ValidationError for the default list");
      },
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ValidationError);
    if (error instanceof ValidationError) {
      expect(error.clientMessage).toBe(
        "The default price list cannot be deactivated.",
      );
    }
    expect(await listRow(defaultId)).toMatchObject({
      isDefault: true,
      isActive: true,
    });
    expect(await countDefaultLists(kitIdentities.companies.a)).toBe(1);
  });

  it("denies staff without pricing:manage", async () => {
    await expect(
      kit.invoke(
        deactivatePriceList,
        { id: fixtures.listIdemSetConflict },
        { userId: clerks.viewOnly, companyId: kitIdentities.companies.a },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("returns the same not-found for missing and foreign lists", async () => {
    const missingId = randomUUID();
    const missingError = await kit
      .invoke(deactivatePriceList, { id: missingId })
      .then(
        () => {
          throw new Error("expected NotFoundError for a missing price list");
        },
        (error: unknown) => error,
      );
    const foreignError = await kit
      .invoke(deactivatePriceList, { id: fixtures.listDeactivateB })
      .then(
        () => {
          throw new Error("expected NotFoundError for a foreign price list");
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

describe("pricing.resolveProductPrices with no company default", () => {
  it("skips level 4 and uses catalog base after the default is cleared", async () => {
    await kit.invoke(setDefaultPriceList, {
      priceListId: fixtures.listIdemSet,
    });
    const withDefault = await kit.invoke(resolveProductPrices, {
      items: [{ productId: fixtures.productResolve }],
    });
    expect(withDefault.prices[0]).toMatchObject({
      unitPriceMinor: "400",
      source: "default_price_list",
      sourceIds: {
        priceListId: fixtures.listIdemSet,
        entryId: fixtures.entryResolve,
      },
    });

    await kit.invoke(setDefaultPriceList, { priceListId: null });
    expect(await countDefaultLists(kitIdentities.companies.a)).toBe(0);

    const withoutDefault = await kit.invoke(resolveProductPrices, {
      items: [{ productId: fixtures.productResolve }],
    });
    expect(withoutDefault.prices[0]).toMatchObject({
      productId: fixtures.productResolve,
      unitPriceMinor: "1500",
      source: "base",
      sourceIds: {},
    });
  });
});
