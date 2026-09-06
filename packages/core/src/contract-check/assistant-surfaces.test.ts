/**
 * SHO-471: assistant surface action/tool bindings must resolve against
 * `deriveAiToolSources` and the staff-assistant toolset. Live registry
 * regression lives in `apps/api` composition (no hardcoded surface list).
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type {
  ActionContract,
  ActionContractDefinition,
} from "../contract/index.js";
import { defineActionContract } from "../contract/index.js";
import { ActionRegistry } from "../runtime/action-registry.js";
import { implementAction } from "../runtime/implement-action.js";
import type { AssistantSurfaceBindingRef } from "./assistant-surfaces.js";
import type { ContractCheckInput } from "./contract-check.js";
import { runContractCheck } from "./contract-check.js";
import { type SuiteCoverageManifest } from "./suite-coverage.js";
import { moduleOf } from "./call-rules.js";

const io = z.object({});

function fixtureContract(
  overrides: Partial<ActionContractDefinition> & { name: string },
): ActionContract {
  return defineActionContract({
    description: "Contract-check fixture action.",
    principal: "staff",
    transport: "client",
    input: io,
    output: io,
    permissions: ["fixture:view"],
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
    ...overrides,
  });
}

function fixtureImplementation(contract: ActionContract) {
  return implementAction(contract, {
    handler: () => Promise.resolve({}),
    ...(contract.requiresConfirmation
      ? { confirmationSummary: () => "fixture summary" }
      : {}),
    ...(contract.audit
      ? { auditTarget: () => ({ type: "fixture", id: "1" }) }
      : {}),
  });
}

function buildRegistry(...contracts: readonly ActionContract[]) {
  const registry = new ActionRegistry();
  for (const contract of contracts) {
    registry.registerContract(contract);
    registry.registerImplementation(fixtureImplementation(contract));
  }
  return registry;
}

function coverageFor(
  registry: ActionRegistry,
  rest: Pick<ContractCheckInput, "subscriptions">,
): SuiteCoverageManifest {
  const contracts = registry.contracts();
  const subscriptionActions = new Set(
    rest.subscriptions.map((subscription) => subscription.action),
  );
  const eventModules = new Set<string>();
  for (const contract of contracts) {
    if (contract.emits.length > 0) {
      eventModules.add(moduleOf(contract.name));
    }
  }
  for (const subscription of rest.subscriptions) {
    eventModules.add(moduleOf(subscription.action));
  }
  return {
    isolation: contracts.map((contract) => contract.name),
    publicProjection: contracts
      .filter(
        (contract) =>
          contract.principal === "public" &&
          contract.publicScope === "globalProjection",
      )
      .map((contract) => contract.name),
    consumerIsolation: contracts
      .filter((contract) => contract.principal === "consumer")
      .map((contract) => contract.name),
    accountIsolation: contracts
      .filter((contract) => contract.principal === "account")
      .map((contract) => contract.name),
    shareIsolation: contracts
      .filter((contract) => contract.principal === "share")
      .map((contract) => contract.name),
    idempotency: contracts
      .filter(
        (contract) =>
          contract.idempotent &&
          contract.risk !== "read" &&
          !subscriptionActions.has(contract.name),
      )
      .map((contract) => contract.name),
    events: [...eventModules],
    atomic: contracts.flatMap((contract) =>
      contract.atomicCalls.map((callee) => ({
        caller: contract.name,
        callee,
      })),
    ),
  };
}

function checkInput(
  registry: ActionRegistry,
  overrides: Partial<Omit<ContractCheckInput, "registry">> = {},
): ContractCheckInput {
  const rest = {
    events: [],
    subscriptions: [],
    callEdges: [],
    projectionGrants: new Set<string>(),
    readModelGrants: [],
    schemaImports: [],
    schemaTables: [],
    assistantSurfaces: [],
    assistantFacadeToolNames: [],
    ...overrides,
  };
  return {
    registry,
    ...rest,
    suiteCoverage: overrides.suiteCoverage ?? coverageFor(registry, rest),
  };
}

function surface(
  overrides: Partial<AssistantSurfaceBindingRef> & { kind: string },
): AssistantSurfaceBindingRef {
  return {
    actionNames: [],
    toolNames: [],
    ...overrides,
  };
}

const EXPOSED_GET = fixtureContract({
  name: "orders.get",
  aiExposure: "exposed",
});

describe("contract check — assistant surface bindings (SHO-471)", () => {
  it("fails when a surface binds a non-existent action and names the kind, string, and nearest real name", () => {
    const registry = buildRegistry(EXPOSED_GET);
    const problems = runContractCheck(
      checkInput(registry, {
        assistantSurfaces: [
          surface({
            kind: "order-entity",
            actionNames: ["orders.gett"],
            toolNames: ["orders_get"],
          }),
        ],
      }),
    ).problems;
    expect(problems).toEqual([
      'assistant surface "order-entity": action "orders.gett" is not registered (nearest: "orders.get")',
    ]);
  });

  it("fails when a surface binds an action that exists but is aiExposure: internal", () => {
    const registry = buildRegistry(
      fixtureContract({
        name: "orders.archive",
        aiExposure: "internal",
        risk: "write",
        idempotent: true,
        audit: true,
      }),
      EXPOSED_GET,
    );
    const problems = runContractCheck(
      checkInput(registry, {
        assistantSurfaces: [
          surface({
            kind: "order-entity",
            actionNames: ["orders.archive"],
            toolNames: ["orders_get"],
          }),
        ],
      }),
    ).problems;
    expect(problems).toEqual([
      'assistant surface "order-entity": action "orders.archive" is not an AI-exposed contract (aiExposure: "internal"; nearest: "orders.get")',
    ]);
  });

  it("fails when a surface binds an unknown tool name and suggests the nearest façade", () => {
    const registry = buildRegistry(
      fixtureContract({
        name: "orders.list",
        aiExposure: "exposed",
      }),
    );
    const problems = runContractCheck(
      checkInput(registry, {
        assistantSurfaces: [
          surface({
            kind: "orders-list",
            actionNames: ["orders.list"],
            toolNames: ["orders_list_pag"],
          }),
        ],
        assistantFacadeToolNames: ["orders_list_page"],
      }),
    ).problems;
    expect(problems).toEqual([
      'assistant surface "orders-list": tool "orders_list_pag" does not resolve to a provider name of an exposed action, an exposed action name, or a registered façade (nearest: "orders_list_page")',
    ]);
  });

  it("passes when a surface binds a registered façade tool name", () => {
    const registry = buildRegistry(
      fixtureContract({
        name: "orders.list",
        aiExposure: "exposed",
      }),
    );
    const result = runContractCheck(
      checkInput(registry, {
        assistantSurfaces: [
          surface({
            kind: "orders-list",
            actionNames: ["orders.list"],
            toolNames: ["orders_list_page"],
          }),
        ],
        assistantFacadeToolNames: ["orders_list_page"],
      }),
    );
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("passes when a surface binds the provider name and registry name of an exposed action", () => {
    const registry = buildRegistry(EXPOSED_GET);
    const result = runContractCheck(
      checkInput(registry, {
        assistantSurfaces: [
          surface({
            kind: "order-entity",
            actionNames: ["orders.get"],
            toolNames: ["orders.get", "orders_get"],
          }),
        ],
      }),
    );
    expect(result.problems).toEqual([]);
  });

  it("does not invent a hardcoded surface list — empty catalog is an explicit no-op", () => {
    const result = runContractCheck(checkInput(buildRegistry(EXPOSED_GET)));
    expect(result.problems).toEqual([]);
  });
});
