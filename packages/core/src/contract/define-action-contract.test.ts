import { assert, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ActionContractDefinitionError,
  defineActionContract,
} from "./define-action-contract.js";
import type { ActionContractDefinition } from "./types.js";

/**
 * A representative valid staff write action. Tests derive invalid variants
 * by overriding single fields — the input type is intentionally permissive
 * about cross-field combinations (see types.ts), so no type suppressions
 * are needed to exercise the runtime rejections.
 */
function staffWriteDefinition(): ActionContractDefinition {
  return {
    name: "orders.create",
    description: "Create a new order for a company customer.",
    principal: "staff",
    transport: "client",
    input: z.object({ customerId: z.uuid() }),
    output: z.object({ orderId: z.uuid() }),
    permissions: ["orders:create"],
    aiExposure: "exposed",
    risk: "write",
    requiresConfirmation: false,
    idempotent: true,
    emits: ["orders.created"],
    atomicCalls: [],
    atomicCallers: [],
    errors: ["VALIDATION", "NOT_FOUND", "CONFLICT"],
    audit: true,
    timeout: 10_000,
  };
}

/** Runs the definition and returns the expected define-time error. */
function defineExpectingError(
  definition: ActionContractDefinition,
): ActionContractDefinitionError {
  try {
    defineActionContract(definition);
  } catch (error) {
    if (error instanceof ActionContractDefinitionError) {
      return error;
    }
    throw error;
  }
  return assert.fail("expected the definition to be rejected at define time");
}

function expectProblem(
  definition: ActionContractDefinition,
  problemFragment: string,
): void {
  const error = defineExpectingError(definition);
  expect(
    error.problems.some((problem) => problem.includes(problemFragment)),
    `expected a problem containing "${problemFragment}", got:\n${error.problems.join("\n")}`,
  ).toBe(true);
}

describe("defineActionContract — valid descriptors per principal mode", () => {
  it("accepts a staff write action and freezes it", () => {
    const contract = defineActionContract(staffWriteDefinition());
    expect(contract.name).toBe("orders.create");
    expect(contract.emits).toEqual(["orders.created"]);
    expect(Object.isFrozen(contract)).toBe(true);
  });

  it("accepts a staff read action", () => {
    const contract = defineActionContract({
      ...staffWriteDefinition(),
      name: "pricing.resolveProductPrices",
      errors: ["VALIDATION", "NOT_FOUND"],
      permissions: ["pricing:view"],
      risk: "read",
      idempotent: false,
      emits: [],
      audit: false,
    });
    expect(contract.risk).toBe("read");
  });

  it("accepts a staff high-risk action with confirmation", () => {
    const contract = defineActionContract({
      ...staffWriteDefinition(),
      name: "featureFlags.setOverride",
      permissions: ["featureFlags:manage"],
      risk: "high",
      requiresConfirmation: true,
      emits: ["featureFlags.overrideChanged"],
    });
    expect(contract.requiresConfirmation).toBe(true);
  });

  it("accepts a customer read action", () => {
    const contract = defineActionContract({
      ...staffWriteDefinition(),
      name: "payments.getOwn",
      principal: "customer",
      permissions: [],
      risk: "read",
      idempotent: false,
      emits: [],
      audit: false,
    });
    expect(contract.principal).toBe("customer");
  });

  it("accepts a public target action", () => {
    const contract = defineActionContract({
      ...staffWriteDefinition(),
      name: "companies.getPublicProfile",
      principal: "public",
      publicScope: "target",
      permissions: [],
      aiExposure: "internal",
      risk: "read",
      idempotent: false,
      emits: [],
      audit: false,
    });
    expect(contract.publicScope).toBe("target");
  });

  it("accepts a public global-projection action with a grant", () => {
    const contract = defineActionContract({
      ...staffWriteDefinition(),
      name: "search.browsePublishedCompanies",
      principal: "public",
      publicScope: "globalProjection",
      projectionGrant: "search.publishedCompanies",
      permissions: [],
      aiExposure: "internal",
      risk: "read",
      idempotent: false,
      emits: [],
      audit: false,
    });
    expect(contract.projectionGrant).toBe("search.publishedCompanies");
  });

  it("accepts a system tenant-scoped internal action", () => {
    const contract = defineActionContract({
      ...staffWriteDefinition(),
      name: "chat.upsertOrderCard",
      errors: ["NOT_FOUND"],
      principal: "system",
      transport: "internal",
      systemScope: "tenant",
      permissions: [],
      aiExposure: "internal",
      emits: [],
      timeout: 5_000,
    });
    expect(contract.systemScope).toBe("tenant");
  });

  it("accepts a consumer read action", () => {
    const contract = defineActionContract({
      ...staffWriteDefinition(),
      name: "search.listFollowedCompanies",
      principal: "consumer",
      permissions: [],
      risk: "read",
      idempotent: false,
      emits: [],
      audit: false,
    });
    expect(contract.principal).toBe("consumer");
  });

  it("accepts an account write action that emits its module's event", () => {
    const contract = defineActionContract({
      ...staffWriteDefinition(),
      name: "companies.create",
      errors: ["VALIDATION", "CONFLICT"],
      principal: "account",
      permissions: [],
      emits: ["companies.created"],
    });
    expect(contract.principal).toBe("account");
  });

  it("accepts a share read action", () => {
    const contract = defineActionContract({
      ...staffWriteDefinition(),
      name: "docSigning.getShared",
      principal: "share",
      permissions: [],
      aiExposure: "internal",
      risk: "read",
      idempotent: false,
      emits: [],
      audit: false,
    });
    expect(contract.principal).toBe("share");
    expect(contract.risk).toBe("read");
  });

  it("accepts a share write action", () => {
    const contract = defineActionContract({
      ...staffWriteDefinition(),
      name: "docSigning.submitShare",
      principal: "share",
      permissions: [],
      aiExposure: "internal",
      emits: ["docSigning.shareSubmitted"],
    });
    expect(contract.principal).toBe("share");
    expect(contract.idempotent).toBe(true);
    expect(contract.audit).toBe(true);
  });

  it("accepts a declared atomic root/callee pair (per-descriptor half)", () => {
    const root = defineActionContract({
      ...staffWriteDefinition(),
      name: "orders.confirm",
      errors: ["VALIDATION", "NOT_FOUND", "CONFLICT"],
      permissions: ["orders:confirm"],
      atomicCalls: ["catalog.decrementStockForOrder"],
      emits: ["orders.confirmed"],
    });
    const callee = defineActionContract({
      ...staffWriteDefinition(),
      name: "catalog.decrementStockForOrder",
      transport: "internal",
      aiExposure: "internal",
      permissions: ["catalog:manageStock"],
      atomicCallers: ["orders.confirm"],
      errors: [],
      emits: ["catalog.stockAdjusted"],
    });
    expect(root.atomicCalls).toEqual(["catalog.decrementStockForOrder"]);
    expect(callee.atomicCallers).toEqual(["orders.confirm"]);
  });

  it("accepts a rate-limit override", () => {
    const contract = defineActionContract({
      ...staffWriteDefinition(),
      rateLimit: { limit: 10, windowSec: 60, scope: "user" },
    });
    expect(contract.rateLimit).toEqual({
      limit: 10,
      windowSec: 60,
      scope: "user",
    });
  });
});

describe("defineActionContract — define-time rejections", () => {
  it("rejects a name that is not <module>.<verb>", () => {
    expectProblem(
      { ...staffWriteDefinition(), name: "orders" },
      'must be "<module>.<verb>"',
    );
    expectProblem(
      { ...staffWriteDefinition(), name: "orders.Create" },
      'must be "<module>.<verb>"',
    );
    expectProblem(
      { ...staffWriteDefinition(), name: "orders.create.now" },
      'must be "<module>.<verb>"',
    );
  });

  it("rejects an empty description", () => {
    expectProblem(
      { ...staffWriteDefinition(), description: "   " },
      "description must be a non-empty",
    );
  });

  it("rejects an input that is not a Zod schema", () => {
    // Forged at the JS boundary; the type system cannot represent this.
    const notASchema = {} as z.ZodType;
    expectProblem(
      { ...staffWriteDefinition(), input: notASchema },
      "input must be a Zod v4 schema",
    );
  });

  it("rejects a staff action without permissions", () => {
    expectProblem(
      { ...staffWriteDefinition(), permissions: [] },
      "staff actions must declare at least one permission",
    );
  });

  it("rejects permissions on non-staff principals", () => {
    expectProblem(
      {
        ...staffWriteDefinition(),
        principal: "customer",
        permissions: ["orders:create"],
      },
      "customer actions must declare permissions: []",
    );
    expectProblem(
      {
        ...staffWriteDefinition(),
        name: "chat.upsertOrderCard",
        errors: ["NOT_FOUND"],
        principal: "system",
        transport: "internal",
        systemScope: "tenant",
        aiExposure: "internal",
        permissions: ["chat:manage"],
        emits: [],
      },
      "system actions must declare permissions: []",
    );
  });

  it("rejects malformed and duplicate permissions", () => {
    expectProblem(
      { ...staffWriteDefinition(), permissions: ["orders.create"] },
      'must be "<module>:<verb>"',
    );
    expectProblem(
      {
        ...staffWriteDefinition(),
        permissions: ["orders:create", "orders:create"],
      },
      "permissions must not contain duplicates",
    );
  });

  it("rejects a system action on client transport", () => {
    expectProblem(
      {
        ...staffWriteDefinition(),
        principal: "system",
        systemScope: "tenant",
        permissions: [],
        emits: [],
      },
      'system actions must declare transport: "internal"',
    );
  });

  it("rejects public/consumer/account actions on internal transport", () => {
    const readOnlyBase = {
      ...staffWriteDefinition(),
      transport: "internal",
      aiExposure: "internal",
      permissions: [],
      risk: "read",
      idempotent: false,
      emits: [],
      audit: false,
    } as const;
    expectProblem(
      { ...readOnlyBase, principal: "public", publicScope: "target" },
      'public actions must declare transport: "client"',
    );
    expectProblem(
      { ...readOnlyBase, principal: "consumer" },
      'consumer actions must declare transport: "client"',
    );
    expectProblem(
      { ...readOnlyBase, principal: "account" },
      'account actions must declare transport: "client"',
    );
    expectProblem(
      { ...readOnlyBase, principal: "share" },
      'share actions must declare transport: "client"',
    );
  });

  it("rejects a public action without publicScope", () => {
    expectProblem(
      {
        ...staffWriteDefinition(),
        principal: "public",
        permissions: [],
        risk: "read",
        idempotent: false,
        emits: [],
        audit: false,
      },
      "public actions must declare publicScope",
    );
  });

  it("rejects publicScope on a non-public action", () => {
    expectProblem(
      { ...staffWriteDefinition(), publicScope: "target" },
      "publicScope is allowed only on public actions",
    );
  });

  it("rejects every share-subset violation (ADR-0022)", () => {
    const shareWrite = {
      ...staffWriteDefinition(),
      name: "docSigning.submitShare",
      principal: "share" as const,
      permissions: [] as string[],
      aiExposure: "internal" as const,
      emits: ["docSigning.shareSubmitted"],
    };
    expectProblem(
      { ...shareWrite, aiExposure: "exposed" },
      'share actions must declare aiExposure: "internal"',
    );
    expectProblem(
      {
        ...shareWrite,
        risk: "high",
        requiresConfirmation: true,
      },
      'share actions must declare risk: "read" | "write"',
    );
    expectProblem(
      {
        ...shareWrite,
        risk: "draft",
        idempotent: false,
        audit: false,
        emits: [],
      },
      'share actions must declare risk: "read" | "write"',
    );
    expectProblem(
      {
        ...shareWrite,
        risk: "high",
        requiresConfirmation: true,
      },
      "share actions must declare requiresConfirmation: false",
    );
    expectProblem(
      { ...shareWrite, idempotent: false },
      "share writes must declare idempotent: true",
    );
    expectProblem(
      { ...shareWrite, permissions: ["docSigning:submit"] },
      "share actions must declare permissions: []",
    );
    expectProblem(
      { ...shareWrite, publicScope: "target" },
      "publicScope is allowed only on public actions",
    );
  });

  it("rejects a global-projection action without a grant", () => {
    expectProblem(
      {
        ...staffWriteDefinition(),
        principal: "public",
        publicScope: "globalProjection",
        permissions: [],
        risk: "read",
        idempotent: false,
        emits: [],
        audit: false,
      },
      "requires a projectionGrant",
    );
  });

  it("rejects a projectionGrant outside globalProjection scope", () => {
    expectProblem(
      {
        ...staffWriteDefinition(),
        principal: "public",
        publicScope: "target",
        projectionGrant: "search.publishedCompanies",
        permissions: [],
        risk: "read",
        idempotent: false,
        emits: [],
        audit: false,
      },
      'projectionGrant is allowed only with publicScope: "globalProjection"',
    );
    expectProblem(
      {
        ...staffWriteDefinition(),
        projectionGrant: "search.publishedCompanies",
      },
      'projectionGrant is allowed only with publicScope: "globalProjection"',
    );
  });

  it("rejects a system action without systemScope, and systemScope elsewhere", () => {
    expectProblem(
      {
        ...staffWriteDefinition(),
        principal: "system",
        transport: "internal",
        aiExposure: "internal",
        permissions: [],
        emits: [],
      },
      "system actions must declare systemScope",
    );
    expectProblem(
      { ...staffWriteDefinition(), systemScope: "tenant" },
      "systemScope is allowed only on system actions",
    );
  });

  it("rejects AI exposure on internal transport", () => {
    expectProblem(
      {
        ...staffWriteDefinition(),
        transport: "internal",
        aiExposure: "exposed",
      },
      'aiExposure "exposed" requires transport "client"',
    );
  });

  it("rejects mutation metadata on public and consumer actions", () => {
    const publicBase = {
      ...staffWriteDefinition(),
      principal: "public",
      publicScope: "target",
      permissions: [],
      aiExposure: "internal",
      risk: "read",
      idempotent: false,
      emits: [],
      audit: false,
    } as const;
    expectProblem(
      { ...publicBase, risk: "write", audit: true },
      'public actions are read-only and must declare risk: "read"',
    );
    expectProblem(
      { ...publicBase, audit: true },
      "public actions must declare audit: false",
    );
    expectProblem(
      { ...publicBase, idempotent: true },
      "public actions must declare idempotent: false",
    );
    expectProblem(
      { ...publicBase, emits: ["companies.published"] },
      "public actions must not emit events",
    );

    expectProblem(
      {
        ...staffWriteDefinition(),
        principal: "consumer",
        permissions: [],
        aiExposure: "internal",
        risk: "read",
        idempotent: true,
        emits: [],
        audit: false,
      },
      "consumer actions must declare idempotent: false",
    );
  });

  it("rejects confirmation on a non-human principal", () => {
    expectProblem(
      {
        ...staffWriteDefinition(),
        principal: "system",
        transport: "internal",
        systemScope: "tenant",
        aiExposure: "internal",
        permissions: [],
        emits: [],
        risk: "high",
        requiresConfirmation: true,
      },
      "requiresConfirmation applies to human principals",
    );
  });

  it("rejects confirmation without risk: high or without idempotency", () => {
    expectProblem(
      { ...staffWriteDefinition(), requiresConfirmation: true },
      'requiresConfirmation requires risk: "high"',
    );
    expectProblem(
      {
        ...staffWriteDefinition(),
        risk: "high",
        requiresConfirmation: true,
        idempotent: false,
      },
      "requiresConfirmation requires idempotent: true",
    );
  });

  it("rejects a human high-risk action without confirmation", () => {
    expectProblem(
      { ...staffWriteDefinition(), risk: "high" },
      'human-invoked risk: "high" actions must declare requiresConfirmation: true',
    );
  });

  it("rejects write/high risk without audit", () => {
    expectProblem(
      { ...staffWriteDefinition(), audit: false },
      'risk "write" and "high" actions must declare audit: true',
    );
  });

  it("rejects malformed, foreign-module, and duplicate event names", () => {
    expectProblem(
      { ...staffWriteDefinition(), emits: ["orders.Created"] },
      'must be named "<module>.<pastVerb>"',
    );
    expectProblem(
      { ...staffWriteDefinition(), emits: ["chat.orderCardUpserted"] },
      'must belong to this action\'s module "orders"',
    );
    expectProblem(
      {
        ...staffWriteDefinition(),
        emits: ["orders.created", "orders.created"],
      },
      "emits must not contain duplicates",
    );
  });

  it("rejects invalid atomic-edge declarations", () => {
    expectProblem(
      { ...staffWriteDefinition(), atomicCalls: ["not a name"] },
      'atomicCalls entry "not a name" must be an action name',
    );
    expectProblem(
      { ...staffWriteDefinition(), atomicCalls: ["orders.create"] },
      "atomicCalls must not reference the action itself",
    );
    expectProblem(
      {
        ...staffWriteDefinition(),
        atomicCalls: ["catalog.decrementStockForOrder"],
        atomicCallers: ["orders.confirm"],
        errors: [],
      },
      "cannot be both an atomic root and an atomic callee",
    );
  });

  it("rejects an atomic root that is read-only or not idempotent", () => {
    expectProblem(
      {
        ...staffWriteDefinition(),
        risk: "read",
        audit: false,
        idempotent: true,
        atomicCalls: ["catalog.decrementStockForOrder"],
      },
      "atomic root actions must be writable",
    );
    expectProblem(
      {
        ...staffWriteDefinition(),
        idempotent: false,
        atomicCalls: ["catalog.decrementStockForOrder"],
      },
      "atomic root actions must declare idempotent: true",
    );
  });

  it("rejects an atomic callee that is client-routed, non-write, or confirmed", () => {
    const callee = {
      ...staffWriteDefinition(),
      name: "catalog.decrementStockForOrder",
      transport: "internal",
      aiExposure: "internal",
      permissions: ["catalog:manageStock"],
      atomicCallers: ["orders.confirm"],
      errors: [],
      emits: [],
    } as const;
    expectProblem(
      { ...callee, transport: "client" },
      'atomic callees must declare transport: "internal"',
    );
    expectProblem(
      { ...callee, risk: "draft" },
      'atomic callees must declare risk: "write"',
    );
    expectProblem(
      { ...callee, risk: "high", requiresConfirmation: true },
      "atomic callees cannot require confirmation",
    );
  });

  it("rejects a non-positive or fractional timeout", () => {
    expectProblem(
      { ...staffWriteDefinition(), timeout: 0 },
      "timeout must be a positive integer",
    );
    expectProblem(
      { ...staffWriteDefinition(), timeout: 10.5 },
      "timeout must be a positive integer",
    );
  });

  it("rejects an invalid rate-limit override", () => {
    expectProblem(
      {
        ...staffWriteDefinition(),
        rateLimit: { limit: 0, windowSec: 60, scope: "user" },
      },
      "rateLimit.limit must be a positive integer",
    );
    expectProblem(
      {
        ...staffWriteDefinition(),
        rateLimit: { limit: 10, windowSec: -1, scope: "user" },
      },
      "rateLimit.windowSec must be a positive integer",
    );
  });

  it("rejects INTERNAL and each pipeline-only code on errors", () => {
    expectProblem(
      { ...staffWriteDefinition(), errors: ["INTERNAL"] },
      'errors must not include "INTERNAL": INTERNAL is a bug signal, not a contract',
    );
    expectProblem(
      { ...staffWriteDefinition(), errors: ["PERMISSION_DENIED"] },
      'errors must not include "PERMISSION_DENIED": PERMISSION_DENIED is pipeline-level and universal',
    );
    expectProblem(
      { ...staffWriteDefinition(), errors: ["IDEMPOTENCY_CONFLICT"] },
      'errors must not include "IDEMPOTENCY_CONFLICT": IDEMPOTENCY_CONFLICT is pipeline-level and universal',
    );
    expectProblem(
      { ...staffWriteDefinition(), errors: ["RETRY_IN_PROGRESS"] },
      'errors must not include "RETRY_IN_PROGRESS": RETRY_IN_PROGRESS is pipeline-level and universal',
    );
    expectProblem(
      { ...staffWriteDefinition(), errors: ["CONFIRMATION_REQUIRED"] },
      'errors must not include "CONFIRMATION_REQUIRED": CONFIRMATION_REQUIRED is pipeline-level and universal',
    );
    expectProblem(
      { ...staffWriteDefinition(), errors: ["RATE_LIMITED"] },
      'errors must not include "RATE_LIMITED": RATE_LIMITED is pipeline-level and universal',
    );
    expectProblem(
      { ...staffWriteDefinition(), errors: ["TIMEOUT"] },
      'errors must not include "TIMEOUT": TIMEOUT is pipeline-level and universal',
    );
  });

  it("rejects duplicate and unknown declared error codes", () => {
    expectProblem(
      { ...staffWriteDefinition(), errors: ["NOT_FOUND", "NOT_FOUND"] },
      "errors must not contain duplicates",
    );
    expectProblem(
      { ...staffWriteDefinition(), errors: ["NOT_A_CODE"] },
      'error code "NOT_A_CODE" is not declarable — declared errors are VALIDATION, NOT_FOUND, CONFLICT',
    );
  });

  it("accepts the three declarable codes and an empty list", () => {
    expect(
      defineActionContract({ ...staffWriteDefinition(), errors: [] }).errors,
    ).toEqual([]);
    expect(
      defineActionContract({
        ...staffWriteDefinition(),
        errors: ["VALIDATION", "NOT_FOUND", "CONFLICT"],
      }).errors,
    ).toEqual(["VALIDATION", "NOT_FOUND", "CONFLICT"]);
  });

  it("reports every violation at once with the action name", () => {
    const error = defineExpectingError({
      ...staffWriteDefinition(),
      permissions: [],
      audit: false,
      timeout: 0,
    });
    expect(error.actionName).toBe("orders.create");
    expect(error.problems.length).toBe(3);
    expect(error.message).toContain('Invalid action contract "orders.create"');
    expect(error.message).toContain("timeout must be a positive integer");
  });
});
