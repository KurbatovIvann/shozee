/**
 * Shared tenant-row column helpers (SHO-294). Module schema files declare
 * `company_id`, `{ created_at, updated_at }`, and `UNIQUE (company_id, id)`
 * through these so the repeating Drizzle shape is written once.
 *
 * Do not use `tenantCompanyId` on `foundation.ts` (nullable `company_id`,
 * no FK). Do not use `timestampColumns` on snapshot/event tables that
 * only have `created_at`, on redemptions (no timestamps), or on
 * `order_number_counters`.
 *
 * Record provenance columns (SHO-465) live here so the nine AI-create
 * tables share one CHECK list with `audit_log.channel`. Do not add them
 * to `companies` or `files`.
 */
import { getTableName, sql } from "drizzle-orm";
import {
  check,
  text,
  timestamp,
  unique,
  uuid,
  type PgColumn,
  type UniqueConstraintBuilder,
} from "drizzle-orm/pg-core";

import { companies } from "./companies.js";

type TenantRow = {
  companyId: PgColumn;
  id: PgColumn;
};

/**
 * Column builder for module-owned tenant FKs to `companies`.
 * Every module `company_id` today is NOT NULL with ON DELETE CASCADE, so
 * the FK is part of the helper (unlike `userIdColumn`, whose ON DELETE
 * varies per table).
 */
export function tenantCompanyId() {
  return uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" });
}

/**
 * `{ createdAt, updatedAt }` both `timestamptz` notNull defaultNow.
 * Call only where both columns already exist.
 */
export function timestampColumns() {
  return {
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  };
}

/**
 * Channel values stored on `created_via`. Same four strings as
 * `audit_log.channel` / `ActionChannel` — duplicated here so `@showzy/db`
 * does not import `@showzy/core`.
 */
export const RECORD_CREATED_VIA_CHANNELS = [
  "ui",
  "ai",
  "system",
  "webhook",
] as const;

export type RecordCreatedVia = (typeof RECORD_CREATED_VIA_CHANNELS)[number];

type RecordProvenanceRow = {
  createdVia: PgColumn;
  vouchedBy: PgColumn;
  vouchedAt: PgColumn;
};

/**
 * Nullable provenance pair written at create (`created_via` from
 * `ctx.channel`) plus the unset vouching columns (SHO-465). Both
 * `vouched_by` and `vouched_at` stay null until a later ticket writes them.
 */
export function recordProvenanceColumns() {
  return {
    createdVia: text("created_via").$type<RecordCreatedVia | null>(),
    vouchedBy: text("vouched_by"),
    vouchedAt: timestamp("vouched_at", { withTimezone: true }),
  };
}

/**
 * `created_via` CHECK mirrors `audit_log_channel_check` (NULL is allowed
 * for pre-migration rows). `vouched_*` must be both null or both set.
 */
export function recordProvenanceChecks(
  tableName: string,
  table: RecordProvenanceRow,
): ReturnType<typeof check>[] {
  return [
    check(
      `${tableName}_created_via_check`,
      sql`${table.createdVia} IN ('ui', 'ai', 'system', 'webhook')`,
    ),
    check(
      `${tableName}_vouched_pair_check`,
      sql`(${table.vouchedBy} IS NULL) = (${table.vouchedAt} IS NULL)`,
    ),
  ];
}

/**
 * `UNIQUE (company_id, id)` with the existing `{table}_company_id_id_uq`
 * name so generate does not emit a rename.
 */
export function tenantRowUnique(table: TenantRow): UniqueConstraintBuilder;
export function tenantRowUnique(
  name: string,
  table: TenantRow,
): UniqueConstraintBuilder;
export function tenantRowUnique(
  nameOrTable: string | TenantRow,
  table?: TenantRow,
): UniqueConstraintBuilder {
  if (typeof nameOrTable !== "string") {
    return unique(
      `${getTableName(nameOrTable.companyId.table)}_company_id_id_uq`,
    ).on(nameOrTable.companyId, nameOrTable.id);
  }
  if (table === undefined) {
    throw new TypeError(
      `tenantRowUnique("${nameOrTable}", table) requires table columns`,
    );
  }
  return unique(nameOrTable).on(table.companyId, table.id);
}
