import { randomUUID } from "node:crypto";

import { PermissionDeniedError, ValidationError } from "@showzy/core/errors";
import {
  createTestKit,
  crossTenantSuite,
  isolationCase,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import { auditLog, domainEvents, idempotencyKeys } from "@showzy/db";
import { user } from "@showzy/db/schema/auth";
import {
  companies,
  companyLegalInfo,
  companyMembers,
  rolePermissionDefaults,
} from "@showzy/db/schema/companies";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getCompany } from "./get.js";

const clerks = {
  manager: randomUUID(),
  employee: randomUUID(),
  admin: randomUUID(),
  denied: randomUUID(),
  viewWithoutDocuments: randomUUID(),
};

const fixtures = {
  companyWithLegal: randomUUID(),
};

const sampleEdrpou = "12345678";
const fixtureIban = "UA123456789012345678901234567";
const foreignIban = "UA999999999999999999999999999";
const foreignEdrpou = "87654321";

let kit: TestKit;

beforeAll(async () => {
  kit = await createTestKit();

  await kit.db.runtime.db.insert(rolePermissionDefaults).values([
    { role: "admin", permission: "companies:view" },
    { role: "manager", permission: "companies:view" },
    { role: "employee", permission: "companies:view" },
  ]);

  await kit.db.runtime.db.insert(companies).values({
    id: fixtures.companyWithLegal,
    name: "Legal Co",
    slug: "legal-co-get",
    prefix: "LG",
  });
  await kit.db.runtime.db.insert(companyMembers).values({
    companyId: fixtures.companyWithLegal,
    userId: kitIdentities.users.anna,
    role: "owner",
    permissions: { granted: [], denied: [] },
  });
  await kit.db.runtime.db.insert(companyLegalInfo).values({
    companyId: fixtures.companyWithLegal,
    companyType: "tov",
    legalName: "ТОВ Альфа",
    edrpou: sampleEdrpou,
    legalAddress: "вул. Хрещатик, 1",
    iban: fixtureIban,
    bankName: "ПриватБанк",
    bankMfo: "300001",
    bankEdrpou: "12345678",
    phone: "+380501111111",
    email: "legal@alpha.test",
  });
  await kit.db.runtime.db.insert(companyLegalInfo).values({
    companyId: kitIdentities.companies.b,
    companyType: "fop",
    legalName: "ФОП Борис",
    edrpou: foreignEdrpou,
    iban: foreignIban,
  });

  await kit.db.runtime.db.insert(user).values([
    {
      id: clerks.manager,
      name: "Manager",
      email: "manager@companies-get.test",
    },
    {
      id: clerks.employee,
      name: "Employee",
      email: "employee@companies-get.test",
    },
    {
      id: clerks.admin,
      name: "Admin",
      email: "admin@companies-get.test",
    },
    {
      id: clerks.denied,
      name: "Denied employee",
      email: "denied@companies-get.test",
    },
    {
      id: clerks.viewWithoutDocuments,
      name: "View without documents",
      email: "view-no-docs@companies-get.test",
    },
  ]);
  await kit.db.runtime.db.insert(companyMembers).values([
    {
      companyId: fixtures.companyWithLegal,
      userId: clerks.manager,
      role: "manager",
      permissions: { granted: [], denied: [] },
    },
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
    {
      companyId: kitIdentities.companies.a,
      userId: clerks.admin,
      role: "admin",
      permissions: { granted: [], denied: [] },
    },
    {
      companyId: kitIdentities.companies.a,
      userId: clerks.denied,
      role: "employee",
      permissions: { granted: [], denied: ["companies:view"] },
    },
    {
      companyId: fixtures.companyWithLegal,
      userId: clerks.viewWithoutDocuments,
      role: "employee",
      permissions: { granted: [], denied: ["documents:view"] },
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
      getCompany,
      { input: {} },
      { input: {}, companyId: kitIdentities.companies.b },
    ),
  ],
);

describe("companies.get", () => {
  it("returns identity with legal null when no legal row exists", async () => {
    const result = await kit.invoke(getCompany, {});
    expect(result).toEqual({
      id: kitIdentities.companies.a,
      name: "Konditerska Anna",
      slug: "konditerska-anna",
      prefix: "KA",
      legal: null,
    });
    expect(JSON.stringify(result)).not.toContain(foreignIban);
    expect(JSON.stringify(result)).not.toContain(foreignEdrpou);
  });

  it("returns the legal row for the active company", async () => {
    const result = await kit.invoke(
      getCompany,
      {},
      { companyId: fixtures.companyWithLegal },
    );
    expect(result).toMatchObject({
      id: fixtures.companyWithLegal,
      name: "Legal Co",
      slug: "legal-co-get",
      prefix: "LG",
      legal: {
        companyType: "tov",
        legalName: "ТОВ Альфа",
        edrpou: sampleEdrpou,
        legalAddress: "вул. Хрещатик, 1",
        iban: fixtureIban,
        bankName: "ПриватБанк",
        bankMfo: "300001",
        bankEdrpou: "12345678",
        phone: "+380501111111",
        email: "legal@alpha.test",
      },
    });
    expect(result.legal?.id).toEqual(expect.any(String));
    expect(result.legal?.createdAt).toEqual(expect.any(String));
    expect(result.legal?.updatedAt).toEqual(expect.any(String));
    expect(JSON.stringify(result)).not.toContain(foreignIban);
  });

  it("allows manager and employee with companies:view without settings:payments", async () => {
    await expect(
      kit.invoke(
        getCompany,
        {},
        { userId: clerks.manager, companyId: fixtures.companyWithLegal },
      ),
    ).resolves.toMatchObject({
      id: fixtures.companyWithLegal,
      prefix: "LG",
      legal: {
        companyType: "tov",
        legalName: "ТОВ Альфа",
        edrpou: sampleEdrpou,
        iban: fixtureIban,
      },
    });
    await expect(
      kit.invoke(
        getCompany,
        {},
        { userId: clerks.manager, companyId: kitIdentities.companies.a },
      ),
    ).resolves.toMatchObject({
      id: kitIdentities.companies.a,
      prefix: "KA",
      legal: null,
    });
    await expect(
      kit.invoke(
        getCompany,
        {},
        { userId: clerks.employee, companyId: kitIdentities.companies.a },
      ),
    ).resolves.toMatchObject({
      id: kitIdentities.companies.a,
      prefix: "KA",
      legal: null,
    });

    await expect(kit.invoke(getCompany, {})).resolves.toMatchObject({
      id: kitIdentities.companies.a,
      prefix: "KA",
      legal: null,
    });
    await expect(
      kit.invoke(
        getCompany,
        {},
        { userId: clerks.admin, companyId: kitIdentities.companies.a },
      ),
    ).resolves.toMatchObject({
      id: kitIdentities.companies.a,
      prefix: "KA",
      legal: null,
    });
  });

  it("returns legal including IBAN to an employee with companies:view and documents:view denied", async () => {
    const result = await kit.invoke(
      getCompany,
      {},
      {
        userId: clerks.viewWithoutDocuments,
        companyId: fixtures.companyWithLegal,
      },
    );
    expect(result).toMatchObject({
      id: fixtures.companyWithLegal,
      prefix: "LG",
      legal: {
        companyType: "tov",
        legalName: "ТОВ Альфа",
        edrpou: sampleEdrpou,
        iban: fixtureIban,
      },
    });
    expect(JSON.stringify(result)).not.toContain(foreignIban);
  });

  it("denies staff whose membership lacks companies:view", async () => {
    await expect(
      kit.invoke(
        getCompany,
        {},
        { userId: clerks.denied, companyId: kitIdentities.companies.a },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("rejects any input identifier — the input is a strict empty object", async () => {
    await expect(
      kit.invoke(getCompany, { companyId: kitIdentities.companies.a }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      kit.invoke(getCompany, { id: kitIdentities.companies.a }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("writes no audit row, no domain event, and no idempotency key", async () => {
    const requestId = randomUUID();
    const idempotencyKey = randomUUID();
    await kit.invoke(
      getCompany,
      {},
      {},
      { request: { requestId, idempotencyKey } },
    );
    const auditRows = await kit.db.runtime.db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(eq(auditLog.requestId, requestId));
    const eventRows = await kit.db.runtime.db
      .select({ id: domainEvents.id })
      .from(domainEvents)
      .where(eq(domainEvents.requestId, requestId));
    const idempotencyRows = await kit.db.runtime.db
      .select({ key: idempotencyKeys.key })
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.key, idempotencyKey));
    expect(auditRows).toEqual([]);
    expect(eventRows).toEqual([]);
    expect(idempotencyRows).toEqual([]);
  });
});
