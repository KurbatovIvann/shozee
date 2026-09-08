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
import {
  SEARCH_GOLDEN_NAME_CASES,
  SEARCH_GOLDEN_VANILLA_NEGATIVE_NAME,
  SEARCH_QUERY_MAX,
  type SearchHit,
} from "@showzy/validation/search";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { searchMatches } from "./search-matches.js";

const fixtures = {
  mak: randomUUID(),
  choco: randomUUID(),
  vanilla: randomUUID(),
  inactive: randomUUID(),
  foreignMak: randomUUID(),
  foreignChoco: randomUUID(),
};

const clerkUserId = randomUUID();

const tokenAndCase = SEARCH_GOLDEN_NAME_CASES.find(
  (entry) => entry.id === "token-and-excludes-vanilla",
);
const wordPrefixCase = SEARCH_GOLDEN_NAME_CASES.find(
  (entry) => entry.id === "word-prefix-mak",
);

let kit: TestKit;

async function insertList(values: {
  id: string;
  companyId: string;
  name: string;
  isActive?: boolean;
}): Promise<void> {
  await kit.db.runtime.db.insert(priceLists).values({
    id: values.id,
    companyId: values.companyId,
    name: values.name,
    ...(values.isActive === undefined ? {} : { isActive: values.isActive }),
  });
}

beforeAll(async () => {
  expect(tokenAndCase?.query).toBe("макаронс шоколодний");
  expect(wordPrefixCase?.query).toBe("мак");
  expect(SEARCH_GOLDEN_VANILLA_NEGATIVE_NAME).toBe("Макаронс ванільний");

  kit = await createTestKit();

  await insertList({
    id: fixtures.mak,
    companyId: kitIdentities.companies.a,
    name: "Макаронс",
  });
  await insertList({
    id: fixtures.choco,
    companyId: kitIdentities.companies.a,
    name: "Макаронс шоколадний",
  });
  await insertList({
    id: fixtures.vanilla,
    companyId: kitIdentities.companies.a,
    name: SEARCH_GOLDEN_VANILLA_NEGATIVE_NAME,
  });
  await insertList({
    id: fixtures.inactive,
    companyId: kitIdentities.companies.a,
    name: "Archived Macaron List",
    isActive: false,
  });
  await insertList({
    id: fixtures.foreignMak,
    companyId: kitIdentities.companies.b,
    name: "Макаронс",
  });
  await insertList({
    id: fixtures.foreignChoco,
    companyId: kitIdentities.companies.b,
    name: "Макаронс шоколадний",
  });

  await kit.db.runtime.db.insert(user).values({
    id: clerkUserId,
    name: "Clerk",
    email: "clerk@pricing-search-matches.test",
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

// Staff matcher has no resource id: the inherited suite's foreign case is
// Anna selecting company B (membership deny). The handler's company_id
// filter is proven by "keeps another company's price lists out".
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

describe("pricing.searchMatches", () => {
  it("returns empty groups without error for empty or punctuation-only queries", async () => {
    const empty = { groups: [] };
    expect(await kit.invoke(searchMatches, { query: "" })).toEqual(empty);
    expect(await kit.invoke(searchMatches, { query: "   " })).toEqual(empty);
    expect(await kit.invoke(searchMatches, { query: "..." })).toEqual(empty);
    expect(await kit.invoke(searchMatches, { query: "!!! ???" })).toEqual(
      empty,
    );
    expect(await kit.invoke(searchMatches, { query: "%%%" })).toEqual(empty);
  });

  it("applies T2 name golden: word-prefix мак, typo token-AND, vanilla negative", async () => {
    expect(wordPrefixCase).toBeDefined();
    expect(tokenAndCase).toBeDefined();
    if (wordPrefixCase === undefined || tokenAndCase === undefined) {
      return;
    }

    const prefix = await kit.invoke(searchMatches, {
      query: wordPrefixCase.query,
    });
    expect(hitIds(priceListGroup(prefix))).toEqual(
      expect.arrayContaining([fixtures.mak, fixtures.choco, fixtures.vanilla]),
    );
    expect(hitIds(priceListGroup(prefix))).not.toContain(fixtures.foreignChoco);
    const exactMak = priceListGroup(prefix)?.hits.find(
      (hit) => hit.id === fixtures.mak,
    );
    expect(exactMak).toEqual(
      expect.objectContaining({
        id: fixtures.mak,
        label: "Макаронс",
        matchedOn: "name",
        exact: true,
        status: "active",
      }),
    );
    expect(exactMak).not.toHaveProperty("productId");

    const tokenAnd = await kit.invoke(searchMatches, {
      query: tokenAndCase.query,
    });
    expect(hitIds(priceListGroup(tokenAnd))).toContain(fixtures.choco);
    expect(hitIds(priceListGroup(tokenAnd))).not.toContain(fixtures.vanilla);
    expect(hitIds(priceListGroup(tokenAnd))).not.toContain(
      fixtures.foreignChoco,
    );
    const chocoHit = priceListGroup(tokenAnd)?.hits.find(
      (hit) => hit.id === fixtures.choco,
    );
    expect(chocoHit?.matchedOn).toBe("name");
    expect(chocoHit?.exact).toBe(false);
    expect(chocoHit?.label).toBe("Макаронс шоколадний");
  });

  it("returns inactive lists with status and does not hide them", async () => {
    const listed = await kit.invoke(searchMatches, {
      query: "Archived Macaron List",
    });
    const hit = priceListGroup(listed)?.hits.find(
      (row) => row.id === fixtures.inactive,
    );
    expect(hit?.status).toBe("inactive");
    expect(hit?.exact).toBe(true);
    expect(hit?.matchedOn).toBe("name");
    expect(hit?.label).toBe("Archived Macaron List");
  });

  it("keeps another company's price lists out of this tenant", async () => {
    const choco = await kit.invoke(searchMatches, {
      query: "макаронс шоколодний",
    });
    expect(hitIds(priceListGroup(choco))).toContain(fixtures.choco);
    expect(hitIds(priceListGroup(choco))).not.toContain(fixtures.foreignChoco);

    const other = await kit.invoke(
      searchMatches,
      { query: "макаронс шоколодний" },
      {
        companyId: kitIdentities.companies.b,
        userId: kitIdentities.users.boris,
      },
    );
    expect(hitIds(priceListGroup(other))).toEqual([fixtures.foreignChoco]);
    expect(hitIds(priceListGroup(other))).not.toContain(fixtures.choco);
  });

  it("truncates at limitPerType and keeps an exact name first in the SQL window", async () => {
    const token = "DisplaySix";
    const exactId = randomUUID();
    const weakIds = await insertNamedLists(`${token} Weak`, 6);
    await insertList({
      id: exactId,
      companyId: kitIdentities.companies.a,
      name: token,
    });

    const listed = await kit.invoke(searchMatches, {
      query: token,
      limitPerType: 5,
    });
    expect(priceListGroup(listed)?.truncated).toBe(true);
    expect(hitIds(priceListGroup(listed))).toHaveLength(5);
    expect(hitIds(priceListGroup(listed))[0]).toBe(exactId);
    expect(priceListGroup(listed)?.hits[0]?.exact).toBe(true);
    expect(weakIds).toEqual(
      expect.arrayContaining(hitIds(priceListGroup(listed)).slice(1)),
    );
  });

  it("denies staff without pricing:view", async () => {
    await expect(
      kit.invoke(
        searchMatches,
        { query: "мак" },
        { userId: clerkUserId, companyId: kitIdentities.companies.a },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("rejects oversize query, unknown extras, and companyId in input", async () => {
    await expect(
      kit.invoke(searchMatches, { query: "x".repeat(SEARCH_QUERY_MAX + 1) }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      kit.invoke(searchMatches, {
        query: "мак",
        types: ["priceList"],
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

async function insertNamedLists(
  prefix: string,
  count: number,
): Promise<string[]> {
  const ids = Array.from({ length: count }, () => randomUUID());
  await kit.db.runtime.db.insert(priceLists).values(
    ids.map((id, index) => ({
      id,
      companyId: kitIdentities.companies.a,
      name: `${prefix} ${String(index).padStart(2, "0")}`,
    })),
  );
  return ids;
}

type SearchMatchesResult = {
  groups: ReadonlyArray<{
    type: "priceList";
    hits: readonly SearchHit[];
    truncated: boolean;
  }>;
};

function priceListGroup(result: SearchMatchesResult) {
  return result.groups.find((group) => group.type === "priceList");
}

function hitIds(group: { hits: readonly SearchHit[] } | undefined): string[] {
  return group?.hits.map((hit) => hit.id) ?? [];
}
