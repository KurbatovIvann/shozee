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
import { companyCustomers, counterparties } from "@showzy/db/schema/customers";
import { and, count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  COUNTERPARTY_NAME_MAX,
  COUNTERPARTY_NOTES_MAX,
} from "./counterparty-view.contract.js";
import { createCounterparty } from "./create-counterparty.js";
import { getCustomer } from "./get-customer.js";
import { updateCounterparty } from "./update-counterparty.js";

const fixtures = {
  customerA: randomUUID(),
  customerAArchived: randomUUID(),
  customerACount: randomUUID(),
  customerARelink: randomUUID(),
  customerB: randomUUID(),
  partyUpdateA: randomUUID(),
  partyUpdateB: randomUUID(),
  partyIdem: randomUUID(),
  partyEdrpou: randomUUID(),
};

const clerks = {
  viewOnly: randomUUID(),
  deleteOnly: randomUUID(),
};

const createIsolationInput = {
  name: "Isolation create A",
};

const updateIsolationOwn = {
  id: fixtures.partyUpdateA,
  name: "Isolation updated A",
};

const updateIsolationForeign = {
  id: fixtures.partyUpdateB,
  name: "Isolation updated B",
};

const occupiedEdrpou = "12345678";
const otherEdrpou = "87654321";
const fixtureIban = "UA123456789012345678901234567";

let kit: TestKit;

async function countCompanyCounterparties(companyId: string): Promise<number> {
  const rows = await kit.db.runtime.db
    .select({ value: count() })
    .from(counterparties)
    .where(eq(counterparties.companyId, companyId));
  return rows[0]?.value ?? 0;
}

async function countUpdateAudits(counterpartyId: string): Promise<number> {
  const rows = await kit.db.runtime.db
    .select({ value: count() })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, "customers.updateCounterparty"),
        eq(auditLog.targetId, counterpartyId),
        eq(auditLog.outcome, "ok"),
      ),
    );
  return rows[0]?.value ?? 0;
}

async function counterpartyRow(counterpartyId: string) {
  const rows = await kit.db.runtime.db
    .select()
    .from(counterparties)
    .where(eq(counterparties.id, counterpartyId));
  return rows[0];
}

beforeAll(async () => {
  kit = await createTestKit();

  await kit.db.runtime.db.insert(companyCustomers).values([
    {
      id: fixtures.customerA,
      companyId: kitIdentities.companies.a,
      name: "Alpha Cake",
      phone: "+380501111111",
    },
    {
      id: fixtures.customerAArchived,
      companyId: kitIdentities.companies.a,
      name: "Archived Baker",
      email: "archived@kit.test",
      status: "archived",
    },
    {
      id: fixtures.customerACount,
      companyId: kitIdentities.companies.a,
      name: "Count Cake",
      phone: "+380501111113",
    },
    {
      id: fixtures.customerARelink,
      companyId: kitIdentities.companies.a,
      name: "Relink Target",
      phone: "+380501111112",
    },
    {
      id: fixtures.customerB,
      companyId: kitIdentities.companies.b,
      name: "Bravo Cake",
      email: "bravo@kit.test",
    },
  ]);

  await kit.db.runtime.db.insert(counterparties).values([
    {
      id: fixtures.partyUpdateA,
      companyId: kitIdentities.companies.a,
      name: "Update Alpha",
    },
    {
      id: fixtures.partyUpdateB,
      companyId: kitIdentities.companies.b,
      name: "Update Bravo",
    },
    {
      id: fixtures.partyIdem,
      companyId: kitIdentities.companies.a,
      name: "Idem Target",
    },
    {
      id: fixtures.partyEdrpou,
      companyId: kitIdentities.companies.a,
      name: "Occupied EDRPOU",
      edrpou: occupiedEdrpou,
    },
  ]);

  await kit.db.runtime.db.insert(user).values([
    {
      id: clerks.viewOnly,
      name: "Viewer",
      email: "viewer@customers-counterparties.test",
    },
    {
      id: clerks.deleteOnly,
      name: "Deleter",
      email: "deleter@customers-counterparties.test",
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
      createCounterparty,
      { input: createIsolationInput },
      { input: createIsolationInput, companyId: kitIdentities.companies.b },
    ),
    isolationCase(
      updateCounterparty,
      { input: updateIsolationOwn },
      { input: updateIsolationForeign },
    ),
  ],
);

idempotencySuite(
  () => kit,
  [
    {
      action: createCounterparty,
      input: { name: "Idem Create" },
      conflictingInput: { name: "Idem Create Other" },
      readEffect: () => countCompanyCounterparties(kitIdentities.companies.a),
    },
    {
      action: updateCounterparty,
      input: {
        id: fixtures.partyIdem,
        name: "Idem Updated",
      },
      conflictingInput: {
        id: fixtures.partyIdem,
        name: "Idem Conflicting",
      },
      readEffect: () => countUpdateAudits(fixtures.partyIdem),
    },
  ],
);

describe("customers.createCounterparty", () => {
  it("creates standalone, linked, full requisites, and multiple null-edrpou rows", async () => {
    const requestId = randomUUID();
    const standalone = await kit.invoke(
      createCounterparty,
      { name: "  ТОВ Самостійна  " },
      {},
      { request: { requestId } },
    );
    expect(standalone).toMatchObject({
      name: "ТОВ Самостійна",
      edrpou: null,
      legalAddress: null,
      iban: null,
      bankName: null,
      bankMfo: null,
      phone: null,
      email: null,
      notes: null,
      customerId: null,
      customerName: null,
    });
    expect(standalone.createdAt).toEqual(expect.any(String));
    expect(standalone.updatedAt).toEqual(expect.any(String));

    const linked = await kit.invoke(createCounterparty, {
      name: "ТОВ Прив'язана",
      customerId: fixtures.customerA,
    });
    expect(linked).toMatchObject({
      name: "ТОВ Прив'язана",
      customerId: fixtures.customerA,
      customerName: "Alpha Cake",
    });

    const archivedLink = await kit.invoke(createCounterparty, {
      name: "ТОВ Архів",
      customerId: fixtures.customerAArchived,
    });
    expect(archivedLink).toMatchObject({
      customerId: fixtures.customerAArchived,
      customerName: "Archived Baker",
    });

    const fullRequestId = randomUUID();
    const full = await kit.invoke(
      createCounterparty,
      {
        name: "ТОВ Повна",
        edrpou: otherEdrpou,
        legalAddress: "вул. Хрещатик, 1",
        iban: fixtureIban,
        bankName: "ПриватБанк",
        bankMfo: "300001",
        phone: "+380501000001",
        email: "office@kit.test",
        notes: "keep me",
        customerId: fixtures.customerA,
      },
      {},
      { request: { requestId: fullRequestId } },
    );
    expect(full).toMatchObject({
      name: "ТОВ Повна",
      edrpou: otherEdrpou,
      legalAddress: "вул. Хрещатик, 1",
      iban: fixtureIban,
      bankName: "ПриватБанк",
      bankMfo: "300001",
      phone: "+380501000001",
      email: "office@kit.test",
      notes: "keep me",
      customerId: fixtures.customerA,
      customerName: "Alpha Cake",
    });

    const nullEdrpouA = await kit.invoke(createCounterparty, {
      name: "Null EDRPOU A",
      edrpou: null,
    });
    const nullEdrpouB = await kit.invoke(createCounterparty, {
      name: "Null EDRPOU B",
      edrpou: "   ",
    });
    expect(nullEdrpouA.edrpou).toBeNull();
    expect(nullEdrpouB.edrpou).toBeNull();
    expect(nullEdrpouA.id).not.toBe(nullEdrpouB.id);

    const row = await counterpartyRow(standalone.id);
    expect(row).toMatchObject({
      companyId: kitIdentities.companies.a,
      name: "ТОВ Самостійна",
      customerId: null,
      edrpou: null,
    });

    const auditRows = await kit.db.runtime.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.requestId, requestId));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: "customers.createCounterparty",
      companyId: kitIdentities.companies.a,
      actorType: "user",
      actorId: kitIdentities.users.anna,
      targetType: "counterparty",
      targetId: standalone.id,
      outcome: "ok",
      inputSnapshot: null,
    });

    const fullAuditRows = await kit.db.runtime.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.requestId, fullRequestId));
    expect(fullAuditRows).toHaveLength(1);
    expect(fullAuditRows[0]).toMatchObject({
      action: "customers.createCounterparty",
      targetType: "counterparty",
      targetId: full.id,
      outcome: "ok",
      inputSnapshot: null,
    });
    const auditJson = JSON.stringify(fullAuditRows[0]);
    expect(auditJson).not.toContain(fixtureIban);
    expect(auditJson).not.toContain(occupiedEdrpou);
    expect(auditJson).not.toContain(otherEdrpou);

    const eventRows = await kit.db.runtime.db
      .select({ id: domainEvents.id })
      .from(domainEvents)
      .where(eq(domainEvents.requestId, requestId));
    expect(eventRows).toEqual([]);

    const afterLink = await kit.invoke(getCustomer, {
      id: fixtures.customerA,
    });
    expect(afterLink.linkedCounterpartyCount).toBe(2);
  });

  it("denies staff with only customers:view and staff with only customers:delete", async () => {
    await expect(
      kit.invoke(
        createCounterparty,
        { name: "Denied view" },
        { userId: clerks.viewOnly, companyId: kitIdentities.companies.a },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      kit.invoke(
        createCounterparty,
        { name: "Denied delete" },
        { userId: clerks.deleteOnly, companyId: kitIdentities.companies.a },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("rejects blank names, over-max lengths, and companyId", async () => {
    const before = await countCompanyCounterparties(kitIdentities.companies.a);
    const invalidInputs: unknown[] = [
      { name: "   " },
      { name: "x".repeat(COUNTERPARTY_NAME_MAX + 1) },
      { name: "ТОВ", notes: "x".repeat(COUNTERPARTY_NOTES_MAX + 1) },
      { name: "ТОВ", companyId: kitIdentities.companies.a },
    ];
    for (const input of invalidInputs) {
      await expect(
        kit.invoke(createCounterparty, input),
      ).rejects.toBeInstanceOf(ValidationError);
    }
    expect(await countCompanyCounterparties(kitIdentities.companies.a)).toBe(
      before,
    );
  });

  it("conflicts on duplicate company edrpou and not-founds missing or foreign customerId", async () => {
    await expect(
      kit.invoke(createCounterparty, {
        name: "Duplicate EDRPOU",
        edrpou: occupiedEdrpou,
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    const missingCustomer = randomUUID();
    const missingError = await kit
      .invoke(createCounterparty, {
        name: "Ghost customer",
        customerId: missingCustomer,
      })
      .then(
        () => {
          throw new Error("expected NotFoundError for a missing customer");
        },
        (error: unknown) => error,
      );
    const foreignError = await kit
      .invoke(createCounterparty, {
        name: "Foreign customer",
        customerId: fixtures.customerB,
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
  });
});

describe("customers.createCounterparty provenance (SHO-465)", () => {
  it("stores ctx.channel and leaves vouched columns null", async () => {
    const viaUi = await kit.invoke(
      createCounterparty,
      { name: "Provenance UI party" },
      {},
      { request: { channel: "ui" } },
    );
    const viaAi = await kit.invoke(
      createCounterparty,
      { name: "Provenance AI party" },
      {},
      { request: { channel: "ai", aiTraceId: "sho-465-party" } },
    );
    const rows = await kit.db.runtime.db
      .select({
        createdVia: counterparties.createdVia,
        vouchedBy: counterparties.vouchedBy,
        vouchedAt: counterparties.vouchedAt,
      })
      .from(counterparties)
      .where(eq(counterparties.id, viaUi.id));
    const aiRows = await kit.db.runtime.db
      .select({
        createdVia: counterparties.createdVia,
        vouchedBy: counterparties.vouchedBy,
        vouchedAt: counterparties.vouchedAt,
      })
      .from(counterparties)
      .where(eq(counterparties.id, viaAi.id));
    expect(rows[0]).toEqual({
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

describe("customers.updateCounterparty", () => {
  it("changes name and requisites, links, unlinks, and relinks", async () => {
    const created = await kit.invoke(createCounterparty, {
      name: "Before",
      notes: "keep",
    });
    const requestId = randomUUID();
    const renamed = await kit.invoke(
      updateCounterparty,
      {
        id: created.id,
        name: "  After  ",
        legalAddress: "вул. Сумська, 2",
        bankName: "Ощадбанк",
        bankMfo: "300335",
        notes: "keep",
      },
      {},
      { request: { requestId } },
    );
    expect(renamed).toMatchObject({
      id: created.id,
      name: "After",
      legalAddress: "вул. Сумська, 2",
      bankName: "Ощадбанк",
      bankMfo: "300335",
      notes: "keep",
      customerId: null,
      customerName: null,
    });

    const linked = await kit.invoke(updateCounterparty, {
      id: created.id,
      name: "After",
      customerId: fixtures.customerACount,
    });
    expect(linked).toMatchObject({
      customerId: fixtures.customerACount,
      customerName: "Count Cake",
      legalAddress: null,
      bankName: null,
      bankMfo: null,
      notes: null,
    });
    expect(
      (await kit.invoke(getCustomer, { id: fixtures.customerACount }))
        .linkedCounterpartyCount,
    ).toBe(1);

    const unlinked = await kit.invoke(updateCounterparty, {
      id: created.id,
      name: "After",
      customerId: null,
    });
    expect(unlinked).toMatchObject({
      customerId: null,
      customerName: null,
    });
    expect(
      (await kit.invoke(getCustomer, { id: fixtures.customerACount }))
        .linkedCounterpartyCount,
    ).toBe(0);

    const relinked = await kit.invoke(updateCounterparty, {
      id: created.id,
      name: "After",
      customerId: fixtures.customerARelink,
    });
    expect(relinked).toMatchObject({
      customerId: fixtures.customerARelink,
      customerName: "Relink Target",
    });
    expect(
      (await kit.invoke(getCustomer, { id: fixtures.customerARelink }))
        .linkedCounterpartyCount,
    ).toBe(1);
    expect(
      (await kit.invoke(getCustomer, { id: fixtures.customerACount }))
        .linkedCounterpartyCount,
    ).toBe(0);

    const archivedStay = await kit.invoke(updateCounterparty, {
      id: created.id,
      name: "After",
      customerId: fixtures.customerAArchived,
    });
    expect(archivedStay).toMatchObject({
      customerId: fixtures.customerAArchived,
      customerName: "Archived Baker",
    });

    const auditRows = await kit.db.runtime.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.requestId, requestId));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: "customers.updateCounterparty",
      companyId: kitIdentities.companies.a,
      targetType: "counterparty",
      targetId: created.id,
      outcome: "ok",
      inputSnapshot: null,
    });
  });

  it("denies staff with only customers:view and staff with only customers:delete", async () => {
    await expect(
      kit.invoke(
        updateCounterparty,
        { id: fixtures.partyUpdateA, name: "Nope" },
        { userId: clerks.viewOnly, companyId: kitIdentities.companies.a },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      kit.invoke(
        updateCounterparty,
        { id: fixtures.partyUpdateA, name: "Nope" },
        { userId: clerks.deleteOnly, companyId: kitIdentities.companies.a },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("returns the same not-found for missing and foreign counterparties", async () => {
    const missingId = randomUUID();
    const missingError = await kit
      .invoke(updateCounterparty, {
        id: missingId,
        name: "Ghost",
      })
      .then(
        () => {
          throw new Error("expected NotFoundError for a missing counterparty");
        },
        (error: unknown) => error,
      );
    const foreignError = await kit
      .invoke(updateCounterparty, {
        id: fixtures.partyUpdateB,
        name: "Ghost",
      })
      .then(
        () => {
          throw new Error("expected NotFoundError for a foreign counterparty");
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

    const foreignRow = await counterpartyRow(fixtures.partyUpdateB);
    expect(foreignRow?.name).toBe("Update Bravo");
    expect(foreignRow?.companyId).toBe(kitIdentities.companies.b);
  });

  it("cannot link another company's customer and conflicts on colliding edrpou", async () => {
    await expect(
      kit.invoke(updateCounterparty, {
        id: fixtures.partyUpdateA,
        name: "Update Alpha",
        customerId: fixtures.customerB,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      kit.invoke(updateCounterparty, {
        id: fixtures.partyUpdateA,
        name: "Update Alpha",
        customerId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    await expect(
      kit.invoke(updateCounterparty, {
        id: fixtures.partyUpdateA,
        name: "Update Alpha",
        edrpou: occupiedEdrpou,
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    const sameEdrpou = await kit.invoke(updateCounterparty, {
      id: fixtures.partyEdrpou,
      name: "Occupied EDRPOU kept",
      edrpou: occupiedEdrpou,
    });
    expect(sameEdrpou.edrpou).toBe(occupiedEdrpou);
  });

  it("rejects blank names and companyId", async () => {
    const invalidInputs: unknown[] = [
      {
        id: fixtures.partyUpdateA,
        name: "   ",
      },
      {
        id: "not-a-uuid",
        name: "Cake",
      },
      {
        id: fixtures.partyUpdateA,
        name: "Cake",
        companyId: kitIdentities.companies.a,
      },
    ];
    for (const input of invalidInputs) {
      await expect(
        kit.invoke(updateCounterparty, input),
      ).rejects.toBeInstanceOf(ValidationError);
    }
  });
});
