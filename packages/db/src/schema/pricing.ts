/**
 * Price resolution tables (SHO-85, pricing-T1). Owned by the pricing module
 * (ADR-0014). Levels of the resolution chain (feature card):
 * personal → customer's list → group's list → company default list → base.
 * Prices are integer minor units (`_minor` bigint + currency, db.md §3);
 * zero is a valid price.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
  check,
  foreignKey,
  index,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { products, productVariants } from "./catalog.js";
import { companyCustomers } from "./customers.js";
import {
  recordProvenanceChecks,
  recordProvenanceColumns,
  tenantCompanyId,
  tenantRowUnique,
  timestampColumns,
} from "./tenant-columns.js";
import { nameFtsColumn } from "./tsvector.js";

/**
 * Named price tiers (SHO-171 adds `name`). At most one default list per
 * company (partial unique); inactive lists are skipped at every resolution
 * level but still returned by the staff list read.
 */
export const priceLists = pgTable(
  "price_lists",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: tenantCompanyId(),
    name: text("name").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    isDefault: boolean("is_default").notNull().default(false),
    ...timestampColumns(),
    ...recordProvenanceColumns(),
    nameFts: nameFtsColumn(),
  },
  (table) => [
    tenantRowUnique("price_lists_company_id_id_uq", table),
    uniqueIndex("price_lists_company_default_uq")
      .on(table.companyId)
      .where(sql`${table.isDefault} = true`),
    index("price_lists_name_trgm_idx").using(
      "gin",
      table.name.op("gin_trgm_ops"),
    ),
    index("price_lists_name_fts_gin_idx").using("gin", table.nameFts),
    check(
      "price_lists_name_length_check",
      sql`char_length(${table.name}) BETWEEN 1 AND 120`,
    ),
    ...recordProvenanceChecks("price_lists", table),
  ],
);

/**
 * Per-list prices at product or variant granularity (levels 2–4). Within a
 * level a variant entry beats a product entry. One product-level entry per
 * (list, product) and one variant-level entry per (list, product, variant)
 * — the two partial unique indexes. Rows are dependent pricing state:
 * deleting the list, product, or variant cascades here (feature card
 * "FK cascades"; resolution never reads stale entries).
 */
export const priceListEntries = pgTable(
  "price_list_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: tenantCompanyId(),
    priceListId: uuid("price_list_id").notNull(),
    productId: uuid("product_id").notNull(),
    variantId: uuid("variant_id"),
    priceMinor: bigint("price_minor", { mode: "bigint" }).notNull(),
    currency: char("currency", { length: 3 }).notNull().default("UAH"),
    ...timestampColumns(),
  },
  (table) => [
    tenantRowUnique("price_list_entries_company_id_id_uq", table),
    index("price_list_entries_price_list_idx").on(table.priceListId),
    index("price_list_entries_product_idx").on(table.productId),
    index("price_list_entries_variant_idx").on(table.variantId),
    foreignKey({
      name: "price_list_entries_price_lists_company_fk",
      columns: [table.companyId, table.priceListId],
      foreignColumns: [priceLists.companyId, priceLists.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "price_list_entries_products_company_fk",
      columns: [table.companyId, table.productId],
      foreignColumns: [products.companyId, products.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "price_list_entries_product_variants_company_fk",
      columns: [table.companyId, table.variantId],
      foreignColumns: [productVariants.companyId, productVariants.id],
    }).onDelete("cascade"),
    uniqueIndex("price_list_entries_list_product_uq")
      .on(table.priceListId, table.productId)
      .where(sql`${table.variantId} IS NULL`),
    uniqueIndex("price_list_entries_list_variant_uq")
      .on(table.priceListId, table.productId, table.variantId)
      .where(sql`${table.variantId} IS NOT NULL`),
    check(
      "price_list_entries_price_minor_check",
      sql`${table.priceMinor} >= 0`,
    ),
    check(
      "price_list_entries_currency_check",
      sql`${table.currency} ~ '^[A-Z]{3}$'`,
    ),
  ],
);

/**
 * Level-1 personal prices for a named CRM customer, at product or variant
 * granularity. One product-level row per (customer, product) and one
 * variant-level row per (customer, product, variant) — the other two
 * partial unique indexes. Dependent pricing state: deleting the customer,
 * product, or variant cascades here (feature card "FK cascades").
 */
export const personalPrices = pgTable(
  "personal_prices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: tenantCompanyId(),
    customerId: uuid("customer_id").notNull(),
    productId: uuid("product_id").notNull(),
    variantId: uuid("variant_id"),
    priceMinor: bigint("price_minor", { mode: "bigint" }).notNull(),
    currency: char("currency", { length: 3 }).notNull().default("UAH"),
    ...timestampColumns(),
  },
  (table) => [
    tenantRowUnique("personal_prices_company_id_id_uq", table),
    index("personal_prices_customer_idx").on(table.customerId),
    index("personal_prices_product_idx").on(table.productId),
    index("personal_prices_variant_idx").on(table.variantId),
    // Getter defers the customers ↔ pricing import cycle (ADR-0025).
    foreignKey({
      name: "personal_prices_company_customers_company_fk",
      columns: [table.companyId, table.customerId],
      get foreignColumns(): [
        typeof companyCustomers.companyId,
        typeof companyCustomers.id,
      ] {
        return [companyCustomers.companyId, companyCustomers.id];
      },
    }).onDelete("cascade"),
    foreignKey({
      name: "personal_prices_products_company_fk",
      columns: [table.companyId, table.productId],
      foreignColumns: [products.companyId, products.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "personal_prices_product_variants_company_fk",
      columns: [table.companyId, table.variantId],
      foreignColumns: [productVariants.companyId, productVariants.id],
    }).onDelete("cascade"),
    uniqueIndex("personal_prices_customer_product_uq")
      .on(table.customerId, table.productId)
      .where(sql`${table.variantId} IS NULL`),
    uniqueIndex("personal_prices_customer_variant_uq")
      .on(table.customerId, table.productId, table.variantId)
      .where(sql`${table.variantId} IS NOT NULL`),
    check("personal_prices_price_minor_check", sql`${table.priceMinor} >= 0`),
    check(
      "personal_prices_currency_check",
      sql`${table.currency} ~ '^[A-Z]{3}$'`,
    ),
  ],
);
