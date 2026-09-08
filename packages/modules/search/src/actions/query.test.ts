import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { CtxCall, StaffMembership } from "@showzy/core";
import {
  GLOBAL_HIT_CAP,
  SEARCH_ENTITY_TYPES,
  SEARCH_LIMIT_PER_TYPE_DEFAULT,
  SEARCH_QUERY_MAX,
  type SearchGroup,
  type SearchHit,
} from "@showzy/validation/search";
import { describe, expect, it } from "vitest";

import { assembleSearchGroups, executeSearchQuery } from "../services/query.js";
import { queryContract } from "./query.contract.js";

const CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";
const ORDER_ID = "22222222-2222-4222-8222-222222222222";

const employee: StaffMembership = {
  role: "employee",
  permissions: [
    "companies:view",
    "customers:view",
    "orders:view",
    "products:view",
    "pricing:view",
    "documents:view",
  ],
};

function asCtxCall(
  impl: (
    action: { readonly contract: { readonly name: string } },
    input: unknown,
  ) => unknown,
): CtxCall {
  return ((action, input) => Promise.resolve(impl(action, input))) as CtxCall;
}

function hit(id: string, exact: boolean, label = "Hit"): SearchHit {
  return { id, label, matchedOn: "name", exact };
}

function uuidAt(typeIndex: number, index: number): string {
  return `11111111-1111-4111-8111-${(typeIndex * 1000 + index).toString(16).padStart(12, "0")}`;
}

function group(
  type: SearchGroup["type"],
  exactCount: number,
  restCount: number,
  truncated = false,
): SearchGroup {
  const typeIndex = SEARCH_ENTITY_TYPES.indexOf(type);
  const hits = [
    ...Array.from({ length: exactCount }, (_, i) =>
      hit(uuidAt(typeIndex, i), true, `${type}-exact-${String(i)}`),
    ),
    ...Array.from({ length: restCount }, (_, i) =>
      hit(uuidAt(typeIndex, 50 + i), false, `${type}-rest-${String(i)}`),
    ),
  ];
  if (type === "variant") {
    return {
      type: "variant",
      truncated,
      hits: hits.map((row) => ({ ...row, productId: CUSTOMER_ID })),
    };
  }
  return { type, truncated, hits };
}

describe("search.query contract", () => {
  it("is a staff client read opened by companies:view, not a new search:query key", () => {
    expect(queryContract.name).toBe("search.query");
    expect(queryContract.principal).toBe("staff");
    expect(queryContract.transport).toBe("client");
    expect(queryContract.risk).toBe("read");
    expect(queryContract.permissions).toEqual(["companies:view"]);
    expect(queryContract.permissions).not.toEqual([]);
    expect(queryContract.aiExposure).toBe("internal");
    expect(queryContract.audit).toBe(false);
    expect(queryContract.idempotent).toBe(false);
    expect(queryContract.emits).toEqual([]);
    expect(queryContract.timeout).toBe(10_000);
    expect(
      queryContract.input.safeParse({ query: "мак", cursor: "next" }).success,
    ).toBe(false);
    expect(
      queryContract.output.parse({
        groups: [],
        searchedTypes: ["order"],
        queryNormalized: "мак",
      }),
    ).toEqual({
      groups: [],
      searchedTypes: ["order"],
      queryNormalized: "мак",
    });
  });

  it("allows empty query up to SEARCH_QUERY_MAX and rejects extras", () => {
    expect(queryContract.input.parse({ query: "" })).toEqual({
      query: "",
      limitPerType: 5,
    });
    expect(
      queryContract.input.safeParse({
        query: "x".repeat(SEARCH_QUERY_MAX + 1),
      }).success,
    ).toBe(false);
    expect(
      queryContract.input.safeParse({
        query: "мак",
        companyId: "11111111-1111-4111-8111-111111111111",
      }).success,
    ).toBe(false);
  });
});

describe("search.query orchestrator", () => {
  it("does not import schema, catch matcher errors, or call companies.get", () => {
    const handlerSrc = readFileSync(
      fileURLToPath(new URL("./query.ts", import.meta.url)),
      "utf8",
    );
    const serviceSrc = readFileSync(
      fileURLToPath(new URL("../services/query.ts", import.meta.url)),
      "utf8",
    );
    for (const src of [handlerSrc, serviceSrc]) {
      expect(src).not.toContain("@showzy/db/schema");
      expect(src).not.toMatch(/\bcatch\b/);
      expect(src).not.toContain("FORBIDDEN");
      expect(src).not.toContain("PermissionDeniedError");
      expect(src).not.toContain("getCompany");
      expect(src).not.toContain("companies.get");
    }
  });

  it("returns empty groups without matcher calls for empty or punctuation-only queries", async () => {
    const calls: string[] = [];
    const call: CtxCall = (action) => {
      calls.push(action.contract.name);
      return Promise.reject(
        new Error(`unexpected matcher call: ${action.contract.name}`),
      );
    };
    for (const query of ["", "   ", "...", "!!! ???", "%%%"]) {
      calls.length = 0;
      const result = await executeSearchQuery(
        { query, limitPerType: SEARCH_LIMIT_PER_TYPE_DEFAULT },
        { membership: employee, call },
      );
      expect(calls).toEqual([]);
      expect(result.groups).toEqual([]);
      expect(result.queryNormalized).toBe("");
      expect(result.searchedTypes).toEqual([...SEARCH_ENTITY_TYPES]);
    }
  });

  it("intersects searchedTypes with permissions on empty query", async () => {
    const call: CtxCall = (action) =>
      Promise.reject(
        new Error(`unexpected matcher call: ${action.contract.name}`),
      );
    const result = await executeSearchQuery(
      {
        query: "...",
        types: ["order", "customer", "document"],
        limitPerType: SEARCH_LIMIT_PER_TYPE_DEFAULT,
      },
      {
        membership: {
          role: "employee",
          permissions: ["companies:view", "orders:view"],
        },
        call,
      },
    );
    expect(result).toEqual({
      groups: [],
      searchedTypes: ["order"],
      queryNormalized: "",
    });
  });

  it("does not put customer in searchedTypes for types:[order] lookup-only", async () => {
    const calls: Array<{ name: string; input: unknown }> = [];
    const call = asCtxCall((action, input) => {
      calls.push({ name: action.contract.name, input });
      if (action.contract.name === "customers.searchMatches") {
        return {
          groups: [
            {
              type: "customer",
              truncated: false,
              hits: [
                {
                  id: CUSTOMER_ID,
                  label: "Olena",
                  matchedOn: "name",
                  exact: true,
                },
              ],
            },
          ],
          orderCustomerLookup: { ids: [CUSTOMER_ID], truncated: false },
        };
      }
      if (action.contract.name === "orders.searchMatches") {
        return {
          groups: [
            {
              type: "order",
              truncated: false,
              hits: [
                {
                  id: ORDER_ID,
                  label: "KA-ZZLOOK1",
                  matchedOn: "customer",
                  exact: false,
                },
              ],
            },
          ],
        };
      }
      throw new Error(`unexpected matcher call: ${action.contract.name}`);
    });

    const result = await executeSearchQuery(
      {
        query: "Olena",
        types: ["order"],
        limitPerType: SEARCH_LIMIT_PER_TYPE_DEFAULT,
      },
      { membership: employee, call },
    );

    expect(result.searchedTypes).toEqual(["order"]);
    expect(result.groups.map((entry) => entry.type)).toEqual(["order"]);
    expect(calls.map((entry) => entry.name)).toEqual([
      "customers.searchMatches",
      "orders.searchMatches",
    ]);
    expect(calls[0]?.input).toEqual({
      query: "Olena",
      limitPerType: 5,
      types: ["customer"],
    });
    expect(calls[1]?.input).toEqual({
      query: "Olena",
      limitPerType: 5,
      customerIds: [CUSTOMER_ID],
    });
  });

  it("omits customers call and customerIds when customers:view is missing", async () => {
    const calls: Array<{ name: string; input: unknown }> = [];
    const call = asCtxCall((action, input) => {
      calls.push({ name: action.contract.name, input });
      if (action.contract.name === "orders.searchMatches") {
        return { groups: [] };
      }
      throw new Error(`unexpected matcher call: ${action.contract.name}`);
    });

    const result = await executeSearchQuery(
      {
        query: "KA-534ORD1",
        types: ["order", "customer", "document"],
        limitPerType: SEARCH_LIMIT_PER_TYPE_DEFAULT,
      },
      {
        membership: {
          role: "employee",
          permissions: ["companies:view", "orders:view"],
        },
        call,
      },
    );

    expect(result.searchedTypes).toEqual(["order"]);
    expect(calls.map((entry) => entry.name)).toEqual(["orders.searchMatches"]);
    expect(calls[0]?.input).toEqual({
      query: "KA-534ORD1",
      limitPerType: 5,
    });
  });

  it("propagates matcher failures without omitting a module", async () => {
    const call: CtxCall = () =>
      Promise.reject(new Error("catalog matcher down"));
    await expect(
      executeSearchQuery(
        {
          query: "мак",
          types: ["product"],
          limitPerType: SEARCH_LIMIT_PER_TYPE_DEFAULT,
        },
        { membership: employee, call },
      ),
    ).rejects.toThrow("catalog matcher down");
  });
});

describe("assembleSearchGroups", () => {
  it("keeps all exact hits first in type-enum order, then remaining budget", () => {
    expect(GLOBAL_HIT_CAP).toBe(40);
    const assembled = assembleSearchGroups(
      [
        group("order", 15, 0),
        group("customer", 15, 0),
        group("product", 15, 0),
      ],
      false,
    );
    const counts = Object.fromEntries(
      assembled.map((entry) => [
        entry.type,
        {
          exact: entry.hits.filter((row) => row.exact).length,
          rest: entry.hits.filter((row) => !row.exact).length,
          truncated: entry.truncated,
        },
      ]),
    );
    expect(counts).toEqual({
      order: { exact: 15, rest: 0, truncated: false },
      customer: { exact: 15, rest: 0, truncated: false },
      product: { exact: 10, rest: 0, truncated: true },
    });
    expect(assembled.some((entry) => entry.type === "document")).toBe(false);
    expect(
      assembled.flatMap((entry) => entry.hits).every((row) => row.exact),
    ).toBe(true);
    expect(assembled.flatMap((entry) => entry.hits)).toHaveLength(40);
  });

  it("fills remaining budget by type-enum order after exacts", () => {
    const assembled = assembleSearchGroups(
      [group("order", 2, 8), group("customer", 2, 20), group("product", 0, 20)],
      false,
    );
    expect(
      assembled.map((entry) => ({
        type: entry.type,
        exact: entry.hits.filter((row) => row.exact).length,
        rest: entry.hits.filter((row) => !row.exact).length,
        truncated: entry.truncated,
      })),
    ).toEqual([
      { type: "order", exact: 2, rest: 8, truncated: false },
      { type: "customer", exact: 2, rest: 20, truncated: false },
      { type: "product", exact: 0, rest: 8, truncated: true },
    ]);
  });

  it("marks the order group truncated when lookup is truncated even with empty hits", () => {
    const assembled = assembleSearchGroups([], true);
    expect(assembled).toEqual([{ type: "order", hits: [], truncated: true }]);
  });

  it("does not treat a 20-id lookup as truncated unless T3 said so", () => {
    const assembled = assembleSearchGroups(
      [
        {
          type: "order",
          truncated: false,
          hits: [hit(ORDER_ID, false, "KA-1")],
        },
      ],
      false,
    );
    expect(assembled).toEqual([
      {
        type: "order",
        truncated: false,
        hits: [hit(ORDER_ID, false, "KA-1")],
      },
    ]);
  });

  it("passes variant productId through", () => {
    const variant = group("variant", 1, 0);
    const assembled = assembleSearchGroups([variant], false);
    expect(assembled[0]).toEqual(variant);
    expect(
      assembled[0]?.type === "variant"
        ? assembled[0].hits[0]?.productId
        : undefined,
    ).toBe(CUSTOMER_ID);
  });
});
