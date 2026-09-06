import { isContractProcedure } from "@orpc/contract";
import { defineActionContract } from "@showzy/core/contract";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  buildContractRouter,
  ContractCompositionError,
} from "./contract-router.js";

const readDefaults = {
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
};

const listThings = defineActionContract({
  ...readDefaults,
  name: "sample.listThings",
  description: "List sample things for the active company.",
  principal: "staff",
  transport: "client",
  input: z.object({ limit: z.number().int().min(1) }),
  output: z.object({ items: z.array(z.string()) }),
  permissions: ["sample:view"],
});

const getShared = defineActionContract({
  ...readDefaults,
  name: "sample.getShared",
  description: "Anonymous share-token read of one document.",
  principal: "share",
  transport: "client",
  input: z.object({ token: z.string().min(1), documentId: z.uuid() }),
  output: z.object({ companyId: z.string() }),
  permissions: [],
});

const internalJob = defineActionContract({
  ...readDefaults,
  name: "sample.internalJob",
  description: "Internal system job — never routable.",
  principal: "system",
  transport: "internal",
  systemScope: "tenant",
  input: z.object({}),
  output: z.object({ done: z.boolean() }),
  permissions: [],
});

describe("buildContractRouter", () => {
  it("builds one contract procedure per client descriptor", () => {
    const router = buildContractRouter({ sample: { listThings } });
    expect(isContractProcedure(router.sample.listThings)).toBe(true);
  });

  it("mounts share-principal actions — transport: client is routable (ADR-0022)", () => {
    const router = buildContractRouter({ sample: { getShared } });
    expect(isContractProcedure(router.sample.getShared)).toBe(true);
  });

  it("rejects non-client transports — internal/system actions have no routable endpoint", () => {
    expect(() => buildContractRouter({ sample: { internalJob } })).toThrow(
      ContractCompositionError,
    );
    expect(() => buildContractRouter({ sample: { internalJob } })).toThrow(
      /transport "internal"/,
    );
  });

  // When the first ctx.callAtomic edge is registered in composition, add a
  // fixture proving that callee is absent from contractRouter / OpenAPI /
  // AI artifacts (contract.md §7, fnd-G1 A12). Do not invent a fake module
  // before then — enforcement above already rejects transport: internal.

  it("rejects record keys that do not mirror the action name", () => {
    expect(() =>
      buildContractRouter({ sample: { things: listThings } }),
    ).toThrow(/bound to descriptor "sample.listThings"/);
    expect(() => buildContractRouter({ catalog: { listThings } })).toThrow(
      /catalog.listThings/,
    );
  });

  it("collects every problem instead of stopping at the first", () => {
    try {
      buildContractRouter({
        sample: { internalJob, wrongKey: listThings },
      });
      expect.unreachable("composition must fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ContractCompositionError);
      expect((error as ContractCompositionError).problems).toHaveLength(2);
    }
  });
});
