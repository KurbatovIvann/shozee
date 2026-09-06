/**
 * SHO-467: AI-exposed create actions require provenance columns on the
 * derived entity table. Rule-matrix tests; the composition stage proves
 * the live registry after T1 (nine tables, zero violations).
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
import { runContractCheck } from "./contract-check.js";
import {
  RECORD_PROVENANCE_CREATE_EXCLUSIONS,
  RECORD_PROVENANCE_PHYSICAL_TABLE_ALIASES,
  type SchemaTableRef,
} from "./record-provenance.js";
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
    ...overrides,
  };
  return {
    registry,
    ...rest,
    suiteCoverage: overrides.suiteCoverage ?? coverageFor(registry, rest),
  };
}

function writeCreate(
  name: string,
  overrides: Partial<ActionContractDefinition> = {},
): ActionContract {
  return fixtureContract({
    name,
    risk: "write",
    idempotent: true,
    audit: true,
    aiExposure: "exposed",
    ...overrides,
  });
}

function emptyTable(name: string, owner: string): SchemaTableRef {
  return { name, owner, columns: [], checks: [] };
}

function provenanceTable(name: string, owner: string): SchemaTableRef {
  return {
    name,
    owner,
    columns: [
      { name: "created_via", notNull: false },
      { name: "vouched_by", notNull: false },
      { name: "vouched_at", notNull: false },
    ],
    checks: [
      {
        name: `${name}_created_via_check`,
        sql: `${name}.created_via IN ('ui', 'ai', 'system', 'webhook')`,
      },
    ],
  };
}

const MISSING_COLUMNS_MESSAGE =
  'action "widgets.create": AI-exposed create writes table "widgets", which must carry nullable created_via, vouched_by and vouched_at plus a created_via CHECK of ui|ai|system|webhook. Missing: created_via, vouched_by, vouched_at, widgets_created_via_check CHECK. Add them with recordProvenanceColumns() and recordProvenanceChecks("widgets", table) on the owning schema (SHO-464).';

describe("contract check — record provenance on AI-exposed creates (SHO-467)", () => {
  it("fails when an AI-exposed create table lacks provenance columns and names the action, table, and missing columns", () => {
    const registry = buildRegistry(writeCreate("widgets.create"));
    const problems = runContractCheck(
      checkInput(registry, {
        schemaTables: [emptyTable("widgets", "widgets")],
      }),
    ).problems;
    expect(problems).toEqual([MISSING_COLUMNS_MESSAGE]);
  });

  it("passes when the same create table carries nullable columns and the created_via CHECK", () => {
    const registry = buildRegistry(writeCreate("widgets.create"));
    const result = runContractCheck(
      checkInput(registry, {
        schemaTables: [provenanceTable("widgets", "widgets")],
      }),
    );
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("does not require provenance for aiExposure: internal creates", () => {
    const registry = buildRegistry(
      writeCreate("widgets.create", { aiExposure: "internal" }),
    );
    const result = runContractCheck(
      checkInput(registry, {
        schemaTables: [emptyTable("widgets", "widgets")],
      }),
    );
    expect(result.problems).toEqual([]);
  });

  it("does not require provenance for risk: read actions, even when named create", () => {
    const registry = buildRegistry(
      fixtureContract({
        name: "widgets.create",
        aiExposure: "exposed",
        risk: "read",
      }),
    );
    const result = runContractCheck(
      checkInput(registry, {
        schemaTables: [emptyTable("widgets", "widgets")],
      }),
    );
    expect(result.problems).toEqual([]);
  });

  it("does not require provenance for AI-exposed updates", () => {
    const registry = buildRegistry(
      writeCreate("widgets.updateWidget", { name: "widgets.updateWidget" }),
    );
    const result = runContractCheck(
      checkInput(registry, {
        schemaTables: [emptyTable("widgets", "widgets")],
      }),
    );
    expect(result.problems).toEqual([]);
  });

  it("requires provenance for risk: high creates", () => {
    const registry = buildRegistry(
      writeCreate("widgets.create", {
        risk: "high",
        requiresConfirmation: true,
      }),
    );
    const problems = runContractCheck(
      checkInput(registry, {
        schemaTables: [emptyTable("widgets", "widgets")],
      }),
    ).problems;
    expect(problems).toEqual([MISSING_COLUMNS_MESSAGE]);
  });

  it("skips companies.create via the named exclusion allowlist", () => {
    const registry = buildRegistry(
      writeCreate("companies.create", {
        principal: "account",
        permissions: [],
      }),
    );
    const result = runContractCheck(
      checkInput(registry, {
        schemaTables: [emptyTable("companies", "companies")],
      }),
    );
    expect(result.problems).toEqual([]);
  });

  it("skips files.create via the named exclusion allowlist", () => {
    const registry = buildRegistry(writeCreate("files.create"));
    const result = runContractCheck(
      checkInput(registry, {
        schemaTables: [emptyTable("files", "files")],
      }),
    );
    expect(result.problems).toEqual([]);
  });

  it("covers exactly companies and files; adding an entry is a source edit", () => {
    expect(Object.isFrozen(RECORD_PROVENANCE_CREATE_EXCLUSIONS)).toBe(true);
    expect(Object.keys(RECORD_PROVENANCE_CREATE_EXCLUSIONS).sort()).toEqual([
      "companies",
      "files",
    ]);
    expect(
      RECORD_PROVENANCE_CREATE_EXCLUSIONS.companies.length,
    ).toBeGreaterThan(0);
    expect(RECORD_PROVENANCE_CREATE_EXCLUSIONS.files.length).toBeGreaterThan(0);
    expect(
      Object.getOwnPropertyDescriptor(
        RECORD_PROVENANCE_CREATE_EXCLUSIONS,
        "companies",
      )?.writable,
    ).toBe(false);
  });

  it("records the two physical-name aliases as a named source map", () => {
    expect(RECORD_PROVENANCE_PHYSICAL_TABLE_ALIASES).toEqual({
      customers: "company_customers",
      invites: "company_customer_invites",
    });
    expect(Object.isFrozen(RECORD_PROVENANCE_PHYSICAL_TABLE_ALIASES)).toBe(
      true,
    );
  });

  it("resolves createCustomer to company_customers via the customers alias", () => {
    const registry = buildRegistry(writeCreate("customers.createCustomer"));
    const problems = runContractCheck(
      checkInput(registry, {
        schemaTables: [emptyTable("company_customers", "customers")],
      }),
    ).problems;
    expect(problems[0]).toContain('action "customers.createCustomer"');
    expect(problems[0]).toContain('table "company_customers"');
    expect(problems[0]).toContain("created_via");
  });

  it("names the action when the derived table is absent from the catalog", () => {
    const registry = buildRegistry(writeCreate("widgets.create"));
    const problems = runContractCheck(checkInput(registry)).problems;
    expect(problems).toEqual([
      'action "widgets.create": AI-exposed create requires provenance columns on table "widgets", but no matching table was found in the schema catalog for module "widgets". Add the table with recordProvenanceColumns() / recordProvenanceChecks(), or add "widgets" to RECORD_PROVENANCE_CREATE_EXCLUSIONS if this create is a deliberate exclusion (SHO-464).',
    ]);
  });
});
