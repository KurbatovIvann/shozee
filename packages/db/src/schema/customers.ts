/**
 * CRM commercial spine (SHO-85 pricing assignments, SHO-170 CRM columns).
 * Owned by the customers module (ADR-0014, ADR-0028). Counterparties are the
 * company-scoped legal face; `customer_legal_profiles` is the account-scoped
 * legal face (no `company_id`). No embedding, invite_id, group color, or
 * counterparty archive column.
 */
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { userIdColumn } from "./auth-ids.js";
import { user } from "./auth.js";
import { priceLists } from "./pricing.js";
import {
  recordProvenanceChecks,
  recordProvenanceColumns,
  tenantCompanyId,
  tenantRowUnique,
  timestampColumns,
} from "./tenant-columns.js";

/**
 * Customer segmentation groups carrying the level-3 price-list assignment.
 * Deleting a price list unlinks the group (SET NULL) so resolution falls
 * through to the next level instead of blocking pricing-owned deletes.
 */
export const customerGroups = pgTable(
  "customer_groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: tenantCompanyId(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    sortOrder: integer("sort_order").notNull().default(0),
    priceListId: uuid("price_list_id"),
    ...timestampColumns(),
    ...recordProvenanceColumns(),
  },
  (table) => [
    tenantRowUnique("customer_groups_company_id_id_uq", table),
    unique("customer_groups_company_slug_uq").on(table.companyId, table.slug),
    check("customer_groups_sort_order_check", sql`${table.sortOrder} >= 0`),
    index("customer_groups_price_list_idx").on(table.priceListId),
    // Getter defers the customers ↔ pricing import cycle (ADR-0025).
    // ON DELETE SET NULL is scoped to price_list_id in 0011 (db.md §7).
    foreignKey({
      name: "customer_groups_price_lists_company_fk",
      columns: [table.companyId, table.priceListId],
      get foreignColumns(): [
        typeof priceLists.companyId,
        typeof priceLists.id,
      ] {
        return [priceLists.companyId, priceLists.id];
      },
    }).onDelete("set null"),
    ...recordProvenanceChecks("customer_groups", table),
  ],
);

/**
 * Company CRM customer records: commercial spine (ADR-0028). Level-2
 * price-list assignment and group membership used at level 3. Deleting a
 * group or a price list unlinks (SET NULL) — resolution falls through.
 */
export const companyCustomers = pgTable(
  "company_customers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: tenantCompanyId(),
    name: text("name").notNull(),
    phone: text("phone"),
    email: text("email"),
    userId: userIdColumn("user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    notes: text("notes"),
    status: text("status").notNull().default("active"),
    groupId: uuid("group_id"),
    priceListId: uuid("price_list_id"),
    ...timestampColumns(),
    ...recordProvenanceColumns(),
  },
  (table) => [
    tenantRowUnique("company_customers_company_id_id_uq", table),
    uniqueIndex("company_customers_company_user_uq")
      .on(table.companyId, table.userId)
      .where(sql`${table.userId} IS NOT NULL`),
    index("company_customers_company_updated_at_id_idx").on(
      table.companyId,
      table.updatedAt.desc().nullsFirst(),
      table.id.desc().nullsFirst(),
    ),
    index("company_customers_company_status_idx").on(
      table.companyId,
      table.status,
    ),
    index("company_customers_company_group_idx")
      .on(table.companyId, table.groupId)
      .where(sql`${table.groupId} IS NOT NULL`),
    index("company_customers_price_list_idx").on(table.priceListId),
    index("company_customers_company_phone_unlinked_idx")
      .on(table.companyId, table.phone)
      .where(sql`${table.userId} IS NULL`),
    index("company_customers_company_email_unlinked_idx")
      .on(table.companyId, table.email)
      .where(sql`${table.userId} IS NULL`),
    // SHO-396 / SHO-398: GIN trigram on name accelerates `%stem%` ILIKE.
    // pg_trgm is already installed (0007). company_id stays on the
    // existing btree indexes; the matcher ANDs tenant scope in SQL.
    index("company_customers_name_trgm_idx").using(
      "gin",
      table.name.op("gin_trgm_ops"),
    ),
    foreignKey({
      name: "company_customers_customer_groups_company_fk",
      columns: [table.companyId, table.groupId],
      foreignColumns: [customerGroups.companyId, customerGroups.id],
    }).onDelete("set null"),
    // Getter defers the customers ↔ pricing import cycle (ADR-0025).
    // ON DELETE SET NULL is scoped to price_list_id in 0011 (db.md §7).
    foreignKey({
      name: "company_customers_price_lists_company_fk",
      columns: [table.companyId, table.priceListId],
      get foreignColumns(): [
        typeof priceLists.companyId,
        typeof priceLists.id,
      ] {
        return [priceLists.companyId, priceLists.id];
      },
    }).onDelete("set null"),
    check(
      "company_customers_status_check",
      sql`${table.status} IN ('active', 'archived')`,
    ),
    // Application writes still need a contact. User delete SET NULLs
    // user_id; 0025 stamps a placeholder email first when it is the only
    // contact so the CHECK and SET NULL can both hold (db.md §7).
    check(
      "company_customers_contact_check",
      sql`${table.phone} IS NOT NULL OR ${table.email} IS NOT NULL OR ${table.userId} IS NOT NULL`,
    ),
    ...recordProvenanceChecks("company_customers", table),
  ],
);

/**
 * Company-owned legal face for documents (ADR-0028). Optional link to a
 * CRM customer (0..N per customer, or standalone). Groups and price lists
 * never hang here. ON DELETE SET NULL is scoped to customer_id (db.md §7).
 */
export const counterparties = pgTable(
  "counterparties",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: tenantCompanyId(),
    customerId: uuid("customer_id"),
    name: text("name").notNull(),
    edrpou: text("edrpou"),
    legalAddress: text("legal_address"),
    iban: text("iban"),
    bankName: text("bank_name"),
    bankMfo: text("bank_mfo"),
    phone: text("phone"),
    email: text("email"),
    notes: text("notes"),
    ...timestampColumns(),
    ...recordProvenanceColumns(),
  },
  (table) => [
    tenantRowUnique("counterparties_company_id_id_uq", table),
    uniqueIndex("counterparties_company_edrpou_uq")
      .on(table.companyId, table.edrpou)
      .where(sql`${table.edrpou} IS NOT NULL`),
    index("counterparties_company_updated_at_id_idx").on(
      table.companyId,
      table.updatedAt.desc().nullsFirst(),
      table.id.desc().nullsFirst(),
    ),
    index("counterparties_company_customer_idx").on(
      table.companyId,
      table.customerId,
    ),
    foreignKey({
      name: "counterparties_company_customers_company_fk",
      columns: [table.companyId, table.customerId],
      foreignColumns: [companyCustomers.companyId, companyCustomers.id],
    }).onDelete("set null"),
    ...recordProvenanceChecks("counterparties", table),
  ],
);

/**
 * Account-scoped legal requisites (ADR-0028 / db.md tenancy exception).
 * No `company_id`. The customer upserts this profile; staff counterparties
 * stay company-scoped. v1 table name was `customer_legal_info`.
 */
export const customerLegalProfiles = pgTable(
  "customer_legal_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: userIdColumn("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    entityType: text("entity_type").notNull().default("fop"),
    legalName: text("legal_name"),
    edrpou: text("edrpou"),
    legalAddress: text("legal_address"),
    iban: text("iban"),
    bankName: text("bank_name"),
    bankMfo: text("bank_mfo"),
    phone: text("phone"),
    email: text("email"),
    ...timestampColumns(),
  },
  (table) => [
    unique("customer_legal_profiles_user_id_uq").on(table.userId),
    check(
      "customer_legal_profiles_entity_type_check",
      sql`${table.entityType} IN ('fop', 'tov')`,
    ),
  ],
);
