/**
 * Staff-order tables (SHO-91, orders-T1; SHO-250 text order_number).
 * Owned by the orders module (ADR-0014). Line rows are immutable money
 * snapshots (money.md): no `updated_at`, and pricing provenance ids are
 * stored without FKs so catalog/pricing deletes cannot rewrite history.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  char,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
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

/**
 * Tenant order header. `canceled` is declared for forward-compat; this
 * slice never writes it. Totals are sums of persisted line snapshots.
 */
export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: tenantCompanyId(),
    /**
     * Per-company display number (SHO-250). Stored as `{prefix}-{token}`
     * (v1 `obfuscate_seq` / `to_base36`). Assigned in `orders.create`.
     */
    orderNumber: text("order_number").notNull(),
    customerId: uuid("customer_id"),
    /**
     * Header CRM name captured at write time (SHO-351 / ADR-0033).
     * Unlinked rows (`customer_id` null) store sentinel `unlinked`;
     * presenters localize it. No column default: `orders.create` always
     * writes the snapshot, and forgotten inserts must fail NOT NULL.
     */
    customerNameSnapshot: text("customer_name_snapshot").notNull(),
    status: text("status").notNull().default("new"),
    comment: text("comment"),
    totalNetMinor: bigint("total_net_minor", { mode: "bigint" }).notNull(),
    totalTaxMinor: bigint("total_tax_minor", { mode: "bigint" }).notNull(),
    totalGrossMinor: bigint("total_gross_minor", { mode: "bigint" }).notNull(),
    currency: char("currency", { length: 3 }).notNull().default("UAH"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    ...timestampColumns(),
    ...recordProvenanceColumns(),
  },
  (table) => [
    tenantRowUnique("orders_company_id_id_uq", table),
    unique("orders_company_id_order_number_uq").on(
      table.companyId,
      table.orderNumber,
    ),
    index("orders_company_created_at_idx").on(
      table.companyId,
      table.createdAt.desc().nullsFirst(),
      table.id.desc().nullsFirst(),
    ),
    index("orders_company_status_idx").on(table.companyId, table.status),
    index("orders_company_status_created_at_id_idx").on(
      table.companyId,
      table.status,
      table.createdAt.desc().nullsFirst(),
      table.id.desc().nullsFirst(),
    ),
    index("orders_customer_idx").on(table.customerId),
    index("orders_company_customer_id_created_at_id_idx").on(
      table.companyId,
      table.customerId,
      table.createdAt.desc().nullsFirst(),
      table.id.desc().nullsFirst(),
    ),
    // ON DELETE SET NULL is scoped to customer_id in the follow-up custom
    // migration (db.md §7 / ADR-0025).
    foreignKey({
      name: "orders_company_customers_company_fk",
      columns: [table.companyId, table.customerId],
      foreignColumns: [companyCustomers.companyId, companyCustomers.id],
    }).onDelete("set null"),
    check(
      "orders_status_check",
      sql`${table.status} IN ('new', 'confirmed', 'in_progress', 'done', 'canceled')`,
    ),
    check(
      "orders_confirmed_requires_confirmed_at_check",
      sql`${table.status} NOT IN ('confirmed', 'in_progress', 'done') OR ${table.confirmedAt} IS NOT NULL`,
    ),
    check(
      "orders_new_forbids_confirmed_at_check",
      sql`${table.status} <> 'new' OR ${table.confirmedAt} IS NULL`,
    ),
    check(
      "orders_order_number_shape_check",
      sql`${table.orderNumber} ~ '^[A-Z0-9]+-[0-9A-Z]+$'`,
    ),
    check(
      "orders_customer_name_snapshot_check",
      sql`char_length(${table.customerNameSnapshot}) > 0`,
    ),
    check("orders_total_net_minor_check", sql`${table.totalNetMinor} >= 0`),
    check("orders_total_tax_minor_check", sql`${table.totalTaxMinor} >= 0`),
    check("orders_total_gross_minor_check", sql`${table.totalGrossMinor} >= 0`),
    check("orders_currency_check", sql`${table.currency} ~ '^[A-Z]{3}$'`),
    ...recordProvenanceChecks("orders", table),
  ],
);

/**
 * Immutable order-line snapshots. Product and variant FKs are RESTRICT so
 * deleting catalog rows cannot erase financial history. Provenance columns
 * (`personal_price_id`, `price_list_id`, `price_list_entry_id`) are
 * historical references with no FK.
 */
export const orderItems = pgTable(
  "order_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: tenantCompanyId(),
    orderId: uuid("order_id").notNull(),
    productId: uuid("product_id").notNull(),
    variantId: uuid("variant_id"),
    titleSnapshot: text("title_snapshot").notNull(),
    quantityMilli: bigint("quantity_milli", { mode: "bigint" }).notNull(),
    unitPriceMinor: bigint("unit_price_minor", { mode: "bigint" }).notNull(),
    discountKind: text("discount_kind").notNull().default("none"),
    discountValue: bigint("discount_value", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    discountAmountMinor: bigint("discount_amount_minor", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    taxTreatment: text("tax_treatment").notNull(),
    taxRateBp: integer("tax_rate_bp").notNull().default(0),
    taxAmountMinor: bigint("tax_amount_minor", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    netAmountMinor: bigint("net_amount_minor", { mode: "bigint" }).notNull(),
    grossAmountMinor: bigint("gross_amount_minor", {
      mode: "bigint",
    }).notNull(),
    currency: char("currency", { length: 3 }).notNull().default("UAH"),
    priceSource: text("price_source"),
    personalPriceId: uuid("personal_price_id"),
    priceListId: uuid("price_list_id"),
    priceListEntryId: uuid("price_list_entry_id"),
    resolverVersion: integer("resolver_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    tenantRowUnique("order_items_company_id_id_uq", table),
    index("order_items_order_idx").on(table.orderId),
    index("order_items_company_order_id_idx").on(
      table.companyId,
      table.orderId,
    ),
    index("order_items_product_idx").on(table.productId),
    index("order_items_variant_idx").on(table.variantId),
    foreignKey({
      name: "order_items_orders_company_fk",
      columns: [table.companyId, table.orderId],
      foreignColumns: [orders.companyId, orders.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "order_items_products_company_fk",
      columns: [table.companyId, table.productId],
      foreignColumns: [products.companyId, products.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "order_items_product_variants_company_fk",
      columns: [table.companyId, table.variantId],
      foreignColumns: [productVariants.companyId, productVariants.id],
    }).onDelete("restrict"),
    check("order_items_quantity_milli_check", sql`${table.quantityMilli} > 0`),
    check(
      "order_items_unit_price_minor_check",
      sql`${table.unitPriceMinor} >= 0`,
    ),
    check(
      "order_items_discount_kind_check",
      sql`${table.discountKind} IN ('none')`,
    ),
    check(
      "order_items_discount_amount_minor_check",
      sql`${table.discountAmountMinor} >= 0`,
    ),
    check(
      "order_items_tax_treatment_check",
      sql`${table.taxTreatment} IN ('exempt', 'inclusive', 'exclusive')`,
    ),
    check("order_items_tax_rate_bp_check", sql`${table.taxRateBp} >= 0`),
    check(
      "order_items_tax_amount_minor_check",
      sql`${table.taxAmountMinor} >= 0`,
    ),
    check(
      "order_items_net_amount_minor_check",
      sql`${table.netAmountMinor} >= 0`,
    ),
    check(
      "order_items_gross_amount_minor_check",
      sql`${table.grossAmountMinor} >= 0`,
    ),
    check(
      "order_items_price_source_check",
      sql`${table.priceSource} IN ('personal', 'customer_price_list', 'group_price_list', 'default_price_list', 'base')`,
    ),
    check("order_items_currency_check", sql`${table.currency} ~ '^[A-Z]{3}$'`),
  ],
);

/**
 * Monotonic per-company sequence for staff order numbers (SHO-250).
 * `company_id` is the PK. Handlers upsert this row (documents-style);
 * they do not lock every order row. `last_number` is the last allocated
 * integer sequence, not the display token.
 */
export const orderNumberCounters = pgTable(
  "order_number_counters",
  {
    companyId: tenantCompanyId(),
    lastNumber: bigint("last_number", { mode: "bigint" }).notNull(),
  },
  (table) => [
    primaryKey({
      name: "order_number_counters_pk",
      columns: [table.companyId],
    }),
    check(
      "order_number_counters_last_number_check",
      sql`${table.lastNumber} > 0`,
    ),
  ],
);
