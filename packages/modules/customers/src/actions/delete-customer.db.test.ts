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
import {
  companyCustomers,
  counterparties,
  customerGroups,
} from "@showzy/db/schema/customers";
import { orders } from "@showzy/db/schema/orders";
import { personalPrices } from "@showzy/db/schema/pricing";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ACTIVE_CUSTOMER_DELETE_MESSAGE,
  deleteCustomer,
  deleteCustomerConfirmationSummary,
} from "./delete-customer.js";

const fixtures = {
  isolationOwn: randomUUID(),
  isolationForeign: randomUUID(),
  customerIdem: randomUUID(),
  customerConcurrent: randomUUID(),
  happyCustomer: randomUUID(),
  activeCustomer: randomUUID(),
  denyTarget: randomUUID(),
  groupKeep: randomUUID(),
  partyKeep: randomUUID(),
  orderKeep: randomUUID(),
  productKeep: randomUUID(),
  personalKeep: randomUUID(),
};

const clerks = {
  manager: randomUUID(),
  employee: randomUUID(),
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
        eq(auditLog.action, "customers.deleteCustomer"),
        eq(auditLog.outcome, "ok"),
      ),
    );
  return rows.length;
}

async function customerRow(customerId: string) {
  const rows = await kit.db.runtime.db
    .select()
    .from(companyCustomers)
    .where(eq(companyCustomers.id, customerId));
  return rows[0];
}

async function groupRow(groupId: string) {
  const rows = await kit.db.runtime.db
    .select()
    .from(customerGroups)
    .where(eq(customerGroups.id, groupId));
  return rows[0];
}

async function orderRow(orderId: string) {
  const rows = await kit.db.runtime.db
    .select()
    .from(orders)
    .where(eq(orders.id, orderId));
  return rows[0];
}

async function partyRow(partyId: string) {
  const rows = await kit.db.runtime.db
    .select()
    .from(counterparties)
    .where(eq(counterparties.id, partyId));
  return rows[0];
}

async function personalPriceRows(customerId: string) {
  return kit.db.runtime.db
    .select()
    .from(personalPrices)
    .where(eq(personalPrices.customerId, customerId));
}

beforeAll(async () => {
  kit = await createTestKit();
  attachAutoConfirm(kit);

  await kit.db.runtime.db.insert(customerGroups).values({
    id: fixtures.groupKeep,
    companyId: kitIdentities.companies.a,
    name: "Keep After Delete",
    slug: "keep-after-delete",
  });

  await kit.db.runtime.db.insert(companyCustomers).values([
    {
      id: fixtures.isolationOwn,
      companyId: kitIdentities.companies.a,
      name: "Delete Isolation A",
      email: `iso-a-${fixtures.isolationOwn}@example.com`,
      status: "archived",
    },
    {
      id: fixtures.isolationForeign,
      companyId: kitIdentities.companies.b,
      name: "Delete Isolation B",
      email: `iso-b-${fixtures.isolationForeign}@example.com`,
      status: "archived",
    },
    {
      id: fixtures.customerIdem,
      companyId: kitIdentities.companies.a,
      name: "Delete Idem",
      email: `idem-${fixtures.customerIdem}@example.com`,
      status: "archived",
    },
    {
      id: fixtures.customerConcurrent,
      companyId: kitIdentities.companies.a,
      name: "Delete Concurrent",
      email: `concurrent-${fixtures.customerConcurrent}@example.com`,
      status: "archived",
    },
    {
      id: fixtures.happyCustomer,
      companyId: kitIdentities.companies.a,
      name: "Happy Delete Client",
      phone: "+380501000010",
      email: `happy-${fixtures.happyCustomer}@example.com`,
      groupId: fixtures.groupKeep,
      status: "archived",
    },
    {
      id: fixtures.activeCustomer,
      companyId: kitIdentities.companies.a,
      name: "Still Active",
      phone: "+380501000011",
      status: "active",
    },
    {
      id: fixtures.denyTarget,
      companyId: kitIdentities.companies.a,
      name: "Deny Target",
      email: `deny-${fixtures.denyTarget}@example.com`,
      status: "archived",
    },
  ]);

  await kit.db.runtime.db.insert(counterparties).values({
    id: fixtures.partyKeep,
    companyId: kitIdentities.companies.a,
    customerId: fixtures.happyCustomer,
    name: "ТОВ Партнер",
  });

  await kit.db.runtime.db.insert(products).values({
    id: fixtures.productKeep,
    companyId: kitIdentities.companies.a,
    name: "Delete-price product",
    basePriceMinor: 1000n,
  });

  await kit.db.runtime.db.insert(personalPrices).values({
    id: fixtures.personalKeep,
    companyId: kitIdentities.companies.a,
    customerId: fixtures.happyCustomer,
    productId: fixtures.productKeep,
    priceMinor: 500n,
  });

  await kit.db.runtime.db.insert(orders).values({
    id: fixtures.orderKeep,
    companyId: kitIdentities.companies.a,
    orderNumber: "T-1",
    customerId: fixtures.happyCustomer,
    customerNameSnapshot: "Fixture customer",
    status: "new",
    totalNetMinor: 100n,
    totalTaxMinor: 0n,
    totalGrossMinor: 100n,
    currency: "UAH",
  });

  await kit.db.runtime.db.insert(user).values([
    {
      id: clerks.manager,
      name: "Manager",
      email: "manager@customers-delete-customer.test",
    },
    {
      id: clerks.employee,
      name: "Employee",
      email: "employee@customers-delete-customer.test",
    },
  ]);
  await kit.db.runtime.db.insert(companyMembers).values([
    {
      companyId: kitIdentities.companies.a,
      userId: clerks.manager,
      role: "manager",
      permissions: { granted: [], denied: [] },
    },
    {
      companyId: kitIdentities.companies.a,
      userId: clerks.employee,
      role: "employee",
      permissions: { granted: [], denied: [] },
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
      deleteCustomer,
      { input: { id: fixtures.isolationOwn } },
      { input: { id: fixtures.isolationForeign } },
    ),
  ],
);

idempotencySuite(
  () => kit,
  [
    {
      action: deleteCustomer,
      input: { id: fixtures.customerIdem },
      conflictingInput: { id: fixtures.isolationForeign },
      freshInput: () => ({ id: fixtures.customerConcurrent }),
      readEffect: () => countOkDeleteAudits(),
    },
  ],
);

describe("customers.deleteCustomer", () => {
  it("deletes an archived customer, SET NULLs orders and counterparties, cascades personal prices, and leaves the group", async () => {
    const requestId = randomUUID();
    const result = await kit.invoke(
      deleteCustomer,
      { id: fixtures.happyCustomer },
      {},
      { request: { requestId } },
    );

    expect(result).toEqual({ id: fixtures.happyCustomer });
    expect(await customerRow(fixtures.happyCustomer)).toBeUndefined();

    const order = await orderRow(fixtures.orderKeep);
    expect(order).toMatchObject({
      id: fixtures.orderKeep,
      companyId: kitIdentities.companies.a,
      customerId: null,
      status: "new",
    });

    const party = await partyRow(fixtures.partyKeep);
    expect(party).toMatchObject({
      id: fixtures.partyKeep,
      companyId: kitIdentities.companies.a,
      customerId: null,
      name: "ТОВ Партнер",
    });

    expect(await personalPriceRows(fixtures.happyCustomer)).toEqual([]);
    expect(await groupRow(fixtures.groupKeep)).toMatchObject({
      id: fixtures.groupKeep,
      companyId: kitIdentities.companies.a,
      name: "Keep After Delete",
    });

    const auditRows = await kit.db.runtime.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.requestId, requestId));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: "customers.deleteCustomer",
      companyId: kitIdentities.companies.a,
      actorType: "user",
      actorId: kitIdentities.users.anna,
      targetType: "customer",
      targetId: fixtures.happyCustomer,
      outcome: "ok",
      inputSnapshot: null,
    });

    const eventRows = await kit.db.runtime.db
      .select({ id: domainEvents.id })
      .from(domainEvents)
      .where(eq(domainEvents.requestId, requestId));
    expect(eventRows).toEqual([]);
  });

  it("rejects deleting an active customer even when confirmation is granted", async () => {
    const error = await kit
      .invoke(deleteCustomer, { id: fixtures.activeCustomer })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ValidationError);
    if (!(error instanceof ValidationError)) {
      throw new Error("expected ValidationError");
    }
    expect(error.clientMessage).toBe(ACTIVE_CUSTOMER_DELETE_MESSAGE);
    expect(await customerRow(fixtures.activeCustomer)).toMatchObject({
      id: fixtures.activeCustomer,
      status: "active",
      companyId: kitIdentities.companies.a,
    });
  });

  it("rejects an unconfirmed call and executes after the challenge", async () => {
    const customerId = randomUUID();
    await kit.db.runtime.db.insert(companyCustomers).values({
      id: customerId,
      companyId: kitIdentities.companies.a,
      name: "Confirm me",
      email: `confirm-${customerId}@example.com`,
      status: "archived",
    });

    const deps = confirmationPipeline(kit);
    const idempotencyKey = randomUUID();
    const unconfirmed = await kit
      .invoke(
        deleteCustomer,
        { id: customerId },
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
    expect(await customerRow(customerId)).toMatchObject({ id: customerId });
    if (!(unconfirmed instanceof ConfirmationRequiredError)) {
      throw new Error("expected ConfirmationRequiredError");
    }
    expect(unconfirmed.challenge.summary).toBe(
      deleteCustomerConfirmationSummary,
    );
    expect(unconfirmed.challenge.summary).toContain("ім’я");
    expect(unconfirmed.challenge.summary).toContain(
      "телефон, email або прив’язаного користувача",
    );
    expect(unconfirmed.challenge.summary).not.toContain("Confirm me");
    expect(unconfirmed.challenge.summary).not.toContain(
      `confirm-${customerId}@example.com`,
    );
    expect(Date.parse(unconfirmed.challenge.expiresAt)).toBeGreaterThan(
      Date.now(),
    );

    const confirmed = await kit.invoke(
      deleteCustomer,
      { id: customerId },
      {},
      {
        deps,
        request: {
          idempotencyKey,
          confirmationChallengeId: unconfirmed.challenge.challengeId,
        },
      },
    );
    expect(confirmed).toEqual({ id: customerId });
    expect(await customerRow(customerId)).toBeUndefined();
  });

  it("still validates archived-only after a confirmation challenge on an active customer", async () => {
    const customerId = randomUUID();
    await kit.db.runtime.db.insert(companyCustomers).values({
      id: customerId,
      companyId: kitIdentities.companies.a,
      name: "Active confirm",
      phone: "+380501000012",
      status: "active",
    });

    const deps = confirmationPipeline(kit);
    const idempotencyKey = randomUUID();
    const unconfirmed = await kit
      .invoke(
        deleteCustomer,
        { id: customerId },
        {},
        { deps, request: { idempotencyKey } },
      )
      .then(
        () => {
          throw new Error("expected ConfirmationRequiredError");
        },
        (error: unknown) => error,
      );
    if (!(unconfirmed instanceof ConfirmationRequiredError)) {
      throw new Error("expected ConfirmationRequiredError");
    }

    const confirmed = await kit
      .invoke(
        deleteCustomer,
        { id: customerId },
        {},
        {
          deps,
          request: {
            idempotencyKey,
            confirmationChallengeId: unconfirmed.challenge.challengeId,
          },
        },
      )
      .catch((error: unknown) => error);

    expect(confirmed).toBeInstanceOf(ValidationError);
    if (!(confirmed instanceof ValidationError)) {
      throw new Error("expected ValidationError");
    }
    expect(confirmed.clientMessage).toBe(ACTIVE_CUSTOMER_DELETE_MESSAGE);
    expect(await customerRow(customerId)).toMatchObject({
      id: customerId,
      status: "active",
    });
  });

  it("denies a manager with customers:edit and an employee with customers:view", async () => {
    const input = { id: fixtures.denyTarget };
    await expect(
      kit.invoke(deleteCustomer, input, {
        userId: clerks.manager,
        companyId: kitIdentities.companies.a,
      }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      kit.invoke(deleteCustomer, input, {
        userId: clerks.employee,
        companyId: kitIdentities.companies.a,
      }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(await customerRow(fixtures.denyTarget)).toMatchObject({
      id: fixtures.denyTarget,
      companyId: kitIdentities.companies.a,
      status: "archived",
    });
  });

  it("returns the same not-found for missing, already-deleted, and foreign customers", async () => {
    const missingId = randomUUID();
    const secondDeleteId = randomUUID();
    await kit.db.runtime.db.insert(companyCustomers).values({
      id: secondDeleteId,
      companyId: kitIdentities.companies.a,
      name: "Second delete",
      email: `second-delete-${secondDeleteId}@example.com`,
      status: "archived",
    });
    await kit.invoke(deleteCustomer, { id: secondDeleteId });

    const missingError = await kit
      .invoke(deleteCustomer, { id: missingId })
      .catch((error: unknown) => error);
    const alreadyDeleted = await kit
      .invoke(deleteCustomer, { id: secondDeleteId })
      .catch((error: unknown) => error);
    const foreignError = await kit
      .invoke(deleteCustomer, { id: fixtures.isolationForeign })
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

    const foreignRow = await customerRow(fixtures.isolationForeign);
    expect(foreignRow?.name).toBe("Delete Isolation B");
    expect(foreignRow?.companyId).toBe(kitIdentities.companies.b);
  });

  it("rejects a missing id, a malformed id, and companyId on input", async () => {
    const invalidInputs: unknown[] = [
      {},
      { id: "not-a-uuid" },
      { id: fixtures.isolationForeign, companyId: kitIdentities.companies.a },
    ];
    for (const input of invalidInputs) {
      await expect(kit.invoke(deleteCustomer, input)).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
    expect(await customerRow(fixtures.isolationForeign)).toMatchObject({
      companyId: kitIdentities.companies.b,
    });
    expect(await customerRow(fixtures.activeCustomer)).toMatchObject({
      status: "active",
    });
  });
});
