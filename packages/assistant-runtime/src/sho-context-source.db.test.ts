import { randomUUID } from "node:crypto";

import { PermissionDeniedError } from "@showzy/core/errors";
import {
  createTestKit,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import { user } from "@showzy/db/schema/auth";
import { products, productVariants } from "@showzy/db/schema/catalog";
import { companyMembers } from "@showzy/db/schema/companies";
import { companyCustomers, customerGroups } from "@showzy/db/schema/customers";
import { priceLists } from "@showzy/db/schema/pricing";
import { shoContextSchema } from "@showzy/sho-protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createShoContextSource,
  readShoNameIndex,
  SHO_CONTEXT_TTL_MS,
  type ShoContextCaller,
} from "./sho-context-source.js";

const revoked = ["products:view", "customers:view", "pricing:view"];

const fixtures = {
  product: randomUUID(),
  variant: randomUUID(),
  laterProduct: randomUUID(),
  sharedProduct: randomUUID(),
  foreignProduct: randomUUID(),
  customer: randomUUID(),
  foreignCustomer: randomUUID(),
  group: randomUUID(),
  priceList: randomUUID(),
};

const names = {
  product: "Шо Кава",
  variant: "Шо Кава / 1 кг",
  laterProduct: "Шо Какао",
  sharedProduct: "Шо Чай",
  foreignProduct: "Шо Чужа Кава",
  customer: "Шо Оля",
  foreignCustomer: "Шо Чужа Оля",
  group: "Шо Гурт",
  priceList: "Шо Роздріб",
};

const contact = {
  phone: "+380501000777",
  email: `sho-context-${fixtures.customer}@kit.test`,
};

const clerkUserId = randomUUID();
const deputyUserId = randomUUID();
const outsiderUserId = randomUUID();

let kit: TestKit;
let clock = 1_000_000;

const callerOf = (companyId: string, userId: string): ShoContextCaller => ({
  companyId,
  userId,
  requestId: randomUUID(),
});

const anna = () =>
  callerOf(kitIdentities.companies.a, kitIdentities.users.anna);
const boris = () =>
  callerOf(kitIdentities.companies.b, kitIdentities.users.boris);
const clerk = () => callerOf(kitIdentities.companies.a, clerkUserId);
const deputy = () => callerOf(kitIdentities.companies.a, deputyUserId);
const outsider = () => callerOf(kitIdentities.companies.a, outsiderUserId);

const sourceOf = () =>
  createShoContextSource({ pipeline: kit.pipeline, now: () => clock });

beforeAll(async () => {
  kit = await createTestKit();

  await kit.db.runtime.db.insert(products).values([
    {
      id: fixtures.product,
      companyId: kitIdentities.companies.a,
      name: names.product,
      basePriceMinor: 1000n,
    },
    {
      id: fixtures.foreignProduct,
      companyId: kitIdentities.companies.b,
      name: names.foreignProduct,
      basePriceMinor: 1100n,
    },
  ]);

  await kit.db.runtime.db.insert(productVariants).values([
    {
      id: fixtures.variant,
      companyId: kitIdentities.companies.a,
      productId: fixtures.product,
      name: names.variant,
    },
  ]);

  await kit.db.runtime.db.insert(companyCustomers).values([
    {
      id: fixtures.customer,
      companyId: kitIdentities.companies.a,
      name: names.customer,
      phone: contact.phone,
      email: contact.email,
    },
    {
      id: fixtures.foreignCustomer,
      companyId: kitIdentities.companies.b,
      name: names.foreignCustomer,
      phone: "+380501000778",
    },
  ]);

  await kit.db.runtime.db.insert(customerGroups).values([
    {
      id: fixtures.group,
      companyId: kitIdentities.companies.a,
      name: names.group,
      slug: `sho-group-${fixtures.group}`,
    },
  ]);

  await kit.db.runtime.db.insert(priceLists).values([
    {
      id: fixtures.priceList,
      companyId: kitIdentities.companies.a,
      name: names.priceList,
      isActive: true,
    },
  ]);

  await kit.db.runtime.db.insert(user).values([
    {
      id: clerkUserId,
      name: "Clerk",
      email: "clerk@sho-context-source.test",
    },
    {
      id: deputyUserId,
      name: "Deputy",
      email: "deputy@sho-context-source.test",
    },
    {
      id: outsiderUserId,
      name: "Outsider",
      email: "outsider@sho-context-source.test",
    },
  ]);
  await kit.db.runtime.db.insert(companyMembers).values([
    {
      companyId: kitIdentities.companies.a,
      userId: clerkUserId,
      role: "employee",
      permissions: {
        granted: ["products:view", "customers:view"],
        denied: ["pricing:view"],
      },
    },
    {
      companyId: kitIdentities.companies.a,
      userId: deputyUserId,
      role: "employee",
      permissions: {
        granted: ["products:view", "customers:view", "pricing:view"],
        denied: [],
      },
    },
  ]);
});

afterAll(async () => {
  await kit.db.close();
});

describe("createShoContextSource", () => {
  it("builds the company's names and no contact field", async () => {
    const built = await sourceOf().current(anna());

    expect(shoContextSchema.parse(built.context)).toEqual(built.context);
    expect(built.context.customers).toContainEqual({
      id: fixtures.customer,
      name: names.customer,
    });
    expect(built.context.products).toContainEqual({
      id: fixtures.product,
      name: names.product,
      variants: [{ id: fixtures.variant, name: names.variant }],
    });
    expect(built.context.groups).toContainEqual({
      id: fixtures.group,
      name: names.group,
    });
    expect(built.context.priceLists).toContainEqual({
      id: fixtures.priceList,
      name: names.priceList,
    });

    const wire = JSON.stringify(built.context);
    expect(wire).not.toContain(contact.phone);
    expect(wire).not.toContain(contact.email);
  });

  it("never carries one company's names into another company's key", async () => {
    const source = sourceOf();
    const first = await source.current(anna());
    const second = await source.current(boris());

    const theirs = JSON.stringify(second.context);
    expect(theirs).not.toContain(names.customer);
    expect(theirs).not.toContain(names.product);
    expect(theirs).toContain(names.foreignCustomer);
    expect(second.fingerprint).not.toBe(first.fingerprint);

    const again = await source.current(anna());
    expect(again.fingerprint).toBe(first.fingerprint);
    expect(JSON.stringify(again.context)).not.toContain(names.foreignCustomer);
  });

  it("holds the fingerprint for the window and rebuilds after it", async () => {
    const source = sourceOf();
    const before = await source.current(anna());

    await kit.db.runtime.db.insert(products).values({
      id: fixtures.laterProduct,
      companyId: kitIdentities.companies.a,
      name: names.laterProduct,
      basePriceMinor: 1200n,
    });

    clock += SHO_CONTEXT_TTL_MS - 1;
    const within = await source.current(anna());
    expect(within.fingerprint).toBe(before.fingerprint);
    expect(JSON.stringify(within.context)).not.toContain(names.laterProduct);

    clock += 1;
    const after = await source.current(anna());
    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect(JSON.stringify(after.context)).toContain(names.laterProduct);
  });

  it("leaves a list the staff member may not see out of the scope", async () => {
    const source = sourceOf();
    const full = await source.current(anna());
    const narrow = await source.current(clerk());

    expect(narrow.context.priceLists).toBeUndefined();
    expect(narrow.context.customers).not.toHaveLength(0);
    expect(narrow.scopeHash).not.toBe(full.scopeHash);
  });

  it("refuses a caller the company has no membership row for", async () => {
    const source = sourceOf();

    await expect(source.current(outsider())).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
    await expect(
      source.current(callerOf(kitIdentities.companies.b, clerkUserId)),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("shares one build between callers of the same company and scope", async () => {
    const source = sourceOf();
    const mine = await source.current(anna());

    await kit.db.runtime.db.insert(products).values({
      id: fixtures.sharedProduct,
      companyId: kitIdentities.companies.a,
      name: names.sharedProduct,
      basePriceMinor: 1300n,
    });
    const theirs = await source.current(deputy());

    expect(theirs.scopeHash).toBe(mine.scopeHash);
    expect(theirs.fingerprint).toBe(mine.fingerprint);
    expect(JSON.stringify(theirs.context)).not.toContain(names.sharedProduct);
  });

  it("reads the same lists for every member of one company", async () => {
    const mine = await readShoNameIndex(kit.pipeline, anna());
    const theirs = await readShoNameIndex(kit.pipeline, deputy());

    expect(theirs).toEqual(mine);
  });

  it("re-reads for a caller whose own verification aged out", async () => {
    const source = sourceOf();
    await source.current(anna());
    const shared = await source.current(deputy());

    await kit.db.runtime.db
      .insert(companyMembers)
      .values({
        companyId: kitIdentities.companies.a,
        userId: deputyUserId,
        role: "employee",
        permissions: { granted: [], denied: revoked },
      })
      .onConflictDoUpdate({
        target: [companyMembers.companyId, companyMembers.userId],
        set: { permissions: { granted: [], denied: revoked } },
      });

    clock += SHO_CONTEXT_TTL_MS;
    const warm = await source.current(anna());
    expect(warm.scopeHash).toBe(shared.scopeHash);

    await expect(source.current(deputy())).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
  });
});
