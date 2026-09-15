import { createActionRegistry } from "@showzy/api/registry";
import { describe, expect, it } from "vitest";

import { workerActionRegistry } from "./assistant.js";
import { createWorkerActionRegistry } from "./maintenance.js";

function names(registry: ReturnType<typeof createActionRegistry>): string[] {
  return registry
    .contracts()
    .map((contract) => contract.name)
    .toSorted();
}

describe("workerActionRegistry", () => {
  it("is the worker registry: the API's actions plus the worker-owned ones", () => {
    expect(workerActionRegistry).toBe(createWorkerActionRegistry);
    expect(names(workerActionRegistry())).toEqual(
      [
        ...names(createActionRegistry()),
        "worker.cleanupIdempotencyKeys",
      ].toSorted(),
    );
  });

  it("is paired, and holds the turn protocol and the tools' actions", () => {
    const registry = workerActionRegistry();
    expect(() => {
      registry.assertPaired();
    }).not.toThrow();
    const contractNames = registry.contracts().map((contract) => contract.name);
    expect(contractNames).toEqual(
      expect.arrayContaining([
        "assistant.readTurnForJob",
        "assistant.startTurn",
        "assistant.finishTurn",
        "customers.listCustomers",
      ]),
    );
  });
});
