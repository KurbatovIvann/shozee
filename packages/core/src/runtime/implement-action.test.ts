import { assert, describe, expect, it } from "vitest";
import { z } from "zod";

import { defineActionContract } from "../contract/index.js";
import type { ActionContract } from "../contract/index.js";
import {
  ActionImplementationError,
  implementAction,
} from "./implement-action.js";
import type { ActionServerCallbacks } from "./implement-action.js";

const input = z.object({ orderId: z.uuid() });
const output = z.object({ ok: z.boolean() });

/** A staff write action — requires `auditTarget`, forbids a resolver. */
function staffWriteContract(): ActionContract<typeof input, typeof output> {
  return defineActionContract({
    name: "orders.confirm",
    description: "Confirm a new order.",
    principal: "staff",
    transport: "client",
    input,
    output,
    permissions: ["orders:confirm"],
    aiExposure: "exposed",
    risk: "write",
    requiresConfirmation: false,
    idempotent: true,
    emits: ["orders.confirmed"],
    atomicCalls: [],
    atomicCallers: [],
    errors: ["VALIDATION", "NOT_FOUND", "CONFLICT"],
    audit: true,
    timeout: 10_000,
  });
}

/** A customer read action — requires `resolveTarget`, forbids audit fns. */
function customerReadContract(): ActionContract<typeof input, typeof output> {
  return defineActionContract({
    name: "payments.getOwn",
    description: "Get the customer's own payment.",
    principal: "customer",
    transport: "client",
    input,
    output,
    permissions: [],
    aiExposure: "internal",
    risk: "read",
    requiresConfirmation: false,
    idempotent: false,
    emits: [],
    atomicCalls: [],
    atomicCallers: [],
    errors: [],
    audit: false,
    timeout: 5_000,
  });
}

const handler = (): Promise<{ ok: boolean }> => Promise.resolve({ ok: true });
const auditTarget = (): { type: string; id: string } => ({
  type: "order",
  id: "order-1",
});
const resolveTarget = (): Promise<{
  companyId: string;
  resource: { paymentId: string };
}> =>
  Promise.resolve({
    companyId: "company-1",
    resource: { paymentId: "payment-1" },
  });

/** Runs the binding and returns the expected implement-time error. */
function implementExpectingError(
  contract: ActionContract<typeof input, typeof output>,
  callbacks: ActionServerCallbacks<
    typeof input,
    typeof output,
    { paymentId: string }
  >,
): ActionImplementationError {
  try {
    implementAction(contract, callbacks);
  } catch (error) {
    if (error instanceof ActionImplementationError) {
      return error;
    }
    throw error;
  }
  return assert.fail("expected the binding to be rejected at implement time");
}

function expectProblem(
  contract: ActionContract<typeof input, typeof output>,
  callbacks: ActionServerCallbacks<
    typeof input,
    typeof output,
    { paymentId: string }
  >,
  problemFragment: string,
): void {
  const error = implementExpectingError(contract, callbacks);
  expect(
    error.problems.some((problem) => problem.includes(problemFragment)),
    `expected a problem containing "${problemFragment}", got:\n${error.problems.join("\n")}`,
  ).toBe(true);
}

describe("implementAction — valid bindings", () => {
  it("binds a staff write action with handler and auditTarget", () => {
    const contract = staffWriteContract();
    const action = implementAction(contract, { handler, auditTarget });
    expect(action.contract).toBe(contract);
    expect(action.handler).toBe(handler);
    expect(action.auditTarget).toBe(auditTarget);
    expect(Object.isFrozen(action)).toBe(true);
  });

  it("binds a customer read action with resolveTarget", () => {
    const action = implementAction(customerReadContract(), {
      handler,
      resolveTarget,
    });
    expect(action.resolveTarget).toBe(resolveTarget);
  });

  it("binds a public-target action with resolveTarget", () => {
    const contract = defineActionContract({
      ...customerReadContract(),
      name: "companies.getPublicProfile",
      principal: "public",
      publicScope: "target",
    });
    const action = implementAction(contract, { handler, resolveTarget });
    expect(action.resolveTarget).toBe(resolveTarget);
  });

  it("binds a share read action with resolveTarget", () => {
    const contract = defineActionContract({
      ...customerReadContract(),
      name: "docSigning.getShared",
      principal: "share",
    });
    const action = implementAction(contract, { handler, resolveTarget });
    expect(action.resolveTarget).toBe(resolveTarget);
  });

  it("binds a share write action with resolveTarget, auditTarget, and auditSnapshot", () => {
    const contract = defineActionContract({
      ...staffWriteContract(),
      name: "docSigning.submitShare",
      principal: "share",
      permissions: [],
      aiExposure: "internal",
      emits: ["docSigning.shareSubmitted"],
    });
    const auditSnapshot = () => ({ cn: "Test Signer" });
    const action = implementAction(contract, {
      handler,
      resolveTarget,
      auditTarget,
      auditSnapshot,
    });
    expect(action.resolveTarget).toBe(resolveTarget);
    expect(action.auditSnapshot).toBe(auditSnapshot);
  });

  it("binds a confirmation action with confirmationSummary", () => {
    const contract = defineActionContract({
      ...staffWriteContract(),
      name: "featureFlags.setOverride",
      permissions: ["featureFlags:manage"],
      risk: "high",
      requiresConfirmation: true,
      emits: [],
    });
    const action = implementAction(contract, {
      handler,
      auditTarget,
      confirmationSummary: () => "Override feature flag for one company",
    });
    expect(action.confirmationSummary).toBeDefined();
  });

  it("accepts an optional auditSnapshot on an audited action", () => {
    const action = implementAction(staffWriteContract(), {
      handler,
      auditTarget,
      auditSnapshot: (validated) => ({ orderId: validated.orderId }),
    });
    expect(action.auditSnapshot).toBeDefined();
  });
});

describe("implementAction — binding rejections (core.md §2)", () => {
  it("rejects audit: true without auditTarget", () => {
    expectProblem(staffWriteContract(), { handler }, "must bind auditTarget");
  });

  it("rejects auditTarget on an unaudited action", () => {
    expectProblem(
      customerReadContract(),
      { handler, resolveTarget, auditTarget },
      "auditTarget is allowed only when audit: true",
    );
  });

  it("rejects auditSnapshot on an unaudited action", () => {
    expectProblem(
      customerReadContract(),
      { handler, resolveTarget, auditSnapshot: () => null },
      "auditSnapshot is allowed only when audit: true",
    );
  });

  it("rejects a customer action without resolveTarget", () => {
    expectProblem(
      customerReadContract(),
      { handler },
      "customer actions must bind resolveTarget",
    );
  });

  it("rejects a public-target action without resolveTarget", () => {
    const contract = defineActionContract({
      ...customerReadContract(),
      name: "companies.getPublicProfile",
      principal: "public",
      publicScope: "target",
    });
    expectProblem(contract, { handler }, "must bind resolveTarget");
  });

  it("rejects a share action without resolveTarget", () => {
    const contract = defineActionContract({
      ...customerReadContract(),
      name: "docSigning.getShared",
      principal: "share",
    });
    expectProblem(
      contract,
      { handler },
      "share actions must bind resolveTarget",
    );
  });

  it("rejects a share write without auditSnapshot", () => {
    const contract = defineActionContract({
      ...staffWriteContract(),
      name: "docSigning.submitShare",
      principal: "share",
      permissions: [],
      aiExposure: "internal",
      emits: ["docSigning.shareSubmitted"],
    });
    expectProblem(
      contract,
      { handler, resolveTarget, auditTarget },
      "share writes must bind auditSnapshot",
    );
  });

  it("rejects resolveTarget on a staff action", () => {
    expectProblem(
      staffWriteContract(),
      { handler, auditTarget, resolveTarget },
      "resolveTarget is allowed only on customer, public-target, and share actions",
    );
  });

  it("rejects resolveTarget on a public-global action", () => {
    const contract = defineActionContract({
      ...customerReadContract(),
      name: "discovery.searchCompanies",
      principal: "public",
      publicScope: "globalProjection",
      projectionGrant: "discovery.companies",
    });
    expectProblem(
      contract,
      { handler, resolveTarget },
      "resolveTarget is allowed only on customer, public-target, and share actions",
    );
  });

  it("rejects requiresConfirmation without confirmationSummary", () => {
    const contract = defineActionContract({
      ...staffWriteContract(),
      name: "featureFlags.setOverride",
      permissions: ["featureFlags:manage"],
      risk: "high",
      requiresConfirmation: true,
      emits: [],
    });
    expectProblem(
      contract,
      { handler, auditTarget },
      "must bind confirmationSummary",
    );
  });

  it("rejects confirmationSummary without requiresConfirmation", () => {
    expectProblem(
      staffWriteContract(),
      { handler, auditTarget, confirmationSummary: () => "summary" },
      "confirmationSummary is allowed only when requiresConfirmation: true",
    );
  });

  it("lists every violation at once", () => {
    const error = implementExpectingError(staffWriteContract(), {
      handler,
      resolveTarget,
      confirmationSummary: () => "summary",
    });
    expect(error.problems).toHaveLength(3);
    expect(error.actionName).toBe("orders.confirm");
    expect(error.message).toContain("orders.confirm");
  });
});
