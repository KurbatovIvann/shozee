import { randomUUID } from "node:crypto";

import { PermissionDeniedError, ValidationError } from "@showzy/core/errors";
import {
  accountIsolationSuite,
  createTestKit,
  crossTenantSuite,
  isolationCase,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import { auditLog, domainEvents } from "@showzy/db";
import { user } from "@showzy/db/schema/auth";
import {
  companies,
  companyMembers,
  rolePermissionDefaults,
} from "@showzy/db/schema/companies";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { listMine } from "./list-mine.js";

const fixtures = {
  emptyUser: randomUUID(),
  multiUser: randomUUID(),
  grantUser: randomUUID(),
  denyUser: randomUUID(),
  otherUser: randomUUID(),
  companyFirst: randomUUID(),
  companySecond: randomUUID(),
  companyGrant: randomUUID(),
  companyDeny: randomUUID(),
  companyOther: randomUUID(),
  membershipFirst: randomUUID(),
  membershipSecond: randomUUID(),
  membershipGrant: randomUUID(),
  membershipDeny: randomUUID(),
  membershipOther: randomUUID(),
};

const EMPLOYEE_DEFAULT_PERMISSIONS = [
  "orders:create",
  "orders:edit",
  "orders:view",
] as const;

const EMPLOYEE_DEFAULT_CLOSURE = [
  "companies:view",
  "customers:view",
  "orders:create",
  "orders:edit",
  "orders:view",
  "pricing:view",
  "products:view",
] as const;

let kit: TestKit;

beforeAll(async () => {
  kit = await createTestKit();

  await kit.db.runtime.db.insert(user).values([
    {
      id: fixtures.emptyUser,
      name: "No companies",
      email: "empty@companies-kit.test",
    },
    {
      id: fixtures.multiUser,
      name: "Two companies",
      email: "multi@companies-kit.test",
    },
    {
      id: fixtures.grantUser,
      name: "Granted employee",
      email: "grant@companies-kit.test",
    },
    {
      id: fixtures.denyUser,
      name: "Denied employee",
      email: "deny@companies-kit.test",
    },
    {
      id: fixtures.otherUser,
      name: "Other account",
      email: "other@companies-kit.test",
    },
  ]);

  await kit.db.runtime.db.insert(companies).values([
    {
      id: fixtures.companyFirst,
      name: "Zavod Zoryany",
      slug: "zavod-zoryany",
      prefix: "ZZ",
    },
    {
      id: fixtures.companySecond,
      name: "Atelier Amaltea",
      slug: "atelier-amaltea",
      prefix: "AA",
    },
    {
      id: fixtures.companyGrant,
      name: "Grant Workshop",
      slug: "grant-workshop",
      prefix: "GW",
    },
    {
      id: fixtures.companyDeny,
      name: "Deny Workshop",
      slug: "deny-workshop",
      prefix: "DW",
    },
    {
      id: fixtures.companyOther,
      name: "Other Workshop",
      slug: "other-workshop",
      prefix: "OW",
    },
  ]);

  // Insert defaults out of alphabetical order so listMine must sort.
  await kit.db.runtime.db.insert(rolePermissionDefaults).values([
    { role: "manager", permission: "orders:edit" },
    { role: "manager", permission: "orders:view" },
    { role: "manager", permission: "orders:create" },
    { role: "employee", permission: "orders:edit" },
    { role: "employee", permission: "orders:view" },
    { role: "employee", permission: "orders:create" },
  ]);

  // Explicit timestamps pin the stable order: the alphabetically-last
  // company was joined first and must stay first in the output.
  await kit.db.runtime.db.insert(companyMembers).values([
    {
      id: fixtures.membershipFirst,
      companyId: fixtures.companyFirst,
      userId: fixtures.multiUser,
      role: "owner",
      permissions: { granted: [], denied: ["orders:create"] },
      createdAt: new Date("2026-01-01T00:00:00Z"),
    },
    {
      id: fixtures.membershipSecond,
      companyId: fixtures.companySecond,
      userId: fixtures.multiUser,
      role: "manager",
      permissions: { granted: [], denied: [] },
      createdAt: new Date("2026-02-01T00:00:00Z"),
    },
    {
      id: fixtures.membershipGrant,
      companyId: fixtures.companyGrant,
      userId: fixtures.grantUser,
      role: "employee",
      permissions: { granted: ["files:view"], denied: [] },
    },
    {
      id: fixtures.membershipDeny,
      companyId: fixtures.companyDeny,
      userId: fixtures.denyUser,
      role: "employee",
      permissions: {
        granted: ["files:view", "orders:create"],
        denied: ["files:view", "orders:create"],
      },
    },
    {
      id: fixtures.membershipOther,
      companyId: fixtures.companyOther,
      userId: fixtures.otherUser,
      role: "employee",
      permissions: { granted: ["secrets:leak"], denied: [] },
    },
  ]);

  // Warm the pooled connection, Drizzle statements, and schema parsers
  // before the isolation suites run: the inherited rate-limit assertion
  // races the bucket's continuous refill, so cold first-call latency must
  // not eat its budget under parallel CI load.
  for (let i = 0; i < 3; i += 1) {
    await kit.invoke(listMine, {}, { userId: fixtures.emptyUser });
  }
});

afterAll(async () => {
  await kit.db.close();
});

crossTenantSuite(
  () => kit,
  [
    isolationCase(
      listMine,
      { input: {}, userId: kitIdentities.users.anna },
      { input: {}, userId: kitIdentities.users.boris },
    ),
  ],
);

accountIsolationSuite(
  () => kit,
  [
    isolationCase(
      listMine,
      { input: {}, userId: kitIdentities.users.anna },
      { input: {}, userId: kitIdentities.users.boris },
    ),
  ],
);

describe("companies.listMine", () => {
  it("returns [] for an account with no memberships", async () => {
    const result = await kit.invoke(
      listMine,
      {},
      { userId: fixtures.emptyUser },
    );
    expect(result).toEqual({ memberships: [] });
  });

  it("returns the caller's single membership with the company view", async () => {
    const result = await kit.invoke(
      listMine,
      {},
      { userId: kitIdentities.users.anna },
    );
    expect(result.memberships).toHaveLength(1);
    expect(result.memberships[0]).toMatchObject({
      role: "owner",
      permissions: [],
      company: {
        id: kitIdentities.companies.a,
        name: "Konditerska Anna",
        slug: "konditerska-anna",
        prefix: "KA",
      },
    });
    const membershipRows = await kit.db.runtime.db
      .select({ id: companyMembers.id })
      .from(companyMembers)
      .where(eq(companyMembers.userId, kitIdentities.users.anna));
    expect(result.memberships[0]?.membershipId).toBe(membershipRows[0]?.id);
  });

  it("returns multiple memberships in membership-creation order, not name order", async () => {
    const result = await kit.invoke(
      listMine,
      {},
      { userId: fixtures.multiUser },
    );
    expect(result).toEqual({
      memberships: [
        {
          membershipId: fixtures.membershipFirst,
          role: "owner",
          permissions: [],
          company: {
            id: fixtures.companyFirst,
            name: "Zavod Zoryany",
            slug: "zavod-zoryany",
            prefix: "ZZ",
          },
        },
        {
          membershipId: fixtures.membershipSecond,
          role: "manager",
          permissions: [...EMPLOYEE_DEFAULT_CLOSURE],
          company: {
            id: fixtures.companySecond,
            name: "Atelier Amaltea",
            slug: "atelier-amaltea",
            prefix: "AA",
          },
        },
      ],
    });
  });

  it("never returns another user's companies or memberships", async () => {
    const result = await kit.invoke(
      listMine,
      {},
      { userId: kitIdentities.users.boris },
    );
    expect(result.memberships.map((m) => m.company.id)).toEqual([
      kitIdentities.companies.b,
    ]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(kitIdentities.companies.a);
    expect(serialized).not.toContain(fixtures.companyFirst);
    expect(serialized).not.toContain(fixtures.companySecond);
  });

  it("returns role defaults, explicit grants, and deny-over-grant/default with stable key order", async () => {
    const granted = await kit.invoke(
      listMine,
      {},
      { userId: fixtures.grantUser },
    );
    expect(granted.memberships).toHaveLength(1);
    expect(granted.memberships[0]?.membershipId).toBe(fixtures.membershipGrant);
    expect(granted.memberships[0]?.role).toBe("employee");
    expect(granted.memberships[0]?.permissions).toEqual([
      "companies:view",
      "customers:view",
      "files:view",
      "orders:create",
      "orders:edit",
      "orders:view",
      "pricing:view",
      "products:view",
    ]);

    const denied = await kit.invoke(
      listMine,
      {},
      { userId: fixtures.denyUser },
    );
    expect(denied.memberships).toHaveLength(1);
    expect(denied.memberships[0]?.membershipId).toBe(fixtures.membershipDeny);
    expect(denied.memberships[0]?.permissions).toEqual([
      "companies:view",
      "customers:view",
      "orders:edit",
      "orders:view",
    ]);
    expect(denied.memberships[0]?.permissions).not.toContain("orders:create");
    expect(denied.memberships[0]?.permissions).not.toContain("files:view");
  });

  it("does not enumerate owner-all even when the owner row has an explicit deny", async () => {
    const result = await kit.invoke(
      listMine,
      {},
      { userId: fixtures.multiUser },
    );
    const owner = result.memberships[0];
    expect(owner?.role).toBe("owner");
    expect(owner?.permissions).toEqual([]);
    expect(owner?.permissions).not.toContain("orders:create");
    expect(owner?.permissions).not.toEqual(
      expect.arrayContaining([...EMPLOYEE_DEFAULT_PERMISSIONS]),
    );
  });

  it("never returns another account's memberships or permission overrides", async () => {
    const result = await kit.invoke(
      listMine,
      {},
      { userId: fixtures.grantUser },
    );
    expect(
      result.memberships.map((membership) => membership.membershipId),
    ).toEqual([fixtures.membershipGrant]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(fixtures.membershipDeny);
    expect(serialized).not.toContain(fixtures.membershipOther);
    expect(serialized).not.toContain(fixtures.companyOther);
    expect(serialized).not.toContain("secrets:leak");
    expect(serialized).not.toContain(fixtures.otherUser);
  });

  it("rejects any input identifier — the input is a strict empty object", async () => {
    await expect(
      kit.invoke(listMine, { userId: fixtures.multiUser }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      kit.invoke(listMine, { companyId: kitIdentities.companies.a }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(kit.invoke(listMine, null)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("denies a call without a session (defense in depth behind the 401 gate)", async () => {
    await expect(
      kit.buildTestContext("account", { session: null }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("writes no audit row and no domain event", async () => {
    const requestId = randomUUID();
    await kit.invoke(
      listMine,
      {},
      { userId: kitIdentities.users.anna },
      { request: { requestId } },
    );
    const auditRows = await kit.db.runtime.db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(eq(auditLog.requestId, requestId));
    const eventRows = await kit.db.runtime.db
      .select({ id: domainEvents.id })
      .from(domainEvents)
      .where(eq(domainEvents.requestId, requestId));
    expect(auditRows).toEqual([]);
    expect(eventRows).toEqual([]);
  });
});
