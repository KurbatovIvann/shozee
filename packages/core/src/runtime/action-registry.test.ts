import { assert, describe, expect, it } from "vitest";
import { z } from "zod";

import { defineActionContract } from "../contract/index.js";
import type { ActionContract } from "../contract/index.js";
import { ActionRegistry, ActionRegistryError } from "./action-registry.js";
import { implementAction } from "./implement-action.js";

const input = z.object({ orderId: z.uuid() });
const output = z.object({ ok: z.boolean() });

/**
 * Contracts are compared by object identity in pairing validation, so the
 * helper returns a fresh (but equal) object on every call — exactly what
 * happens when a descriptor is accidentally defined twice.
 */
function ordersGetContract(): ActionContract<typeof input, typeof output> {
  return defineActionContract({
    name: "orders.get",
    description: "Get one order with items.",
    principal: "staff",
    transport: "client",
    input,
    output,
    permissions: ["orders:view"],
    aiExposure: "exposed",
    risk: "read",
    requiresConfirmation: false,
    idempotent: false,
    emits: [],
    atomicCalls: [],
    atomicCallers: [],
    errors: ["NOT_FOUND"],
    audit: false,
    timeout: 5_000,
  });
}

const handler = (): Promise<{ ok: boolean }> => Promise.resolve({ ok: true });

function expectRegistryError(run: () => void): ActionRegistryError {
  try {
    run();
  } catch (error) {
    if (error instanceof ActionRegistryError) {
      return error;
    }
    throw error;
  }
  return assert.fail("expected an ActionRegistryError");
}

describe("ActionRegistry — registration", () => {
  it("registers a contract and its implementation, then retrieves both", () => {
    const registry = new ActionRegistry();
    const contract = ordersGetContract();
    const implementation = implementAction(contract, { handler });

    registry.registerContract(contract);
    registry.registerImplementation(implementation);

    expect(registry.getContract("orders.get")).toBe(contract);
    expect(registry.getImplementation("orders.get")).toBe(implementation);
    expect(registry.contracts()).toHaveLength(1);
    expect(registry.implementations()).toHaveLength(1);
  });

  it("returns undefined for an unknown action name", () => {
    const registry = new ActionRegistry();
    expect(registry.getContract("orders.get")).toBeUndefined();
    expect(registry.getImplementation("orders.get")).toBeUndefined();
  });

  it("rejects a duplicate contract name", () => {
    const registry = new ActionRegistry();
    registry.registerContract(ordersGetContract());
    const error = expectRegistryError(() => {
      registry.registerContract(ordersGetContract());
    });
    expect(error.problems[0]).toContain('duplicate contract "orders.get"');
  });

  it("rejects a duplicate implementation name", () => {
    const registry = new ActionRegistry();
    registry.registerImplementation(
      implementAction(ordersGetContract(), { handler }),
    );
    const error = expectRegistryError(() => {
      registry.registerImplementation(
        implementAction(ordersGetContract(), { handler }),
      );
    });
    expect(error.problems[0]).toContain(
      'duplicate implementation "orders.get"',
    );
  });
});

describe("ActionRegistry — boot-time pairing validation (ADR-0016)", () => {
  it("passes when every contract pairs with its implementation", () => {
    const registry = new ActionRegistry();
    const contract = ordersGetContract();
    registry.registerContract(contract);
    registry.registerImplementation(implementAction(contract, { handler }));
    expect(() => {
      registry.assertPaired();
    }).not.toThrow();
  });

  it("fails boot on a contract without an implementation", () => {
    const registry = new ActionRegistry();
    registry.registerContract(ordersGetContract());
    const error = expectRegistryError(() => {
      registry.assertPaired();
    });
    expect(error.problems[0]).toContain(
      'contract "orders.get" has no registered implementation',
    );
  });

  it("fails boot on an implementation without a contract", () => {
    const registry = new ActionRegistry();
    registry.registerImplementation(
      implementAction(ordersGetContract(), { handler }),
    );
    const error = expectRegistryError(() => {
      registry.assertPaired();
    });
    expect(error.problems[0]).toContain(
      'implementation "orders.get" has no registered contract',
    );
  });

  it("fails boot when descriptor and implementation are different objects", () => {
    const registry = new ActionRegistry();
    registry.registerContract(ordersGetContract());
    // Same name, second defineActionContract call — a drift bug where the
    // server file defines its own copy instead of importing the descriptor.
    registry.registerImplementation(
      implementAction(ordersGetContract(), { handler }),
    );
    const error = expectRegistryError(() => {
      registry.assertPaired();
    });
    expect(error.problems[0]).toContain(
      'implementation of "orders.get" is bound to a different contract object',
    );
  });

  it("lists every pairing problem at once", () => {
    const registry = new ActionRegistry();
    registry.registerContract(ordersGetContract());
    const orphanImplementation = implementAction(
      defineActionContract({
        ...ordersGetContract(),
        name: "orders.list",
        errors: ["VALIDATION"],
      }),
      { handler },
    );
    registry.registerImplementation(orphanImplementation);
    const error = expectRegistryError(() => {
      registry.assertPaired();
    });
    expect(error.problems).toHaveLength(2);
  });
});
