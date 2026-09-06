/**
 * SHO-465: createdVia / vouchedBy are not writable from any client
 * contract input in the six provenance modules. Update paths stay
 * immutable by construction.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { contractModules } from "./modules.js";

const FORBIDDEN = [
  "createdVia",
  "vouchedBy",
  "vouchedAt",
  "created_via",
  "vouched_by",
  "vouched_at",
] as const;

function jsonSchemaPropertyKeys(schema: z.ZodType): string[] {
  const json = z.toJSONSchema(schema);
  const keys = new Set<string>();
  collectPropertyKeys(json, keys);
  return [...keys];
}

function collectPropertyKeys(node: unknown, keys: Set<string>): void {
  if (typeof node !== "object" || node === null) {
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      collectPropertyKeys(item, keys);
    }
    return;
  }
  const record = node as Record<string, unknown>;
  const properties = record.properties;
  if (typeof properties === "object" && properties !== null) {
    for (const [key, value] of Object.entries(properties)) {
      keys.add(key);
      collectPropertyKeys(value, keys);
    }
  }
  for (const nested of [
    "items",
    "additionalProperties",
    "oneOf",
    "anyOf",
    "allOf",
  ]) {
    if (nested in record) {
      collectPropertyKeys(record[nested], keys);
    }
  }
}

function scanModule(
  moduleName: string,
  actions: { readonly [verb: string]: { readonly input: z.ZodType } },
): string[] {
  const scanned: string[] = [];
  for (const [verb, contract] of Object.entries(actions)) {
    scanned.push(`${moduleName}.${verb}`);
    const keys = jsonSchemaPropertyKeys(contract.input);
    for (const forbidden of FORBIDDEN) {
      expect(keys).not.toContain(forbidden);
    }
  }
  return scanned;
}

describe("record provenance input schemas (SHO-465)", () => {
  it("keeps createdVia and vouchedBy off every contract input in the six modules", () => {
    const scanned = [
      ...scanModule("catalog", contractModules.catalog),
      ...scanModule("customers", contractModules.customers),
      ...scanModule("documents", contractModules.documents),
      ...scanModule("invites", contractModules.invites),
      ...scanModule("orders", contractModules.orders),
      ...scanModule("pricing", contractModules.pricing),
    ];
    expect(scanned).toEqual(
      expect.arrayContaining([
        "orders.create",
        "orders.confirm",
        "customers.updateCustomer",
        "catalog.updateProduct",
        "catalog.updateVariant",
        "pricing.updatePriceList",
        "documents.cancel",
        "invites.revoke",
      ]),
    );
  });
});
