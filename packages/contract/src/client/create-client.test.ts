import { isContractProcedure } from "@orpc/contract";
import { defineActionContract } from "@showzy/core/contract";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { buildContractRouter } from "./contract-router.js";
import { createContractClient, RPC_PREFIX } from "./create-client.js";
import { createMutationAttempt } from "./mutation-attempt.js";
import {
  COMPANY_SELECTOR_HEADER,
  CONFIRMATION_CHALLENGE_HEADER,
  IDEMPOTENCY_KEY_HEADER,
} from "./transport-meta.js";

const submit = defineActionContract({
  name: "sample.submit",
  description: "Idempotent staff write.",
  principal: "staff",
  transport: "client",
  aiExposure: "internal",
  risk: "write",
  requiresConfirmation: false,
  idempotent: true,
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: [],
  audit: true,
  timeout: 5_000,
  permissions: ["sample:manage"],
  input: z.object({ note: z.string() }),
  output: z.object({ receiptId: z.string() }),
});

const sampleRouter = buildContractRouter({ sample: { submit } });
type SampleRouter = typeof sampleRouter;

async function ignoreRpcFailure(promise: Promise<unknown>): Promise<void> {
  await promise.catch(() => {
    // Stub 599 is not a valid RPC body; headers were already captured.
  });
}

/**
 * Hermes/whatwg-fetch-shaped clone: copying an existing Request with
 * `credentials: "omit"` does not tee the body (the original is marked
 * used; a native copy may also strip forbidden `Cookie`). The production
 * wrapper must rebuild from URL + init instead of this path.
 */
function cloneRequestLikeHermes(request: Request): Request {
  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (key.toLowerCase() !== "cookie") {
      headers.set(key, value);
    }
  });
  return new Request(request.url, {
    method: request.method,
    headers,
    credentials: "omit",
  });
}

async function captureRequest(
  run: (
    created: ReturnType<typeof createContractClient<SampleRouter>>,
  ) => Promise<void>,
  options: {
    readonly getAccessToken?: () => string | null;
    readonly getCookie?: () => string | null;
    readonly initialCompanyId?: string | null;
  } = {},
): Promise<Request[]> {
  const requests: Request[] = [];
  const created = createContractClient<SampleRouter>({
    baseUrl: "http://contract.test",
    ...options,
    fetch: (request) => {
      requests.push(request);
      return Promise.resolve(new Response(null, { status: 599 }));
    },
  });
  await run(created);
  return requests;
}

describe("createContractClient (contract.md §3)", () => {
  it("types the client from a defined contract router", () => {
    expect(isContractProcedure(sampleRouter.sample.submit)).toBe(true);
  });
  it("mounts at /rpc under the API origin", async () => {
    const [request] = await captureRequest(async ({ client }) => {
      await ignoreRpcFailure(client.sample.submit({ note: "hello" }));
    });
    expect(request).toBeDefined();
    expect(new URL(request?.url ?? "").pathname).toBe(
      `${RPC_PREFIX}/sample/submit`,
    );
  });

  it("sends the bearer token and the active-company selector", async () => {
    const requests = await captureRequest(
      async (created) => {
        created.setActiveCompany("company-a");
        await ignoreRpcFailure(created.client.sample.submit({ note: "hello" }));
        created.setActiveCompany("company-b");
        await ignoreRpcFailure(created.client.sample.submit({ note: "hello" }));
        created.setActiveCompany(null);
        await ignoreRpcFailure(created.client.sample.submit({ note: "hello" }));
      },
      { getAccessToken: () => "token-1" },
    );
    expect(requests).toHaveLength(3);
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer token-1");
    expect(requests[0]?.headers.get(COMPANY_SELECTOR_HEADER)).toBe("company-a");
    expect(requests[1]?.headers.get(COMPANY_SELECTOR_HEADER)).toBe("company-b");
    expect(requests[2]?.headers.has(COMPANY_SELECTOR_HEADER)).toBe(false);
  });

  it("sends the session cookie with credentials omitted", async () => {
    const requests = await captureRequest(
      async ({ client }) => {
        await ignoreRpcFailure(client.sample.submit({ note: "hello" }));
      },
      { getCookie: () => "better-auth.session_token=abc" },
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.get("cookie")).toBe(
      "better-auth.session_token=abc",
    );
    expect(requests[0]?.headers.has("authorization")).toBe(false);
    expect(requests[0]?.credentials).toBe("omit");
  });

  it("passes a JSON string body to global fetch, not an ArrayBuffer", async () => {
    const captured: RequestInit[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (_url, init = {}): Promise<Response> => {
      captured.push(init);
      return Promise.resolve(new Response(null, { status: 599 }));
    };
    try {
      const created = createContractClient<SampleRouter>({
        baseUrl: "http://contract.test",
        getCookie: () => "better-auth.session_token=abc",
      });
      const attempt = created.createMutationAttempt();
      await ignoreRpcFailure(
        created.client.sample.submit({ note: "sofi" }, attempt.options),
      );
      expect(captured).toHaveLength(1);
      const body = captured[0]?.body;
      expect(typeof body).toBe("string");
      if (typeof body !== "string") {
        throw new Error("expected a JSON string body");
      }
      expect(JSON.parse(body)).toEqual({
        json: { note: "sofi" },
      });
      expect(captured[0]?.credentials).toBe("omit");
      const headers = captured[0]?.headers;
      expect(headers).toEqual(
        expect.objectContaining({
          cookie: "better-auth.session_token=abc",
          [IDEMPOTENCY_KEY_HEADER]: attempt.key,
        }),
      );
      expect(headers instanceof Headers).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps Cookie, JSON body, and the attempt key through the omit wrapper", async () => {
    const captured: Array<{
      readonly method: string;
      readonly url: string;
      readonly cookie: string | null;
      readonly idempotencyKey: string | null;
      readonly body: unknown;
      readonly credentials: Request["credentials"];
    }> = [];
    const created = createContractClient<SampleRouter>({
      baseUrl: "http://contract.test",
      getCookie: () => "better-auth.session_token=abc",
      fetch: async (request) => {
        captured.push({
          method: request.method,
          url: request.url,
          cookie: request.headers.get("cookie"),
          idempotencyKey: request.headers.get(IDEMPOTENCY_KEY_HEADER),
          body: JSON.parse(await request.text()) as unknown,
          credentials: request.credentials,
        });
        return new Response(null, { status: 599 });
      },
    });
    const attempt = created.createMutationAttempt();
    await ignoreRpcFailure(
      created.client.sample.submit({ note: "sofi" }, attempt.options),
    );
    expect(captured).toHaveLength(1);
    expect(captured[0]?.method).toBe("POST");
    expect(new URL(captured[0]?.url ?? "").pathname).toBe(
      `${RPC_PREFIX}/sample/submit`,
    );
    expect(captured[0]?.cookie).toBe("better-auth.session_token=abc");
    expect(captured[0]?.idempotencyKey).toBe(attempt.key);
    expect(captured[0]?.credentials).toBe("omit");
    expect(captured[0]?.body).toEqual({ json: { note: "sofi" } });
  });

  it("an RN-shaped Request clone drops Cookie and the JSON body", async () => {
    const original = new Request("http://contract.test/rpc/companies/create", {
      method: "POST",
      headers: {
        cookie: "better-auth.session_token=abc",
        [IDEMPOTENCY_KEY_HEADER]: "attempt-1",
        "content-type": "application/json",
      },
      body: JSON.stringify({ json: { name: "Sofi", slug: "sofi" } }),
    });
    const cloned = cloneRequestLikeHermes(original);
    expect(cloned.headers.get("cookie")).toBeNull();
    expect(cloned.headers.get(IDEMPOTENCY_KEY_HEADER)).toBe("attempt-1");
    expect(await cloned.text()).toBe("");
  });

  it("omits authorization and the selector when anonymous", async () => {
    const [request] = await captureRequest(async ({ client }) => {
      await ignoreRpcFailure(client.sample.submit({ note: "hello" }));
    });
    expect(request?.headers.has("authorization")).toBe(false);
    expect(request?.headers.has(COMPANY_SELECTOR_HEADER)).toBe(false);
  });

  it("reuses the mutation-attempt key on every retry of that submit", async () => {
    const keys: Array<string | null> = [];
    const { client, createMutationAttempt: startAttempt } =
      createContractClient<SampleRouter>({
        baseUrl: "http://contract.test",
        fetch: (request) => {
          keys.push(request.headers.get(IDEMPOTENCY_KEY_HEADER));
          return Promise.resolve(new Response(null, { status: 599 }));
        },
      });
    const attempt = startAttempt();

    await ignoreRpcFailure(
      client.sample.submit({ note: "retry me" }, attempt.options),
    );
    await ignoreRpcFailure(
      client.sample.submit({ note: "retry me" }, attempt.options),
    );

    expect(keys).toEqual([attempt.key, attempt.key]);
    expect(createMutationAttempt().key).not.toBe(attempt.key);
  });

  it("does not send an idempotency key unless an attempt is supplied", async () => {
    const [request] = await captureRequest(async ({ client }) => {
      await ignoreRpcFailure(client.sample.submit({ note: "no key" }));
    });
    expect(request?.headers.has(IDEMPOTENCY_KEY_HEADER)).toBe(false);
  });

  it("sends confirmation challenge meta without replacing the attempt key", async () => {
    const requests: Request[] = [];
    const { client, createMutationAttempt: startAttempt } =
      createContractClient<SampleRouter>({
        baseUrl: "http://contract.test",
        fetch: (request) => {
          requests.push(request);
          return Promise.resolve(new Response(null, { status: 599 }));
        },
      });
    const attempt = startAttempt();
    await ignoreRpcFailure(
      client.sample.submit(
        { note: "confirm" },
        attempt.withChallenge("challenge-9"),
      ),
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.get(IDEMPOTENCY_KEY_HEADER)).toBe(attempt.key);
    expect(requests[0]?.headers.get(CONFIRMATION_CHALLENGE_HEADER)).toBe(
      "challenge-9",
    );
  });

  it("honours initialCompanyId until the setter replaces it", async () => {
    const [request] = await captureRequest(
      async ({ client }) => {
        await ignoreRpcFailure(client.sample.submit({ note: "hello" }));
      },
      { initialCompanyId: "company-initial" },
    );
    expect(request?.headers.get(COMPANY_SELECTOR_HEADER)).toBe(
      "company-initial",
    );
  });
});
