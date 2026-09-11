/**
 * The worker runs assistant turns against the API's action registry, through
 * the approved `@showzy/api/registry` subpath — not a copy it could forget to
 * update (SHO-569). That `buildContractCheckInput` checks the same registry is
 * pinned in `apps/api/src/registry.test.ts`.
 */
import { createActionRegistry } from "@showzy/api/registry";
import { describe, expect, it } from "vitest";

import { workerActionRegistry } from "./assistant.js";

describe("workerActionRegistry", () => {
  it("is the API's registry builder itself (single source)", () => {
    expect(workerActionRegistry).toBe(createActionRegistry);
  });

  it("is paired, and holds the turn protocol and the tools' actions", () => {
    const registry = workerActionRegistry();
    expect(() => {
      registry.assertPaired();
    }).not.toThrow();
    const names = registry.contracts().map((contract) => contract.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "assistant.readTurnForJob",
        "assistant.startTurn",
        "assistant.finishTurn",
        "customers.listCustomers",
      ]),
    );
  });
});
