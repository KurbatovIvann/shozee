/**
 * Drizzle catalog helper for SHO-467: production tables after T1 carry
 * provenance columns on the nine AI-create entities.
 */
import { ownedSchemaModules } from "@showzy/db";
import { describe, expect, it } from "vitest";

import type { SchemaTableRef } from "./record-provenance.js";
import { schemaTablesFromModules } from "./schema-tables.js";

const T1_TABLES = [
  "orders",
  "company_customers",
  "counterparties",
  "customer_groups",
  "products",
  "product_variants",
  "price_lists",
  "documents",
  "company_customer_invites",
] as const;

function requireTable(
  tables: readonly SchemaTableRef[],
  name: string,
): SchemaTableRef {
  const table = tables.find((entry) => entry.name === name);
  expect(table, name).toBeDefined();
  if (table === undefined) {
    expect.fail(`missing table ${name}`);
  }
  return table;
}

describe("schemaTablesFromModules — provenance inspector (SHO-467)", () => {
  const tables = schemaTablesFromModules(ownedSchemaModules);

  it("sees nullable created_via / vouched_* and the created_via CHECK on the T1 tables", () => {
    for (const name of T1_TABLES) {
      const table = requireTable(tables, name);
      const byName = new Map(
        table.columns.map((column) => [column.name, column]),
      );
      expect(byName.get("created_via")?.notNull).toBe(false);
      expect(byName.get("vouched_by")?.notNull).toBe(false);
      expect(byName.get("vouched_at")?.notNull).toBe(false);
      const check = table.checks.find(
        (entry) => entry.name === `${name}_created_via_check`,
      );
      expect(check?.sql).toContain("'ui'");
      expect(check?.sql).toContain("'ai'");
      expect(check?.sql).toContain("'system'");
      expect(check?.sql).toContain("'webhook'");
    }
  });

  it("does not invent provenance columns on the excluded companies and files tables", () => {
    for (const name of ["companies", "files"] as const) {
      const table = requireTable(tables, name);
      expect(table.columns.map((column) => column.name)).not.toContain(
        "created_via",
      );
    }
  });
});
