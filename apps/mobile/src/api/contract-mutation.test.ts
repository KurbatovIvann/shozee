import { ORPCError } from "@orpc/client";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  buildContractRouter,
  CONFIRMATION_CHALLENGE_HEADER,
  IDEMPOTENCY_KEY_HEADER,
} from "@showzy/contract";
import { defineActionContract } from "@showzy/core/contract";
import { MutationObserver } from "@tanstack/react-query";

import { createShowzyClient } from "./client";
import {
  confirmationFromError,
  createContractMutationController,
} from "./contract-mutation";
import { createShowzyQueryClient } from "./query-client";

const submit = defineActionContract({
  name: "sample.submit",
  description: "Fixture write used only by the mutation helper test.",
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

describe("createContractMutationController", () => {
  it("reuses one idempotency key on retry and mints a new key on a second submit", async () => {
    expect("sample" in sampleRouter).toBe(true);
    const keys: Array<string | null> = [];
    const created = createShowzyClient<SampleRouter>({
      apiUrl: "http://api.test",
      fetch: (request) => {
        keys.push(request.headers.get(IDEMPOTENCY_KEY_HEADER));
        return Promise.resolve(new Response(null, { status: 599 }));
      },
    });
    const controller = createContractMutationController<
      { note: string },
      unknown
    >({
      mutate: (input, options) => created.client.sample.submit(input, options),
    });

    await ignoreRpcFailure(controller.submit({ note: "one" }));
    await ignoreRpcFailure(controller.retry());
    const firstKey = controller.attemptKey();
    await ignoreRpcFailure(controller.submit({ note: "two" }));
    const secondKey = controller.attemptKey();

    expect(keys).toHaveLength(3);
    expect(keys[0]).toBe(firstKey);
    expect(keys[1]).toBe(firstKey);
    expect(keys[2]).toBe(secondKey);
    expect(secondKey).not.toBe(firstKey);
  });

  it("clears the in-flight attempt so retry after reset has no key", async () => {
    const created = createShowzyClient<SampleRouter>({
      apiUrl: "http://api.test",
      fetch: () => Promise.resolve(new Response(null, { status: 599 })),
    });
    const controller = createContractMutationController<
      { note: string },
      unknown
    >({
      mutate: (input, options) => created.client.sample.submit(input, options),
    });

    await ignoreRpcFailure(controller.submit({ note: "one" }));
    expect(controller.attemptKey()).not.toBeNull();
    controller.reset();
    expect(controller.attemptKey()).toBeNull();
    await expect(controller.retry()).rejects.toThrow(
      "contract mutation has no in-flight submit",
    );
  });

  it("keeps the attempt key and sets challenge meta on confirmation re-invoke", async () => {
    const requests: Request[] = [];
    const created = createShowzyClient<SampleRouter>({
      apiUrl: "http://api.test",
      fetch: (request) => {
        requests.push(request);
        return Promise.resolve(new Response(null, { status: 599 }));
      },
    });
    const controller = createContractMutationController<
      { note: string },
      unknown
    >({
      mutate: (input, options) => created.client.sample.submit(input, options),
    });

    await ignoreRpcFailure(controller.submit({ note: "confirm" }));
    const key = controller.attemptKey();
    await ignoreRpcFailure(controller.confirm("challenge-9"));

    expect(requests).toHaveLength(2);
    expect(requests[0]?.headers.get(IDEMPOTENCY_KEY_HEADER)).toBe(key);
    expect(requests[1]?.headers.get(IDEMPOTENCY_KEY_HEADER)).toBe(key);
    expect(requests[1]?.headers.get(CONFIRMATION_CHALLENGE_HEADER)).toBe(
      "challenge-9",
    );
    expect(
      confirmationFromError(
        new ORPCError("CONFIRMATION_REQUIRED", {
          defined: true,
          status: 409,
          message: "Confirm.",
          data: {
            challenge: {
              challengeId: "challenge-9",
              summary: "Delete?",
              expiresAt: "2026-08-21T00:00:00.000Z",
            },
          },
        }),
      ),
    ).toEqual({ challengeId: "challenge-9", summary: "Delete?" });
  });

  it("does not auto-retry mutations on the QueryClient", async () => {
    const queryClient = createShowzyQueryClient({ retryDelay: () => 0 });
    let calls = 0;
    const observer = new MutationObserver(queryClient, {
      mutationFn: () => {
        calls += 1;
        return Promise.reject(new TypeError("Failed to fetch"));
      },
    });
    await observer.mutate().catch(() => undefined);
    expect(calls).toBe(1);
    queryClient.clear();
  });
});
