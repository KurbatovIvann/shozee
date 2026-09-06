import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { buildContractRouter } from "@showzy/contract";
import { defineActionContract } from "@showzy/core/contract";

import { createShowzyClient } from "./client";
import { createShowzyQueryClient } from "./query-client";
import {
  accountContractQueryKey,
  accountContractQueryOptions,
  assertCompanyStillActive,
  contractInfiniteQueryOptions,
  contractQueryKey,
  contractQueryOptions,
  NULL_COMPANY_QUERY_SCOPE,
  StaleCompanyQueryError,
} from "./query-options";

const ping = defineActionContract({
  name: "sample.ping",
  description: "Fixture read used only by the query-options wiring test.",
  principal: "staff",
  transport: "client",
  aiExposure: "internal",
  risk: "read",
  requiresConfirmation: false,
  idempotent: true,
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: [],
  audit: false,
  timeout: 5_000,
  permissions: ["sample:view"],
  input: z.object({ n: z.number() }),
  output: z.object({ ok: z.boolean() }),
});

const sampleRouter = buildContractRouter({ sample: { ping } });
type SampleRouter = typeof sampleRouter;

function samplePingQueryOptions(
  client: ReturnType<typeof createShowzyClient<SampleRouter>>,
  input: { n: number },
  companyId: string | null,
) {
  return contractQueryOptions({
    actionName: "sample.ping",
    companyId,
    input,
    getActiveCompany: () => client.getActiveCompany(),
    queryFn: () => client.client.sample.ping(input),
  });
}

describe("contractQueryOptions", () => {
  it("puts action name, company selector, and input in the key", () => {
    expect("sample" in sampleRouter).toBe(true);
    const created = createShowzyClient<SampleRouter>({
      apiUrl: "http://api.test",
      initialCompanyId: "company-a",
    });
    const options = samplePingQueryOptions(created, { n: 1 }, "company-a");
    expect(options.queryKey).toEqual(
      contractQueryKey("sample.ping", "company-a", { n: 1 }),
    );
    created.setActiveCompany(null);
    expect(samplePingQueryOptions(created, { n: 1 }, null).queryKey[1]).toBe(
      NULL_COMPANY_QUERY_SCOPE,
    );
  });

  it("calls the contract procedure through queryFn", async () => {
    const requests: Request[] = [];
    const created = createShowzyClient<SampleRouter>({
      apiUrl: "http://api.test",
      initialCompanyId: "company-a",
      fetch: (request) => {
        requests.push(request);
        return Promise.resolve(new Response(null, { status: 599 }));
      },
    });
    const queryClient = createShowzyQueryClient({ retryDelay: () => 0 });
    await queryClient
      .fetchQuery({
        ...samplePingQueryOptions(created, { n: 7 }, "company-a"),
        retry: false,
      })
      .catch(() => undefined);
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0]?.url ?? "").pathname).toBe("/rpc/sample/ping");
    expect(requests[0]?.headers.get("x-company-id")).toBe("company-a");
    queryClient.clear();
  });
});

describe("contractInfiniteQueryOptions", () => {
  type Page = {
    readonly items: readonly number[];
    readonly nextCursor: string | null;
  };

  function pagedOptions(args: {
    readonly pages: Readonly<Record<string, Page>>;
    readonly firstPage: Page;
    readonly getActiveCompany?: () => string | null;
    readonly seen?: Array<string | null>;
  }) {
    return contractInfiniteQueryOptions({
      actionName: "sample.list",
      companyId: "company-a",
      input: { status: "active" },
      getActiveCompany: args.getActiveCompany ?? (() => "company-a"),
      queryFn: (cursor) => {
        args.seen?.push(cursor);
        return Promise.resolve(
          cursor === null
            ? args.firstPage
            : (args.pages[cursor] ?? args.firstPage),
        );
      },
      nextCursor: (page) => page.nextCursor,
    });
  }

  it("keeps the [actionName, companyScope, input] key shape without the cursor", () => {
    const options = pagedOptions({
      pages: {},
      firstPage: { items: [], nextCursor: null },
    });
    expect(options.queryKey).toEqual(
      contractQueryKey("sample.list", "company-a", { status: "active" }),
    );
  });

  it("feeds the server cursor into the next page fetch and stops on null", async () => {
    const seen: Array<string | null> = [];
    const queryClient = createShowzyQueryClient({ retryDelay: () => 0 });
    const data = await queryClient.fetchInfiniteQuery({
      ...pagedOptions({
        firstPage: { items: [1, 2], nextCursor: "cursor-2" },
        pages: { "cursor-2": { items: [3], nextCursor: null } },
        seen,
      }),
      pages: 3,
    });
    expect(seen).toEqual([null, "cursor-2"]);
    expect(data.pages.map((page) => page.items)).toEqual([[1, 2], [3]]);
    queryClient.clear();
  });

  it("refuses to fetch under a stale company selector", async () => {
    const queryClient = createShowzyQueryClient({ retryDelay: () => 0 });
    await expect(
      queryClient.fetchInfiniteQuery({
        ...pagedOptions({
          firstPage: { items: [], nextCursor: null },
          pages: {},
          getActiveCompany: () => "company-b",
        }),
        retry: false,
      }),
    ).rejects.toBeInstanceOf(StaleCompanyQueryError);
    queryClient.clear();
  });
});

describe("accountContractQueryOptions", () => {
  it("isolates null-company cache entries by authenticated session", () => {
    const input = {};
    expect(
      accountContractQueryKey("companies.listMine", "user-a", input),
    ).toEqual([
      "companies.listMine",
      NULL_COMPANY_QUERY_SCOPE,
      "user-a",
      input,
    ]);
    expect(
      accountContractQueryKey("companies.listMine", "user-b", input),
    ).not.toEqual(
      accountContractQueryKey("companies.listMine", "user-a", input),
    );
  });

  it("runs independently of an active staff selector", async () => {
    const queryFn = vi.fn(() => Promise.resolve({ memberships: [] }));
    const queryClient = createShowzyQueryClient({ retryDelay: () => 0 });
    const options = accountContractQueryOptions({
      actionName: "companies.listMine",
      sessionUserId: "user-a",
      input: {},
      queryFn,
    });

    await expect(queryClient.fetchQuery(options)).resolves.toEqual({
      memberships: [],
    });
    expect(queryFn).toHaveBeenCalledOnce();
    queryClient.clear();
  });
});

describe("assertCompanyStillActive", () => {
  it("throws StaleCompanyQueryError when the live selector drifted", () => {
    expect(() => {
      assertCompanyStillActive(() => "company-b", "company-a");
    }).toThrow(StaleCompanyQueryError);
    expect(() => {
      assertCompanyStillActive(() => "company-a", "company-a");
    }).not.toThrow();
  });
});
