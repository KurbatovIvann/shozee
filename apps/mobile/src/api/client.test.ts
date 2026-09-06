import { defineActionContract } from "@showzy/core/contract";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { buildContractRouter } from "@showzy/contract";

import { createShowzyClient } from "./client";

const ping = defineActionContract({
  name: "sample.ping",
  description: "Fixture read used only by the mobile client wiring test.",
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
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
});

const sampleRouter = buildContractRouter({ sample: { ping } });
type SampleRouter = typeof sampleRouter;

async function ignoreRpcFailure(promise: Promise<unknown>): Promise<void> {
  await promise.catch(() => {
    // Stub 599 is not a valid RPC body; headers were already captured.
  });
}

describe("createShowzyClient (contract.md §3)", () => {
  it("sends a session cookie and /rpc path through the mocked transport", async () => {
    expect("sample" in sampleRouter).toBe(true);
    const requests: Request[] = [];
    const created = createShowzyClient<SampleRouter>({
      apiUrl: "http://api.test/",
      getCookie: () => "better-auth.session_token=abc",
      initialCompanyId: "company-a",
      fetch: (request) => {
        requests.push(request);
        return Promise.resolve(new Response(null, { status: 599 }));
      },
    });

    await ignoreRpcFailure(created.client.sample.ping({}));
    created.setActiveCompany(null);
    await ignoreRpcFailure(created.client.sample.ping({}));

    expect(requests).toHaveLength(2);
    expect(new URL(requests[0]?.url ?? "").origin).toBe("http://api.test");
    expect(new URL(requests[0]?.url ?? "").pathname).toBe("/rpc/sample/ping");
    expect(requests[0]?.headers.get("cookie")).toBe(
      "better-auth.session_token=abc",
    );
    expect(requests[0]?.headers.has("authorization")).toBe(false);
    expect(requests[0]?.headers.get("x-company-id")).toBe("company-a");
    expect(requests[0]?.credentials).toBe("omit");
    expect(requests[1]?.headers.has("x-company-id")).toBe(false);
  });

  it("omits cookie and authorization when providers return empty", async () => {
    const requests: Request[] = [];
    const created = createShowzyClient<SampleRouter>({
      apiUrl: "http://api.test",
      getCookie: () => null,
      fetch: (request) => {
        requests.push(request);
        return Promise.resolve(new Response(null, { status: 599 }));
      },
    });
    await ignoreRpcFailure(created.client.sample.ping({}));
    expect(requests[0]?.headers.has("cookie")).toBe(false);
    expect(requests[0]?.headers.has("authorization")).toBe(false);
  });

  it("reuses a mutation-attempt key", () => {
    const created = createShowzyClient({ apiUrl: "http://api.test" });
    const attempt = created.createMutationAttempt();
    expect(attempt.key).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(attempt.options.context.idempotencyKey).toBe(attempt.key);
    expect(attempt.withChallenge("c-1").context.confirmationChallengeId).toBe(
      "c-1",
    );
    expect(attempt.withChallenge("c-1").context.idempotencyKey).toBe(
      attempt.key,
    );
  });

  it("notifies every onActiveCompanyChange listener and honors unsubscribe", () => {
    const created = createShowzyClient({ apiUrl: "http://api.test" });
    const first: string[] = [];
    const second: string[] = [];
    const unsubscribeFirst = created.onActiveCompanyChange((companyId) => {
      first.push(companyId ?? "null");
    });
    created.onActiveCompanyChange((companyId) => {
      second.push(companyId ?? "null");
    });

    created.setActiveCompany("company-a");
    unsubscribeFirst();
    created.setActiveCompany("company-b");
    created.setActiveCompany(null);

    expect(first).toEqual(["company-a"]);
    expect(second).toEqual(["company-a", "company-b", "null"]);
  });
});
