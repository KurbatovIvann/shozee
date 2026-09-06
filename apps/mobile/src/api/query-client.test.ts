import { ORPCError } from "@orpc/client";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { buildContractRouter } from "@showzy/contract";
import { defineActionContract } from "@showzy/core/contract";
import { MutationObserver, QueryObserver } from "@tanstack/react-query";

import { createShowzyClient } from "./client";
import { ClientUnavailableError, InternalInvariantError } from "./errors";
import {
  bindActiveCompanyQueryIsolation,
  createShowzyQueryClient,
  createUnauthenticatedCleanupLatch,
  handleUnauthenticatedQueryError,
  hasLocalSession,
  isolateCacheOnSessionLoss,
  QUERY_RETRY_LIMIT,
  queryRetryDelay,
  resetTenantQueryState,
} from "./query-client";
import {
  accountContractQueryKey,
  contractQueryKey,
  contractQueryOptions,
  NULL_COMPANY_QUERY_SCOPE,
  StaleCompanyQueryError,
} from "./query-options";

const getOrder = defineActionContract({
  name: "sample.getOrder",
  description: "Fixture read used only by the query runtime tests.",
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
  input: z.object({ orderId: z.string() }),
  output: z.object({ orderId: z.string(), totalMinor: z.string() }),
});

const sampleRouter = buildContractRouter({ sample: { getOrder } });
type SampleRouter = typeof sampleRouter;

function sampleGetOrderQueryOptions(
  client: ReturnType<typeof createShowzyClient<SampleRouter>>,
  input: { orderId: string },
  companyId: string | null,
) {
  return contractQueryOptions({
    actionName: "sample.getOrder",
    companyId,
    input,
    getActiveCompany: () => client.getActiveCompany(),
    queryFn: () => client.client.sample.getOrder(input),
  });
}

function permissionDenied(): ORPCError<string, unknown> {
  return new ORPCError("PERMISSION_DENIED", {
    defined: true,
    status: 403,
    message: "Not allowed.",
  });
}

function notFound(): ORPCError<string, unknown> {
  return new ORPCError("NOT_FOUND", {
    defined: true,
    status: 404,
    message: "Missing.",
  });
}

function validation(): ORPCError<string, { issues: [] }> {
  return new ORPCError("VALIDATION", {
    defined: true,
    status: 400,
    message: "Invalid.",
    data: { issues: [] },
  });
}

function unauthenticated(): ORPCError<string, unknown> {
  return new ORPCError("UNAUTHENTICATED", {
    defined: true,
    status: 401,
    message: "Sign in.",
  });
}

function confirmationRequired(): ORPCError<
  string,
  {
    challenge: {
      challengeId: string;
      summary: string;
      expiresAt: string;
    };
  }
> {
  return new ORPCError("CONFIRMATION_REQUIRED", {
    defined: true,
    status: 409,
    message: "Confirm.",
    data: {
      challenge: {
        challengeId: "c-1",
        summary: "Delete?",
        expiresAt: "2026-08-21T00:00:00.000Z",
      },
    },
  });
}

function timeout(): ORPCError<string, unknown> {
  return new ORPCError("TIMEOUT", {
    defined: true,
    status: 504,
    message: "Timed out.",
  });
}

function rateLimited(
  retryAfterSec: number,
): ORPCError<string, { retryAfterSec: number }> {
  return new ORPCError("RATE_LIMITED", {
    defined: true,
    status: 429,
    message: "Slow down.",
    data: { retryAfterSec },
  });
}

async function countQueryAttempts(error: Error): Promise<number> {
  const queryClient = createShowzyQueryClient({ retryDelay: () => 0 });
  let calls = 0;
  await queryClient
    .fetchQuery({
      queryKey: ["retry-probe"],
      queryFn: () => {
        calls += 1;
        return Promise.reject(error);
      },
    })
    .catch(() => undefined);
  queryClient.clear();
  return calls;
}

describe("createShowzyQueryClient retry policy", () => {
  it("retries network and TIMEOUT failures", async () => {
    expect("sample" in sampleRouter).toBe(true);
    expect(await countQueryAttempts(new TypeError("Failed to fetch"))).toBe(
      QUERY_RETRY_LIMIT + 1,
    );
    expect(await countQueryAttempts(timeout())).toBe(QUERY_RETRY_LIMIT + 1);
  });

  it("retries RATE_LIMITED and honors retryAfterSec in the delay", async () => {
    expect(await countQueryAttempts(rateLimited(12))).toBe(
      QUERY_RETRY_LIMIT + 1,
    );
    expect(queryRetryDelay(0, rateLimited(12))).toBe(12_000);
    expect(queryRetryDelay(0, rateLimited(3_600))).toBe(60_000);
    expect(queryRetryDelay(0, rateLimited(-5))).toBe(0);
  });

  it("does not retry client wire codes", async () => {
    expect(await countQueryAttempts(permissionDenied())).toBe(1);
    expect(await countQueryAttempts(notFound())).toBe(1);
    expect(await countQueryAttempts(validation())).toBe(1);
    expect(await countQueryAttempts(unauthenticated())).toBe(1);
    expect(await countQueryAttempts(confirmationRequired())).toBe(1);
    expect(await countQueryAttempts(new StaleCompanyQueryError())).toBe(1);
    expect(await countQueryAttempts(new ClientUnavailableError())).toBe(1);
    expect(await countQueryAttempts(new InternalInvariantError())).toBe(1);
  });

  it("does not retry mutations", async () => {
    const queryClient = createShowzyQueryClient({ retryDelay: () => 0 });
    let calls = 0;
    const observer = new MutationObserver(queryClient, {
      mutationFn: () => {
        calls += 1;
        return Promise.reject(timeout());
      },
    });
    await observer.mutate().catch(() => undefined);
    expect(calls).toBe(1);
    queryClient.clear();
  });
});

describe("query cache isolation", () => {
  it("clears tenant rows but preserves account rows on setActiveCompany", () => {
    const queryClient = createShowzyQueryClient();
    const created = createShowzyClient<SampleRouter>({
      apiUrl: "http://api.test",
    });
    bindActiveCompanyQueryIsolation(created, queryClient);

    const companyAKey = contractQueryKey("sample.getOrder", "company-a", {
      orderId: "o-1",
    });
    const membershipsKey = accountContractQueryKey(
      "companies.listMine",
      "user-a",
      {},
    );
    queryClient.setQueryData(companyAKey, {
      orderId: "o-1",
      totalMinor: "1990",
    });
    queryClient.setQueryData(membershipsKey, { memberships: [] });
    expect(queryClient.getQueryData(companyAKey)).toEqual({
      orderId: "o-1",
      totalMinor: "1990",
    });

    created.setActiveCompany("company-b");
    expect(queryClient.getQueryData(companyAKey)).toBeUndefined();
    expect(queryClient.getQueryData(membershipsKey)).toEqual({
      memberships: [],
    });
    expect(queryClient.getQueryCache().getAll()).toHaveLength(1);
  });

  it("clears leftover rows and resets the selector on session loss", () => {
    const queryClient = createShowzyQueryClient();
    const created = createShowzyClient<SampleRouter>({
      apiUrl: "http://api.test",
      initialCompanyId: "company-a",
    });
    bindActiveCompanyQueryIsolation(created, queryClient);
    const priceKey = contractQueryKey("sample.getOrder", "company-a", {
      orderId: "o-2",
    });
    const membershipsKey = accountContractQueryKey(
      "companies.listMine",
      "user-a",
      {},
    );
    queryClient.setQueryData(priceKey, { orderId: "o-2", totalMinor: "500" });
    queryClient.setQueryData(membershipsKey, { memberships: [] });

    isolateCacheOnSessionLoss("loading", "anonymous", {
      client: created,
      queryClient,
    });
    expect(queryClient.getQueryData(priceKey)).toEqual({
      orderId: "o-2",
      totalMinor: "500",
    });
    expect(created.getActiveCompany()).toBe("company-a");

    isolateCacheOnSessionLoss("authenticated", "anonymous", {
      client: created,
      queryClient,
    });
    expect(queryClient.getQueryData(priceKey)).toBeUndefined();
    expect(queryClient.getQueryData(membershipsKey)).toBeUndefined();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(created.getActiveCompany()).toBeNull();
  });

  it("does not store the next company's payload under the previous key", async () => {
    const created = createShowzyClient<SampleRouter>({
      apiUrl: "http://api.test",
    });
    created.setActiveCompany("company-a");
    const queryClient = createShowzyQueryClient({ retryDelay: () => 0 });
    bindActiveCompanyQueryIsolation(created, queryClient);

    const input = { orderId: "o-1" };
    const keyA = contractQueryKey("sample.getOrder", "company-a", input);
    const keyB = contractQueryKey("sample.getOrder", "company-b", input);

    function optionsFor(companyId: string) {
      return {
        ...contractQueryOptions({
          actionName: "sample.getOrder",
          companyId,
          input,
          getActiveCompany: () => created.getActiveCompany(),
          queryFn: () =>
            Promise.resolve({
              orderId: "o-1",
              totalMinor:
                created.getActiveCompany() === "company-b" ? "B" : "A",
            }),
        }),
        retry: false as const,
      };
    }

    const observer = new QueryObserver(queryClient, optionsFor("company-a"));
    const unsubscribe = observer.subscribe(() => undefined);
    await queryClient.fetchQuery(optionsFor("company-a"));
    expect(queryClient.getQueryData(keyA)).toEqual({
      orderId: "o-1",
      totalMinor: "A",
    });

    created.setActiveCompany("company-b");
    expect(queryClient.getQueryData(keyA)).toBeUndefined();

    await observer.refetch().catch(() => undefined);
    expect(queryClient.getQueryData(keyA)).toBeUndefined();

    await queryClient.fetchQuery(optionsFor("company-b"));
    expect(queryClient.getQueryData(keyB)).toEqual({
      orderId: "o-1",
      totalMinor: "B",
    });
    expect(queryClient.getQueryData(keyA)).toBeUndefined();
    unsubscribe();
    queryClient.clear();
  });

  it("uses a distinct null-company key namespace", () => {
    expect(
      contractQueryKey("sample.getOrder", null, { orderId: "o-1" })[1],
    ).toBe(NULL_COMPANY_QUERY_SCOPE);
    expect(
      contractQueryKey("sample.getOrder", "company-a", { orderId: "o-1" })[1],
    ).toBe("company-a");
  });
});

describe("UNAUTHENTICATED query handling", () => {
  it("notifies the session hook on query 401", async () => {
    const onUnauthenticated = vi.fn();
    const queryClient = createShowzyQueryClient({
      onUnauthenticated,
      retryDelay: () => 0,
    });
    await queryClient
      .fetchQuery({
        queryKey: ["unauthenticated"],
        queryFn: () => Promise.reject(unauthenticated()),
      })
      .catch(() => undefined);
    expect(onUnauthenticated).toHaveBeenCalledTimes(1);
    queryClient.clear();
  });

  it("collapses N unauthenticated failures to one cleanup", async () => {
    const onUnauthenticated = vi.fn(
      () =>
        new Promise<void>(() => {
          // Stay in-flight so later 401s share this cleanup.
        }),
    );
    const queryClient = createShowzyQueryClient({
      onUnauthenticated,
      retryDelay: () => 0,
    });
    await Promise.all(
      ["a", "b", "c"].map((key) =>
        queryClient
          .fetchQuery({
            queryKey: ["unauthenticated", key],
            queryFn: () => Promise.reject(unauthenticated()),
            retry: false,
          })
          .catch(() => undefined),
      ),
    );
    expect(onUnauthenticated).toHaveBeenCalledTimes(1);
    queryClient.clear();
  });

  it("createUnauthenticatedCleanupLatch ignores re-entry while in flight", () => {
    const cleanup = vi.fn(
      () =>
        new Promise<void>(() => {
          // never settles
        }),
    );
    const latch = createUnauthenticatedCleanupLatch(cleanup);
    void latch();
    void latch();
    void latch();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("does not 401-gate anonymous public/share work", () => {
    const clearSession = vi.fn();
    const clearCache = vi.fn();
    void handleUnauthenticatedQueryError({
      hadSession: hasLocalSession(null),
      clearSession,
      clearCache,
    });
    expect(clearSession).not.toHaveBeenCalled();
    expect(clearCache).not.toHaveBeenCalled();

    void handleUnauthenticatedQueryError({
      hadSession: hasLocalSession("better-auth.session_token=abc"),
      clearSession,
      clearCache,
    });
    expect(clearSession).toHaveBeenCalledTimes(1);
    expect(clearCache).toHaveBeenCalledTimes(1);
  });

  it("clears a stored cookie on 401 even when the session snapshot is still null", () => {
    let cookie = "better-auth.session_token=dead";
    const created = createShowzyClient<SampleRouter>({
      apiUrl: "http://api.test",
      initialCompanyId: "company-a",
    });
    const queryClient = createShowzyQueryClient();
    bindActiveCompanyQueryIsolation(created, queryClient);
    const priceKey = contractQueryKey("sample.getOrder", "company-a", {
      orderId: "o-3",
    });
    queryClient.setQueryData(priceKey, { orderId: "o-3", totalMinor: "1" });

    void handleUnauthenticatedQueryError({
      hadSession: hasLocalSession(cookie),
      clearSession: () => {
        cookie = "";
      },
      clearCache: () => {
        resetTenantQueryState({ client: created, queryClient });
      },
    });
    expect(cookie).toBe("");
    expect(queryClient.getQueryData(priceKey)).toBeUndefined();
    expect(created.getActiveCompany()).toBeNull();
  });

  it("issues a read without a session (no client-side 401 gate)", async () => {
    const requests: Request[] = [];
    const created = createShowzyClient<SampleRouter>({
      apiUrl: "http://api.test",
      getCookie: () => null,
      fetch: (request) => {
        requests.push(request);
        return Promise.resolve(new Response(null, { status: 599 }));
      },
    });
    const queryClient = createShowzyQueryClient({ retryDelay: () => 0 });
    await queryClient
      .fetchQuery({
        ...sampleGetOrderQueryOptions(created, { orderId: "o-public" }, null),
        retry: false,
      })
      .catch(() => undefined);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.has("authorization")).toBe(false);
    queryClient.clear();
  });
});
