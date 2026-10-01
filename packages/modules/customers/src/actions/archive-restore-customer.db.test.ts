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
import { companyMembers } from "@showzy/db/schema/companies";
import {
  companyCustomers,
  counterparties,
  customerGroups,
} from "@showzy/db/schema/customers";
import { priceLists } from "@showzy/db/schema/pricing";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { archiveCustomer } from "./archive-customer.js";
import { getCustomerPricingFacts } from "./get-customer-pricing-facts.js";
import { restoreCustomer } from "./restore-customer.js";

const fixtures = {
  customerHappy: randomUUID(),
  customerRestore: randomUUID(),
  customerColumns: randomUUID(),
  customerIsolationArchiveA: randomUUID(),
  customerIsolationArchiveB: randomUUID(),
  customerIsolationRestoreA: randomUUID(),
  customerIsolationRestoreB: randomUUID(),
  customerIdempotencyArchive: randomUUID(),
  customerIdempotencyArchiveFresh: randomUUID(),
  customerIdempotencyRestore: randomUUID(),
  customerIdempotencyRestoreFresh: randomUUID(),
  customerFacts: randomUUID(),
  customerWithParty: randomUUID(),
  groupA: randomUUID(),
  listA: randomUUID(),
  partyA: randomUUID(),
};

const clerks = {
  viewOnly: randomUUID(),
  deleteOnly: randomUUID(),
};

let kit: TestKit;

async function customerRow(id: string) {
  const rows = await kit.db.runtime.db
    .select()
    .from(companyCustomers)
    .where(eq(companyCustomers.id, id));
  return rows[0];
}

async function countCustomerIdsWithStatus(
  ids: readonly string[],
  status: "active" | "archived",
): Promise<number> {
  const rows = await kit.db.runtime.db
    .select({ id: companyCustomers.id })
    .from(companyCustomers)
    .where(
      and(
        inArray(companyCustomers.id, [...ids]),
        eq(companyCustomers.status, status),
      ),
    );
  return rows.length;
}

beforeAll(async () => {
  kit = await createTestKit();

  await kit.db.runtime.db.insert(priceLists).values({
    id: fixtures.listA,
    companyId: kitIdentities.companies.a,
    name: "Retail A",
  });
  await kit.db.runtime.db.insert(customerGroups).values({
    id: fixtures.groupA,
    companyId: kitIdentities.companies.a,
    name: "Wholesale",
    slug: "wholesale",
    priceListId: fixtures.listA,
  });

  await kit.db.runtime.db.insert(companyCustomers).values([
    {
      id: fixtures.customerHappy,
      companyId: kitIdentities.companies.a,
      name: "Happy archive",
      phone: "+380501000101",
      notes: "keep notes",
      groupId: fixtures.groupA,
      priceListId: fixtures.listA,
    },
    {
      id: fixtures.customerRestore,
      companyId: kitIdentities.companies.a,
      name: "Happy restore",
      email: "restore@kit.test",
      groupId: fixtures.groupA,
      status: "archived",
    },
    {
      id: fixtures.customerColumns,
      companyId: kitIdentities.companies.a,
      name: "Columns stay",
      phone: "+380501000102",
      notes: "unchanged",
      groupId: fixtures.groupA,
    },
    {
      id: fixtures.customerIsolationArchiveA,
      companyId: kitIdentities.companies.a,
      name: "Isolation archive A",
      phone: "+380501000103",
    },
    {
      id: fixtures.customerIsolationArchiveB,
      companyId: kitIdentities.companies.b,
      name: "Isolation archive B",
      phone: "+380501000104",
    },
    {
      id: fixtures.customerIsolationRestoreA,
      companyId: kitIdentities.companies.a,
      name: "Isolation restore A",
      phone: "+380501000105",
      status: "archived",
    },
    {
      id: fixtures.customerIsolationRestoreB,
      companyId: kitIdentities.companies.b,
      name: "Isolation restore B",
      phone: "+380501000106",
      status: "archived",
    },
    {
      id: fixtures.customerIdempotencyArchive,
      companyId: kitIdentities.companies.a,
      name: "Idempotency archive",
      phone: "+380501000107",
    },
    {
      id: fixtures.customerIdempotencyArchiveFresh,
      companyId: kitIdentities.companies.a,
      name: "Idempotency archive fresh",
      phone: "+380501000108",
    },
    {
      id: fixtures.customerIdempotencyRestore,
      companyId: kitIdentities.companies.a,
      name: "Idempotency restore",
      phone: "+380501000109",
      status: "archived",
    },
    {
      id: fixtures.customerIdempotencyRestoreFresh,
      companyId: kitIdentities.companies.a,
      name: "Idempotency restore fresh",
      phone: "+380501000110",
      status: "archived",
    },
    {
      id: fixtures.customerFacts,
      companyId: kitIdentities.companies.a,
      name: "Facts stay visible",
      email: "facts@kit.test",
      groupId: fixtures.groupA,
      priceListId: fixtures.listA,
    },
    {
      id: fixtures.customerWithParty,
      companyId: kitIdentities.companies.a,
      name: "Has party",
      email: "party@kit.test",
    },
  ]);

  await kit.db.runtime.db.insert(counterparties).values({
    id: fixtures.partyA,
    companyId: kitIdentities.companies.a,
    customerId: fixtures.customerWithParty,
    name: "ТОВ Партнер",
  });

  await kit.db.runtime.db.insert(user).values([
    {
      id: clerks.viewOnly,
      name: "Viewer",
      email: "viewer@customers-archive.test",
    },
    {
      id: clerks.deleteOnly,
      name: "Deleter",
      email: "deleter@customers-archive.test",
    },
  ]);
  await kit.db.runtime.db.insert(companyMembers).values([
    {
      companyId: kitIdentities.companies.a,
      userId: clerks.viewOnly,
      role: "employee",
      permissions: { granted: [], denied: [] },
    },
    {
      companyId: kitIdentities.companies.a,
      userId: clerks.deleteOnly,
      role: "employee",
      permissions: { granted: ["customers:delete"], denied: [] },
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
      archiveCustomer,
      { input: { id: fixtures.customerIsolationArchiveA } },
      { input: { id: fixtures.customerIsolationArchiveB } },
      { missing: { input: { id: randomUUID() } } },
    ),
    isolationCase(
      restoreCustomer,
      { input: { id: fixtures.customerIsolationRestoreA } },
      { input: { id: fixtures.customerIsolationRestoreB } },
      { missing: { input: { id: randomUUID() } } },
    ),
  ],
);

idempotencySuite(
  () => kit,
  [
    {
      action: archiveCustomer,
      input: { id: fixtures.customerIdempotencyArchive },
      conflictingInput: {
        id: fixtures.customerIdempotencyArchiveFresh,
      },
      freshInput: () => ({
        id: fixtures.customerIdempotencyArchiveFresh,
      }),
      readEffect: () =>
        countCustomerIdsWithStatus(
          [
            fixtures.customerIdempotencyArchive,
            fixtures.customerIdempotencyArchiveFresh,
          ],
          "archived",
        ),
    },
    {
      action: restoreCustomer,
      input: { id: fixtures.customerIdempotencyRestore },
      conflictingInput: {
        id: fixtures.customerIdempotencyRestoreFresh,
      },
      freshInput: () => ({
        id: fixtures.customerIdempotencyRestoreFresh,
      }),
      readEffect: () =>
        countCustomerIdsWithStatus(
          [
            fixtures.customerIdempotencyRestore,
            fixtures.customerIdempotencyRestoreFresh,
          ],
          "active",
        ),
    },
  ],
);

describe("customers archive/restore", () => {
  it("archives an active customer and keeps group membership", async () => {
    const requestId = randomUUID();
    const archived = await kit.invoke(
      archiveCustomer,
      { id: fixtures.customerHappy },
      {},
      { request: { requestId } },
    );
    expect(archived).toMatchObject({
      id: fixtures.customerHappy,
      name: "Happy archive",
      phone: "+380501000101",
      notes: "keep notes",
      groupId: fixtures.groupA,
      priceListId: fixtures.listA,
      status: "archived",
      linkedCounterpartyCount: 0,
    });
    const row = await customerRow(fixtures.customerHappy);
    expect(row?.status).toBe("archived");
    expect(row?.groupId).toBe(fixtures.groupA);
    expect(row?.priceListId).toBe(fixtures.listA);
    expect(row?.name).toBe("Happy archive");
    expect(row?.notes).toBe("keep notes");

    const auditRows = await kit.db.runtime.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.requestId, requestId));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: "customers.archiveCustomer",
      companyId: kitIdentities.companies.a,
      actorType: "user",
      actorId: kitIdentities.users.anna,
      targetType: "customer",
      targetId: fixtures.customerHappy,
      outcome: "ok",
      inputSnapshot: null,
    });

    const eventRows = await kit.db.runtime.db
      .select({ id: domainEvents.id })
      .from(domainEvents)
      .where(eq(domainEvents.requestId, requestId));
    expect(eventRows).toEqual([]);
  });

  it("restores an archived customer without dropping the group", async () => {
    const requestId = randomUUID();
    const restored = await kit.invoke(
      restoreCustomer,
      { id: fixtures.customerRestore },
      {},
      { request: { requestId } },
    );
    expect(restored).toMatchObject({
      id: fixtures.customerRestore,
      name: "Happy restore",
      email: "restore@kit.test",
      groupId: fixtures.groupA,
      status: "active",
      linkedCounterpartyCount: 0,
    });
    const restoredRow = await customerRow(fixtures.customerRestore);
    expect(restoredRow?.status).toBe("active");
    expect(restoredRow?.groupId).toBe(fixtures.groupA);

    const restoreAudit = await kit.db.runtime.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.requestId, requestId));
    expect(restoreAudit).toHaveLength(1);
    expect(restoreAudit[0]).toMatchObject({
      action: "customers.restoreCustomer",
      actorType: "user",
      actorId: kitIdentities.users.anna,
      targetType: "customer",
      targetId: fixtures.customerRestore,
      outcome: "ok",
    });
    const restoreEvents = await kit.db.runtime.db
      .select({ id: domainEvents.id })
      .from(domainEvents)
      .where(eq(domainEvents.requestId, requestId));
    expect(restoreEvents).toEqual([]);
  });

  it("treats a repeat archive or restore as an idempotent no-op", async () => {
    const first = await kit.invoke(archiveCustomer, {
      id: fixtures.customerColumns,
    });
    const beforeRepeat = await customerRow(fixtures.customerColumns);
    expect(first.status).toBe("archived");
    expect(first.linkedCounterpartyCount).toBe(0);
    expect(beforeRepeat?.name).toBe("Columns stay");
    expect(beforeRepeat?.phone).toBe("+380501000102");
    expect(beforeRepeat?.notes).toBe("unchanged");
    expect(beforeRepeat?.groupId).toBe(fixtures.groupA);

    const second = await kit.invoke(archiveCustomer, {
      id: fixtures.customerColumns,
    });
    const afterRepeat = await customerRow(fixtures.customerColumns);
    expect(second).toEqual(first);
    expect(afterRepeat?.name).toBe(beforeRepeat?.name);
    expect(afterRepeat?.phone).toBe(beforeRepeat?.phone);
    expect(afterRepeat?.notes).toBe(beforeRepeat?.notes);
    expect(afterRepeat?.groupId).toBe(beforeRepeat?.groupId);
    expect(afterRepeat?.updatedAt.getTime()).toBe(
      beforeRepeat?.updatedAt.getTime(),
    );

    const restoredOnce = await kit.invoke(restoreCustomer, {
      id: fixtures.customerColumns,
    });
    const restoredBeforeRepeat = await customerRow(fixtures.customerColumns);
    expect(restoredOnce.status).toBe("active");
    const restoreAgain = await kit.invoke(restoreCustomer, {
      id: fixtures.customerColumns,
    });
    const restoredAfterRepeat = await customerRow(fixtures.customerColumns);
    expect(restoreAgain).toEqual(restoredOnce);
    expect(restoredAfterRepeat?.name).toBe(restoredBeforeRepeat?.name);
    expect(restoredAfterRepeat?.groupId).toBe(restoredBeforeRepeat?.groupId);
    expect(restoredAfterRepeat?.updatedAt.getTime()).toBe(
      restoredBeforeRepeat?.updatedAt.getTime(),
    );
  });

  it("returns linked counterparties on archive and keeps pricing facts", async () => {
    const archivedParty = await kit.invoke(archiveCustomer, {
      id: fixtures.customerWithParty,
    });
    expect(archivedParty).toMatchObject({
      id: fixtures.customerWithParty,
      status: "archived",
      linkedCounterpartyCount: 1,
      groupId: null,
    });

    await kit.invoke(archiveCustomer, { id: fixtures.customerFacts });
    await expect(
      kit.invoke(getCustomerPricingFacts, {
        customerId: fixtures.customerFacts,
      }),
    ).resolves.toEqual({
      priceListId: fixtures.listA,
      groupId: fixtures.groupA,
      groupPriceListId: fixtures.listA,
    });
    expect((await customerRow(fixtures.customerFacts))?.status).toBe(
      "archived",
    );
  });

  it("denies staff with only customers:view and staff with only customers:delete", async () => {
    const viewActor = {
      userId: clerks.viewOnly,
      companyId: kitIdentities.companies.a,
    };
    const deleteActor = {
      userId: clerks.deleteOnly,
      companyId: kitIdentities.companies.a,
    };
    await expect(
      kit.invoke(archiveCustomer, { id: fixtures.customerHappy }, viewActor),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      kit.invoke(restoreCustomer, { id: fixtures.customerRestore }, viewActor),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      kit.invoke(archiveCustomer, { id: fixtures.customerHappy }, deleteActor),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      kit.invoke(
        restoreCustomer,
        { id: fixtures.customerRestore },
        deleteActor,
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("rejects malformed ids, extras, and a missing idempotency key", async () => {
    await expect(
      kit.invoke(archiveCustomer, { id: "not-a-uuid" }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      kit.invoke(restoreCustomer, { id: "not-a-uuid" }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(kit.invoke(archiveCustomer, {})).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      kit.invoke(archiveCustomer, {
        id: fixtures.customerHappy,
        companyId: kitIdentities.companies.a,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      kit.invoke(restoreCustomer, {
        id: fixtures.customerRestore,
        status: "active",
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    await expect(
      kit.invoke(
        archiveCustomer,
        { id: fixtures.customerHappy },
        {},
        { request: { idempotencyKey: "" } },
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      kit.invoke(
        restoreCustomer,
        { id: fixtures.customerRestore },
        {},
        { request: { idempotencyKey: "" } },
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("returns the same not-found for missing and foreign rows", async () => {
    const missing = randomUUID();
    await expectSameNotFound(
      archiveCustomer,
      { id: missing },
      { id: fixtures.customerIsolationArchiveB },
    );
    await expectSameNotFound(
      restoreCustomer,
      { id: missing },
      { id: fixtures.customerIsolationRestoreB },
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
