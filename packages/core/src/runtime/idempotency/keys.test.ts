/**
 * Unit tests for idempotency/confirmation identity keys (core.md §5).
 * Share writes use the stored token hash, never the raw secret.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineActionContract } from "../../contract/define-action-contract.js";
import { CoreInvariantError } from "../../errors/index.js";
import type { PipelineHookEnv } from "../pipeline/types.js";
import {
  principalKeyFor,
  scopeKeyFor,
  type ProtocolIdentityEnv,
} from "./keys.js";

const shareWrite = defineActionContract({
  name: "docSigning.submitShare",
  description: "Share write fixture for principal-key tests.",
  principal: "share",
  transport: "client",
  input: z.object({}),
  output: z.object({}),
  permissions: [],
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
});

const staffWrite = defineActionContract({
  name: "orders.confirm",
  description: "Staff write fixture for principal-key tests.",
  principal: "staff",
  transport: "client",
  input: z.object({}),
  output: z.object({}),
  permissions: ["orders:confirm"],
  aiExposure: "internal",
  risk: "write",
  requiresConfirmation: false,
  idempotent: true,
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: ["VALIDATION", "NOT_FOUND", "CONFLICT"],
  audit: true,
  timeout: 5_000,
});

function hookEnv(
  contract: typeof shareWrite | typeof staffWrite,
  principal: PipelineHookEnv["principal"],
): PipelineHookEnv {
  return {
    contract,
    principal,
    input: {},
    request: {
      action: contract.name,
      requestId: "req-1",
      correlationId: "req-1",
      channel: "ui",
    },
  };
}

describe("principalKeyFor — share", () => {
  it("keys share writes as share:<tokenHash>, never the raw secret", () => {
    const tokenHash = "ab".repeat(32);
    const env: ProtocolIdentityEnv = {
      ...hookEnv(shareWrite, { mode: "share" }),
      authorization: {
        actor: { type: "anonymous", id: "anonymous" },
        companyId: "company-a",
        tokenHash,
      },
    };
    expect(principalKeyFor(env)).toBe(`share:${tokenHash}`);
    expect(principalKeyFor(env)).not.toContain("raw-token");
    expect(scopeKeyFor(env, principalKeyFor(env))).toBe("company:company-a");
  });

  it("treats a missing tokenHash as a composition bug", () => {
    const env: ProtocolIdentityEnv = {
      ...hookEnv(shareWrite, { mode: "share" }),
      authorization: {
        actor: { type: "anonymous", id: "anonymous" },
        companyId: "company-a",
      },
    };
    expect(() => principalKeyFor(env)).toThrow(CoreInvariantError);
  });

  it("still keys staff writes as staff:<userId>", () => {
    const env: ProtocolIdentityEnv = {
      ...hookEnv(staffWrite, {
        mode: "staff",
        session: { userId: "user-anna" },
        companySelector: "company-a",
      }),
      authorization: {
        actor: { type: "user", id: "user-anna" },
        companyId: "company-a",
      },
    };
    expect(principalKeyFor(env)).toBe("staff:user-anna");
  });
});
