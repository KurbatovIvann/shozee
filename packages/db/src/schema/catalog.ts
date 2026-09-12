/**
 * Catalog slice for price resolution (SHO-85), order-line titles (SHO-90),
 * and staff catalog status + media (SHO-131). Owned by the catalog module
 * (ADR-0014). Deliberately absent: sku.
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
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { files } from "./files.js";
import {
  recordProvenanceChecks,
  recordProvenanceColumns,
  tenantCompanyId,
  tenantRowUnique,
  timestampColumns,
} from "./tenant-columns.js";
import { nameFtsColumn } from "./tsvector.js";

/** Products carry the display name and the level-5 base price. */
export const products = pgTable(
  "products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: tenantCompanyId(),
    name: text("name").notNull(),
    basePriceMinor: bigint("base_price_minor", { mode: "bigint" }).notNull(),
    currency: char("currency", { length: 3 }).notNull().default("UAH"),
    status: text("status").notNull().default("active"),
    ...timestampColumns(),
    ...recordProvenanceColumns(),
    // SHO-528: generated name FTS for staff matchers (simple, weight A).
    // Not an ADR-0020 discovery projection; not schema/search.ts.
    nameFts: nameFtsColumn(),
  },
  (table) => [
    tenantRowUnique("products_company_id_id_uq", table),
    index("products_company_created_at_id_idx").on(
      table.companyId,
      table.createdAt.desc().nullsFirst(),
      table.id.desc().nullsFirst(),
    ),
    index("products_company_status_idx").on(table.companyId, table.status),
    // SHO-396 / SHO-400 / SHO-528: GIN trigram on name for `%stem%` ILIKE
    // and word_similarity. pg_trgm is already installed (0007). company_id
    // stays on the existing btree indexes; the matcher ANDs tenant scope.
    index("products_name_trgm_idx").using("gin", table.name.op("gin_trgm_ops")),
    index("products_name_fts_gin_idx").using("gin", table.nameFts),
    check("products_base_price_minor_check", sql`${table.basePriceMinor} >= 0`),
    check(
      "products_status_check",
      sql`${table.status} IN ('active', 'archived')`,
    ),
    check("products_currency_check", sql`${table.currency} ~ '^[A-Z]{3}$'`),
    ...recordProvenanceChecks("products", table),
  ],
);

/**
 * Variants carry an optional base-price override used at level 5 when set;
 * otherwise resolution falls back to the product base price. The override
 * price and its currency are set or null together (consistency CHECK).
 */
export const productVariants = pgTable(
  "product_variants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: tenantCompanyId(),
    // Same-module ownership: a product deletion removes its variants.
    productId: uuid("product_id").notNull(),
    name: text("name").notNull(),
    basePriceMinor: bigint("base_price_minor", { mode: "bigint" }),
    currency: char("currency", { length: 3 }),
    status: text("status").notNull().default("active"),
    ...timestampColumns(),
    ...recordProvenanceColumns(),
    nameFts: nameFtsColumn(),
  },
  (table) => [
    tenantRowUnique("product_variants_company_id_id_uq", table),
    index("product_variants_product_idx").on(table.productId),
    index("product_variants_name_trgm_idx").using(
      "gin",
      table.name.op("gin_trgm_ops"),
    ),
    index("product_variants_name_fts_gin_idx").using("gin", table.nameFts),
    foreignKey({
      name: "product_variants_products_company_fk",
      columns: [table.companyId, table.productId],
      foreignColumns: [products.companyId, products.id],
    }).onDelete("cascade"),
    check(
      "product_variants_base_price_minor_check",
      sql`${table.basePriceMinor} IS NULL OR ${table.basePriceMinor} >= 0`,
    ),
    check(
      "product_variants_price_currency_check",
      sql`(${table.basePriceMinor} IS NULL) = (${table.currency} IS NULL)`,
    ),
    check(
      "product_variants_currency_check",
      sql`${table.currency} IS NULL OR ${table.currency} ~ '^[A-Z]{3}$'`,
    ),
    check(
      "product_variants_status_check",
      sql`${table.status} IN ('active', 'archived')`,
    ),
    ...recordProvenanceChecks("product_variants", table),
  ],
);

/**
 * Ordered product↔file links (SHO-131). Same-tenant FKs (ADR-0025): product
 * deletion removes media rows; a referenced file cannot be deleted while
 * linked. Unique file per product; position is a non-negative sort key.
 */
export const productMedia = pgTable(
  "product_media",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: tenantCompanyId(),
    productId: uuid("product_id").notNull(),
    fileId: uuid("file_id").notNull(),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    tenantRowUnique("product_media_company_id_id_uq", table),
    unique("product_media_product_file_uq").on(
      table.companyId,
      table.productId,
      table.fileId,
    ),
    index("product_media_product_idx").on(
      table.companyId,
      table.productId,
      table.position,
    ),
    index("product_media_file_idx").on(table.companyId, table.fileId),
    foreignKey({
      name: "product_media_products_company_fk",
      columns: [table.companyId, table.productId],
      foreignColumns: [products.companyId, products.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "product_media_files_company_fk",
      columns: [table.companyId, table.fileId],
      foreignColumns: [files.companyId, files.id],
    }).onDelete("restrict"),
    check("product_media_position_check", sql`${table.position} >= 0`),
  ],
);
