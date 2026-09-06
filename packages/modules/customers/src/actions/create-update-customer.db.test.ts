import { randomUUID } from "node:crypto";

import {
  ConflictError,
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
import {
  companyCustomers,
  counterparties,
  customerGroups,
} from "@showzy/db/schema/customers";
import { priceLists } from "@showzy/db/schema/pricing";
import { and, count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CUSTOMER_NAME_MAX,
  CUSTOMER_PHONE_MAX,
} from "./customer-view.contract.js";
import { createCustomer } from "./create-customer.js";
import { getCustomerPricingFacts } from "./get-customer-pricing-facts.js";
import { updateCustomer } from "./update-customer.js";

const fixtures = {
  customerUpdateA: randomUUID(),
  customerUpdateB: randomUUID(),
  customerIdem: randomUUID(),
  customerArchived: randomUUID(),
  customerWithParty: randomUUID(),
  groupA: randomUUID(),
  groupAOther: randomUUID(),
  groupB: randomUUID(),
  listA: randomUUID(),
  listB: randomUUID(),
  partyA: randomUUID(),
};

const clerks = {
  noWrite: randomUUID(),
};

const linkedUsers = {
  first: randomUUID(),
  second: randomUUID(),
  third: randomUUID(),
};

const createIsolationInput = {
  name: "Isolation create A",
  phone: "+380501000001",
};

const updateIsolationOwn = {
  id: fixtures.customerUpdateA,
  name: "Isolation updated A",
  phone: "+380501000002",
};

const updateIsolationForeign = {
  id: fixtures.customerUpdateB,
  name: "Isolation updated B",
  phone: "+380501000003",
};

let kit: TestKit;

async function countCompanyCustomers(companyId: string): Promise<number> {
  const rows = await kit.db.runtime.db
    .select({ value: count() })
    .from(companyCustomers)
    .where(eq(companyCustomers.companyId, companyId));
  return rows[0]?.value ?? 0;
}

async function countUpdateAudits(customerId: string): Promise<number> {
  const rows = await kit.db.runtime.db
    .select({ value: count() })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, "customers.updateCustomer"),
        eq(auditLog.targetId, customerId),
        eq(auditLog.outcome, "ok"),
      ),
    );
  return rows[0]?.value ?? 0;
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

  await kit.db.runtime.db.insert(priceLists).values([
    {
      id: fixtures.listA,
      companyId: kitIdentities.companies.a,
      name: "Retail A",
    },
    {
      id: fixtures.listB,
      companyId: kitIdentities.companies.b,
      name: "Retail B",
    },
  ]);

  await kit.db.runtime.db.insert(customerGroups).values([
    {
      id: fixtures.groupA,
      companyId: kitIdentities.companies.a,
      name: "Wholesale",
      slug: "wholesale",
      priceListId: fixtures.listA,
    },
    {
      id: fixtures.groupAOther,
      companyId: kitIdentities.companies.a,
      name: "Retail group",
      slug: "retail-group",
    },
    {
      id: fixtures.groupB,
      companyId: kitIdentities.companies.b,
      name: "Foreign group",
      slug: "foreign-group",
    },
  ]);

  await kit.db.runtime.db.insert(companyCustomers).values([
    {
      id: fixtures.customerUpdateA,
      companyId: kitIdentities.companies.a,
      name: "Update Alpha",
      phone: "+380501000010",
      groupId: fixtures.groupA,
    },
    {
      id: fixtures.customerUpdateB,
      companyId: kitIdentities.companies.b,
      name: "Update Bravo",
      phone: "+380501000011",
    },
    {
      id: fixtures.customerIdem,
      companyId: kitIdentities.companies.a,
      name: "Idem Target",
      email: "idem@kit.test",
    },
    {
      id: fixtures.customerArchived,
      companyId: kitIdentities.companies.a,
      name: "Archived",
      phone: "+380501000012",
      status: "archived",
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
      id: clerks.noWrite,
      name: "Clerk",
      email: "clerk@customers-writes.test",
    },
    {
      id: linkedUsers.first,
      name: "Linked First",
      email: "linked-first@customers-writes.test",
    },
    {
      id: linkedUsers.second,
      name: "Linked Second",
      email: "linked-second@customers-writes.test",
    },
    {
      id: linkedUsers.third,
      name: "Linked Third",
      email: "linked-third@customers-writes.test",
    },
  ]);
  await kit.db.runtime.db.insert(companyMembers).values({
    companyId: kitIdentities.companies.a,
    userId: clerks.noWrite,
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
      createCustomer,
      { input: createIsolationInput },
      { input: createIsolationInput, companyId: kitIdentities.companies.b },
    ),
    isolationCase(
      updateCustomer,
      { input: updateIsolationOwn },
      { input: updateIsolationForeign },
    ),
  ],
);

idempotencySuite(
  () => kit,
  [
    {
      action: createCustomer,
      input: { name: "Idem Create", phone: "+380501000020" },
      conflictingInput: { name: "Idem Create Other", phone: "+380501000021" },
      readEffect: () => countCompanyCustomers(kitIdentities.companies.a),
    },
    {
      action: updateCustomer,
      input: {
        id: fixtures.customerIdem,
        name: "Idem Updated",
        email: "idem@kit.test",
      },
      conflictingInput: {
        id: fixtures.customerIdem,
        name: "Idem Conflicting",
        email: "other@kit.test",
      },
      readEffect: () => countUpdateAudits(fixtures.customerIdem),
    },
  ],
);

describe("customers.createCustomer", () => {
  it("creates from phone, email, userId, both contacts, group, price list, and inherit", async () => {
    const requestId = randomUUID();
    const phoneOnly = await kit.invoke(
      createCustomer,
      { name: "  Телефон  ", phone: "  +380501000030  " },
      {},
      { request: { requestId } },
    );
    expect(phoneOnly).toMatchObject({
      name: "Телефон",
      phone: "+380501000030",
      email: null,
      userId: null,
      notes: null,
      groupId: null,
      priceListId: null,
      status: "active",
      linkedCounterpartyCount: 0,
    });
    expect(phoneOnly.createdAt).toEqual(expect.any(String));
    expect(phoneOnly.updatedAt).toEqual(expect.any(String));

    const emailOnly = await kit.invoke(createCustomer, {
      name: "Email",
      email: "email-only@kit.test",
    });
    expect(emailOnly).toMatchObject({
      phone: null,
      email: "email-only@kit.test",
      userId: null,
      status: "active",
    });

    const userIdOnly = await kit.invoke(createCustomer, {
      name: "Linked",
      userId: linkedUsers.first,
    });
    expect(userIdOnly).toMatchObject({
      phone: null,
      email: null,
      userId: linkedUsers.first,
    });

    const both = await kit.invoke(createCustomer, {
      name: "Both",
      phone: "+380501000031",
      email: "both@kit.test",
      notes: "keep me",
    });
    expect(both).toMatchObject({
      phone: "+380501000031",
      email: "both@kit.test",
      notes: "keep me",
    });

    const withGroup = await kit.invoke(createCustomer, {
      name: "Grouped",
      phone: "+380501000032",
      groupId: fixtures.groupA,
    });
    expect(withGroup).toMatchObject({
      groupId: fixtures.groupA,
      priceListId: null,
    });

    const withList = await kit.invoke(createCustomer, {
      name: "Listed",
      phone: "+380501000033",
      priceListId: fixtures.listA,
    });
    expect(withList).toMatchObject({
      groupId: null,
      priceListId: fixtures.listA,
    });

    const inherit = await kit.invoke(createCustomer, {
      name: "Inherit",
      phone: "+380501000034",
      groupId: null,
      priceListId: null,
    });
    expect(inherit).toMatchObject({
      groupId: null,
      priceListId: null,
    });

    const row = await customerRow(phoneOnly.id);
    expect(row).toMatchObject({
      companyId: kitIdentities.companies.a,
      name: "Телефон",
      status: "active",
    });

    const auditRows = await kit.db.runtime.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.requestId, requestId));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: "customers.createCustomer",
      companyId: kitIdentities.companies.a,
      actorType: "user",
      actorId: kitIdentities.users.anna,
      targetType: "customer",
      targetId: phoneOnly.id,
      outcome: "ok",
      inputSnapshot: null,
    });

    const eventRows = await kit.db.runtime.db
      .select({ id: domainEvents.id })
      .from(domainEvents)
      .where(eq(domainEvents.requestId, requestId));
    expect(eventRows).toEqual([]);

    await expect(
      kit.invoke(getCustomerPricingFacts, { customerId: withGroup.id }),
    ).resolves.toEqual({
      priceListId: null,
      groupId: fixtures.groupA,
      groupPriceListId: fixtures.listA,
    });
    await expect(
      kit.invoke(getCustomerPricingFacts, { customerId: withList.id }),
    ).resolves.toEqual({
      priceListId: fixtures.listA,
      groupId: null,
      groupPriceListId: null,
    });
    await expect(
      kit.invoke(getCustomerPricingFacts, { customerId: inherit.id }),
    ).resolves.toEqual({
      priceListId: null,
      groupId: null,
      groupPriceListId: null,
    });
  });

  it("denies staff without customers:create", async () => {
    await expect(
      kit.invoke(
        createCustomer,
        { name: "Denied", phone: "+380501000040" },
        { userId: clerks.noWrite, companyId: kitIdentities.companies.a },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("rejects empty name, missing contacts, over-max lengths, and companyId", async () => {
    const before = await countCompanyCustomers(kitIdentities.companies.a);
    const invalidInputs: unknown[] = [
      { name: "   ", phone: "1" },
      { name: "x".repeat(CUSTOMER_NAME_MAX + 1), phone: "1" },
      { name: "No contact" },
      { name: "Long phone", phone: "1".repeat(CUSTOMER_PHONE_MAX + 1) },
      {
        name: "Cake",
        phone: "1",
        companyId: kitIdentities.companies.a,
      },
      {
        name: "Cake",
        phone: "1",
        status: "archived",
      },
    ];
    for (const input of invalidInputs) {
      await expect(kit.invoke(createCustomer, input)).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
    expect(await countCompanyCustomers(kitIdentities.companies.a)).toBe(before);
  });

  it("returns the same not-found for unknown and foreign group or price list", async () => {
    const missingGroup = randomUUID();
    const missingList = randomUUID();
    const missingGroupError = await kit
      .invoke(createCustomer, {
        name: "Ghost group",
        phone: "+380501000041",
        groupId: missingGroup,
      })
      .then(
        () => {
          throw new Error("expected NotFoundError for a missing group");
        },
        (error: unknown) => error,
      );
    const foreignGroupError = await kit
      .invoke(createCustomer, {
        name: "Foreign group",
        phone: "+380501000042",
        groupId: fixtures.groupB,
      })
      .then(
        () => {
          throw new Error("expected NotFoundError for a foreign group");
        },
        (error: unknown) => error,
      );
    const missingListError = await kit
      .invoke(createCustomer, {
        name: "Ghost list",
        phone: "+380501000043",
        priceListId: missingList,
      })
      .then(
        () => {
          throw new Error("expected NotFoundError for a missing price list");
        },
        (error: unknown) => error,
      );
    const foreignListError = await kit
      .invoke(createCustomer, {
        name: "Foreign list",
        phone: "+380501000044",
        priceListId: fixtures.listB,
      })
      .then(
        () => {
          throw new Error("expected NotFoundError for a foreign price list");
        },
        (error: unknown) => error,
      );

    expect(missingGroupError).toBeInstanceOf(NotFoundError);
    expect(foreignGroupError).toBeInstanceOf(NotFoundError);
    expect(missingListError).toBeInstanceOf(NotFoundError);
    expect(foreignListError).toBeInstanceOf(NotFoundError);
    if (
      missingGroupError instanceof NotFoundError &&
      foreignGroupError instanceof NotFoundError
    ) {
      expect(missingGroupError.clientMessage).toBe(
        foreignGroupError.clientMessage,
      );
    }
    if (
      missingListError instanceof NotFoundError &&
      foreignListError instanceof NotFoundError
    ) {
      expect(missingListError.clientMessage).toBe(
        foreignListError.clientMessage,
      );
    }
  });

  it("conflicts on a duplicate company userId and not-founds an unknown userId", async () => {
    await kit.invoke(createCustomer, {
      name: "First link",
      userId: linkedUsers.second,
    });
    await expect(
      kit.invoke(createCustomer, {
        name: "Second link",
        userId: linkedUsers.second,
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    const unknownUserError = await kit
      .invoke(createCustomer, {
        name: "Ghost user",
        userId: "missing-user-does-not-exist",
      })
      .then(
        () => {
          throw new Error("expected NotFoundError for a missing user");
        },
        (error: unknown) => error,
      );
    expect(unknownUserError).toBeInstanceOf(NotFoundError);
  });
});

describe("customers.createCustomer provenance (SHO-465)", () => {
  it("stores ctx.channel and leaves vouched columns null", async () => {
    const viaUi = await kit.invoke(
      createCustomer,
      { name: "Provenance UI", phone: "+380501000101" },
      {},
      { request: { channel: "ui" } },
    );
    const viaAi = await kit.invoke(
      createCustomer,
      { name: "Provenance AI", phone: "+380501000102" },
      {},
      { request: { channel: "ai", aiTraceId: "sho-465-customer" } },
    );
    const rows = await kit.db.runtime.db
      .select({
        id: companyCustomers.id,
        createdVia: companyCustomers.createdVia,
        vouchedBy: companyCustomers.vouchedBy,
        vouchedAt: companyCustomers.vouchedAt,
      })
      .from(companyCustomers)
      .where(eq(companyCustomers.id, viaUi.id));
    const aiRows = await kit.db.runtime.db
      .select({
        createdVia: companyCustomers.createdVia,
        vouchedBy: companyCustomers.vouchedBy,
        vouchedAt: companyCustomers.vouchedAt,
      })
      .from(companyCustomers)
      .where(eq(companyCustomers.id, viaAi.id));
    expect(rows[0]).toEqual({
      id: viaUi.id,
      createdVia: "ui",
      vouchedBy: null,
      vouchedAt: null,
    });
    expect(aiRows[0]).toEqual({
      createdVia: "ai",
      vouchedBy: null,
      vouchedAt: null,
    });
  });
});

describe("customers.updateCustomer", () => {
  it("changes name, reassigns and clears group, sets and clears price list", async () => {
    const created = await kit.invoke(createCustomer, {
      name: "Before",
      phone: "+380501000050",
      groupId: fixtures.groupA,
    });
    const requestId = randomUUID();
    const renamed = await kit.invoke(
      updateCustomer,
      {
        id: created.id,
        name: "  After  ",
        phone: "+380501000050",
        groupId: fixtures.groupAOther,
      },
      {},
      { request: { requestId } },
    );
    expect(renamed).toMatchObject({
      id: created.id,
      name: "After",
      phone: "+380501000050",
      groupId: fixtures.groupAOther,
      priceListId: null,
      status: "active",
    });

    const clearedGroup = await kit.invoke(updateCustomer, {
      id: created.id,
      name: "After",
      phone: "+380501000050",
      groupId: null,
      priceListId: fixtures.listA,
    });
    expect(clearedGroup).toMatchObject({
      groupId: null,
      priceListId: fixtures.listA,
    });

    const clearedList = await kit.invoke(updateCustomer, {
      id: created.id,
      name: "After",
      phone: "+380501000050",
      priceListId: null,
    });
    expect(clearedList).toMatchObject({
      groupId: null,
      priceListId: null,
    });

    const auditRows = await kit.db.runtime.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.requestId, requestId));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: "customers.updateCustomer",
      companyId: kitIdentities.companies.a,
      targetType: "customer",
      targetId: created.id,
      outcome: "ok",
    });
  });

  it("updates an archived customer without restoring and counts linked counterparties", async () => {
    const archived = await kit.invoke(updateCustomer, {
      id: fixtures.customerArchived,
      name: "Still archived",
      phone: "+380501000012",
    });
    expect(archived).toMatchObject({
      id: fixtures.customerArchived,
      name: "Still archived",
      status: "archived",
      linkedCounterpartyCount: 0,
    });
    expect((await customerRow(fixtures.customerArchived))?.status).toBe(
      "archived",
    );

    const withParty = await kit.invoke(updateCustomer, {
      id: fixtures.customerWithParty,
      name: "Still has party",
      email: "party@kit.test",
    });
    expect(withParty.linkedCounterpartyCount).toBe(1);
    expect(withParty.status).toBe("active");
  });

  it("denies staff without customers:edit", async () => {
    await expect(
      kit.invoke(
        updateCustomer,
        {
          id: fixtures.customerUpdateA,
          name: "Nope",
          phone: "+380501000010",
        },
        { userId: clerks.noWrite, companyId: kitIdentities.companies.a },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("returns the same not-found for missing and foreign customers", async () => {
    const missingId = randomUUID();
    const missingError = await kit
      .invoke(updateCustomer, {
        id: missingId,
        name: "Ghost",
        phone: "1",
      })
      .then(
        () => {
          throw new Error("expected NotFoundError for a missing customer");
        },
        (error: unknown) => error,
      );
    const foreignError = await kit
      .invoke(updateCustomer, {
        id: fixtures.customerUpdateB,
        name: "Ghost",
        phone: "1",
      })
      .then(
        () => {
          throw new Error("expected NotFoundError for a foreign customer");
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

    const foreignRow = await customerRow(fixtures.customerUpdateB);
    expect(foreignRow?.name).toBe("Update Bravo");
    expect(foreignRow?.companyId).toBe(kitIdentities.companies.b);
  });

  it("cannot assign another company's group or price list", async () => {
    await expect(
      kit.invoke(updateCustomer, {
        id: fixtures.customerUpdateA,
        name: "Update Alpha",
        phone: "+380501000010",
        groupId: fixtures.groupB,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      kit.invoke(updateCustomer, {
        id: fixtures.customerUpdateA,
        name: "Update Alpha",
        phone: "+380501000010",
        priceListId: fixtures.listB,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects blank names, missing contacts, and companyId", async () => {
    const invalidInputs: unknown[] = [
      {
        id: fixtures.customerUpdateA,
        name: "   ",
        phone: "1",
      },
      {
        id: fixtures.customerUpdateA,
        name: "Cake",
      },
      {
        id: "not-a-uuid",
        name: "Cake",
        phone: "1",
      },
      {
        id: fixtures.customerUpdateA,
        name: "Cake",
        phone: "1",
        companyId: kitIdentities.companies.a,
      },
    ];
    for (const input of invalidInputs) {
      await expect(kit.invoke(updateCustomer, input)).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
  });

  it("conflicts on a duplicate company userId and not-founds an unknown userId", async () => {
    await kit.invoke(createCustomer, {
      name: "Update first link",
      userId: linkedUsers.third,
    });
    const second = await kit.invoke(createCustomer, {
      name: "Update second",
      phone: "+380501000060",
    });
    await expect(
      kit.invoke(updateCustomer, {
        id: second.id,
        name: "Update second",
        userId: linkedUsers.third,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      kit.invoke(updateCustomer, {
        id: second.id,
        name: "Update second",
        userId: "missing-user-does-not-exist",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
