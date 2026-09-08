/**
 * Documents tables (SHO-228, documents-T1). Owned by the documents module
 * (ADR-0014). Line rows are immutable money snapshots (money.md): no
 * `updated_at`. Deliberately absent: `default_document_templates`, year on
 * the counter, `template_id` FK, `pdf_url`, order status, signature columns
 * (`sign_requested_at` is the HITL grant, not a signature). Named
 * nullable `basis` is create-time «Підстава» (SHO-365).
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  char,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { products, productVariants } from "./catalog.js";
import { counterparties } from "./customers.js";
import { orders } from "./orders.js";
import {
  recordProvenanceChecks,
  recordProvenanceColumns,
  tenantCompanyId,
  tenantRowUnique,
  timestampColumns,
} from "./tenant-columns.js";

/**
 * Tenant document header. Totals are sums of persisted line snapshots.
 * `issued_on` is the Kyiv calendar day written by create (T2), not a
 * server-TZ `now()` default.
 */
export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: tenantCompanyId(),
    orderId: uuid("order_id").notNull(),
    counterpartyId: uuid("counterparty_id"),
    type: text("type").notNull(),
    status: text("status").notNull().default("issued"),
    documentNumber: text("document_number").notNull(),
    issuedOn: date("issued_on", { mode: "string" }).notNull(),
    supplierDetails: jsonb("supplier_details").notNull(),
    buyerDetails: jsonb("buyer_details").notNull(),
    totalNetMinor: bigint("total_net_minor", { mode: "bigint" }).notNull(),
    totalTaxMinor: bigint("total_tax_minor", { mode: "bigint" }).notNull(),
    totalGrossMinor: bigint("total_gross_minor", { mode: "bigint" }).notNull(),
    currency: char("currency", { length: 3 }).notNull().default("UAH"),
    templateSource: text("template_source").notNull().default("system"),
    templateName: text("template_name").notNull(),
    ...timestampColumns(),
    ...recordProvenanceColumns(),
    signRequestedAt: timestamp("sign_requested_at", { withTimezone: true }),
    /**
     * Optional create-time «Підстава» (SHO-365). Snapshot string, not an
     * FK. Empty input is stored as null. Max 500 after trim.
     */
    basis: text("basis"),
  },
  (table) => [
    tenantRowUnique("documents_company_id_id_uq", table),
    unique("documents_company_type_document_number_uq").on(
      table.companyId,
      table.type,
      table.documentNumber,
    ),
    // SHO-533: left-prefix LIKE 'canonical%' on document_number. Unique
    // btree (company_id, type, document_number) does not put LIKE in
    // Index Cond; text_pattern_ops can. Mechanical schema amendment —
    // not a product fork (card: "EXPLAIN + text_pattern_ops if needed").
    index("documents_company_id_document_number_pattern_idx").on(
      table.companyId,
      table.documentNumber.op("text_pattern_ops"),
    ),
    uniqueIndex("documents_company_order_type_live_uq")
      .on(table.companyId, table.orderId, table.type)
      .where(sql`${table.status} <> 'cancelled'`),
    index("documents_company_created_at_idx").on(
      table.companyId,
      table.createdAt.desc().nullsFirst(),
      table.id.desc().nullsFirst(),
    ),
    index("documents_company_status_idx").on(table.companyId, table.status),
    index("documents_company_type_idx").on(table.companyId, table.type),
    index("documents_order_idx").on(table.orderId),
    index("documents_counterparty_idx").on(table.counterpartyId),
    foreignKey({
      name: "documents_orders_company_fk",
      columns: [table.companyId, table.orderId],
      foreignColumns: [orders.companyId, orders.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "documents_counterparties_company_fk",
      columns: [table.companyId, table.counterpartyId],
      foreignColumns: [counterparties.companyId, counterparties.id],
    }).onDelete("restrict"),
    check(
      "documents_type_check",
      sql`${table.type} IN ('payment_invoice', 'delivery_note')`,
    ),
    check(
      "documents_status_check",
      sql`${table.status} IN ('issued', 'cancelled')`,
    ),
    check("documents_total_net_minor_check", sql`${table.totalNetMinor} >= 0`),
    check("documents_total_tax_minor_check", sql`${table.totalTaxMinor} >= 0`),
    check(
      "documents_total_gross_minor_check",
      sql`${table.totalGrossMinor} >= 0`,
    ),
    check(
      "documents_template_source_check",
      sql`${table.templateSource} IN ('system')`,
    ),
    check("documents_currency_check", sql`${table.currency} ~ '^[A-Z]{3}$'`),
    check(
      "documents_basis_check",
      sql`${table.basis} IS NULL OR char_length(${table.basis}) BETWEEN 1 AND 500`,
    ),
    ...recordProvenanceChecks("documents", table),
  ],
);

/**
 * Immutable copies of order lines (money.md). Product and variant FKs are
 * RESTRICT so deleting catalog rows cannot erase issued document history.
 */
export const documentItems = pgTable(
  "document_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: tenantCompanyId(),
    documentId: uuid("document_id").notNull(),
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
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    tenantRowUnique("document_items_company_id_id_uq", table),
    index("document_items_document_idx").on(table.documentId),
    index("document_items_product_idx").on(table.productId),
    index("document_items_variant_idx").on(table.variantId),
    foreignKey({
      name: "document_items_documents_company_fk",
      columns: [table.companyId, table.documentId],
      foreignColumns: [documents.companyId, documents.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "document_items_products_company_fk",
      columns: [table.companyId, table.productId],
      foreignColumns: [products.companyId, products.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "document_items_product_variants_company_fk",
      columns: [table.companyId, table.variantId],
      foreignColumns: [productVariants.companyId, productVariants.id],
    }).onDelete("restrict"),
    check(
      "document_items_quantity_milli_check",
      sql`${table.quantityMilli} > 0`,
    ),
    check(
      "document_items_unit_price_minor_check",
      sql`${table.unitPriceMinor} >= 0`,
    ),
    check(
      "document_items_discount_kind_check",
      sql`${table.discountKind} IN ('none')`,
    ),
    check(
      "document_items_discount_amount_minor_check",
      sql`${table.discountAmountMinor} >= 0`,
    ),
    check(
      "document_items_tax_treatment_check",
      sql`${table.taxTreatment} IN ('exempt', 'inclusive', 'exclusive')`,
    ),
    check("document_items_tax_rate_bp_check", sql`${table.taxRateBp} >= 0`),
    check(
      "document_items_tax_amount_minor_check",
      sql`${table.taxAmountMinor} >= 0`,
    ),
    check(
      "document_items_net_amount_minor_check",
      sql`${table.netAmountMinor} >= 0`,
    ),
    check(
      "document_items_gross_amount_minor_check",
      sql`${table.grossAmountMinor} >= 0`,
    ),
    check(
      "document_items_currency_check",
      sql`${table.currency} ~ '^[A-Z]{3}$'`,
    ),
  ],
);

/**
 * Monotonic per-company, per-type sequence. PK has no year — numbering
 * does not reset at New Year. Handlers lock/upsert this row (T2).
 */
export const documentNumberCounters = pgTable(
  "document_number_counters",
  {
    companyId: tenantCompanyId(),
    type: text("type").notNull(),
    lastNumber: bigint("last_number", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
  },
  (table) => [
    primaryKey({
      name: "document_number_counters_pk",
      columns: [table.companyId, table.type],
    }),
    check(
      "document_number_counters_type_check",
      sql`${table.type} IN ('payment_invoice', 'delivery_note')`,
    ),
    check(
      "document_number_counters_last_number_check",
      sql`${table.lastNumber} >= 0`,
    ),
  ],
);

/**
 * Capability page tokens for unauthenticated handover. Raw token is never
 * stored — only the SHA-256 hex. One active (unrevoked) token per document.
 * `pdf_download_url` and `signed_download_url` are short-lived signatures,
 * not the 90-day page TTL. Signing after share writes the signed columns
 * on the active row and does not rotate `token_hash`.
 */
export const documentShareTokens = pgTable(
  "document_share_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: tenantCompanyId(),
    documentId: uuid("document_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    pdfDownloadUrl: text("pdf_download_url"),
    pdfDownloadExpiresAt: timestamp("pdf_download_expires_at", {
      withTimezone: true,
    }),
    signedDownloadUrl: text("signed_download_url"),
    signedDownloadExpiresAt: timestamp("signed_download_expires_at", {
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    tenantRowUnique("document_share_tokens_company_id_id_uq", table),
    unique("document_share_tokens_token_hash_uq").on(table.tokenHash),
    uniqueIndex("document_share_tokens_document_id_active_uq")
      .on(table.documentId)
      .where(sql`${table.revokedAt} IS NULL`),
    index("document_share_tokens_company_document_idx").on(
      table.companyId,
      table.documentId,
    ),
    foreignKey({
      name: "document_share_tokens_documents_company_fk",
      columns: [table.companyId, table.documentId],
      foreignColumns: [documents.companyId, documents.id],
    }).onDelete("cascade"),
    check(
      "document_share_tokens_token_hash_check",
      sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);
