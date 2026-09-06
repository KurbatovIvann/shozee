/**
 * Rule-matrix tests for the registry-wide contract check (core.md §2,
 * §13 "test per rule").
 *
 * Scope note: rules checkable from a single descriptor (metadata
 * completeness, principal/transport/AI combinations, read-only principal
 * subsets, confirmation implications, `emits` naming, audit implications)
 * are enforced — and tested per rule — at define time in
 * `define-action-contract.test.ts`; conditional callback binding
 * (`resolveTarget`/`confirmationSummary`/`auditTarget`) at implement time
 * in `implement-action.test.ts`; duplicate names at registration in
 * `action-registry.test.ts`. The CI stage executes those layers by
 * importing the composition manifest, so this file covers exactly the
 * rules that need the whole registry and the event/call/grant manifests.
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
import type { ContractCheckInput } from "./contract-check.js";
import {
  assertContractCheck,
  ContractCheckError,
  runContractCheck,
} from "./contract-check.js";
import { moduleOf } from "./call-rules.js";
import {
  emptySuiteCoverage,
  type SuiteCoverageManifest,
} from "./suite-coverage.js";

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

/** Binds the minimal callbacks the contract's metadata implies. */
function fixtureImplementation(contract: ActionContract) {
  const needsResolver =
    contract.principal === "customer" ||
    contract.principal === "share" ||
    (contract.principal === "public" && contract.publicScope === "target");
  return implementAction(contract, {
    handler: () => Promise.resolve({}),
    ...(needsResolver
      ? {
          resolveTarget: () =>
            Promise.resolve({
              companyId: "company-a",
              resource: {},
              ...(contract.principal === "share"
                ? { tokenHash: "a".repeat(64) }
                : {}),
            }),
        }
      : {}),
    ...(contract.requiresConfirmation
      ? { confirmationSummary: () => "fixture summary" }
      : {}),
    ...(contract.audit
      ? { auditTarget: () => ({ type: "fixture", id: "1" }) }
      : {}),
    ...(contract.principal === "share" && contract.risk === "write"
      ? { auditSnapshot: () => ({ cn: "fixture" }) }
      : {}),
  });
}

/** Registers each contract together with a minimal paired implementation. */
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

function problemsOf(input: ContractCheckInput): readonly string[] {
  return runContractCheck(input).problems;
}

describe("contract check — pairing (ADR-0016)", () => {
  it("reports an orphan descriptor in the collected problems", () => {
    const registry = new ActionRegistry();
    registry.registerContract(fixtureContract({ name: "orders.get" }));
    expect(problemsOf(checkInput(registry))).toEqual([
      expect.stringContaining(
        'contract "orders.get" has no registered implementation',
      ),
    ]);
  });

  it("reports an orphan implementation in the collected problems", () => {
    const registry = new ActionRegistry();
    registry.registerImplementation(
      fixtureImplementation(fixtureContract({ name: "orders.get" })),
    );
    expect(problemsOf(checkInput(registry))).toEqual([
      expect.stringContaining(
        'implementation "orders.get" has no registered contract',
      ),
    ]);
  });
});

describe("contract check — projection grants (ADR-0020)", () => {
  const publicGlobal = fixtureContract({
    name: "discovery.listCompanies",
    principal: "public",
    publicScope: "globalProjection",
    projectionGrant: "publishedCompanies",
    permissions: [],
  });

  it("rejects a public-global action whose grant no projection owner declares", () => {
    const registry = buildRegistry(publicGlobal);
    expect(problemsOf(checkInput(registry))).toEqual([
      expect.stringContaining(
        'projectionGrant "publishedCompanies" is not declared by any projection owner',
      ),
    ]);
  });

  it("accepts a public-global action whose grant exists in the manifest", () => {
    const registry = buildRegistry(publicGlobal);
    const result = runContractCheck(
      checkInput(registry, {
        projectionGrants: new Set(["publishedCompanies"]),
      }),
    );
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe("contract check — event definitions (core.md §6)", () => {
  it("rejects duplicate event definitions", () => {
    const registry = buildRegistry();
    const problems = problemsOf(
      checkInput(registry, {
        events: [
          { name: "orders.created", scope: "tenant" },
          { name: "orders.created", scope: "tenant" },
        ],
      }),
    );
    expect(problems).toEqual([
      expect.stringContaining('event "orders.created": duplicate definition'),
    ]);
  });

  it("rejects an emitted event that has no registered definition", () => {
    const registry = buildRegistry(
      fixtureContract({
        name: "orders.create",
        errors: ["VALIDATION", "NOT_FOUND", "CONFLICT"],
        risk: "write",
        idempotent: true,
        audit: true,
        emits: ["orders.created"],
      }),
    );
    expect(problemsOf(checkInput(registry))).toEqual([
      expect.stringContaining(
        'action "orders.create": emits "orders.created" but no event definition is registered',
      ),
    ]);
  });
});

describe("contract check — emitter/event scope consistency (core.md §6)", () => {
  it("rejects a staff emitter declaring a global-scope event", () => {
    const registry = buildRegistry(
      fixtureContract({
        name: "orders.ship",
        risk: "write",
        idempotent: true,
        audit: true,
        emits: ["orders.shipped"],
      }),
    );
    const problems = problemsOf(
      checkInput(registry, {
        events: [{ name: "orders.shipped", scope: "global" }],
      }),
    );
    expect(problems).toEqual([
      expect.stringContaining('a staff emitter requires scope "tenant"'),
    ]);
  });

  it("rejects a tenant-scoped system emitter declaring a global event", () => {
    const registry = buildRegistry(
      fixtureContract({
        name: "payments.reconcile",
        principal: "system",
        transport: "internal",
        systemScope: "tenant",
        permissions: [],
        risk: "write",
        idempotent: true,
        audit: true,
        emits: ["payments.reconciled"],
      }),
    );
    const problems = problemsOf(
      checkInput(registry, {
        events: [{ name: "payments.reconciled", scope: "global" }],
      }),
    );
    expect(problems).toEqual([
      expect.stringContaining(
        'a system (tenant-scope) emitter requires scope "tenant"',
      ),
    ]);
  });

  it("rejects a global system emitter declaring a tenant event", () => {
    const registry = buildRegistry(
      fixtureContract({
        name: "dictionaries.sync",
        principal: "system",
        transport: "internal",
        systemScope: "global",
        permissions: [],
        risk: "write",
        idempotent: true,
        audit: true,
        emits: ["dictionaries.synced"],
      }),
    );
    const problems = problemsOf(
      checkInput(registry, {
        events: [{ name: "dictionaries.synced", scope: "tenant" }],
      }),
    );
    expect(problems).toEqual([
      expect.stringContaining(
        'a system (global-scope) emitter requires scope "global"',
      ),
    ]);
  });

  it("rejects an account emitter declaring a tenant event (account events carry a null company)", () => {
    const registry = buildRegistry(
      fixtureContract({
        name: "companies.create",
        errors: ["VALIDATION", "CONFLICT"],
        principal: "account",
        permissions: [],
        risk: "write",
        idempotent: true,
        audit: true,
        emits: ["companies.created"],
      }),
    );
    const problems = problemsOf(
      checkInput(registry, {
        events: [{ name: "companies.created", scope: "tenant" }],
      }),
    );
    expect(problems).toEqual([
      expect.stringContaining('an account emitter requires scope "global"'),
    ]);
  });

  it("rejects a share emitter declaring a global event (share events carry the resolved company)", () => {
    const registry = buildRegistry(
      fixtureContract({
        name: "docSigning.submitShare",
        principal: "share",
        permissions: [],
        risk: "write",
        idempotent: true,
        audit: true,
        emits: ["docSigning.shareSubmitted"],
      }),
    );
    const problems = problemsOf(
      checkInput(registry, {
        events: [{ name: "docSigning.shareSubmitted", scope: "global" }],
      }),
    );
    expect(problems).toEqual([
      expect.stringContaining('a share emitter requires scope "tenant"'),
    ]);
  });

  it("accepts matching emitter and event scopes", () => {
    const registry = buildRegistry(
      fixtureContract({
        name: "orders.create",
        errors: ["VALIDATION", "NOT_FOUND", "CONFLICT"],
        risk: "write",
        idempotent: true,
        audit: true,
        emits: ["orders.created"],
      }),
      fixtureContract({
        name: "companies.create",
        errors: ["VALIDATION", "CONFLICT"],
        principal: "account",
        permissions: [],
        risk: "write",
        idempotent: true,
        audit: true,
        emits: ["companies.created"],
      }),
    );
    const result = runContractCheck(
      checkInput(registry, {
        events: [
          { name: "orders.created", scope: "tenant" },
          { name: "companies.created", scope: "global" },
        ],
      }),
    );
    expect(result.problems).toEqual([]);
  });
});

describe("contract check — subscription bindings (core.md §6)", () => {
  const orderCreated = { name: "orders.created", scope: "tenant" } as const;
  const validConsumerAction = fixtureContract({
    name: "chat.upsertOrderCard",
    errors: ["NOT_FOUND"],
    principal: "system",
    transport: "internal",
    systemScope: "tenant",
    permissions: [],
    risk: "write",
    idempotent: true,
    audit: true,
  });

  it("accepts a binding to a compatible internal idempotent system action", () => {
    const registry = buildRegistry(validConsumerAction);
    const result = runContractCheck(
      checkInput(registry, {
        events: [orderCreated],
        subscriptions: [
          {
            event: "orders.created",
            consumer: "chat.order-card-updater",
            action: "chat.upsertOrderCard",
          },
        ],
      }),
    );
    expect(result.problems).toEqual([]);
  });

  it("rejects a duplicate (consumer, event) binding", () => {
    const registry = buildRegistry(validConsumerAction);
    const subscription = {
      event: "orders.created",
      consumer: "chat.order-card-updater",
      action: "chat.upsertOrderCard",
    };
    const problems = problemsOf(
      checkInput(registry, {
        events: [orderCreated],
        subscriptions: [subscription, subscription],
      }),
    );
    expect(problems).toEqual([expect.stringContaining("duplicate binding")]);
  });

  it("accepts one consumer bound to two events", () => {
    const registry = buildRegistry(validConsumerAction);
    const result = runContractCheck(
      checkInput(registry, {
        events: [orderCreated, { name: "orders.confirmed", scope: "tenant" }],
        subscriptions: [
          {
            event: "orders.created",
            consumer: "chat.order-card-updater",
            action: "chat.upsertOrderCard",
          },
          {
            event: "orders.confirmed",
            consumer: "chat.order-card-updater",
            action: "chat.upsertOrderCard",
          },
        ],
      }),
    );
    expect(result.problems).toEqual([]);
  });

  it("rejects a subscription to an undefined event", () => {
    const registry = buildRegistry(validConsumerAction);
    const problems = problemsOf(
      checkInput(registry, {
        subscriptions: [
          {
            event: "orders.created",
            consumer: "chat.order-card-updater",
            action: "chat.upsertOrderCard",
          },
        ],
      }),
    );
    expect(problems).toEqual([
      expect.stringContaining("the event has no registered definition"),
    ]);
  });

  it("rejects a subscription bound to an unregistered action", () => {
    const registry = buildRegistry();
    const problems = problemsOf(
      checkInput(registry, {
        events: [orderCreated],
        subscriptions: [
          {
            event: "orders.created",
            consumer: "chat.order-card-updater",
            action: "chat.upsertOrderCard",
          },
        ],
      }),
    );
    expect(problems).toEqual([
      expect.stringContaining(
        'bound action "chat.upsertOrderCard" is not registered',
      ),
    ]);
  });

  it("rejects a binding to a non-system, client-routable, AI-exposed action", () => {
    const registry = buildRegistry(
      fixtureContract({
        name: "chat.getOrderCard",
        errors: ["VALIDATION", "NOT_FOUND"],
        aiExposure: "exposed",
        risk: "write",
        idempotent: true,
        audit: true,
      }),
    );
    const problems = problemsOf(
      checkInput(registry, {
        events: [orderCreated],
        subscriptions: [
          {
            event: "orders.created",
            consumer: "chat.order-card-updater",
            action: "chat.getOrderCard",
          },
        ],
      }),
    );
    expect(problems).toEqual([
      expect.stringContaining("must be system-principal"),
      expect.stringContaining("must be transport-internal"),
      expect.stringContaining("must be AI-internal"),
    ]);
  });

  it("rejects a binding to a read-risk, non-idempotent system action", () => {
    const registry = buildRegistry(
      fixtureContract({
        name: "chat.getOrderFacts",
        principal: "system",
        transport: "internal",
        systemScope: "tenant",
        permissions: [],
      }),
    );
    const problems = problemsOf(
      checkInput(registry, {
        events: [orderCreated],
        subscriptions: [
          {
            event: "orders.created",
            consumer: "chat.order-card-updater",
            action: "chat.getOrderFacts",
          },
        ],
      }),
    );
    expect(problems).toEqual([
      expect.stringContaining('must declare risk: "write"'),
      expect.stringContaining("must be idempotent"),
    ]);
  });

  it("rejects a binding whose system scope contradicts the event scope", () => {
    const registry = buildRegistry(
      fixtureContract({
        name: "chat.upsertGlobalCard",
        principal: "system",
        transport: "internal",
        systemScope: "global",
        permissions: [],
        risk: "write",
        idempotent: true,
        audit: true,
      }),
    );
    const problems = problemsOf(
      checkInput(registry, {
        events: [orderCreated],
        subscriptions: [
          {
            event: "orders.created",
            consumer: "chat.order-card-updater",
            action: "chat.upsertGlobalCard",
          },
        ],
      }),
    );
    expect(problems).toEqual([
      expect.stringContaining(
        'has systemScope "global" but the event is tenant-scoped',
      ),
    ]);
  });
});

describe("contract check — ctx.call edges (core.md §9, ADR-0015)", () => {
  const staffCaller = fixtureContract({
    name: "orders.create",
    errors: ["VALIDATION", "NOT_FOUND", "CONFLICT"],
    risk: "write",
    idempotent: true,
    audit: true,
  });
  const staffRead = fixtureContract({ name: "pricing.resolvePrices" });

  it("accepts a cross-module staff read edge", () => {
    const registry = buildRegistry(staffCaller, staffRead);
    const result = runContractCheck(
      checkInput(registry, {
        callEdges: [
          { caller: "orders.create", callee: "pricing.resolvePrices" },
        ],
      }),
    );
    expect(result.problems).toEqual([]);
  });

  it("rejects an edge whose caller or callee is not registered", () => {
    const registry = buildRegistry(staffRead);
    const problems = problemsOf(
      checkInput(registry, {
        callEdges: [
          { caller: "orders.create", callee: "pricing.resolvePrices" },
          { caller: "pricing.resolvePrices", callee: "catalog.getFacts" },
        ],
      }),
    );
    expect(problems).toEqual([
      expect.stringContaining("caller is not registered"),
      expect.stringContaining("callee is not registered"),
    ]);
  });

  it("rejects a write callee", () => {
    const registry = buildRegistry(
      staffCaller,
      fixtureContract({
        name: "pricing.updateList",
        risk: "write",
        idempotent: true,
        audit: true,
      }),
    );
    const problems = problemsOf(
      checkInput(registry, {
        callEdges: [{ caller: "orders.create", callee: "pricing.updateList" }],
      }),
    );
    expect(problems).toEqual([
      expect.stringContaining(
        'only risk: "read" actions are callable cross-module',
      ),
    ]);
  });

  it("rejects a same-module edge (services/, not ctx.call)", () => {
    const registry = buildRegistry(
      staffCaller,
      fixtureContract({ name: "orders.get" }),
    );
    const problems = problemsOf(
      checkInput(registry, {
        callEdges: [{ caller: "orders.create", callee: "orders.get" }],
      }),
    );
    expect(problems).toEqual([
      expect.stringContaining("same-module composition uses services/"),
    ]);
  });

  it("rejects a public-global caller", () => {
    const registry = buildRegistry(
      fixtureContract({
        name: "discovery.listCompanies",
        principal: "public",
        publicScope: "globalProjection",
        projectionGrant: "publishedCompanies",
        permissions: [],
      }),
      fixtureContract({
        name: "catalog.browsePublished",
        principal: "consumer",
        permissions: [],
      }),
    );
    const problems = problemsOf(
      checkInput(registry, {
        projectionGrants: new Set(["publishedCompanies"]),
        callEdges: [
          {
            caller: "discovery.listCompanies",
            callee: "catalog.browsePublished",
          },
        ],
      }),
    );
    expect(problems).toEqual([
      expect.stringContaining("public-global actions cannot use ctx.call"),
    ]);
  });

  it("rejects a public-global callee", () => {
    const registry = buildRegistry(
      fixtureContract({
        name: "companies.viewProfile",
        principal: "public",
        publicScope: "target",
        permissions: [],
      }),
      fixtureContract({
        name: "discovery.listCompanies",
        principal: "public",
        publicScope: "globalProjection",
        projectionGrant: "publishedCompanies",
        permissions: [],
      }),
    );
    const problems = problemsOf(
      checkInput(registry, {
        projectionGrants: new Set(["publishedCompanies"]),
        callEdges: [
          {
            caller: "companies.viewProfile",
            callee: "discovery.listCompanies",
          },
        ],
      }),
    );
    expect(problems).toEqual([
      expect.stringContaining("cannot be a ctx.call target"),
    ]);
  });

  it("rejects a principal mismatch (staff caller, customer callee)", () => {
    const registry = buildRegistry(
      staffCaller,
      fixtureContract({
        name: "payments.getOwn",
        principal: "customer",
        permissions: [],
      }),
    );
    const problems = problemsOf(
      checkInput(registry, {
        callEdges: [{ caller: "orders.create", callee: "payments.getOwn" }],
      }),
    );
    expect(problems).toEqual([
      expect.stringContaining("does not accept the caller's principal"),
    ]);
  });

  it("rejects a consumer caller invoking a company-scoped callee", () => {
    const registry = buildRegistry(
      fixtureContract({
        name: "discovery.browse",
        principal: "consumer",
        permissions: [],
      }),
      staffRead,
    );
    const problems = problemsOf(
      checkInput(registry, {
        callEdges: [
          { caller: "discovery.browse", callee: "pricing.resolvePrices" },
        ],
      }),
    );
    expect(problems).toEqual([
      expect.stringContaining("does not accept the caller's principal"),
    ]);
  });

  it("accepts an account caller invoking a consumer read", () => {
    const registry = buildRegistry(
      fixtureContract({
        name: "companies.listMine",
        errors: ["VALIDATION"],
        principal: "account",
        permissions: [],
      }),
      fixtureContract({
        name: "discovery.browse",
        principal: "consumer",
        permissions: [],
      }),
    );
    const result = runContractCheck(
      checkInput(registry, {
        callEdges: [
          { caller: "companies.listMine", callee: "discovery.browse" },
        ],
      }),
    );
    expect(result.problems).toEqual([]);
  });

  it("accepts a share caller invoking a share read", () => {
    const registry = buildRegistry(
      fixtureContract({
        name: "docSigning.getShared",
        principal: "share",
        permissions: [],
      }),
      fixtureContract({
        name: "catalog.getSharedFacts",
        principal: "share",
        permissions: [],
      }),
    );
    const result = runContractCheck(
      checkInput(registry, {
        callEdges: [
          {
            caller: "docSigning.getShared",
            callee: "catalog.getSharedFacts",
          },
        ],
      }),
    );
    expect(result.problems).toEqual([]);
  });

  it("rejects a share caller invoking a public-target read", () => {
    const registry = buildRegistry(
      fixtureContract({
        name: "docSigning.getShared",
        principal: "share",
        permissions: [],
      }),
      fixtureContract({
        name: "companies.getPublicProfile",
        principal: "public",
        publicScope: "target",
        permissions: [],
      }),
    );
    const problems = problemsOf(
      checkInput(registry, {
        callEdges: [
          {
            caller: "docSigning.getShared",
            callee: "companies.getPublicProfile",
          },
        ],
      }),
    );
    expect(problems).toEqual([
      expect.stringContaining("does not accept the caller's principal"),
    ]);
  });

  it("rejects a global system caller invoking a tenant-scoped system read", () => {
    const registry = buildRegistry(
      fixtureContract({
        name: "dictionaries.sync",
        principal: "system",
        transport: "internal",
        systemScope: "global",
        permissions: [],
      }),
      fixtureContract({
        name: "companies.getTenantFacts",
        principal: "system",
        transport: "internal",
        systemScope: "tenant",
        permissions: [],
      }),
    );
    const problems = problemsOf(
      checkInput(registry, {
        callEdges: [
          { caller: "dictionaries.sync", callee: "companies.getTenantFacts" },
        ],
      }),
    );
    expect(problems).toEqual([
      expect.stringContaining("does not accept the caller's principal"),
    ]);
  });

  it("accepts a tenant system caller invoking a global system read", () => {
    const registry = buildRegistry(
      fixtureContract({
        name: "payments.reconcile",
        principal: "system",
        transport: "internal",
        systemScope: "tenant",
        permissions: [],
      }),
      fixtureContract({
        name: "dictionaries.getEntries",
        principal: "system",
        transport: "internal",
        systemScope: "global",
        permissions: [],
      }),
    );
    const result = runContractCheck(
      checkInput(registry, {
        callEdges: [
          { caller: "payments.reconcile", callee: "dictionaries.getEntries" },
        ],
      }),
    );
    expect(result.problems).toEqual([]);
  });
});

describe("contract check — declared error superset (SHO-485)", () => {
  it("rejects a caller declaring [] whose ctx.call callee declares CONFLICT", () => {
    const registry = buildRegistry(
      fixtureContract({
        name: "orders.create",
        errors: [],
        risk: "write",
        idempotent: true,
        audit: true,
      }),
      fixtureContract({
        name: "customers.resolveCustomerReference",
        errors: ["CONFLICT"],
      }),
    );
    const problems = problemsOf(
      checkInput(registry, {
        callEdges: [
          {
            caller: "orders.create",
            callee: "customers.resolveCustomerReference",
          },
        ],
      }),
    );
    expect(problems).toEqual([
      expect.stringMatching(
        /action "orders\.create".*does not include CONFLICT declared by ctx\.call callee "customers\.resolveCustomerReference"/,
      ),
    ]);
    expect(problems[0]).toContain("orders.create");
    expect(problems[0]).toContain("customers.resolveCustomerReference");
  });

  it("accepts a caller whose declared set includes the callee's codes", () => {
    const registry = buildRegistry(
      fixtureContract({
        name: "orders.create",
        risk: "write",
        idempotent: true,
        audit: true,
        errors: ["CONFLICT", "NOT_FOUND"],
      }),
      fixtureContract({
        name: "customers.resolveCustomerReference",
        errors: ["CONFLICT"],
      }),
    );
    const result = runContractCheck(
      checkInput(registry, {
        callEdges: [
          {
            caller: "orders.create",
            callee: "customers.resolveCustomerReference",
          },
        ],
      }),
    );
    expect(result.problems).toEqual([]);
  });

  it("rejects a caller declaring [] whose atomic callee declares CONFLICT", () => {
    const registry = buildRegistry(
      fixtureContract({
        name: "orders.confirm",
        errors: [],
        risk: "write",
        idempotent: true,
        audit: true,
        atomicCalls: ["catalog.decrementStock"],
      }),
      fixtureContract({
        name: "catalog.decrementStock",
        transport: "internal",
        risk: "write",
        audit: true,
        atomicCallers: ["orders.confirm"],
        errors: ["CONFLICT"],
      }),
    );
    const problems = problemsOf(checkInput(registry));
    expect(problems).toEqual([
      expect.stringMatching(
        /action "orders\.confirm".*does not include CONFLICT declared by ctx\.callAtomic callee "catalog\.decrementStock"/,
      ),
    ]);
  });
});

describe("contract check — atomic edges (ADR-0021)", () => {
  function atomicPair(): readonly [ActionContract, ActionContract] {
    return [
      fixtureContract({
        name: "orders.confirm",
        errors: ["VALIDATION", "NOT_FOUND", "CONFLICT"],
        risk: "write",
        idempotent: true,
        audit: true,
        atomicCalls: ["catalog.decrementStock"],
      }),
      fixtureContract({
        name: "catalog.decrementStock",
        transport: "internal",
        risk: "write",
        audit: true,
        atomicCallers: ["orders.confirm"],
        errors: [],
      }),
    ];
  }

  it("accepts a mutually declared same-principal edge", () => {
    const registry = buildRegistry(...atomicPair());
    const result = runContractCheck(checkInput(registry));
    expect(result.problems).toEqual([]);
  });

  it("rejects an atomicCalls entry that is not registered", () => {
    const [root] = atomicPair();
    const registry = buildRegistry(root);
    expect(problemsOf(checkInput(registry))).toEqual([
      expect.stringContaining(
        'atomic edge "orders.confirm" → "catalog.decrementStock": callee is not registered',
      ),
    ]);
  });

  it("rejects an atomicCallers entry that is not registered", () => {
    const [, callee] = atomicPair();
    const registry = buildRegistry(callee);
    expect(problemsOf(checkInput(registry))).toEqual([
      expect.stringContaining(
        'atomic edge "orders.confirm" → "catalog.decrementStock": declared caller is not registered',
      ),
    ]);
  });

  it("rejects a one-sided edge the callee does not declare", () => {
    const [root] = atomicPair();
    const registry = buildRegistry(
      root,
      fixtureContract({
        name: "catalog.decrementStock",
        transport: "internal",
        risk: "write",
        audit: true,
        // No atomicCallers — the callee does not acknowledge the edge.
      }),
    );
    expect(problemsOf(checkInput(registry))).toEqual([
      expect.stringContaining(
        '"catalog.decrementStock" does not list "orders.confirm" in atomicCallers',
      ),
    ]);
  });

  it("rejects a one-sided edge the caller does not declare", () => {
    const [, callee] = atomicPair();
    const registry = buildRegistry(
      fixtureContract({
        name: "orders.confirm",
        errors: ["VALIDATION", "NOT_FOUND", "CONFLICT"],
        risk: "write",
        idempotent: true,
        audit: true,
        // No atomicCalls — the root does not acknowledge the edge.
      }),
      callee,
    );
    expect(problemsOf(checkInput(registry))).toEqual([
      expect.stringContaining(
        '"orders.confirm" does not list "catalog.decrementStock" in atomicCalls',
      ),
    ]);
  });

  it("rejects a declared edge whose principals differ", () => {
    const registry = buildRegistry(
      fixtureContract({
        name: "orders.confirm",
        errors: ["VALIDATION", "NOT_FOUND", "CONFLICT"],
        risk: "write",
        idempotent: true,
        audit: true,
        atomicCalls: ["catalog.decrementStock"],
      }),
      fixtureContract({
        name: "catalog.decrementStock",
        principal: "system",
        transport: "internal",
        systemScope: "tenant",
        permissions: [],
        risk: "write",
        audit: true,
        atomicCallers: ["orders.confirm"],
        errors: [],
      }),
    );
    expect(problemsOf(checkInput(registry))).toEqual([
      expect.stringContaining("must use the same principal mode"),
    ]);
  });
});

describe("contract check — call-graph acyclicity (core.md §9, ADR-0021)", () => {
  it("accepts an acyclic graph, including diamonds over shared callees", () => {
    // a → b, a → c, b → d, c → d: node d is reached twice without any
    // cycle — the walk must not misreport revisits of finished nodes.
    const registry = buildRegistry(
      fixtureContract({ name: "orders.getSummary" }),
      fixtureContract({ name: "pricing.getQuote" }),
      fixtureContract({ name: "catalog.getProduct" }),
      fixtureContract({ name: "dictionaries.getUnits" }),
    );
    const result = runContractCheck(
      checkInput(registry, {
        callEdges: [
          { caller: "orders.getSummary", callee: "pricing.getQuote" },
          { caller: "orders.getSummary", callee: "catalog.getProduct" },
          { caller: "pricing.getQuote", callee: "dictionaries.getUnits" },
          { caller: "catalog.getProduct", callee: "dictionaries.getUnits" },
        ],
      }),
    );
    expect(result.problems).toEqual([]);
  });

  it("rejects a ctx.call cycle and names its chain", () => {
    const registry = buildRegistry(
      fixtureContract({ name: "orders.getStatus" }),
      fixtureContract({ name: "pricing.getContext" }),
    );
    const problems = problemsOf(
      checkInput(registry, {
        callEdges: [
          { caller: "orders.getStatus", callee: "pricing.getContext" },
          { caller: "pricing.getContext", callee: "orders.getStatus" },
        ],
      }),
    );
    expect(problems).toEqual([
      expect.stringContaining(
        'call-graph cycle: "orders.getStatus" → "pricing.getContext" → "orders.getStatus"',
      ),
    ]);
  });

  it("detects a cycle closed through a declared atomic edge", () => {
    // orders.confirm →(atomic) catalog.decrementStock →(read, illegally
    // declared) orders.confirm. The bad read edge also fails its own
    // per-edge rule — the point here is that the atomic edge participates
    // in the combined graph, so the cycle is reported as well.
    const registry = buildRegistry(
      fixtureContract({
        name: "orders.confirm",
        errors: ["VALIDATION", "NOT_FOUND", "CONFLICT"],
        risk: "write",
        idempotent: true,
        audit: true,
        atomicCalls: ["catalog.decrementStock"],
      }),
      fixtureContract({
        name: "catalog.decrementStock",
        transport: "internal",
        risk: "write",
        audit: true,
        atomicCallers: ["orders.confirm"],
        errors: [],
      }),
    );
    const problems = problemsOf(
      checkInput(registry, {
        callEdges: [
          { caller: "catalog.decrementStock", callee: "orders.confirm" },
        ],
      }),
    );
    expect(problems).toContainEqual(
      expect.stringContaining(
        'call-graph cycle: "catalog.decrementStock" → "orders.confirm" → "catalog.decrementStock"',
      ),
    );
  });
});

describe("contract check — schema-ownership manifest (ADR-0014, ADR-0015)", () => {
  it("accepts own-schema imports without any grant", () => {
    const result = runContractCheck(
      checkInput(buildRegistry(), {
        schemaImports: [{ importer: "catalog", schemaOwner: "catalog" }],
      }),
    );
    expect(result.problems).toEqual([]);
  });

  it("rejects a foreign schema import without a read-model grant", () => {
    const problems = problemsOf(
      checkInput(buildRegistry(), {
        schemaImports: [{ importer: "search", schemaOwner: "catalog" }],
      }),
    );
    expect(problems).toEqual([
      expect.stringContaining(
        'module "search" imports the "catalog" schema without a read-model grant',
      ),
    ]);
  });

  it("accepts a foreign schema import covered by a declared grant", () => {
    const result = runContractCheck(
      checkInput(buildRegistry(), {
        readModelGrants: [{ owner: "catalog", grantee: "search" }],
        schemaImports: [{ importer: "search", schemaOwner: "catalog" }],
      }),
    );
    expect(result.problems).toEqual([]);
  });

  it("rejects a grant to a module that is not a cross-cutting projection", () => {
    const problems = problemsOf(
      checkInput(buildRegistry(), {
        readModelGrants: [{ owner: "catalog", grantee: "orders" }],
      }),
    );
    expect(problems).toEqual([
      expect.stringContaining(
        'read-model grant "catalog" → "orders": grantee is not a cross-cutting projection module',
      ),
    ]);
  });
});

describe("contract check — reporting", () => {
  it("aggregates every violation into one report", () => {
    const registry = new ActionRegistry();
    registry.registerContract(fixtureContract({ name: "orders.get" }));
    registry.registerContract(
      fixtureContract({
        name: "discovery.listCompanies",
        principal: "public",
        publicScope: "globalProjection",
        projectionGrant: "unknownGrant",
        permissions: [],
      }),
    );
    const problems = problemsOf(
      checkInput(registry, {
        schemaImports: [{ importer: "search", schemaOwner: "catalog" }],
      }),
    );
    expect(problems).toHaveLength(4);
  });

  it("assertContractCheck throws a ContractCheckError listing the problems", () => {
    const registry = new ActionRegistry();
    registry.registerContract(fixtureContract({ name: "orders.get" }));
    try {
      assertContractCheck(checkInput(registry));
    } catch (error) {
      if (!(error instanceof ContractCheckError)) {
        throw error;
      }
      expect(error.problems).toHaveLength(1);
      expect(error.message).toContain('contract "orders.get"');
      return;
    }
    expect.unreachable("expected a ContractCheckError");
  });

  it("passes a fully populated valid composition", () => {
    const registry = buildRegistry(
      fixtureContract({
        name: "orders.create",
        errors: ["VALIDATION", "NOT_FOUND", "CONFLICT"],
        risk: "write",
        idempotent: true,
        audit: true,
        emits: ["orders.created"],
      }),
      fixtureContract({ name: "pricing.resolvePrices" }),
      fixtureContract({
        name: "chat.upsertOrderCard",
        errors: ["NOT_FOUND"],
        principal: "system",
        transport: "internal",
        systemScope: "tenant",
        permissions: [],
        risk: "write",
        idempotent: true,
        audit: true,
      }),
      fixtureContract({
        name: "discovery.listCompanies",
        principal: "public",
        publicScope: "globalProjection",
        projectionGrant: "publishedCompanies",
        permissions: [],
      }),
    );
    const result = runContractCheck(
      checkInput(registry, {
        events: [{ name: "orders.created", scope: "tenant" }],
        subscriptions: [
          {
            event: "orders.created",
            consumer: "chat.order-card-updater",
            action: "chat.upsertOrderCard",
          },
        ],
        callEdges: [
          { caller: "orders.create", callee: "pricing.resolvePrices" },
        ],
        projectionGrants: new Set(["publishedCompanies"]),
        readModelGrants: [{ owner: "orders", grantee: "search" }],
        schemaImports: [
          { importer: "orders", schemaOwner: "orders" },
          { importer: "search", schemaOwner: "orders" },
        ],
      }),
    );
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe("contract check — inherited suite coverage (core.md §12)", () => {
  it("fails when a registered action is omitted from isolation coverage", () => {
    expect(
      problemsOf(
        checkInput(buildRegistry(fixtureContract({ name: "orders.get" })), {
          suiteCoverage: emptySuiteCoverage,
        }),
      ),
    ).toEqual([
      expect.stringContaining(
        'action "orders.get": missing crossTenantSuite instantiation',
      ),
    ]);
  });

  it("fails when a public-global action omits publicProjectionSuite", () => {
    const contract = fixtureContract({
      name: "search.browse",
      principal: "public",
      permissions: [],
      publicScope: "globalProjection",
      projectionGrant: "publishedCompanies",
    });
    expect(
      problemsOf(
        checkInput(buildRegistry(contract), {
          projectionGrants: new Set(["publishedCompanies"]),
          suiteCoverage: {
            ...emptySuiteCoverage,
            isolation: ["search.browse"],
          },
        }),
      ),
    ).toEqual([
      expect.stringContaining(
        'action "search.browse": missing publicProjectionSuite instantiation',
      ),
    ]);
  });

  it("fails when a consumer action omits consumerIsolationSuite", () => {
    const contract = fixtureContract({
      name: "search.feed",
      principal: "consumer",
      permissions: [],
    });
    expect(
      problemsOf(
        checkInput(buildRegistry(contract), {
          suiteCoverage: {
            ...emptySuiteCoverage,
            isolation: ["search.feed"],
          },
        }),
      ),
    ).toEqual([
      expect.stringContaining(
        'action "search.feed": missing consumerIsolationSuite instantiation',
      ),
    ]);
  });

  it("fails when an account action omits accountIsolationSuite", () => {
    const contract = fixtureContract({
      name: "companies.listMine",
      errors: ["VALIDATION"],
      principal: "account",
      permissions: [],
    });
    expect(
      problemsOf(
        checkInput(buildRegistry(contract), {
          suiteCoverage: {
            ...emptySuiteCoverage,
            isolation: ["companies.listMine"],
          },
        }),
      ),
    ).toEqual([
      expect.stringContaining(
        'action "companies.listMine": missing accountIsolationSuite instantiation',
      ),
    ]);
  });

  it("fails when a share action omits shareIsolationSuite", () => {
    const contract = fixtureContract({
      name: "docSigning.getShared",
      principal: "share",
      permissions: [],
    });
    expect(
      problemsOf(
        checkInput(buildRegistry(contract), {
          suiteCoverage: {
            ...emptySuiteCoverage,
            isolation: ["docSigning.getShared"],
          },
        }),
      ),
    ).toEqual([
      expect.stringContaining(
        'action "docSigning.getShared": missing shareIsolationSuite instantiation',
      ),
    ]);
  });

  it("fails when an idempotent mutation omits idempotencySuite", () => {
    const contract = fixtureContract({
      name: "orders.create",
      errors: ["VALIDATION", "NOT_FOUND", "CONFLICT"],
      risk: "write",
      idempotent: true,
      audit: true,
    });
    expect(
      problemsOf(
        checkInput(buildRegistry(contract), {
          suiteCoverage: {
            ...emptySuiteCoverage,
            isolation: ["orders.create"],
          },
        }),
      ),
    ).toEqual([
      expect.stringContaining(
        'action "orders.create": missing idempotencySuite instantiation',
      ),
    ]);
  });

  it("does not require idempotencySuite for an event-consumer binding", () => {
    const consumer = fixtureContract({
      name: "chat.upsertOrderCard",
      errors: ["NOT_FOUND"],
      principal: "system",
      systemScope: "tenant",
      transport: "internal",
      permissions: [],
      risk: "write",
      idempotent: true,
      audit: true,
    });
    expect(
      problemsOf(
        checkInput(buildRegistry(consumer), {
          events: [{ name: "orders.created", scope: "tenant" }],
          subscriptions: [
            {
              event: "orders.created",
              consumer: "chat.order-card-updater",
              action: "chat.upsertOrderCard",
            },
          ],
          suiteCoverage: {
            ...emptySuiteCoverage,
            isolation: ["chat.upsertOrderCard"],
            events: ["chat"],
          },
        }),
      ),
    ).toEqual([]);
  });

  it("fails when an emitting module omits eventSuite", () => {
    const contract = fixtureContract({
      name: "orders.create",
      errors: ["VALIDATION", "NOT_FOUND", "CONFLICT"],
      risk: "write",
      idempotent: true,
      audit: true,
      emits: ["orders.created"],
    });
    expect(
      problemsOf(
        checkInput(buildRegistry(contract), {
          events: [{ name: "orders.created", scope: "tenant" }],
          suiteCoverage: {
            ...emptySuiteCoverage,
            isolation: ["orders.create"],
            idempotency: ["orders.create"],
          },
        }),
      ),
    ).toEqual([
      expect.stringContaining(
        'module "orders": missing eventSuite instantiation',
      ),
    ]);
  });

  it("fails when a declared atomic edge omits atomicCallSuite", () => {
    const root = fixtureContract({
      name: "orders.confirm",
      errors: ["VALIDATION", "NOT_FOUND", "CONFLICT"],
      transport: "internal",
      risk: "write",
      idempotent: true,
      audit: true,
      atomicCalls: ["catalog.decrementStock"],
    });
    const callee = fixtureContract({
      name: "catalog.decrementStock",
      transport: "internal",
      risk: "write",
      audit: true,
      atomicCallers: ["orders.confirm"],
      errors: [],
    });
    expect(
      problemsOf(
        checkInput(buildRegistry(root, callee), {
          suiteCoverage: {
            ...emptySuiteCoverage,
            isolation: ["orders.confirm", "catalog.decrementStock"],
            idempotency: ["orders.confirm"],
          },
        }),
      ),
    ).toEqual([
      expect.stringContaining(
        'atomic edge "orders.confirm" → "catalog.decrementStock": missing atomicCallSuite instantiation',
      ),
    ]);
  });

  it("fails when isolation coverage names an action that is not registered", () => {
    expect(
      problemsOf(
        checkInput(buildRegistry(), {
          suiteCoverage: {
            ...emptySuiteCoverage,
            isolation: ["orders.get"],
          },
        }),
      ),
    ).toEqual([
      expect.stringContaining(
        'suiteCoverage.isolation "orders.get" is not a registered action',
      ),
    ]);
  });

  it("fails when a staff action is listed in publicProjectionSuite", () => {
    expect(
      problemsOf(
        checkInput(buildRegistry(fixtureContract({ name: "orders.get" })), {
          suiteCoverage: {
            ...emptySuiteCoverage,
            isolation: ["orders.get"],
            publicProjection: ["orders.get"],
          },
        }),
      ),
    ).toEqual([
      expect.stringContaining(
        'action "orders.get": listed in publicProjectionSuite but is not publicScope: "globalProjection"',
      ),
    ]);
  });
});
