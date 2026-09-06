/**
 * Customer-entry invite tokens and redemptions (SHO-202 / SHO-201). Owned
 * by the invites module (ADR-0014, ADR-0028). TRANSFORM of v1
 * `company_customer_invites`: store SHA-256 hex only (no plaintext token),
 * no `company_customer_id` on the invite row (reusable has many acceptors),
 * no `invite_id` on `company_customers`. Expired / exhausted are derived;
 * `status` is only `pending` | `revoked`.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { userIdColumn } from "./auth-ids.js";
import { user } from "./auth.js";
import { companyCustomers, customerGroups } from "./customers.js";
import { priceLists } from "./pricing.js";
import {
  recordProvenanceChecks,
  recordProvenanceColumns,
  tenantCompanyId,
  tenantRowUnique,
  timestampColumns,
} from "./tenant-columns.js";

/**
 * Staff-created customer-entry invite. Lookup is by globally unique
 * `token_hash`, not tenant. Group / price-list assignments unlink
 * (SET NULL on those columns only) so a catalog delete cannot null
 * `company_id` (ADR-0025 / db.md §7).
 */
export const companyCustomerInvites = pgTable(
  "company_customer_invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: tenantCompanyId(),
    invitedBy: userIdColumn("invited_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    tokenHash: text("token_hash").notNull(),
    isReusable: boolean("is_reusable").notNull(),
    maxUses: integer("max_uses"),
    usesCount: integer("uses_count").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("pending"),
    groupId: uuid("group_id"),
    priceListId: uuid("price_list_id"),
    name: text("name"),
    phone: text("phone"),
    email: text("email"),
    ...timestampColumns(),
    ...recordProvenanceColumns(),
  },
  (table) => [
    tenantRowUnique("company_customer_invites_company_id_id_uq", table),
    unique("company_customer_invites_token_hash_uq").on(table.tokenHash),
    index("company_customer_invites_company_updated_at_id_idx").on(
      table.companyId,
      table.updatedAt.desc().nullsFirst(),
      table.id.desc().nullsFirst(),
    ),
    index("company_customer_invites_company_status_idx").on(
      table.companyId,
      table.status,
    ),
    index("company_customer_invites_company_group_idx")
      .on(table.companyId, table.groupId)
      .where(sql`${table.groupId} IS NOT NULL`),
    index("company_customer_invites_company_price_list_idx")
      .on(table.companyId, table.priceListId)
      .where(sql`${table.priceListId} IS NOT NULL`),
    index("company_customer_invites_pending_expires_at_idx")
      .on(table.expiresAt)
      .where(sql`${table.status} = 'pending'`),
    // ON DELETE SET NULL is scoped to group_id / price_list_id in the
    // generated migration (ADR-0025, db.md §7).
    foreignKey({
      name: "company_customer_invites_customer_groups_company_fk",
      columns: [table.companyId, table.groupId],
      foreignColumns: [customerGroups.companyId, customerGroups.id],
    }).onDelete("set null"),
    foreignKey({
      name: "company_customer_invites_price_lists_company_fk",
      columns: [table.companyId, table.priceListId],
      foreignColumns: [priceLists.companyId, priceLists.id],
    }).onDelete("set null"),
    check(
      "company_customer_invites_status_check",
      sql`${table.status} IN ('pending', 'revoked')`,
    ),
    check(
      "company_customer_invites_uses_count_check",
      sql`${table.usesCount} >= 0`,
    ),
    check(
      "company_customer_invites_max_uses_check",
      sql`${table.maxUses} IS NULL OR ${table.maxUses} >= 1`,
    ),
    check(
      "company_customer_invites_uses_within_max_check",
      sql`${table.maxUses} IS NULL OR ${table.usesCount} <= ${table.maxUses}`,
    ),
    // Personal: is_reusable = false AND max_uses = 1. Reusable may have
    // max_uses NULL or >= 1 (enforced with max_uses_check). `max_uses = 1`
    // is NULL when the column is NULL, which would pass a CHECK — require
    // NOT NULL so a personal row cannot omit max_uses.
    check(
      "company_customer_invites_personal_check",
      sql`${table.isReusable} = true OR (${table.maxUses} IS NOT NULL AND ${table.maxUses} = 1)`,
    ),
    ...recordProvenanceChecks("company_customer_invites", table),
  ],
);

/**
 * One redemption per (invite, acceptor). The CRM row is the commercial
 * spine created or enriched on accept (ADR-0028); this table only records
 * that pairing. No `updated_at` — the row is an accept event.
 */
export const companyCustomerInviteRedemptions = pgTable(
  "company_customer_invite_redemptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    inviteId: uuid("invite_id").notNull(),
    companyId: tenantCompanyId(),
    userId: userIdColumn("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    companyCustomerId: uuid("company_customer_id").notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    tenantRowUnique(
      "company_customer_invite_redemptions_company_id_id_uq",
      table,
    ),
    unique("company_customer_invite_redemptions_invite_user_uq").on(
      table.inviteId,
      table.userId,
    ),
    index("company_customer_invite_redemptions_company_customer_idx").on(
      table.companyId,
      table.companyCustomerId,
    ),
    foreignKey({
      name: "company_customer_invite_redemptions_invites_company_fk",
      columns: [table.companyId, table.inviteId],
      foreignColumns: [
        companyCustomerInvites.companyId,
        companyCustomerInvites.id,
      ],
    }).onDelete("cascade"),
    // Name stays under PostgreSQL's 63-byte identifier limit (the
    // `..._company_customers_company_fk` form truncates).
    foreignKey({
      name: "company_customer_invite_redemptions_customers_company_fk",
      columns: [table.companyId, table.companyCustomerId],
      foreignColumns: [companyCustomers.companyId, companyCustomers.id],
    }).onDelete("cascade"),
  ],
);
