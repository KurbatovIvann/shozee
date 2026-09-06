import { defineActionContract } from "@showzy/core/contract";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ContractCompositionError } from "../client/contract-router.js";
import {
  toPipelineRequestMeta,
  toPrincipalInvocation,
  type TransportInvocationContext,
} from "./transport-context.js";

const readDefaults = {
  transport: "client" as const,
  aiExposure: "internal" as const,
  risk: "read" as const,
  requiresConfirmation: false,
  idempotent: false,
  emits: [] as const,
  atomicCalls: [] as const,
  atomicCallers: [] as const,
  errors: [],
  audit: false,
  timeout: 5_000,
  input: z.object({}),
  output: z.object({}),
  permissions: [] as string[],
};

const staffList = defineActionContract({
  ...readDefaults,
  name: "sample.list",
  description: "Staff read.",
  principal: "staff",
  permissions: ["sample:view"],
});

const customerPeek = defineActionContract({
  ...readDefaults,
  name: "sample.customerPeek",
  description: "Customer read of one owned record.",
  principal: "customer",
});

const publicDiscover = defineActionContract({
  ...readDefaults,
  name: "sample.discover",
  description: "Anonymous global discovery.",
  principal: "public",
  publicScope: "globalProjection",
  projectionGrant: "fixture.discovery",
});

const consumerWhoami = defineActionContract({
  ...readDefaults,
  name: "sample.whoami",
  description: "Consumer read.",
  principal: "consumer",
});

const accountMine = defineActionContract({
  ...readDefaults,
  name: "sample.mine",
  description: "Account read.",
  principal: "account",
});

const sharePeek = defineActionContract({
  ...readDefaults,
  name: "sample.getShared",
  description: "Share-token read.",
  principal: "share",
});

const systemJob = defineActionContract({
  ...readDefaults,
  name: "sample.internalJob",
  description: "Internal system job.",
  principal: "system",
  transport: "internal",
  systemScope: "tenant",
});

const context: TransportInvocationContext = {
  requestId: "req-1",
  channel: "ui",
  session: { userId: "user-anna" },
  companySelector: "company-a",
  clientIp: "203.0.113.7",
  idempotencyKey: "idem-1",
  confirmationChallengeId: "chal-1",
};

describe("toPipelineRequestMeta", () => {
  it("starts the correlation chain at the request id and copies protocol meta", () => {
    expect(toPipelineRequestMeta(context)).toEqual({
      requestId: "req-1",
      correlationId: "req-1",
      channel: "ui",
      clientIp: "203.0.113.7",
      idempotencyKey: "idem-1",
      confirmationChallengeId: "chal-1",
    });
  });

  it("omits absent optional fields rather than sending undefined", () => {
    const meta = toPipelineRequestMeta({
      requestId: "req-2",
      channel: "ai",
      session: null,
      companySelector: null,
    });
    expect(meta).toEqual({
      requestId: "req-2",
      correlationId: "req-2",
      channel: "ai",
    });
    expect("clientIp" in meta).toBe(false);
    expect("idempotencyKey" in meta).toBe(false);
    expect("confirmationChallengeId" in meta).toBe(false);
  });
});

describe("toPrincipalInvocation", () => {
  it("staff receives the session and the raw selector — never as authority", () => {
    expect(toPrincipalInvocation(staffList, context)).toEqual({
      mode: "staff",
      session: { userId: "user-anna" },
      companySelector: "company-a",
    });
  });

  it("customer receives only the session; company scope comes from the resolver", () => {
    expect(toPrincipalInvocation(customerPeek, context)).toEqual({
      mode: "customer",
      session: { userId: "user-anna" },
    });
  });

  it("public receives neither session nor selector (ADR-0020)", () => {
    expect(toPrincipalInvocation(publicDiscover, context)).toEqual({
      mode: "public",
    });
  });

  it("consumer and account receive only the session; a present selector grants nothing", () => {
    expect(toPrincipalInvocation(consumerWhoami, context)).toEqual({
      mode: "consumer",
      session: { userId: "user-anna" },
    });
    expect(toPrincipalInvocation(accountMine, context)).toEqual({
      mode: "account",
      session: { userId: "user-anna" },
    });
  });

  it("share receives neither session nor selector even when both are present (ADR-0022)", () => {
    expect(toPrincipalInvocation(sharePeek, context)).toEqual({
      mode: "share",
    });
  });

  it("system is unreachable — a composition bug, not a routable principal", () => {
    expect(() => toPrincipalInvocation(systemJob, context)).toThrow(
      ContractCompositionError,
    );
    expect(() => toPrincipalInvocation(systemJob, context)).toThrow(
      /principal "system"/,
    );
  });
});
