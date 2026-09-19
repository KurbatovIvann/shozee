import { randomUUID } from "node:crypto";

import { PermissionDeniedError, ValidationError } from "@showzy/core/errors";
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
import {
  companies,
  companyLegalInfo,
  companyMembers,
  rolePermissionDefaults,
} from "@showzy/db/schema/companies";
import { count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { COMPANY_LEGAL_NAME_MAX } from "./company-view.contract.js";
import { getCompany } from "./get.js";
import { updateLegal } from "./update-legal.js";

const clerks = {
  manager: randomUUID(),
  employee: randomUUID(),
  admin: randomUUID(),
};

const fixtureIban = "UA123456789012345678901234567";
const replacedIban = "UA222222222222222222222222222";
const foreignIban = "UA999999999999999999999999999";

const updateIsolationInput = {
  companyType: "fop" as const,
  legalName: "Isolation Legal A",
};

let kit: TestKit;

async function countCompanyLegalRows(companyId: string): Promise<number> {
  const rows = await kit.db.runtime.db
    .select({ value: count() })
    .from(companyLegalInfo)
    .where(eq(companyLegalInfo.companyId, companyId));
  return rows[0]?.value ?? 0;
}

async function companyRow(companyId: string) {
  const rows = await kit.db.runtime.db
    .select()
    .from(companies)
    .where(eq(companies.id, companyId));
  return rows[0];
}

async function legalRow(companyId: string) {
  const rows = await kit.db.runtime.db
    .select()
    .from(companyLegalInfo)
    .where(eq(companyLegalInfo.companyId, companyId));
  return rows[0];
}

beforeAll(async () => {
  kit = await createTestKit();

  await kit.db.runtime.db.insert(rolePermissionDefaults).values({
    role: "admin",
    permission: "settings:payments",
  });

  await kit.db.runtime.db.insert(companyLegalInfo).values({
    companyId: kitIdentities.companies.b,
    companyType: "fop",
    legalName: "ФОП Борис",
    iban: foreignIban,
  });

  await kit.db.runtime.db.insert(user).values([
    {
      id: clerks.manager,
      name: "Manager",
      email: "manager@companies-update-legal.test",
    },
    {
      id: clerks.employee,
      name: "Employee",
      email: "employee@companies-update-legal.test",
    },
    {
      id: clerks.admin,
      name: "Admin",
      email: "admin@companies-update-legal.test",
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
    {
      companyId: kitIdentities.companies.a,
      userId: clerks.admin,
      role: "admin",
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
      updateLegal,
      { input: updateIsolationInput },
      { input: updateIsolationInput, companyId: kitIdentities.companies.b },
    ),
  ],
);

idempotencySuite(
  () => kit,
  [
    {
      action: updateLegal,
      input: { companyType: "fop" as const, legalName: "Idem Legal" },
      conflictingInput: {
        companyType: "tov" as const,
        legalName: "Idem Conflicting",
      },
      readEffect: () => countCompanyLegalRows(kitIdentities.companies.a),
    },
  ],
);

describe("companies.updateLegal", () => {
  it("upserts legal info, returns it on get, keeps omitted fields, and stores empty optionals as null", async () => {
    const identityBefore = await companyRow(kitIdentities.companies.a);
    const requestId = randomUUID();
    const created = await kit.invoke(
      updateLegal,
      {
        companyType: "fop",
        legalName: "  ФОП Коваленко  ",
        edrpou: "12345678",
        legalAddress: "вул. Хрещатик, 1",
        iban: fixtureIban,
        bankName: "ПриватБанк",
        bankMfo: "300001",
        bankEdrpou: "12345678",
        phone: "+380501000001",
        email: "office@kit.test",
      },
      {},
      { request: { requestId } },
    );

    expect(created).toMatchObject({
      id: kitIdentities.companies.a,
      name: "Konditerska Anna",
      slug: "konditerska-anna",
      prefix: "KA",
      legal: {
        companyType: "fop",
        legalName: "ФОП Коваленко",
        edrpou: "12345678",
        legalAddress: "вул. Хрещатик, 1",
        iban: fixtureIban,
        bankName: "ПриватБанк",
        bankMfo: "300001",
        bankEdrpou: "12345678",
        phone: "+380501000001",
        email: "office@kit.test",
      },
    });
    expect(created.legal?.id).toEqual(expect.any(String));
    expect(created.legal?.createdAt).toEqual(expect.any(String));
    expect(created.legal?.updatedAt).toEqual(expect.any(String));

    const loaded = await kit.invoke(getCompany, {});
    expect(loaded).toEqual(created);
    expect(await countCompanyLegalRows(kitIdentities.companies.a)).toBe(1);

    const replaced = await kit.invoke(updateLegal, {
      companyType: "tov",
      legalName: "ТОВ Київські торти",
      iban: replacedIban,
      bankName: "Ощадбанк",
      bankMfo: "300335",
    });
    expect(replaced.legal).toMatchObject({
      id: created.legal?.id,
      companyType: "tov",
      legalName: "ТОВ Київські торти",
      edrpou: "12345678",
      legalAddress: "вул. Хрещатик, 1",
      iban: replacedIban,
      bankName: "Ощадбанк",
      bankMfo: "300335",
      bankEdrpou: "12345678",
      phone: "+380501000001",
      email: "office@kit.test",
    });
    expect(await countCompanyLegalRows(kitIdentities.companies.a)).toBe(1);

    const cleared = await kit.invoke(updateLegal, {
      companyType: "tov",
      legalName: "ТОВ Київські торти",
      edrpou: "   ",
      legalAddress: "",
      iban: "   ",
      bankName: "",
      bankMfo: "   ",
      bankEdrpou: "",
      phone: "   ",
      email: "",
    });
    expect(cleared.legal).toMatchObject({
      id: created.legal?.id,
      companyType: "tov",
      legalName: "ТОВ Київські торти",
      edrpou: null,
      legalAddress: null,
      iban: null,
      bankName: null,
      bankMfo: null,
      bankEdrpou: null,
      phone: null,
      email: null,
    });

    const stored = await legalRow(kitIdentities.companies.a);
    expect(stored).toMatchObject({
      companyId: kitIdentities.companies.a,
      companyType: "tov",
      legalName: "ТОВ Київські торти",
      edrpou: null,
      iban: null,
    });

    const identityAfter = await companyRow(kitIdentities.companies.a);
    expect(identityAfter).toMatchObject({
      name: identityBefore?.name,
      slug: identityBefore?.slug,
      prefix: identityBefore?.prefix,
    });

    const foreign = await legalRow(kitIdentities.companies.b);
    expect(foreign).toMatchObject({
      legalName: "ФОП Борис",
      iban: foreignIban,
    });

    const auditRows = await kit.db.runtime.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.requestId, requestId));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: "companies.updateLegal",
      companyId: kitIdentities.companies.a,
      actorType: "user",
      actorId: kitIdentities.users.anna,
      targetType: "company",
      targetId: kitIdentities.companies.a,
      outcome: "ok",
      inputSnapshot: null,
    });
    const auditJson = JSON.stringify(auditRows[0]);
    expect(auditJson).not.toContain(fixtureIban);
    expect(auditJson).not.toContain("12345678");
    expect(auditJson).not.toContain("+380501000001");
    expect(auditJson).not.toContain("office@kit.test");

    const eventRows = await kit.db.runtime.db
      .select({ id: domainEvents.id })
      .from(domainEvents)
      .where(eq(domainEvents.requestId, requestId));
    expect(eventRows).toEqual([]);
  });

  it("denies manager and employee without settings:payments and allows owner and admin", async () => {
    await expect(
      kit.invoke(
        updateLegal,
        { companyType: "fop", legalName: "Denied manager" },
        { userId: clerks.manager, companyId: kitIdentities.companies.a },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      kit.invoke(
        updateLegal,
        { companyType: "fop", legalName: "Denied employee" },
        { userId: clerks.employee, companyId: kitIdentities.companies.a },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);

    const byAdmin = await kit.invoke(
      updateLegal,
      { companyType: "fop", legalName: "Admin Legal" },
      { userId: clerks.admin, companyId: kitIdentities.companies.a },
    );
    expect(byAdmin.legal).toMatchObject({
      companyType: "fop",
      legalName: "Admin Legal",
    });
  });

  it("rejects blank legal names, over-max lengths, invalid companyType, and companyId", async () => {
    const before = await countCompanyLegalRows(kitIdentities.companies.a);
    const invalidInputs: unknown[] = [
      { companyType: "fop", legalName: "   " },
      {
        companyType: "fop",
        legalName: "x".repeat(COMPANY_LEGAL_NAME_MAX + 1),
      },
      { companyType: "llc", legalName: "ФОП" },
      { companyType: "", legalName: "ФОП" },
      {
        companyType: "fop",
        legalName: "ФОП",
        companyId: kitIdentities.companies.a,
      },
    ];
    for (const input of invalidInputs) {
      await expect(kit.invoke(updateLegal, input)).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
    expect(await countCompanyLegalRows(kitIdentities.companies.a)).toBe(before);
  });
});
