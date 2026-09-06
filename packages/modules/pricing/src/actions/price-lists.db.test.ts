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

import { PRICE_LIST_NAME_MAX } from "./list-price-lists.contract.js";
import { createPriceList } from "./create-price-list.js";
import { updatePriceList } from "./update-price-list.js";

const fixtures = {
  listUpdateA: randomUUID(),
  listUpdateB: randomUUID(),
  listIdem: randomUUID(),
  productA: randomUUID(),
  entryA: randomUUID(),
};

const clerks = {
  viewOnly: randomUUID(),
};

const createIsolationInput = {
  name: "Isolation create A",
};

const updateIsolationOwn = {
  id: fixtures.listUpdateA,
  name: "Isolation updated A",
};

const updateIsolationForeign = {
  id: fixtures.listUpdateB,
  name: "Isolation updated B",
};

let kit: TestKit;

async function countCompanyLists(companyId: string): Promise<number> {
  const rows = await kit.db.runtime.db
    .select({ id: priceLists.id })
    .from(priceLists)
    .where(eq(priceLists.companyId, companyId));
  return rows.length;
}

async function countDefaultLists(companyId: string): Promise<number> {
  const rows = await kit.db.runtime.db
    .select({ id: priceLists.id })
    .from(priceLists)
    .where(
      and(eq(priceLists.companyId, companyId), eq(priceLists.isDefault, true)),
    );
  return rows.length;
}

async function countUpdateAudits(listId: string): Promise<number> {
  const rows = await kit.db.runtime.db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, "pricing.updatePriceList"),
        eq(auditLog.targetId, listId),
        eq(auditLog.outcome, "ok"),
      ),
    );
  return rows.length;
}

async function listRow(listId: string) {
  const rows = await kit.db.runtime.db
    .select()
    .from(priceLists)
    .where(eq(priceLists.id, listId));
  return rows[0];
}

beforeAll(async () => {
  kit = await createTestKit();

  await kit.db.runtime.db.insert(priceLists).values([
    {
      id: fixtures.listUpdateA,
      companyId: kitIdentities.companies.a,
      name: "Update Alpha",
    },
    {
      id: fixtures.listUpdateB,
      companyId: kitIdentities.companies.b,
      name: "Update Bravo",
    },
    {
      id: fixtures.listIdem,
      companyId: kitIdentities.companies.a,
      name: "Idem Target",
    },
  ]);

  await kit.db.runtime.db.insert(products).values({
    id: fixtures.productA,
    companyId: kitIdentities.companies.a,
    name: "Cake",
    basePriceMinor: 1500n,
  });
  await kit.db.runtime.db.insert(priceListEntries).values({
    id: fixtures.entryA,
    companyId: kitIdentities.companies.a,
    priceListId: fixtures.listUpdateA,
    productId: fixtures.productA,
    priceMinor: 1200n,
  });

  await kit.db.runtime.db.insert(user).values({
    id: clerks.viewOnly,
    name: "Viewer",
    email: "viewer@pricing-writes.test",
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
      createPriceList,
      { input: createIsolationInput },
      { input: createIsolationInput, companyId: kitIdentities.companies.b },
    ),
    isolationCase(
      updatePriceList,
      { input: updateIsolationOwn },
      { input: updateIsolationForeign },
    ),
  ],
);

idempotencySuite(
  () => kit,
  [
    {
      action: createPriceList,
      input: { name: "Idem Create" },
      conflictingInput: { name: "Idem Create Other" },
      readEffect: () => countCompanyLists(kitIdentities.companies.a),
    },
    {
      action: updatePriceList,
      input: {
        id: fixtures.listIdem,
        name: "Idem Updated",
      },
      conflictingInput: {
        id: fixtures.listIdem,
        name: "Idem Conflicting",
      },
      readEffect: () => countUpdateAudits(fixtures.listIdem),
    },
  ],
);

describe("pricing.createPriceList", () => {
  it("creates a non-default active list with entryCount 0 and audits once", async () => {
    const requestId = randomUUID();
    const result = await kit.invoke(
      createPriceList,
      { name: "  Оптовий  " },
      {},
      { request: { requestId } },
    );

    expect(result).toMatchObject({
      name: "Оптовий",
      isDefault: false,
      isActive: true,
      entryCount: 0,
    });
    expect(typeof result.id).toBe("string");
    expect(typeof result.createdAt).toBe("string");
    expect(typeof result.updatedAt).toBe("string");

    const row = await listRow(result.id);
    expect(row).toMatchObject({
      id: result.id,
      companyId: kitIdentities.companies.a,
      name: "Оптовий",
      isDefault: false,
      isActive: true,
    });

    const auditRows = await kit.db.runtime.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.requestId, requestId));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: "pricing.createPriceList",
      companyId: kitIdentities.companies.a,
      actorType: "user",
      actorId: kitIdentities.users.anna,
      targetType: "price_list",
      targetId: result.id,
      outcome: "ok",
      inputSnapshot: null,
    });

    const eventRows = await kit.db.runtime.db
      .select({ id: domainEvents.id })
      .from(domainEvents)
      .where(eq(domainEvents.requestId, requestId));
    expect(eventRows).toEqual([]);
  });

  it("creates as default, unsets the previous default, and stores isActive true even when input isActive is false", async () => {
    const previous = await kit.invoke(createPriceList, {
      name: "Previous default",
      isDefault: true,
    });
    expect(previous).toMatchObject({
      isDefault: true,
      isActive: true,
    });

    const created = await kit.invoke(createPriceList, {
      name: "New default",
      isDefault: true,
      isActive: false,
    });
    expect(created).toMatchObject({
      name: "New default",
      isDefault: true,
      isActive: true,
      entryCount: 0,
    });

    const previousRow = await listRow(previous.id);
    expect(previousRow).toMatchObject({
      id: previous.id,
      isDefault: false,
      isActive: true,
    });
    const createdRow = await listRow(created.id);
    expect(createdRow).toMatchObject({
      id: created.id,
      isDefault: true,
      isActive: true,
    });
    expect(await countDefaultLists(kitIdentities.companies.a)).toBe(1);
  });

  it("denies staff without pricing:manage", async () => {
    await expect(
      kit.invoke(
        createPriceList,
        { name: "Denied" },
        { userId: clerks.viewOnly, companyId: kitIdentities.companies.a },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("rejects blank names, over-max names, and companyId", async () => {
    const before = await countCompanyLists(kitIdentities.companies.a);
    const invalidInputs: unknown[] = [
      { name: "   " },
      { name: "x".repeat(PRICE_LIST_NAME_MAX + 1) },
      { name: "VIP", companyId: kitIdentities.companies.a },
    ];
    for (const input of invalidInputs) {
      await expect(kit.invoke(createPriceList, input)).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
    expect(await countCompanyLists(kitIdentities.companies.a)).toBe(before);
  });
});

describe("pricing.createPriceList provenance (SHO-465)", () => {
  it("stores ctx.channel and leaves vouched columns null", async () => {
    const viaUi = await kit.invoke(
      createPriceList,
      { name: "Provenance UI list" },
      {},
      { request: { channel: "ui" } },
    );
    const viaAi = await kit.invoke(
      createPriceList,
      { name: "Provenance AI list" },
      {},
      { request: { channel: "ai", aiTraceId: "sho-465-list" } },
    );
    expect(await listRow(viaUi.id)).toMatchObject({
      createdVia: "ui",
      vouchedBy: null,
      vouchedAt: null,
    });
    expect(await listRow(viaAi.id)).toMatchObject({
      createdVia: "ai",
      vouchedBy: null,
      vouchedAt: null,
    });
  });
});

describe("pricing.updatePriceList", () => {
  it("renames the list, keeps entryCount, and audits once", async () => {
    const requestId = randomUUID();
    const result = await kit.invoke(
      updatePriceList,
      { id: fixtures.listUpdateA, name: "  After  " },
      {},
      { request: { requestId } },
    );

    expect(result).toMatchObject({
      id: fixtures.listUpdateA,
      name: "After",
      isDefault: false,
      isActive: true,
      entryCount: 1,
    });

    const row = await listRow(fixtures.listUpdateA);
    expect(row).toMatchObject({
      name: "After",
      companyId: kitIdentities.companies.a,
    });

    const auditRows = await kit.db.runtime.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.requestId, requestId));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: "pricing.updatePriceList",
      companyId: kitIdentities.companies.a,
      targetType: "price_list",
      targetId: fixtures.listUpdateA,
      outcome: "ok",
      inputSnapshot: null,
    });
  });

  it("denies staff without pricing:manage", async () => {
    await expect(
      kit.invoke(
        updatePriceList,
        { id: fixtures.listUpdateA, name: "Nope" },
        { userId: clerks.viewOnly, companyId: kitIdentities.companies.a },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("returns the same not-found for missing and foreign lists", async () => {
    const missingId = randomUUID();
    const missingError = await kit
      .invoke(updatePriceList, { id: missingId, name: "Ghost" })
      .then(
        () => {
          throw new Error("expected NotFoundError for a missing price list");
        },
        (error: unknown) => error,
      );
    const foreignError = await kit
      .invoke(updatePriceList, {
        id: fixtures.listUpdateB,
        name: "Ghost",
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

    const foreignRow = await listRow(fixtures.listUpdateB);
    expect(foreignRow?.name).toBe("Update Bravo");
    expect(foreignRow?.companyId).toBe(kitIdentities.companies.b);
  });

  it("rejects blank names, over-max names, companyId, and default/active flags", async () => {
    const invalidInputs: unknown[] = [
      { id: fixtures.listUpdateA, name: "   " },
      {
        id: fixtures.listUpdateA,
        name: "x".repeat(PRICE_LIST_NAME_MAX + 1),
      },
      {
        id: fixtures.listUpdateA,
        name: "Cake",
        companyId: kitIdentities.companies.a,
      },
      { id: fixtures.listUpdateA, name: "Cake", isDefault: true },
      { id: fixtures.listUpdateA, name: "Cake", isActive: false },
      { id: "not-a-uuid", name: "Cake" },
    ];
    for (const input of invalidInputs) {
      await expect(kit.invoke(updatePriceList, input)).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
  });
});
