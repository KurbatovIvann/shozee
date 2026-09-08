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
import { companyCustomers } from "@showzy/db/schema/customers";
import { orders } from "@showzy/db/schema/orders";
import {
  canonicalizeOrderNumberToken,
  ORDER_CUSTOMER_LOOKUP_MAX,
  SEARCH_GOLDEN_ORDER_NUMBER_CASES,
  SEARCH_GOLDEN_VANILLA_NEGATIVE_NAME,
  SEARCH_QUERY_MAX,
  type SearchHit,
} from "@showzy/validation/search";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { orderNumberLeftPrefixPattern } from "../services/search-matches.js";
import { UNLINKED_CUSTOMER_NAME_SNAPSHOT } from "./list.contract.js";
import { searchMatches } from "./search-matches.js";

const COMPANY_A_PREFIX = "KA";
const COMPANY_B_PREFIX = "MB";
const FULL_TOKEN = "32KUY41";
const PREFIX_TOKEN = "32KU";

const fixtures = {
  fullNumber: randomUUID(),
  prefixSibling: randomUUID(),
  snapshotChoco: randomUUID(),
  snapshotVanilla: randomUUID(),
  unlinked: randomUUID(),
  relatedCustomer: randomUUID(),
  otherCustomer: randomUUID(),
  foreignFull: randomUUID(),
  customerRelated: randomUUID(),
  customerOther: randomUUID(),
  customerForeign: randomUUID(),
};

const clerks = {
  noView: randomUUID(),
  noDocuments: randomUUID(),
};

let kit: TestKit;

async function insertOrder(values: {
  id: string;
  companyId: string;
  orderNumber: string;
  customerId: string | null;
  customerNameSnapshot: string;
  status?: "new" | "confirmed" | "in_progress" | "done" | "canceled";
}): Promise<void> {
  await kit.db.runtime.db.insert(orders).values({
    id: values.id,
    companyId: values.companyId,
    orderNumber: values.orderNumber,
    customerId: values.customerId,
    customerNameSnapshot: values.customerNameSnapshot,
    status: values.status ?? "new",
    totalNetMinor: 100n,
    totalTaxMinor: 0n,
    totalGrossMinor: 100n,
    currency: "UAH",
  });
}

beforeAll(async () => {
  const prefixAlone = SEARCH_GOLDEN_ORDER_NUMBER_CASES.find(
    (entry) => entry.id === "company-prefix-alone",
  );
  const fullCanonical = SEARCH_GOLDEN_ORDER_NUMBER_CASES.find(
    (entry) => entry.id === "full-canonical",
  );
  expect(prefixAlone?.expected).toBeUndefined();
  expect(fullCanonical?.query).toBe("SP-32KUY41");
  expect(canonicalizeOrderNumberToken(FULL_TOKEN, COMPANY_A_PREFIX)).toBe(
    `${COMPANY_A_PREFIX}-${FULL_TOKEN}`,
  );
  expect(canonicalizeOrderNumberToken(PREFIX_TOKEN, COMPANY_A_PREFIX)).toBe(
    `${COMPANY_A_PREFIX}-${PREFIX_TOKEN}`,
  );
  expect(
    canonicalizeOrderNumberToken(COMPANY_A_PREFIX, COMPANY_A_PREFIX),
  ).toBeUndefined();

  kit = await createTestKit();

  await kit.db.runtime.db.insert(companyCustomers).values([
    {
      id: fixtures.customerRelated,
      companyId: kitIdentities.companies.a,
      name: "Related Person",
      email: "related-orders-search@kit.test",
    },
    {
      id: fixtures.customerOther,
      companyId: kitIdentities.companies.a,
      name: "Other Person",
      email: "other-orders-search@kit.test",
    },
    {
      id: fixtures.customerForeign,
      companyId: kitIdentities.companies.b,
      name: "Related Person",
      email: "foreign-orders-search@kit.test",
    },
  ]);

  await insertOrder({
    id: fixtures.fullNumber,
    companyId: kitIdentities.companies.a,
    orderNumber: `${COMPANY_A_PREFIX}-${FULL_TOKEN}`,
    customerId: fixtures.customerRelated,
    customerNameSnapshot: "Related Person",
  });
  await insertOrder({
    id: fixtures.prefixSibling,
    companyId: kitIdentities.companies.a,
    orderNumber: `${COMPANY_A_PREFIX}-${PREFIX_TOKEN}ZZZ`,
    customerId: fixtures.customerOther,
    customerNameSnapshot: "Other Person",
  });
  await insertOrder({
    id: fixtures.snapshotChoco,
    companyId: kitIdentities.companies.a,
    orderNumber: `${COMPANY_A_PREFIX}-CHOCO1`,
    customerId: fixtures.customerOther,
    customerNameSnapshot: "Макаронс шоколадний",
  });
  await insertOrder({
    id: fixtures.snapshotVanilla,
    companyId: kitIdentities.companies.a,
    orderNumber: `${COMPANY_A_PREFIX}-VANIL1`,
    customerId: fixtures.customerOther,
    customerNameSnapshot: SEARCH_GOLDEN_VANILLA_NEGATIVE_NAME,
  });
  await insertOrder({
    id: fixtures.unlinked,
    companyId: kitIdentities.companies.a,
    orderNumber: `${COMPANY_A_PREFIX}-UNLNK1`,
    customerId: null,
    customerNameSnapshot: UNLINKED_CUSTOMER_NAME_SNAPSHOT,
  });
  await insertOrder({
    id: fixtures.relatedCustomer,
    companyId: kitIdentities.companies.a,
    orderNumber: `${COMPANY_A_PREFIX}-RELAT1`,
    customerId: fixtures.customerRelated,
    customerNameSnapshot: "Snapshot Without Query Token",
  });
  await insertOrder({
    id: fixtures.otherCustomer,
    companyId: kitIdentities.companies.a,
    orderNumber: `${COMPANY_A_PREFIX}-OTHER1`,
    customerId: fixtures.customerOther,
    customerNameSnapshot: "Other Snapshot",
  });
  await insertOrder({
    id: fixtures.foreignFull,
    companyId: kitIdentities.companies.b,
    orderNumber: `${COMPANY_B_PREFIX}-${FULL_TOKEN}`,
    customerId: fixtures.customerForeign,
    customerNameSnapshot: "Related Person",
  });

  const explainSeed = Array.from({ length: 40 }, (_, index) => ({
    id: randomUUID(),
    companyId: kitIdentities.companies.a,
    orderNumber: `${COMPANY_A_PREFIX}-32EX${String(index).padStart(2, "0")}`,
    customerId: null,
    customerNameSnapshot: UNLINKED_CUSTOMER_NAME_SNAPSHOT,
    status: "new" as const,
    totalNetMinor: 100n,
    totalTaxMinor: 0n,
    totalGrossMinor: 100n,
    currency: "UAH" as const,
  }));
  await kit.db.runtime.db.insert(orders).values(explainSeed);

  await kit.db.runtime.db.insert(user).values([
    {
      id: clerks.noView,
      name: "No view",
      email: "no-view-orders-search@kit.test",
    },
    {
      id: clerks.noDocuments,
      name: "No documents",
      email: "no-docs-orders-search@kit.test",
    },
  ]);
  await kit.db.runtime.db.insert(companyMembers).values([
    {
      companyId: kitIdentities.companies.a,
      userId: clerks.noView,
      role: "employee",
      permissions: { granted: [], denied: ["orders:view"] },
    },
    {
      companyId: kitIdentities.companies.a,
      userId: clerks.noDocuments,
      role: "employee",
      permissions: { granted: [], denied: ["documents:view"] },
    },
  ]);

  await kit.db.admin.query("ANALYZE orders");
});

afterAll(async () => {
  await kit.db.close();
});

crossTenantSuite(
  () => kit,
  [
    isolationCase(
      searchMatches,
      { input: { query: FULL_TOKEN } },
      {
        input: { query: FULL_TOKEN },
        companyId: kitIdentities.companies.b,
        userId: kitIdentities.users.anna,
      },
    ),
  ],
);

describe("orders.searchMatches", () => {
  it("returns empty groups without error for empty or punctuation-only queries", async () => {
    const empty = { groups: [] };
    expect(await kit.invoke(searchMatches, { query: "" })).toEqual(empty);
    expect(await kit.invoke(searchMatches, { query: "   " })).toEqual(empty);
    expect(await kit.invoke(searchMatches, { query: "..." })).toEqual(empty);
    expect(await kit.invoke(searchMatches, { query: "!!! ???" })).toEqual(
      empty,
    );
    expect(await kit.invoke(searchMatches, { query: "%%%" })).toEqual(empty);
    expect(await kit.invoke(searchMatches, { query: "#" })).toEqual(empty);
  });

  it("matches a full canonical number, hash, case, and token-without-prefix as exact", async () => {
    const canonical = `${COMPANY_A_PREFIX}-${FULL_TOKEN}`;
    const queries = [canonical, `#${canonical.toLowerCase()}`, FULL_TOKEN];
    for (const query of queries) {
      const listed = await kit.invoke(searchMatches, { query });
      const hit = orderGroup(listed)?.hits.find(
        (row) => row.id === fixtures.fullNumber,
      );
      expect(hit).toEqual(
        expect.objectContaining({
          id: fixtures.fullNumber,
          label: canonical,
          matchedOn: "number",
          exact: true,
          status: "new",
        }),
      );
      expect(hitIds(orderGroup(listed))).not.toContain(fixtures.foreignFull);
      expect(hitIds(orderGroup(listed))).not.toContain(fixtures.prefixSibling);
    }
  });

  it("matches number prefix 32KU as left-prefix, never exact, and may be several", async () => {
    const listed = await kit.invoke(searchMatches, { query: PREFIX_TOKEN });
    const ids = hitIds(orderGroup(listed));
    expect(ids).toEqual(
      expect.arrayContaining([fixtures.fullNumber, fixtures.prefixSibling]),
    );
    expect(ids).not.toContain(fixtures.foreignFull);
    for (const hit of orderGroup(listed)?.hits ?? []) {
      if (hit.id === fixtures.fullNumber || hit.id === fixtures.prefixSibling) {
        expect(hit.matchedOn).toBe("number");
        expect(hit.exact).toBe(false);
      }
    }
  });

  it("does not match orders by number when the query is the company prefix alone", async () => {
    const listed = await kit.invoke(searchMatches, { query: COMPANY_A_PREFIX });
    const hashed = await kit.invoke(searchMatches, {
      query: `#${COMPANY_A_PREFIX.toLowerCase()}`,
    });
    for (const result of [listed, hashed]) {
      const numberHits = (orderGroup(result)?.hits ?? []).filter(
        (hit) => hit.matchedOn === "number",
      );
      expect(numberHits).toEqual([]);
      expect(hitIds(orderGroup(result))).not.toContain(fixtures.fullNumber);
      expect(hitIds(orderGroup(result))).not.toContain(fixtures.prefixSibling);
    }
  });

  it("marks customerIds-only hits as matchedOn customer and never exact", async () => {
    const listed = await kit.invoke(searchMatches, {
      query: "Qqxlookup",
      customerIds: [fixtures.customerRelated],
    });
    const ids = hitIds(orderGroup(listed));
    expect(ids).toEqual(
      expect.arrayContaining([fixtures.fullNumber, fixtures.relatedCustomer]),
    );
    expect(ids).not.toContain(fixtures.otherCustomer);
    expect(ids).not.toContain(fixtures.foreignFull);
    for (const hit of orderGroup(listed)?.hits ?? []) {
      expect(hit.matchedOn).toBe("customer");
      expect(hit.exact).toBe(false);
    }
  });

  it("keeps number over customerIds when both match the same order", async () => {
    const listed = await kit.invoke(searchMatches, {
      query: FULL_TOKEN,
      customerIds: [fixtures.customerRelated],
    });
    const hit = orderGroup(listed)?.hits.find(
      (row) => row.id === fixtures.fullNumber,
    );
    expect(hit?.matchedOn).toBe("number");
    expect(hit?.exact).toBe(true);
  });

  it("matches customer_name_snapshot with token-AND ILIKE and not the vanilla negative", async () => {
    const partial = await kit.invoke(searchMatches, { query: "макаронс" });
    expect(hitIds(orderGroup(partial))).toEqual(
      expect.arrayContaining([
        fixtures.snapshotChoco,
        fixtures.snapshotVanilla,
      ]),
    );
    const partialChoco = orderGroup(partial)?.hits.find(
      (hit) => hit.id === fixtures.snapshotChoco,
    );
    expect(partialChoco?.matchedOn).toBe("customerNameSnapshot");
    expect(partialChoco?.exact).toBe(false);

    const exact = await kit.invoke(searchMatches, {
      query: "Макаронс шоколадний",
    });
    const exactHit = orderGroup(exact)?.hits.find(
      (hit) => hit.id === fixtures.snapshotChoco,
    );
    expect(exactHit?.matchedOn).toBe("customerNameSnapshot");
    expect(exactHit?.exact).toBe(true);
    expect(hitIds(orderGroup(exact))).not.toContain(fixtures.snapshotVanilla);

    const tokenAnd = await kit.invoke(searchMatches, {
      query: "макаронс шоколадний",
    });
    expect(hitIds(orderGroup(tokenAnd))).toContain(fixtures.snapshotChoco);
    expect(hitIds(orderGroup(tokenAnd))).not.toContain(
      fixtures.snapshotVanilla,
    );
  });

  it("does not match the unlinked snapshot sentinel", async () => {
    const listed = await kit.invoke(searchMatches, { query: "unlinked" });
    expect(hitIds(orderGroup(listed))).not.toContain(fixtures.unlinked);
    const numberHits = (orderGroup(listed)?.hits ?? []).filter(
      (hit) => hit.matchedOn === "customerNameSnapshot",
    );
    expect(numberHits.every((hit) => hit.id !== fixtures.unlinked)).toBe(true);
  });

  it("keeps another company's orders out of this tenant", async () => {
    const listed = await kit.invoke(searchMatches, { query: FULL_TOKEN });
    expect(hitIds(orderGroup(listed))).toContain(fixtures.fullNumber);
    expect(hitIds(orderGroup(listed))).not.toContain(fixtures.foreignFull);

    const other = await kit.invoke(
      searchMatches,
      { query: FULL_TOKEN },
      {
        companyId: kitIdentities.companies.b,
        userId: kitIdentities.users.boris,
      },
    );
    expect(hitIds(orderGroup(other))).toEqual([fixtures.foreignFull]);
    expect(hitIds(orderGroup(other))).not.toContain(fixtures.fullNumber);
  });

  it("denies staff without orders:view", async () => {
    await expect(
      kit.invoke(
        searchMatches,
        { query: FULL_TOKEN },
        { userId: clerks.noView, companyId: kitIdentities.companies.a },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("still matches by number for staff with orders:view and without documents:view", async () => {
    const listed = await kit.invoke(
      searchMatches,
      { query: FULL_TOKEN },
      { userId: clerks.noDocuments, companyId: kitIdentities.companies.a },
    );
    const hit = orderGroup(listed)?.hits.find(
      (row) => row.id === fixtures.fullNumber,
    );
    expect(hit?.matchedOn).toBe("number");
    expect(hit?.exact).toBe(true);
  });

  it("truncates at limitPerType after the SQL window (exact first)", async () => {
    const listed = await kit.invoke(searchMatches, {
      query: PREFIX_TOKEN,
      limitPerType: 1,
    });
    expect(orderGroup(listed)?.truncated).toBe(true);
    expect(hitIds(orderGroup(listed))).toHaveLength(1);
  });

  it("rejects oversize query, oversize customerIds, extras, and companyId in input", async () => {
    await expect(
      kit.invoke(searchMatches, { query: "x".repeat(SEARCH_QUERY_MAX + 1) }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      kit.invoke(searchMatches, {
        query: FULL_TOKEN,
        customerIds: Array.from({ length: ORDER_CUSTOMER_LOOKUP_MAX + 1 }, () =>
          randomUUID(),
        ),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      kit.invoke(searchMatches, {
        query: FULL_TOKEN,
        types: ["order"],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      kit.invoke(searchMatches, {
        query: FULL_TOKEN,
        companyId: kitIdentities.companies.b,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("uses an index for left-prefix LIKE on order_number", async () => {
    const canonical = canonicalizeOrderNumberToken(
      PREFIX_TOKEN,
      COMPANY_A_PREFIX,
    );
    expect(canonical).toBe(`${COMPANY_A_PREFIX}-${PREFIX_TOKEN}`);
    const pattern = orderNumberLeftPrefixPattern(canonical ?? "");
    expect(pattern).toBe(`${COMPANY_A_PREFIX}-${PREFIX_TOKEN}%`);
    expect(pattern?.includes("%")).toBe(true);
    expect(pattern?.startsWith("%")).toBe(false);

    const compiled = kit.db.runtime.db
      .select({ id: orders.id })
      .from(orders)
      .where(
        and(
          eq(orders.companyId, kitIdentities.companies.a),
          sql`${orders.orderNumber} LIKE ${pattern}`,
        ),
      )
      .toSQL();

    await kit.db.admin.query("BEGIN");
    try {
      await kit.db.admin.query("SET LOCAL enable_seqscan = off");
      const explained = await kit.db.admin.query<{ "QUERY PLAN": string }>(
        `EXPLAIN ${compiled.sql}`,
        compiled.params,
      );
      const plan = explained.rows.map((row) => row["QUERY PLAN"]).join("\n");
      expect(plan).toMatch(/Index (Only )?Scan|Bitmap Index Scan/);
      expect(plan).toMatch(/order_number/);
      expect(plan).not.toMatch(/\bSeq Scan\b/);
    } finally {
      await kit.db.admin.query("ROLLBACK");
    }
  });
});

type SearchMatchesResult = {
  groups: ReadonlyArray<{
    type: "order";
    hits: readonly SearchHit[];
    truncated: boolean;
  }>;
};

function orderGroup(result: SearchMatchesResult) {
  return result.groups[0];
}

function hitIds(group: { hits: readonly SearchHit[] } | undefined): string[] {
  return group?.hits.map((hit) => hit.id) ?? [];
}
