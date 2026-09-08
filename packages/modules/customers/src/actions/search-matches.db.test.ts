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
import {
  companyCustomers,
  counterparties,
  customerGroups,
} from "@showzy/db/schema/customers";
import {
  ORDER_CUSTOMER_LOOKUP_MAX,
  SEARCH_GOLDEN_NAME_CASES,
  SEARCH_GOLDEN_VANILLA_NEGATIVE_NAME,
  SEARCH_QUERY_MAX,
  type SearchHit,
} from "@showzy/validation/search";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { searchMatches } from "./search-matches.js";

const fixtures = {
  phone: randomUUID(),
  email: randomUUID(),
  archived: randomUUID(),
  mak: randomUUID(),
  choco: randomUUID(),
  vanilla: randomUUID(),
  olena: randomUUID(),
  foreignPhone: randomUUID(),
  foreignChoco: randomUUID(),
  groupMak: randomUUID(),
  groupChoco: randomUUID(),
  groupVanilla: randomUUID(),
  groupForeign: randomUUID(),
  partyChoco: randomUUID(),
  partyVanilla: randomUUID(),
  partyEdrpou: randomUUID(),
  partyPhone: randomUUID(),
  partyForeignEdrpou: randomUUID(),
};

const clerkUserId = randomUUID();
const phoneStored = "+380671234567";
const phoneNational = "0671234567";
const emailStored = "Owner@Example.COM";
const edrpouStored = "12345678";

const tokenAndCase = SEARCH_GOLDEN_NAME_CASES.find(
  (entry) => entry.id === "token-and-excludes-vanilla",
);
const wordPrefixCase = SEARCH_GOLDEN_NAME_CASES.find(
  (entry) => entry.id === "word-prefix-mak",
);

let kit: TestKit;

beforeAll(async () => {
  expect(tokenAndCase?.query).toBe("макаронс шоколодний");
  expect(wordPrefixCase?.query).toBe("мак");
  expect(SEARCH_GOLDEN_VANILLA_NEGATIVE_NAME).toBe("Макаронс ванільний");

  kit = await createTestKit();

  await kit.db.runtime.db.insert(companyCustomers).values([
    {
      id: fixtures.phone,
      companyId: kitIdentities.companies.a,
      name: "Phone Person",
      phone: phoneStored,
      email: `phone-${fixtures.phone}@kit.test`,
    },
    {
      id: fixtures.email,
      companyId: kitIdentities.companies.a,
      name: "Email Person",
      email: emailStored,
    },
    {
      id: fixtures.archived,
      companyId: kitIdentities.companies.a,
      name: "Archived Macaron",
      phone: "+380501000099",
      status: "archived",
    },
    {
      id: fixtures.mak,
      companyId: kitIdentities.companies.a,
      name: "Макаронс",
      email: `mak-${fixtures.mak}@kit.test`,
    },
    {
      id: fixtures.choco,
      companyId: kitIdentities.companies.a,
      name: "Макаронс шоколадний",
      email: `choco-${fixtures.choco}@kit.test`,
    },
    {
      id: fixtures.vanilla,
      companyId: kitIdentities.companies.a,
      name: SEARCH_GOLDEN_VANILLA_NEGATIVE_NAME,
      email: `vanilla-${fixtures.vanilla}@kit.test`,
    },
    {
      id: fixtures.olena,
      companyId: kitIdentities.companies.a,
      name: "Олена",
      email: `olena-${fixtures.olena}@kit.test`,
    },
    {
      id: fixtures.foreignPhone,
      companyId: kitIdentities.companies.b,
      name: "Foreign Phone",
      phone: phoneStored,
      email: `foreign-phone-${fixtures.foreignPhone}@kit.test`,
    },
    {
      id: fixtures.foreignChoco,
      companyId: kitIdentities.companies.b,
      name: "Макаронс шоколадний",
      email: `foreign-choco-${fixtures.foreignChoco}@kit.test`,
    },
  ]);

  await kit.db.runtime.db.insert(customerGroups).values([
    {
      id: fixtures.groupMak,
      companyId: kitIdentities.companies.a,
      name: "Макаронс",
      slug: "search-mak",
    },
    {
      id: fixtures.groupChoco,
      companyId: kitIdentities.companies.a,
      name: "Макаронс шоколадний",
      slug: "search-choco",
    },
    {
      id: fixtures.groupVanilla,
      companyId: kitIdentities.companies.a,
      name: SEARCH_GOLDEN_VANILLA_NEGATIVE_NAME,
      slug: "search-vanilla",
    },
    {
      id: fixtures.groupForeign,
      companyId: kitIdentities.companies.b,
      name: "Макаронс шоколадний",
      slug: "search-choco",
    },
  ]);

  await kit.db.runtime.db.insert(counterparties).values([
    {
      id: fixtures.partyChoco,
      companyId: kitIdentities.companies.a,
      name: "Макаронс шоколадний",
    },
    {
      id: fixtures.partyVanilla,
      companyId: kitIdentities.companies.a,
      name: SEARCH_GOLDEN_VANILLA_NEGATIVE_NAME,
    },
    {
      id: fixtures.partyEdrpou,
      companyId: kitIdentities.companies.a,
      name: "Legal Face",
      edrpou: edrpouStored,
      email: "legal@kit.test",
    },
    {
      id: fixtures.partyPhone,
      companyId: kitIdentities.companies.a,
      name: "Party Phone",
      phone: phoneStored,
    },
    {
      id: fixtures.partyForeignEdrpou,
      companyId: kitIdentities.companies.b,
      name: "Foreign Legal",
      edrpou: edrpouStored,
    },
  ]);

  await kit.db.runtime.db.insert(user).values({
    id: clerkUserId,
    name: "Clerk",
    email: "clerk@customers-search-matches.test",
  });
  await kit.db.runtime.db.insert(companyMembers).values({
    companyId: kitIdentities.companies.a,
    userId: clerkUserId,
    role: "employee",
    permissions: { granted: [], denied: ["customers:view"] },
  });
});

afterAll(async () => {
  await kit.db.close();
});

crossTenantSuite(
  () => kit,
  [
    isolationCase(
      searchMatches,
      { input: { query: "мак" } },
      {
        input: { query: "мак" },
        companyId: kitIdentities.companies.b,
        userId: kitIdentities.users.anna,
      },
    ),
  ],
);

describe("customers.searchMatches", () => {
  it("returns empty groups and lookup without error for empty or punctuation-only queries", async () => {
    const empty = {
      groups: [],
      orderCustomerLookup: { ids: [], truncated: false },
    };
    expect(await kit.invoke(searchMatches, { query: "" })).toEqual(empty);
    expect(await kit.invoke(searchMatches, { query: "   " })).toEqual(empty);
    expect(await kit.invoke(searchMatches, { query: "..." })).toEqual(empty);
    expect(await kit.invoke(searchMatches, { query: "!!! ???" })).toEqual(
      empty,
    );
    expect(await kit.invoke(searchMatches, { query: "%%%" })).toEqual(empty);
  });

  it("matches UA 0… and +380… phones as the same 380… prefix, not FTS", async () => {
    const national = await kit.invoke(searchMatches, { query: phoneNational });
    const intl = await kit.invoke(searchMatches, { query: phoneStored });
    const prefix = await kit.invoke(searchMatches, { query: "06712" });

    const nationalCustomer = customerGroup(national);
    const intlCustomer = customerGroup(intl);
    expect(hitIds(nationalCustomer)).toContain(fixtures.phone);
    expect(hitIds(intlCustomer)).toContain(fixtures.phone);
    expect(hitIds(nationalCustomer)).not.toContain(fixtures.foreignPhone);
    const phoneHit = nationalCustomer?.hits.find(
      (hit) => hit.id === fixtures.phone,
    );
    expect(phoneHit?.matchedOn).toBe("phone");
    expect(phoneHit?.exact).toBe(true);

    const prefixHit = customerGroup(prefix)?.hits.find(
      (hit) => hit.id === fixtures.phone,
    );
    expect(prefixHit?.matchedOn).toBe("phone");
    expect(prefixHit?.exact).toBe(false);

    expect(hitIds(groupOf(national, "counterparty"))).toContain(
      fixtures.partyPhone,
    );
  });

  it("matches email and ЄДРПОУ by canonical equality", async () => {
    const byEmail = await kit.invoke(searchMatches, {
      query: "owner@example.com",
    });
    const emailHit = customerGroup(byEmail)?.hits.find(
      (hit) => hit.id === fixtures.email,
    );
    expect(emailHit?.matchedOn).toBe("email");
    expect(emailHit?.exact).toBe(true);
    expect(emailHit?.label).toBe("Email Person");

    const byEdrpou = await kit.invoke(searchMatches, { query: "1234 5678" });
    const party = groupOf(byEdrpou, "counterparty")?.hits.find(
      (hit) => hit.id === fixtures.partyEdrpou,
    );
    expect(party?.matchedOn).toBe("edrpou");
    expect(party?.exact).toBe(true);
    expect(hitIds(groupOf(byEdrpou, "counterparty"))).not.toContain(
      fixtures.partyForeignEdrpou,
    );
  });

  it("applies T2 name golden: word-prefix мак and token-AND vanilla negative", async () => {
    expect(wordPrefixCase).toBeDefined();
    expect(tokenAndCase).toBeDefined();
    if (wordPrefixCase === undefined || tokenAndCase === undefined) {
      return;
    }

    const prefix = await kit.invoke(searchMatches, {
      query: wordPrefixCase.query,
    });
    expect(hitIds(customerGroup(prefix))).toEqual(
      expect.arrayContaining([fixtures.mak, fixtures.choco, fixtures.vanilla]),
    );
    expect(hitIds(groupOf(prefix, "customerGroup"))).toEqual(
      expect.arrayContaining([
        fixtures.groupMak,
        fixtures.groupChoco,
        fixtures.groupVanilla,
      ]),
    );

    const tokenAnd = await kit.invoke(searchMatches, {
      query: tokenAndCase.query,
    });
    expect(hitIds(customerGroup(tokenAnd))).toContain(fixtures.choco);
    expect(hitIds(customerGroup(tokenAnd))).not.toContain(fixtures.vanilla);
    expect(hitIds(groupOf(tokenAnd, "customerGroup"))).toContain(
      fixtures.groupChoco,
    );
    expect(hitIds(groupOf(tokenAnd, "customerGroup"))).not.toContain(
      fixtures.groupVanilla,
    );
    expect(hitIds(groupOf(tokenAnd, "counterparty"))).toContain(
      fixtures.partyChoco,
    );
    expect(hitIds(groupOf(tokenAnd, "counterparty"))).not.toContain(
      fixtures.partyVanilla,
    );
    const chocoHit = customerGroup(tokenAnd)?.hits.find(
      (hit) => hit.id === fixtures.choco,
    );
    expect(chocoHit?.matchedOn).toBe("name");
    expect(chocoHit?.exact).toBe(false);
  });

  it("returns archived customers with status and does not hide them", async () => {
    const listed = await kit.invoke(searchMatches, {
      query: "Archived Macaron",
    });
    const hit = customerGroup(listed)?.hits.find(
      (row) => row.id === fixtures.archived,
    );
    expect(hit?.status).toBe("archived");
    expect(hit?.exact).toBe(true);
    expect(hit?.matchedOn).toBe("name");
  });

  it("keeps another company's names, phones, and ЄДРПОУ out of this tenant", async () => {
    const choco = await kit.invoke(searchMatches, {
      query: "макаронс шоколодний",
    });
    expect(hitIds(customerGroup(choco))).toContain(fixtures.choco);
    expect(hitIds(customerGroup(choco))).not.toContain(fixtures.foreignChoco);
    expect(hitIds(groupOf(choco, "customerGroup"))).not.toContain(
      fixtures.groupForeign,
    );

    const phone = await kit.invoke(searchMatches, { query: phoneNational });
    expect(hitIds(customerGroup(phone))).not.toContain(fixtures.foreignPhone);

    const other = await kit.invoke(
      searchMatches,
      { query: phoneNational },
      {
        companyId: kitIdentities.companies.b,
        userId: kitIdentities.users.boris,
      },
    );
    expect(hitIds(customerGroup(other))).toEqual([fixtures.foreignPhone]);
    expect(hitIds(customerGroup(other))).not.toContain(fixtures.phone);
  });

  it("keeps lookup complete when display limitPerType truncates", async () => {
    const ids = await insertNamedCustomers("DisplaySix", 6);
    const listed = await kit.invoke(searchMatches, {
      query: "DisplaySix",
      limitPerType: 5,
    });
    expect(customerGroup(listed)?.truncated).toBe(true);
    expect(hitIds(customerGroup(listed))).toHaveLength(5);
    expect(listed.orderCustomerLookup.ids).toHaveLength(6);
    expect(listed.orderCustomerLookup.truncated).toBe(false);
    expect(new Set(listed.orderCustomerLookup.ids)).toEqual(new Set(ids));
  });

  it("does not mark lookup truncated at exactly 20 matching customers", async () => {
    const ids = await insertNamedCustomers("ExactlyTwenty", 20);
    const listed = await kit.invoke(searchMatches, {
      query: "ExactlyTwenty",
      limitPerType: 5,
    });
    expect(customerGroup(listed)?.truncated).toBe(true);
    expect(hitIds(customerGroup(listed))).toHaveLength(5);
    expect(listed.orderCustomerLookup.ids).toHaveLength(
      ORDER_CUSTOMER_LOOKUP_MAX,
    );
    expect(listed.orderCustomerLookup.truncated).toBe(false);
    expect(new Set(listed.orderCustomerLookup.ids)).toEqual(new Set(ids));
  });

  it("caps lookup at 20 and sets truncated when 21 customers match", async () => {
    const ids = await insertNamedCustomers("OverTwenty", 21);
    const listed = await kit.invoke(searchMatches, {
      query: "OverTwenty",
      limitPerType: 5,
    });
    expect(customerGroup(listed)?.truncated).toBe(true);
    expect(hitIds(customerGroup(listed))).toHaveLength(5);
    expect(listed.orderCustomerLookup.ids).toHaveLength(
      ORDER_CUSTOMER_LOOKUP_MAX,
    );
    expect(listed.orderCustomerLookup.truncated).toBe(true);
    expect(ids).toEqual(expect.arrayContaining(listed.orderCustomerLookup.ids));
    expect(new Set(listed.orderCustomerLookup.ids).size).toBe(
      ORDER_CUSTOMER_LOOKUP_MAX,
    );
  });

  it("includes an exact customer in lookup when more than 21 weak name matches fill the SQL window", async () => {
    const token = "38098221";
    const exactId = randomUUID();
    const weakCount = ORDER_CUSTOMER_LOOKUP_MAX + 2;
    const weakIds = Array.from({ length: weakCount }, () => randomUUID());
    await kit.db.runtime.db.insert(companyCustomers).values([
      {
        id: exactId,
        companyId: kitIdentities.companies.a,
        name: token,
        email: `sql-window-exact-${exactId}@kit.test`,
      },
      ...weakIds.map((id, index) => ({
        id,
        companyId: kitIdentities.companies.a,
        name: `${token} Weak ${String(index).padStart(2, "0")}`,
        phone: `+${token}${String(index).padStart(4, "0")}`,
        email: `sql-window-weak-${String(index)}-${id}@kit.test`,
      })),
    ]);

    const listed = await kit.invoke(searchMatches, {
      query: token,
      limitPerType: 5,
    });

    expect(listed.orderCustomerLookup.truncated).toBe(true);
    expect(listed.orderCustomerLookup.ids).toHaveLength(
      ORDER_CUSTOMER_LOOKUP_MAX,
    );
    expect(listed.orderCustomerLookup.ids).toContain(exactId);
    expect(listed.orderCustomerLookup.ids[0]).toBe(exactId);
  });

  it("still fills orderCustomerLookup when display types omit customer", async () => {
    const listed = await kit.invoke(searchMatches, {
      query: "мак",
      types: ["customerGroup"],
    });
    expect(listed.groups.map((group) => group.type)).toEqual(["customerGroup"]);
    expect(listed.orderCustomerLookup.ids).toEqual(
      expect.arrayContaining([fixtures.mak, fixtures.choco, fixtures.vanilla]),
    );
    expect(listed.orderCustomerLookup.truncated).toBe(false);
  });

  it("denies staff without customers:view", async () => {
    await expect(
      kit.invoke(
        searchMatches,
        { query: "мак" },
        { userId: clerkUserId, companyId: kitIdentities.companies.a },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("rejects oversize query, unknown type, and companyId in input", async () => {
    await expect(
      kit.invoke(searchMatches, { query: "x".repeat(SEARCH_QUERY_MAX + 1) }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      kit.invoke(searchMatches, {
        query: "мак",
        types: ["order"],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      kit.invoke(searchMatches, {
        query: "мак",
        companyId: kitIdentities.companies.b,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

async function insertNamedCustomers(
  prefix: string,
  count: number,
): Promise<string[]> {
  const ids = Array.from({ length: count }, () => randomUUID());
  await kit.db.runtime.db.insert(companyCustomers).values(
    ids.map((id, index) => ({
      id,
      companyId: kitIdentities.companies.a,
      name: `${prefix} ${String(index).padStart(2, "0")}`,
      email: `${prefix.toLowerCase()}-${String(index)}-${id}@kit.test`,
    })),
  );
  return ids;
}

type SearchMatchesResult = {
  groups: ReadonlyArray<{
    type: "customer" | "customerGroup" | "counterparty";
    hits: readonly SearchHit[];
    truncated: boolean;
  }>;
  orderCustomerLookup: { ids: string[]; truncated: boolean };
};

function groupOf(
  result: SearchMatchesResult,
  type: "customer" | "customerGroup" | "counterparty",
) {
  return result.groups.find((group) => group.type === type);
}

function customerGroup(result: SearchMatchesResult) {
  return groupOf(result, "customer");
}

function hitIds(group: { hits: readonly SearchHit[] } | undefined): string[] {
  return group?.hits.map((hit) => hit.id) ?? [];
}
