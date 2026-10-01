import { randomUUID } from "node:crypto";

import { PermissionDeniedError, ValidationError } from "@showzy/core/errors";
import {
  createTestKit,
  crossTenantSuite,
  isolationCase,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import { user } from "@showzy/db/schema/auth";
import { companyMembers } from "@showzy/db/schema/companies";
import { priceLists } from "@showzy/db/schema/pricing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readPricingNameIndex } from "../services/name-index.js";
import { listNameIndex } from "./list-name-index.js";

const fixtures = {
  active: randomUUID(),
  secondActive: randomUUID(),
  inactive: randomUUID(),
  foreign: randomUUID(),
};

const clerkUserId = randomUUID();

let kit: TestKit;

beforeAll(async () => {
  kit = await createTestKit();

  await kit.db.runtime.db.insert(priceLists).values([
    {
      id: fixtures.active,
      companyId: kitIdentities.companies.a,
      name: "Index Роздріб",
      isActive: true,
    },
    {
      id: fixtures.secondActive,
      companyId: kitIdentities.companies.a,
      name: "Index Опт",
      isActive: true,
    },
    {
      id: fixtures.inactive,
      companyId: kitIdentities.companies.a,
      name: "Index Архівний",
      isActive: false,
    },
    {
      id: fixtures.foreign,
      companyId: kitIdentities.companies.b,
      name: "Index Чужий",
      isActive: true,
    },
  ]);

  await kit.db.runtime.db.insert(user).values({
    id: clerkUserId,
    name: "Clerk",
    email: "clerk@pricing-list-name-index.test",
  });
  await kit.db.runtime.db.insert(companyMembers).values({
    companyId: kitIdentities.companies.a,
    userId: clerkUserId,
    role: "employee",
    permissions: { granted: [], denied: ["pricing:view"] },
  });
});

afterAll(async () => {
  await kit.db.close();
});

crossTenantSuite(
  () => kit,
  [
    isolationCase(
      listNameIndex,
      { input: {} },
      {
        input: {},
        companyId: kitIdentities.companies.b,
        userId: kitIdentities.users.anna,
      },
    ),
  ],
);

describe("pricing.listNameIndex", () => {
  it("returns active price lists as ids and names", async () => {
    const listed = await kit.invoke(listNameIndex, {});
    const entry = listed.priceLists.items.find(
      (row) => row.id === fixtures.active,
    );
    expect(entry?.name).toBe("Index Роздріб");
    expect(listed.priceLists.truncated).toBe(false);
    for (const row of listed.priceLists.items) {
      expect(Object.keys(row).sort()).toEqual(["id", "name"]);
    }
  });

  it("cuts the list at its cap and sets truncated", async () => {
    const capped = await readPricingNameIndex({
      db: kit.db.runtime.db,
      companyId: kitIdentities.companies.a,
      cap: 1,
    });

    expect(capped.priceLists.items).toHaveLength(1);
    expect(capped.priceLists.truncated).toBe(true);
  });

  it("excludes a deactivated price list", async () => {
    const listed = await kit.invoke(listNameIndex, {});
    expect(listed.priceLists.items.map((row) => row.id)).not.toContain(
      fixtures.inactive,
    );
  });

  it("does not leak another tenant's price lists", async () => {
    const listed = await kit.invoke(listNameIndex, {});
    expect(listed.priceLists.items.map((row) => row.id)).not.toContain(
      fixtures.foreign,
    );

    const otherTenant = await kit.invoke(
      listNameIndex,
      {},
      {
        companyId: kitIdentities.companies.b,
        userId: kitIdentities.users.boris,
      },
    );
    expect(otherTenant.priceLists.items.map((row) => row.id)).toContain(
      fixtures.foreign,
    );
    expect(otherTenant.priceLists.items.map((row) => row.id)).not.toContain(
      fixtures.active,
    );
  });

  it("denies staff without pricing:view", async () => {
    await expect(
      kit.invoke(
        listNameIndex,
        {},
        { userId: clerkUserId, companyId: kitIdentities.companies.a },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("rejects an input that names a company", async () => {
    await expect(
      kit.invoke(listNameIndex, { companyId: kitIdentities.companies.b }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
