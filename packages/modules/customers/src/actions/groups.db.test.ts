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
import { companyMembers } from "@showzy/db/schema/companies";
import { companyCustomers, customerGroups } from "@showzy/db/schema/customers";
import { priceLists } from "@showzy/db/schema/pricing";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  GROUP_DESCRIPTION_MAX,
  GROUP_NAME_MAX,
} from "./group-view.contract.js";
import { createGroup } from "./create-group.js";
import { isGroupFallbackSlug } from "../services/group-slug.js";
import { updateGroup } from "./update-group.js";

const fixtures = {
  groupUpdateA: randomUUID(),
  groupUpdateB: randomUUID(),
  groupIdem: randomUUID(),
  listA: randomUUID(),
  listAInactive: randomUUID(),
  listB: randomUUID(),
  memberActive: randomUUID(),
  memberArchived: randomUUID(),
};

const clerks = {
  viewOnly: randomUUID(),
  deleteOnly: randomUUID(),
};

const createIsolationInput = {
  name: "Isolation create A",
};

const updateIsolationOwn = {
  id: fixtures.groupUpdateA,
  name: "Isolation updated A",
};

const updateIsolationForeign = {
  id: fixtures.groupUpdateB,
  name: "Isolation updated B",
};

let kit: TestKit;

async function countCompanyGroups(companyId: string): Promise<number> {
  const rows = await kit.db.runtime.db
    .select({ id: customerGroups.id })
    .from(customerGroups)
    .where(eq(customerGroups.companyId, companyId));
  return rows.length;
}

async function countUpdateAudits(groupId: string): Promise<number> {
  const rows = await kit.db.runtime.db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, "customers.updateGroup"),
        eq(auditLog.targetId, groupId),
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

beforeAll(async () => {
  kit = await createTestKit();

  await kit.db.runtime.db.insert(priceLists).values([
    {
      id: fixtures.listA,
      companyId: kitIdentities.companies.a,
      name: "Wholesale A",
    },
    {
      id: fixtures.listAInactive,
      companyId: kitIdentities.companies.a,
      name: "Inactive A",
      isActive: false,
    },
    {
      id: fixtures.listB,
      companyId: kitIdentities.companies.b,
      name: "Wholesale B",
    },
  ]);

  await kit.db.runtime.db.insert(customerGroups).values([
    {
      id: fixtures.groupUpdateA,
      companyId: kitIdentities.companies.a,
      name: "Update Alpha",
      slug: "update-alpha",
      priceListId: fixtures.listA,
    },
    {
      id: fixtures.groupUpdateB,
      companyId: kitIdentities.companies.b,
      name: "Update Bravo",
      slug: "update-bravo",
    },
    {
      id: fixtures.groupIdem,
      companyId: kitIdentities.companies.a,
      name: "Idem Target",
      slug: "idem-target",
    },
  ]);

  await kit.db.runtime.db.insert(companyCustomers).values([
    {
      id: fixtures.memberActive,
      companyId: kitIdentities.companies.a,
      name: "Active member",
      email: `active-${fixtures.memberActive}@example.com`,
      groupId: fixtures.groupUpdateA,
      status: "active",
    },
    {
      id: fixtures.memberArchived,
      companyId: kitIdentities.companies.a,
      name: "Archived member",
      email: `archived-${fixtures.memberArchived}@example.com`,
      groupId: fixtures.groupUpdateA,
      status: "archived",
    },
  ]);

  await kit.db.runtime.db.insert(user).values([
    {
      id: clerks.viewOnly,
      name: "Viewer",
      email: "viewer@customers-groups.test",
    },
    {
      id: clerks.deleteOnly,
      name: "Deleter",
      email: "deleter@customers-groups.test",
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
      createGroup,
      { input: createIsolationInput },
      { input: createIsolationInput, companyId: kitIdentities.companies.b },
    ),
    isolationCase(
      updateGroup,
      { input: updateIsolationOwn },
      { input: updateIsolationForeign },
    ),
  ],
);

idempotencySuite(
  () => kit,
  [
    {
      action: createGroup,
      input: { name: "Idem Create" },
      conflictingInput: { name: "Idem Create Other" },
      freshInput: () => ({ name: `Idem Concurrent ${randomUUID()}` }),
      readEffect: () => countCompanyGroups(kitIdentities.companies.a),
    },
    {
      action: updateGroup,
      input: {
        id: fixtures.groupIdem,
        name: "Idem Updated",
      },
      conflictingInput: {
        id: fixtures.groupIdem,
        name: "Idem Conflicting",
      },
      readEffect: () => countUpdateAudits(fixtures.groupIdem),
    },
  ],
);

describe("customers.createGroup", () => {
  it("creates a name-only group with sort_order 0, a generated slug, and audits once", async () => {
    const requestId = randomUUID();
    const result = await kit.invoke(
      createGroup,
      { name: "  VIP  " },
      {},
      { request: { requestId } },
    );

    expect(result.name).toBe("VIP");
    expect(result.slug).toBe("vip");
    expect(result.description).toBeNull();
    expect(result.priceListId).toBeNull();
    expect(result.memberCount).toBe(0);
    expect(typeof result.createdAt).toBe("string");
    expect(typeof result.updatedAt).toBe("string");

    const row = await groupRow(result.id);
    expect(row).toMatchObject({
      id: result.id,
      companyId: kitIdentities.companies.a,
      name: "VIP",
      slug: "vip",
      description: null,
      priceListId: null,
      sortOrder: 0,
    });

    const auditRows = await kit.db.runtime.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.requestId, requestId));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: "customers.createGroup",
      companyId: kitIdentities.companies.a,
      actorType: "user",
      actorId: kitIdentities.users.anna,
      targetType: "customer_group",
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

  it("creates with description and an assigned price list", async () => {
    const result = await kit.invoke(createGroup, {
      name: "Retail",
      description: "  Walk-in  ",
      priceListId: fixtures.listA,
    });
    expect(result).toMatchObject({
      name: "Retail",
      slug: "retail",
      description: "Walk-in",
      priceListId: fixtures.listA,
      memberCount: 0,
    });
    const row = await groupRow(result.id);
    expect(row?.priceListId).toBe(fixtures.listA);
    expect(row?.description).toBe("Walk-in");
  });

  it("assigns an inactive price list", async () => {
    const result = await kit.invoke(createGroup, {
      name: "Legacy list group",
      priceListId: fixtures.listAInactive,
    });
    expect(result.priceListId).toBe(fixtures.listAInactive);
  });

  it("falls back to group-{shortid} for a Ukrainian-punctuation name", async () => {
    const result = await kit.invoke(createGroup, { name: "«—»!!!" });
    expect(isGroupFallbackSlug(result.slug)).toBe(true);
    expect(result.name).toBe("«—»!!!");
  });

  it("transliterates a Ukrainian name into a Latin slug", async () => {
    const result = await kit.invoke(createGroup, { name: "Київські торти" });
    expect(result.slug).toBe("kyivski-torty");
  });

  it("uses group-{shortid} when a second group transliterates to the same slug", async () => {
    const first = await kit.invoke(createGroup, { name: "віп-clone" });
    expect(first.slug).toBe("vip-clone");
    const second = await kit.invoke(createGroup, { name: "віп-clone" });
    expect(isGroupFallbackSlug(second.slug)).toBe(true);
    expect(second.slug).not.toBe(first.slug);
    expect(second.id).not.toBe(first.id);
  });

  it("denies staff with only customers:view and staff with only customers:delete", async () => {
    await expect(
      kit.invoke(
        createGroup,
        { name: "Denied view" },
        { userId: clerks.viewOnly, companyId: kitIdentities.companies.a },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      kit.invoke(
        createGroup,
        { name: "Denied delete" },
        { userId: clerks.deleteOnly, companyId: kitIdentities.companies.a },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("rejects blank names, over-max fields, companyId, and unknown or foreign price lists", async () => {
    const before = await countCompanyGroups(kitIdentities.companies.a);
    const missingList = randomUUID();
    const invalidInputs: unknown[] = [
      { name: "   " },
      { name: "x".repeat(GROUP_NAME_MAX + 1) },
      { name: "VIP", description: "x".repeat(GROUP_DESCRIPTION_MAX + 1) },
      { name: "VIP", companyId: kitIdentities.companies.a },
      { name: "VIP", slug: "vip" },
      { name: "VIP", priceListId: "not-a-uuid" },
    ];
    for (const input of invalidInputs) {
      await expect(kit.invoke(createGroup, input)).rejects.toBeInstanceOf(
        ValidationError,
      );
    }

    const missingError = await kit
      .invoke(createGroup, { name: "Missing list", priceListId: missingList })
      .then(
        () => {
          throw new Error("expected NotFoundError for a missing price list");
        },
        (error: unknown) => error,
      );
    const foreignError = await kit
      .invoke(createGroup, {
        name: "Foreign list",
        priceListId: fixtures.listB,
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

    expect(await countCompanyGroups(kitIdentities.companies.a)).toBe(before);
  });
});

describe("customers.createGroup provenance (SHO-465)", () => {
  it("stores ctx.channel and leaves vouched columns null", async () => {
    const viaUi = await kit.invoke(
      createGroup,
      { name: "Provenance UI group" },
      {},
      { request: { channel: "ui" } },
    );
    const viaAi = await kit.invoke(
      createGroup,
      { name: "Provenance AI group" },
      {},
      { request: { channel: "ai", aiTraceId: "sho-465-group" } },
    );
    expect(await groupRow(viaUi.id)).toMatchObject({
      createdVia: "ui",
      vouchedBy: null,
      vouchedAt: null,
    });
    expect(await groupRow(viaAi.id)).toMatchObject({
      createdVia: "ai",
      vouchedBy: null,
      vouchedAt: null,
    });
  });
});

describe("customers.updateGroup", () => {
  it("renames without changing slug, sets and clears the price list, and audits once", async () => {
    const created = await kit.invoke(createGroup, {
      name: "Before",
      description: "Keep me",
      priceListId: fixtures.listA,
    });
    expect(created.slug).toBe("before");
    const requestId = randomUUID();
    const renamed = await kit.invoke(
      updateGroup,
      {
        id: created.id,
        name: "  After  ",
        description: "Keep me",
        priceListId: fixtures.listA,
      },
      {},
      { request: { requestId } },
    );

    expect(renamed).toMatchObject({
      id: created.id,
      name: "After",
      slug: "before",
      description: "Keep me",
      priceListId: fixtures.listA,
    });

    const cleared = await kit.invoke(updateGroup, {
      id: created.id,
      name: "After",
      priceListId: null,
    });
    expect(cleared.slug).toBe("before");
    expect(cleared.priceListId).toBeNull();
    expect(cleared.description).toBeNull();

    const reassigned = await kit.invoke(updateGroup, {
      id: created.id,
      name: "After",
      priceListId: fixtures.listAInactive,
    });
    expect(reassigned.priceListId).toBe(fixtures.listAInactive);

    const row = await groupRow(created.id);
    expect(row).toMatchObject({
      name: "After",
      slug: "before",
      priceListId: fixtures.listAInactive,
    });

    const auditRows = await kit.db.runtime.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.requestId, requestId));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: "customers.updateGroup",
      companyId: kitIdentities.companies.a,
      targetType: "customer_group",
      targetId: created.id,
      outcome: "ok",
      inputSnapshot: null,
    });
  });

  it("counts only active members on update", async () => {
    const result = await kit.invoke(updateGroup, {
      id: fixtures.groupUpdateA,
      name: "Update Alpha counted",
    });
    expect(result.memberCount).toBe(1);
    expect(result.slug).toBe("update-alpha");
  });

  it("denies staff with only customers:view and staff with only customers:delete", async () => {
    const input = {
      id: fixtures.groupUpdateA,
      name: "Nope",
    };
    await expect(
      kit.invoke(updateGroup, input, {
        userId: clerks.viewOnly,
        companyId: kitIdentities.companies.a,
      }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      kit.invoke(updateGroup, input, {
        userId: clerks.deleteOnly,
        companyId: kitIdentities.companies.a,
      }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("returns the same not-found for missing and foreign groups", async () => {
    const missingId = randomUUID();
    const missingError = await kit
      .invoke(updateGroup, { id: missingId, name: "Ghost" })
      .catch((error: unknown) => error);
    const foreignError = await kit
      .invoke(updateGroup, {
        id: fixtures.groupUpdateB,
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

    const foreignRow = await groupRow(fixtures.groupUpdateB);
    expect(foreignRow?.name).toBe("Update Bravo");
    expect(foreignRow?.companyId).toBe(kitIdentities.companies.b);
  });

  it("rejects blank names, over-max fields, companyId, and unknown price lists", async () => {
    const missingList = randomUUID();
    const invalidInputs: unknown[] = [
      { id: fixtures.groupUpdateA, name: "   " },
      {
        id: fixtures.groupUpdateA,
        name: "x".repeat(GROUP_NAME_MAX + 1),
      },
      {
        id: fixtures.groupUpdateA,
        name: "Cake",
        companyId: kitIdentities.companies.a,
      },
      { id: fixtures.groupUpdateA, name: "Cake", slug: "nope" },
      { id: "not-a-uuid", name: "Cake" },
    ];
    for (const input of invalidInputs) {
      await expect(kit.invoke(updateGroup, input)).rejects.toBeInstanceOf(
        ValidationError,
      );
    }

    await expect(
      kit.invoke(updateGroup, {
        id: fixtures.groupUpdateA,
        name: "Cake",
        priceListId: missingList,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      kit.invoke(updateGroup, {
        id: fixtures.groupUpdateA,
        name: "Cake",
        priceListId: fixtures.listB,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    const row = await groupRow(fixtures.groupUpdateA);
    expect(row?.companyId).toBe(kitIdentities.companies.a);
  });
});
