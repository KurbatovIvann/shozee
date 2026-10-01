import { randomUUID } from "node:crypto";

import {
  CONFIRMATION_TTL_MS,
  createConfirmationHook,
  createInMemoryConfirmationStore,
  type ActionPipelineDeps,
  type ConfirmationHook,
} from "@showzy/core";
import {
  ConfirmationRequiredError,
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
import { companyCustomers, customerGroups } from "@showzy/db/schema/customers";
import { priceListEntries, priceLists } from "@showzy/db/schema/pricing";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  deletePriceList,
  deletePriceListConfirmationSummary,
} from "./delete-price-list.js";
import { PRICING_RESOLVER_VERSION } from "./resolve-product-prices.contract.js";
import { resolveProductPrices } from "./resolve-product-prices.js";

const fixtures = {
  isolationOwn: randomUUID(),
  isolationForeign: randomUUID(),
  listIdem: randomUUID(),
  listConcurrent: randomUUID(),
  happyList: randomUUID(),
  denyTarget: randomUUID(),
  productHappy: randomUUID(),
  entryHappy: randomUUID(),
  groupAssigned: randomUUID(),
  customerAssigned: randomUUID(),
};

const clerks = {
  viewOnly: randomUUID(),
};

let kit: TestKit;

/**
 * The core test kit omits the confirmation slot (`kitProtocolHooks`).
 * Inherited isolation/idempotency suites invoke once and do not complete
 * a challenge, so this file attaches an auto-grant for those suites.
 * Protocol tests compose the real in-memory store via `deps`.
 */
function autoConfirmHook(): ConfirmationHook {
  return {
    gate: () => {
      const confirmedAt = new Date();
      return Promise.resolve({
        challengeId: randomUUID(),
        confirmedAt,
        expiresAt: new Date(confirmedAt.getTime() + CONFIRMATION_TTL_MS),
      });
    },
  };
}

function attachAutoConfirm(target: TestKit): void {
  const hooks = target.pipeline.hooks;
  if (hooks === undefined) {
    throw new Error("test kit pipeline is missing protocol hooks");
  }
  Object.assign(hooks, { confirmation: autoConfirmHook() });
}

function confirmationPipeline(target: TestKit): ActionPipelineDeps {
  return {
    ...target.pipeline,
    hooks: {
      ...target.pipeline.hooks,
      confirmation: createConfirmationHook({
        store: createInMemoryConfirmationStore(),
      }),
    },
  };
}

async function countOkDeleteAudits(): Promise<number> {
  const rows = await kit.db.runtime.db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, "pricing.deletePriceList"),
        eq(auditLog.outcome, "ok"),
      ),
    );
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

async function listRow(listId: string) {
  const rows = await kit.db.runtime.db
    .select()
    .from(priceLists)
    .where(eq(priceLists.id, listId));
  return rows[0];
}

async function entryRows(listId: string) {
  return kit.db.runtime.db
    .select()
    .from(priceListEntries)
    .where(eq(priceListEntries.priceListId, listId));
}

async function groupRow(groupId: string) {
  const rows = await kit.db.runtime.db
    .select()
    .from(customerGroups)
    .where(eq(customerGroups.id, groupId));
  return rows[0];
}

async function customerRow(customerId: string) {
  const rows = await kit.db.runtime.db
    .select()
    .from(companyCustomers)
    .where(eq(companyCustomers.id, customerId));
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

beforeAll(async () => {
  kit = await createTestKit();
  attachAutoConfirm(kit);

  await insertList({
    id: fixtures.isolationOwn,
    companyId: kitIdentities.companies.a,
    name: "Delete Isolation A",
  });
  await insertList({
    id: fixtures.isolationForeign,
    companyId: kitIdentities.companies.b,
    name: "Delete Isolation B",
  });
  await insertList({
    id: fixtures.listIdem,
    companyId: kitIdentities.companies.a,
    name: "Delete Idem",
  });
  await insertList({
    id: fixtures.listConcurrent,
    companyId: kitIdentities.companies.a,
    name: "Delete Concurrent",
  });
  await insertList({
    id: fixtures.happyList,
    companyId: kitIdentities.companies.a,
    name: "Happy Delete",
  });
  await insertList({
    id: fixtures.denyTarget,
    companyId: kitIdentities.companies.a,
    name: "Deny Target",
  });

  await kit.db.runtime.db.insert(products).values({
    id: fixtures.productHappy,
    companyId: kitIdentities.companies.a,
    name: "Happy product",
    basePriceMinor: 1500n,
  });
  await kit.db.runtime.db.insert(priceListEntries).values({
    id: fixtures.entryHappy,
    companyId: kitIdentities.companies.a,
    priceListId: fixtures.happyList,
    productId: fixtures.productHappy,
    priceMinor: 1200n,
  });

  // SET NULL DoD: db-test-only insert of customers-owned rows. Production
  // pricing code does not import `@showzy/db/schema/customers` (ADR-0014);
  // import-boundaries skip `*.db.test.ts`. Schema already SET NULLs
  // `price_list_id` (migration 0011).
  await kit.db.runtime.db.insert(customerGroups).values({
    id: fixtures.groupAssigned,
    companyId: kitIdentities.companies.a,
    name: "Assigned group",
    slug: `assigned-${fixtures.groupAssigned}`,
    priceListId: fixtures.happyList,
  });
  await kit.db.runtime.db.insert(companyCustomers).values({
    id: fixtures.customerAssigned,
    companyId: kitIdentities.companies.a,
    name: "Assigned customer",
    email: `assigned-${fixtures.customerAssigned}@example.com`,
    priceListId: fixtures.happyList,
  });

  await kit.db.runtime.db.insert(user).values({
    id: clerks.viewOnly,
    name: "Viewer",
    email: "viewer@pricing-delete-price-list.test",
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
      deletePriceList,
      { input: { id: fixtures.isolationOwn } },
      { input: { id: fixtures.isolationForeign } },
    ),
  ],
);

idempotencySuite(
  () => kit,
  [
    {
      action: deletePriceList,
      input: { id: fixtures.listIdem },
      conflictingInput: { id: fixtures.isolationForeign },
      freshInput: () => ({ id: fixtures.listConcurrent }),
      readEffect: () => countOkDeleteAudits(),
    },
  ],
);

describe("pricing.deletePriceList", () => {
  it("deletes a non-default list, cascades entries, SET NULLs assignments, and audits once", async () => {
    const requestId = randomUUID();
    const result = await kit.invoke(
      deletePriceList,
      { id: fixtures.happyList },
      {},
      { request: { requestId } },
    );

    expect(result).toEqual({ id: fixtures.happyList });
    expect(await listRow(fixtures.happyList)).toBeUndefined();
    expect(await entryRows(fixtures.happyList)).toEqual([]);

    expect(await groupRow(fixtures.groupAssigned)).toMatchObject({
      id: fixtures.groupAssigned,
      companyId: kitIdentities.companies.a,
      name: "Assigned group",
      priceListId: null,
    });
    expect(await customerRow(fixtures.customerAssigned)).toMatchObject({
      id: fixtures.customerAssigned,
      companyId: kitIdentities.companies.a,
      name: "Assigned customer",
      priceListId: null,
    });

    const auditRows = await kit.db.runtime.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.requestId, requestId));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: "pricing.deletePriceList",
      companyId: kitIdentities.companies.a,
      actorType: "user",
      actorId: kitIdentities.users.anna,
      targetType: "price_list",
      targetId: fixtures.happyList,
      outcome: "ok",
      inputSnapshot: null,
    });

    const eventRows = await kit.db.runtime.db
      .select({ id: domainEvents.id })
      .from(domainEvents)
      .where(eq(domainEvents.requestId, requestId));
    expect(eventRows).toEqual([]);
  });

  it("deletes the default list and leaves zero defaults", async () => {
    const defaultId = randomUUID();
    await insertList({
      id: defaultId,
      companyId: kitIdentities.companies.a,
      name: "Default to delete",
      isDefault: true,
    });
    expect(await countDefaultLists(kitIdentities.companies.a)).toBe(1);

    const result = await kit.invoke(deletePriceList, { id: defaultId });
    expect(result).toEqual({ id: defaultId });
    expect(await listRow(defaultId)).toBeUndefined();
    expect(await countDefaultLists(kitIdentities.companies.a)).toBe(0);
  });

  it("rejects an unconfirmed call and executes after the challenge", async () => {
    const listId = randomUUID();
    await insertList({
      id: listId,
      companyId: kitIdentities.companies.a,
      name: "Confirm me",
    });

    const deps = confirmationPipeline(kit);
    const idempotencyKey = randomUUID();
    const unconfirmed = await kit
      .invoke(
        deletePriceList,
        { id: listId },
        {},
        { deps, request: { idempotencyKey } },
      )
      .then(
        () => {
          throw new Error("expected ConfirmationRequiredError");
        },
        (error: unknown) => error,
      );

    expect(unconfirmed).toBeInstanceOf(ConfirmationRequiredError);
    expect(await listRow(listId)).toMatchObject({ id: listId });
    if (!(unconfirmed instanceof ConfirmationRequiredError)) {
      throw new Error("expected ConfirmationRequiredError");
    }
    expect(unconfirmed.challenge.summary).toBe(
      deletePriceListConfirmationSummary,
    );
    expect(unconfirmed.challenge.summary).toContain(
      "Усі ціни в ньому буде видалено",
    );
    expect(unconfirmed.challenge.summary).not.toContain("Confirm me");
    expect(Date.parse(unconfirmed.challenge.expiresAt)).toBeGreaterThan(
      Date.now(),
    );

    const confirmed = await kit.invoke(
      deletePriceList,
      { id: listId },
      {},
      {
        deps,
        request: {
          idempotencyKey,
          confirmationChallengeId: unconfirmed.challenge.challengeId,
        },
      },
    );
    expect(confirmed).toEqual({ id: listId });
    expect(await listRow(listId)).toBeUndefined();
  });

  it("denies staff without pricing:manage", async () => {
    const input = { id: fixtures.denyTarget };
    await expect(
      kit.invoke(deletePriceList, input, {
        userId: clerks.viewOnly,
        companyId: kitIdentities.companies.a,
      }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(await listRow(fixtures.denyTarget)).toMatchObject({
      id: fixtures.denyTarget,
      companyId: kitIdentities.companies.a,
    });
  });

  it("returns the same not-found for missing, already-deleted, and foreign lists", async () => {
    const missingId = randomUUID();
    const secondDeleteId = randomUUID();
    await insertList({
      id: secondDeleteId,
      companyId: kitIdentities.companies.a,
      name: "Second delete",
    });
    await kit.invoke(deletePriceList, { id: secondDeleteId });

    const missingError = await kit
      .invoke(deletePriceList, { id: missingId })
      .catch((error: unknown) => error);
    const alreadyDeleted = await kit
      .invoke(deletePriceList, { id: secondDeleteId })
      .catch((error: unknown) => error);
    const foreignError = await kit
      .invoke(deletePriceList, { id: fixtures.isolationForeign })
      .catch((error: unknown) => error);

    expect(missingError).toBeInstanceOf(NotFoundError);
    expect(alreadyDeleted).toBeInstanceOf(NotFoundError);
    expect(foreignError).toBeInstanceOf(NotFoundError);
    if (
      missingError instanceof NotFoundError &&
      alreadyDeleted instanceof NotFoundError &&
      foreignError instanceof NotFoundError
    ) {
      expect(missingError.clientMessage).toBe(alreadyDeleted.clientMessage);
      expect(missingError.clientMessage).toBe(foreignError.clientMessage);
    }

    const foreignRow = await listRow(fixtures.isolationForeign);
    expect(foreignRow?.name).toBe("Delete Isolation B");
    expect(foreignRow?.companyId).toBe(kitIdentities.companies.b);
  });

  it("replays the stored acknowledgement for the same idempotency key after delete", async () => {
    const listId = randomUUID();
    await insertList({
      id: listId,
      companyId: kitIdentities.companies.a,
      name: "Replay delete",
    });
    const idempotencyKey = randomUUID();
    const first = await kit.invoke(
      deletePriceList,
      { id: listId },
      {},
      { request: { idempotencyKey } },
    );
    expect(first).toEqual({ id: listId });
    expect(await listRow(listId)).toBeUndefined();

    const replay = await kit.invoke(
      deletePriceList,
      { id: listId },
      {},
      { request: { idempotencyKey } },
    );
    expect(replay).toEqual({ id: listId });
    expect(await listRow(listId)).toBeUndefined();
  });

  it("resolves from catalog base after deleting the default list", async () => {
    const productId = randomUUID();
    const defaultId = randomUUID();
    const entryId = randomUUID();
    await kit.db.runtime.db.insert(products).values({
      id: productId,
      companyId: kitIdentities.companies.a,
      name: "Resolve after delete",
      basePriceMinor: 1500n,
    });
    await insertList({
      id: defaultId,
      companyId: kitIdentities.companies.a,
      name: "Default for resolve",
      isDefault: true,
    });
    await kit.db.runtime.db.insert(priceListEntries).values({
      id: entryId,
      companyId: kitIdentities.companies.a,
      priceListId: defaultId,
      productId,
      priceMinor: 400n,
    });

    const before = await kit.invoke(resolveProductPrices, {
      items: [{ productId }],
    });
    expect(before.prices[0]).toMatchObject({
      unitPriceMinor: "400",
      source: "default_price_list",
      sourceIds: {
        priceListId: defaultId,
        entryId,
      },
    });

    await kit.invoke(deletePriceList, { id: defaultId });
    expect(await countDefaultLists(kitIdentities.companies.a)).toBe(0);

    const after = await kit.invoke(resolveProductPrices, {
      items: [{ productId }],
    });
    expect(after.prices[0]).toEqual({
      productId,
      variantId: null,
      unitPriceMinor: "1500",
      currency: "UAH",
      source: "base",
      matchLevel: "product",
      sourceIds: {},
      resolverVersion: PRICING_RESOLVER_VERSION,
    });
  });

  it("rejects a missing id, a malformed id, and companyId on input", async () => {
    const invalidInputs: unknown[] = [
      {},
      { id: "not-a-uuid" },
      {
        id: fixtures.isolationForeign,
        companyId: kitIdentities.companies.a,
      },
    ];
    for (const input of invalidInputs) {
      await expect(kit.invoke(deletePriceList, input)).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
    expect(await listRow(fixtures.isolationForeign)).toMatchObject({
      companyId: kitIdentities.companies.b,
    });
  });
});
