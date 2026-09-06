/**
 * Typed-client transport round-trip: the factory's headers are the only
 * way protocol meta reaches the pipeline. Missing idempotency keys must
 * surface as the §4 VALIDATION wire error; retries of one
 * `createMutationAttempt` must replay rather than re-execute.
 */
import { randomUUID } from "node:crypto";

import { RPCHandler } from "@orpc/server/fetch";
import {
  ActionRegistry,
  implementAction,
  type ActionPipelineDeps,
  type ImplementedAction,
} from "@showzy/core";
import { defineActionContract } from "@showzy/core/contract";
import {
  createTestKit,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createContractClient } from "../client/create-client.js";
import type { ContractRouterFor } from "../client/contract-router.js";
import {
  COMPANY_SELECTOR_HEADER,
  CONFIRMATION_CHALLENGE_HEADER,
  IDEMPOTENCY_KEY_HEADER,
} from "../client/transport-meta.js";
import { isWireError } from "../client/wire-errors.js";
import { buildServerRouter } from "./server-router.js";
import type { TransportInvocationContext } from "./transport-context.js";
import { wireErrorInterceptors } from "./wire-error.js";

const submitContract = defineActionContract({
  name: "sample.submit",
  description: "Idempotent staff write returning a fresh receipt.",
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
  input: z.object({ note: z.string().min(3) }),
  output: z.object({ receiptId: z.string() }),
});

function register<TInput extends z.ZodType, TOutput extends z.ZodType, TTarget>(
  registry: ActionRegistry,
  action: ImplementedAction<TInput, TOutput, TTarget>,
): void {
  registry.registerContract(action.contract);
  registry.registerImplementation(action);
}

const exposed = { sample: { submit: submitContract } };
type SampleRouter = ContractRouterFor<typeof exposed>;

let kit: TestKit;
let pipeline: ActionPipelineDeps;
let rpcHandler: RPCHandler<TransportInvocationContext>;

function contextFromRequest(request: Request): TransportInvocationContext {
  const idempotencyKey = request.headers.get(IDEMPOTENCY_KEY_HEADER);
  const confirmationChallengeId = request.headers.get(
    CONFIRMATION_CHALLENGE_HEADER,
  );
  return {
    requestId: randomUUID(),
    channel: "ui",
    session: { userId: kitIdentities.users.anna },
    companySelector: request.headers.get(COMPANY_SELECTOR_HEADER),
    clientIp: "203.0.113.7",
    ...(idempotencyKey !== null && idempotencyKey !== ""
      ? { idempotencyKey }
      : {}),
    ...(confirmationChallengeId !== null && confirmationChallengeId !== ""
      ? { confirmationChallengeId }
      : {}),
  };
}

beforeAll(async () => {
  kit = await createTestKit();
  pipeline = kit.pipeline;
  const submit = implementAction(submitContract, {
    handler: () => Promise.resolve({ receiptId: randomUUID() }),
    auditTarget: () => ({ type: "sample-receipt", id: randomUUID() }),
  });
  const registry = new ActionRegistry();
  register(registry, submit);
  rpcHandler = new RPCHandler(
    buildServerRouter(exposed, { registry, pipeline }),
    { clientInterceptors: [...wireErrorInterceptors] },
  );
});

afterAll(async () => {
  await kit.db.close();
});

function typedClient() {
  return createContractClient<SampleRouter>({
    baseUrl: "http://contract.test",
    getAccessToken: () => "test-session",
    initialCompanyId: kitIdentities.companies.a,
    fetch: async (request) => {
      const result = await rpcHandler.handle(request, {
        prefix: "/rpc",
        context: contextFromRequest(request),
      });
      return result.matched
        ? result.response
        : new Response(null, { status: 404 });
    },
  });
}

describe("typed client over the pipeline", () => {
  it("missing key on an idempotent mutation → typed VALIDATION error", async () => {
    const { client } = typedClient();
    try {
      await client.sample.submit({ note: "no key supplied" });
      expect.unreachable("missing idempotency key must fail");
    } catch (error) {
      expect(isWireError(error)).toBe(true);
      if (!isWireError(error) || error.code !== "VALIDATION") {
        expect.unreachable("expected VALIDATION");
        return;
      }
      expect(error.status).toBe(400);
      expect(
        error.data.issues.some((issue) =>
          issue.path.includes("idempotencyKey"),
        ),
      ).toBe(true);
    }
  });

  it("retries of one mutation attempt replay the stored receipt", async () => {
    const { client, createMutationAttempt } = typedClient();
    const attempt = createMutationAttempt();
    const first = await client.sample.submit(
      { note: "replay me" },
      attempt.options,
    );
    const second = await client.sample.submit(
      { note: "replay me" },
      attempt.options,
    );
    expect(second.receiptId).toBe(first.receiptId);
  });
});
