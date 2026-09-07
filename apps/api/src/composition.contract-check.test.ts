/**
 * The CI contract-check stage (core.md §2, fnd-T10 / fnd-G1 A2): walks the
 * API composition root and fails on any registry-wide violation. Define-
 * time and implement-time rules run implicitly — importing the composition
 * executes `defineActionContract` / `implementAction` for everything
 * registered, so a broken definition fails this stage before the walk
 * starts.
 *
 * Run in CI as `pnpm --filter @showzy/api contract:check`.
 */
import {
  deriveRecordProvenanceRequirements,
  runContractCheck,
  type ActionChannel,
} from "@showzy/core";
import type { ActionContract } from "@showzy/core/contract";
import type { RecordCreatedVia as DbRecordCreatedVia } from "@showzy/db/schema/tenant-columns";
import { ASSISTANT_SURFACE_REGISTRY } from "@showzy/validation/assistant-surfaces";
import type { RecordCreatedVia as ValidationRecordCreatedVia } from "@showzy/validation/record-verification";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import { buildContractCheckInput } from "./composition.js";

const T1_PROVENANCE_TABLES = [
  "company_customer_invites",
  "company_customers",
  "counterparties",
  "customer_groups",
  "documents",
  "orders",
  "price_lists",
  "product_variants",
  "products",
] as const;

/**
 * SHO-509 / SHO-504 T1: every `staff` + `aiExposure: "exposed"` action
 * must appear here on purpose. A new exposed staff action fails CI until
 * it is added to this list.
 */
const STAFF_EXPOSED_ACTION_ALLOWLIST = [
  "catalog.archiveProduct",
  "catalog.archiveVariant",
  "catalog.createProduct",
  "catalog.createVariant",
  "catalog.getProduct",
  "catalog.listProducts",
  "catalog.restoreProduct",
  "catalog.restoreVariant",
  "catalog.updateProduct",
  "catalog.updateVariant",
  "companies.get",
  "companies.updateLegal",
  "customers.archiveCustomer",
  "customers.createCounterparty",
  "customers.createCustomer",
  "customers.createGroup",
  "customers.deleteCounterparty",
  "customers.deleteCustomer",
  "customers.deleteGroup",
  "customers.getCounterparty",
  "customers.getCustomer",
  "customers.getGroup",
  "customers.listCounterparties",
  "customers.listCustomers",
  "customers.listGroups",
  "customers.restoreCustomer",
  "customers.updateCounterparty",
  "customers.updateCustomer",
  "customers.updateGroup",
  "docGeneration.listLayouts",
  "documents.cancel",
  "documents.createFromOrder",
  "documents.get",
  "documents.list",
  "documents.requestSign",
  "documents.share",
  "invites.create",
  "invites.get",
  "invites.list",
  "invites.revoke",
  "orders.cancel",
  "orders.complete",
  "orders.confirm",
  "orders.create",
  "orders.get",
  "orders.list",
  "orders.start",
  "pricing.activatePriceList",
  "pricing.createPriceList",
  "pricing.deactivatePriceList",
  "pricing.deletePriceList",
  "pricing.getPriceList",
  "pricing.listPriceListEntries",
  "pricing.listPriceLists",
  "pricing.removePriceListEntries",
  "pricing.setDefaultPriceList",
  "pricing.setPriceListEntries",
  "pricing.updatePriceList",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveJsonPointer(root: unknown, ref: string): unknown {
  if (!ref.startsWith("#/")) {
    return undefined;
  }
  let current: unknown = root;
  for (const segment of ref.slice(2).split("/")) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment.replaceAll("~1", "/").replaceAll("~0", "~")];
  }
  return current;
}

function jsonSchemaRequiresFileId(schema: unknown, root: unknown): boolean {
  if (!isRecord(schema)) {
    return false;
  }
  const ref = schema["$ref"];
  if (typeof ref === "string") {
    return jsonSchemaRequiresFileId(resolveJsonPointer(root, ref), root);
  }
  const required = schema["required"];
  if (
    Array.isArray(required) &&
    required.some((key) => key === "fileId" || key === "fileIds")
  ) {
    return true;
  }
  for (const key of ["oneOf", "anyOf", "allOf"] as const) {
    const variants = schema[key];
    if (
      Array.isArray(variants) &&
      variants.some((variant) => jsonSchemaRequiresFileId(variant, root))
    ) {
      return true;
    }
  }
  return false;
}

function inputRequiresFileIdOrFileIds(contract: ActionContract): boolean {
  const json = z.toJSONSchema(contract.input);
  return jsonSchemaRequiresFileId(json, json);
}

function staffExposedActionNames(
  contracts: readonly ActionContract[],
): string[] {
  return contracts
    .filter(
      (contract) =>
        contract.principal === "staff" && contract.aiExposure === "exposed",
    )
    .map((contract) => contract.name)
    .toSorted();
}

describe("CI contract-check stage", () => {
  it("the registered surface satisfies every core.md §2 registry rule", () => {
    const result = runContractCheck(buildContractCheckInput());
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("SHO-467: AI-exposed creates derive the nine T1 tables and none violate", () => {
    const input = buildContractCheckInput();
    const required = deriveRecordProvenanceRequirements(
      input.registry.contracts(),
      input.schemaTables,
    );
    const tables = [...new Set(required.map((entry) => entry.table))].sort();
    expect(tables).toEqual([...T1_PROVENANCE_TABLES]);
    expect(
      runContractCheck(input).problems.filter((problem) =>
        problem.includes("provenance"),
      ),
    ).toEqual([]);
  });

  it("SHO-491: ActionChannel, db RecordCreatedVia, and validation RecordCreatedVia match", () => {
    expectTypeOf<ActionChannel>().toEqualTypeOf<DbRecordCreatedVia>();
    expectTypeOf<ActionChannel>().toEqualTypeOf<ValidationRecordCreatedVia>();
    expectTypeOf<DbRecordCreatedVia>().toEqualTypeOf<ValidationRecordCreatedVia>();
  });

  it("SHO-471: every registered assistant surface binding resolves (no hardcoded kinds)", () => {
    const input = buildContractCheckInput();
    expect(input.assistantSurfaces).toEqual(
      ASSISTANT_SURFACE_REGISTRY.map((surface) => ({
        kind: surface.kind,
        actionNames: surface.actionNames,
        toolNames: surface.toolNames,
      })),
    );
    expect(input.assistantSurfaces.length).toBeGreaterThan(0);
    expect(
      runContractCheck(input).problems.filter((problem) =>
        problem.startsWith("assistant surface "),
      ),
    ).toEqual([]);
  });

  it("SHO-509: staff + exposed actions equal the literal allowlist", () => {
    const contracts = buildContractCheckInput().registry.contracts();
    expect([...STAFF_EXPOSED_ACTION_ALLOWLIST]).toEqual(
      [...STAFF_EXPOSED_ACTION_ALLOWLIST].toSorted(),
    );
    expect(staffExposedActionNames(contracts)).toEqual([
      ...STAFF_EXPOSED_ACTION_ALLOWLIST,
    ]);
  });

  it("SHO-509: no files.* action and no required fileId/fileIds input is exposed to staff AI", () => {
    const contracts = buildContractCheckInput().registry.contracts();
    const exposed = staffExposedActionNames(contracts);
    expect(exposed.filter((name) => name.startsWith("files."))).toEqual([]);

    const byName = new Map(
      contracts.map((contract) => [contract.name, contract]),
    );
    const requiringFileId = exposed.filter((name) => {
      const contract = byName.get(name);
      return contract !== undefined && inputRequiresFileIdOrFileIds(contract);
    });
    expect(requiringFileId).toEqual([]);

    expect(exposed).toContain("documents.requestSign");
    expect(exposed).toContain("documents.share");
    expect(exposed).toContain("documents.createFromOrder");

    const setProductImages = byName.get("catalog.setProductImages");
    expect(setProductImages?.aiExposure).toBe("internal");
    expect(setProductImages).toBeDefined();
    if (setProductImages === undefined) {
      return;
    }
    expect(inputRequiresFileIdOrFileIds(setProductImages)).toBe(true);
  });
});
