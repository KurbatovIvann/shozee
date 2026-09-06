/**
 * Drizzle → contract-check schema catalog (SHO-467). The provenance rule
 * walks this structural list, not live Postgres.
 */
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";

import type { SchemaTableRef } from "./record-provenance.js";

function flattenSqlText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(flattenSqlText).join("");
  }
  if (value === null || typeof value !== "object") {
    return "";
  }
  if ("queryChunks" in value && Array.isArray(value.queryChunks)) {
    return value.queryChunks.map(flattenSqlText).join("");
  }
  if ("value" in value) {
    return flattenSqlText(value.value);
  }
  if ("name" in value && typeof value.name === "string") {
    return value.name;
  }
  return "";
}

export function schemaTableRefFromPgTable(
  owner: string,
  table: PgTable,
): SchemaTableRef {
  const config = getTableConfig(table);
  return {
    owner,
    name: config.name,
    columns: config.columns.map((column) => ({
      name: column.name,
      notNull: column.notNull,
    })),
    checks: config.checks.map((check) => ({
      name: check.name,
      sql: flattenSqlText(check.value),
    })),
  };
}

/**
 * Walk owned schema namespaces (`@showzy/db` module files) and collect
 * every `pgTable`. New schema files must be added to the composition
 * catalog so AI-exposed creates can resolve their table.
 */
export function schemaTablesFromModules(
  modules: Readonly<Record<string, object>>,
): readonly SchemaTableRef[] {
  const tables: SchemaTableRef[] = [];
  for (const [owner, namespace] of Object.entries(modules)) {
    for (const value of Object.values(namespace)) {
      if (is(value, PgTable)) {
        tables.push(schemaTableRefFromPgTable(owner, value));
      }
    }
  }
  return tables;
}
