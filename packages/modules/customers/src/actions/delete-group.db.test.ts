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
import { companyMembers } from "@showzy/db/schema/companies";
import { companyCustomers, customerGroups } from "@showzy/db/schema/customers";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteGroup, deleteGroupConfirmationSummary } from "./delete-group.js";

const fixtures = {
  isolationOwn: randomUUID(),
  isolationForeign: randomUUID(),
  groupIdem: randomUUID(),
  groupConcurrent: randomUUID(),
  happyGroup: randomUUID(),
  denyTarget: randomUUID(),
  memberActive: randomUUID(),
  memberArchived: randomUUID(),
};

const clerks = {
  viewOnly: randomUUID(),
  deleteOnly: randomUUID(),
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
        eq(auditLog.action, "customers.deleteGroup"),
        eq(auditLog.outcome, "ok"),
      ),
    );
  return rows.length;
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

beforeAll(async () => {
  kit = await createTestKit();
  attachAutoConfirm(kit);

  await kit.db.runtime.db.insert(customerGroups).values([
    {
      id: fixtures.isolationOwn,
      companyId: kitIdentities.companies.a,
      name: "Delete Isolation A",
      slug: "delete-isolation-a",
    },
    {
      id: fixtures.isolationForeign,
      companyId: kitIdentities.companies.b,
      name: "Delete Isolation B",
      slug: "delete-isolation-b",
    },
    {
      id: fixtures.groupIdem,
      companyId: kitIdentities.companies.a,
      name: "Delete Idem",
      slug: "delete-idem",
    },
    {
      id: fixtures.groupConcurrent,
      companyId: kitIdentities.companies.a,
      name: "Delete Concurrent",
      slug: "delete-concurrent",
    },
    {
      id: fixtures.happyGroup,
      companyId: kitIdentities.companies.a,
      name: "Happy Delete",
      slug: "happy-delete",
    },
    {
      id: fixtures.denyTarget,
      companyId: kitIdentities.companies.a,
      name: "Deny Target",
      slug: "deny-target",
    },
  ]);

  await kit.db.runtime.db.insert(companyCustomers).values([
    {
      id: fixtures.memberActive,
      companyId: kitIdentities.companies.a,
      name: "Active member",
      email: `active-${fixtures.memberActive}@example.com`,
      groupId: fixtures.happyGroup,
      status: "active",
    },
    {
      id: fixtures.memberArchived,
      companyId: kitIdentities.companies.a,
      name: "Archived member",
      email: `archived-${fixtures.memberArchived}@example.com`,
      groupId: fixtures.happyGroup,
      status: "archived",
    },
  ]);

  await kit.db.runtime.db.insert(user).values([
    {
      id: clerks.viewOnly,
      name: "Viewer",
      email: "viewer@customers-delete-group.test",
    },
    {
      id: clerks.deleteOnly,
      name: "Deleter",
      email: "deleter@customers-delete-group.test",
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
      deleteGroup,
      { input: { id: fixtures.isolationOwn } },
      { input: { id: fixtures.isolationForeign } },
    ),
  ],
);

idempotencySuite(
  () => kit,
  [
    {
      action: deleteGroup,
      input: { id: fixtures.groupIdem },
      conflictingInput: { id: fixtures.isolationForeign },
      freshInput: () => ({ id: fixtures.groupConcurrent }),
      readEffect: () => countOkDeleteAudits(),
    },
  ],
);

describe("customers.deleteGroup", () => {
  it("deletes the group, SET NULLs member group_id, and audits once", async () => {
    const requestId = randomUUID();
    const result = await kit.invoke(
      deleteGroup,
      { id: fixtures.happyGroup },
      {},
      { request: { requestId } },
    );

    expect(result).toEqual({ id: fixtures.happyGroup });
    expect(await groupRow(fixtures.happyGroup)).toBeUndefined();

    const active = await customerRow(fixtures.memberActive);
    const archived = await customerRow(fixtures.memberArchived);
    expect(active).toMatchObject({
      id: fixtures.memberActive,
      companyId: kitIdentities.companies.a,
      name: "Active member",
      groupId: null,
      status: "active",
    });
    expect(archived).toMatchObject({
      id: fixtures.memberArchived,
      companyId: kitIdentities.companies.a,
      name: "Archived member",
      groupId: null,
      status: "archived",
    });

    const auditRows = await kit.db.runtime.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.requestId, requestId));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: "customers.deleteGroup",
      companyId: kitIdentities.companies.a,
      actorType: "user",
      actorId: kitIdentities.users.anna,
      targetType: "customer_group",
      targetId: fixtures.happyGroup,
      outcome: "ok",
      inputSnapshot: null,
    });

    const eventRows = await kit.db.runtime.db
      .select({ id: domainEvents.id })
      .from(domainEvents)
      .where(eq(domainEvents.requestId, requestId));
    expect(eventRows).toEqual([]);
  });

  it("rejects an unconfirmed call and executes after the challenge", async () => {
    const groupId = randomUUID();
    await kit.db.runtime.db.insert(customerGroups).values({
      id: groupId,
      companyId: kitIdentities.companies.a,
      name: "Confirm me",
      slug: `confirm-${groupId}`,
    });

    const deps = confirmationPipeline(kit);
    const idempotencyKey = randomUUID();
    const unconfirmed = await kit
      .invoke(
        deleteGroup,
        { id: groupId },
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
    expect(await groupRow(groupId)).toMatchObject({ id: groupId });
    if (!(unconfirmed instanceof ConfirmationRequiredError)) {
      throw new Error("expected ConfirmationRequiredError");
    }
    expect(unconfirmed.challenge.summary).toBe(deleteGroupConfirmationSummary);
    expect(unconfirmed.challenge.summary).toContain(
      "Клієнти залишаться і втратять призначення групи",
    );
    expect(unconfirmed.challenge.summary).not.toContain("Confirm me");
    expect(Date.parse(unconfirmed.challenge.expiresAt)).toBeGreaterThan(
      Date.now(),
    );

    const confirmed = await kit.invoke(
      deleteGroup,
      { id: groupId },
      {},
      {
        deps,
        request: {
          idempotencyKey,
          confirmationChallengeId: unconfirmed.challenge.challengeId,
        },
      },
    );
    expect(confirmed).toEqual({ id: groupId });
    expect(await groupRow(groupId)).toBeUndefined();
  });

  it("denies staff with only customers:view and staff with only customers:delete", async () => {
    const input = { id: fixtures.denyTarget };
    await expect(
      kit.invoke(deleteGroup, input, {
        userId: clerks.viewOnly,
        companyId: kitIdentities.companies.a,
      }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      kit.invoke(deleteGroup, input, {
        userId: clerks.deleteOnly,
        companyId: kitIdentities.companies.a,
      }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(await groupRow(fixtures.denyTarget)).toMatchObject({
      id: fixtures.denyTarget,
      companyId: kitIdentities.companies.a,
    });
  });

  it("returns the same not-found for missing, already-deleted, and foreign groups", async () => {
    const missingId = randomUUID();
    const secondDeleteId = randomUUID();
    await kit.db.runtime.db.insert(customerGroups).values({
      id: secondDeleteId,
      companyId: kitIdentities.companies.a,
      name: "Second delete",
      slug: `second-delete-${secondDeleteId}`,
    });
    await kit.invoke(deleteGroup, { id: secondDeleteId });

    const missingError = await kit
      .invoke(deleteGroup, { id: missingId })
      .catch((error: unknown) => error);
    const alreadyDeleted = await kit
      .invoke(deleteGroup, { id: secondDeleteId })
      .catch((error: unknown) => error);
    const foreignError = await kit
      .invoke(deleteGroup, { id: fixtures.isolationForeign })
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

    const foreignRow = await groupRow(fixtures.isolationForeign);
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
      await expect(kit.invoke(deleteGroup, input)).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
    expect(await groupRow(fixtures.isolationForeign)).toMatchObject({
      companyId: kitIdentities.companies.b,
    });
  });
});
