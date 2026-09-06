-- SHO-465 record provenance. Generated ADD COLUMN / CHECK, then a one-time
-- backfill of `created_via` from the earliest successful attesting create
-- `audit_log` row per (target_type, target_id). SHO-487: each CTE filters
-- target_type, action IN (attesting creates), and outcome = 'ok' so
-- DISTINCT ON never sorts discarded rows. Unmatched rows stay NULL — do
-- not guess 'ui'. Do not backfill vouched_by. No index on audit_log
-- (target_type, target_id).
--
-- Reverse (db.md §6 is forward-only; this is the documented inverse for
-- a restore + roll-forward world). Per table:
--   ALTER TABLE <t> DROP CONSTRAINT <t>_created_via_check;
--   ALTER TABLE <t> DROP CONSTRAINT <t>_vouched_pair_check;
--   ALTER TABLE <t> DROP COLUMN "created_via", DROP COLUMN "vouched_by",
--     DROP COLUMN "vouched_at";
ALTER TABLE "product_variants" ADD COLUMN "created_via" text;--> statement-breakpoint
ALTER TABLE "product_variants" ADD COLUMN "vouched_by" text;--> statement-breakpoint
ALTER TABLE "product_variants" ADD COLUMN "vouched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "created_via" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "vouched_by" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "vouched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "company_customers" ADD COLUMN "created_via" text;--> statement-breakpoint
ALTER TABLE "company_customers" ADD COLUMN "vouched_by" text;--> statement-breakpoint
ALTER TABLE "company_customers" ADD COLUMN "vouched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "counterparties" ADD COLUMN "created_via" text;--> statement-breakpoint
ALTER TABLE "counterparties" ADD COLUMN "vouched_by" text;--> statement-breakpoint
ALTER TABLE "counterparties" ADD COLUMN "vouched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customer_groups" ADD COLUMN "created_via" text;--> statement-breakpoint
ALTER TABLE "customer_groups" ADD COLUMN "vouched_by" text;--> statement-breakpoint
ALTER TABLE "customer_groups" ADD COLUMN "vouched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "created_via" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "vouched_by" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "vouched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "company_customer_invites" ADD COLUMN "created_via" text;--> statement-breakpoint
ALTER TABLE "company_customer_invites" ADD COLUMN "vouched_by" text;--> statement-breakpoint
ALTER TABLE "company_customer_invites" ADD COLUMN "vouched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "created_via" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "vouched_by" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "vouched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "price_lists" ADD COLUMN "created_via" text;--> statement-breakpoint
ALTER TABLE "price_lists" ADD COLUMN "vouched_by" text;--> statement-breakpoint
ALTER TABLE "price_lists" ADD COLUMN "vouched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_created_via_check" CHECK ("product_variants"."created_via" IN ('ui', 'ai', 'system', 'webhook'));--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_vouched_pair_check" CHECK (("product_variants"."vouched_by" IS NULL) = ("product_variants"."vouched_at" IS NULL));--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_created_via_check" CHECK ("products"."created_via" IN ('ui', 'ai', 'system', 'webhook'));--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_vouched_pair_check" CHECK (("products"."vouched_by" IS NULL) = ("products"."vouched_at" IS NULL));--> statement-breakpoint
ALTER TABLE "company_customers" ADD CONSTRAINT "company_customers_created_via_check" CHECK ("company_customers"."created_via" IN ('ui', 'ai', 'system', 'webhook'));--> statement-breakpoint
ALTER TABLE "company_customers" ADD CONSTRAINT "company_customers_vouched_pair_check" CHECK (("company_customers"."vouched_by" IS NULL) = ("company_customers"."vouched_at" IS NULL));--> statement-breakpoint
ALTER TABLE "counterparties" ADD CONSTRAINT "counterparties_created_via_check" CHECK ("counterparties"."created_via" IN ('ui', 'ai', 'system', 'webhook'));--> statement-breakpoint
ALTER TABLE "counterparties" ADD CONSTRAINT "counterparties_vouched_pair_check" CHECK (("counterparties"."vouched_by" IS NULL) = ("counterparties"."vouched_at" IS NULL));--> statement-breakpoint
ALTER TABLE "customer_groups" ADD CONSTRAINT "customer_groups_created_via_check" CHECK ("customer_groups"."created_via" IN ('ui', 'ai', 'system', 'webhook'));--> statement-breakpoint
ALTER TABLE "customer_groups" ADD CONSTRAINT "customer_groups_vouched_pair_check" CHECK (("customer_groups"."vouched_by" IS NULL) = ("customer_groups"."vouched_at" IS NULL));--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_created_via_check" CHECK ("documents"."created_via" IN ('ui', 'ai', 'system', 'webhook'));--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_vouched_pair_check" CHECK (("documents"."vouched_by" IS NULL) = ("documents"."vouched_at" IS NULL));--> statement-breakpoint
ALTER TABLE "company_customer_invites" ADD CONSTRAINT "company_customer_invites_created_via_check" CHECK ("company_customer_invites"."created_via" IN ('ui', 'ai', 'system', 'webhook'));--> statement-breakpoint
ALTER TABLE "company_customer_invites" ADD CONSTRAINT "company_customer_invites_vouched_pair_check" CHECK (("company_customer_invites"."vouched_by" IS NULL) = ("company_customer_invites"."vouched_at" IS NULL));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_created_via_check" CHECK ("orders"."created_via" IN ('ui', 'ai', 'system', 'webhook'));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_vouched_pair_check" CHECK (("orders"."vouched_by" IS NULL) = ("orders"."vouched_at" IS NULL));--> statement-breakpoint
ALTER TABLE "price_lists" ADD CONSTRAINT "price_lists_created_via_check" CHECK ("price_lists"."created_via" IN ('ui', 'ai', 'system', 'webhook'));--> statement-breakpoint
ALTER TABLE "price_lists" ADD CONSTRAINT "price_lists_vouched_pair_check" CHECK (("price_lists"."vouched_by" IS NULL) = ("price_lists"."vouched_at" IS NULL));--> statement-breakpoint
WITH earliest AS (
	SELECT DISTINCT ON ("target_type", "target_id")
		"target_type",
		"target_id",
		"channel"
	FROM "audit_log"
	WHERE "target_type" = 'order'
		AND "action" IN ('orders.create')
		AND "outcome" = 'ok'
	ORDER BY "target_type", "target_id", "created_at" ASC, "id" ASC
)
UPDATE "orders" AS t
SET "created_via" = earliest."channel"
FROM earliest
WHERE earliest."target_type" = 'order'
	AND earliest."target_id" = t."id"::text;--> statement-breakpoint
WITH earliest AS (
	SELECT DISTINCT ON ("target_type", "target_id")
		"target_type",
		"target_id",
		"channel"
	FROM "audit_log"
	WHERE "target_type" = 'customer'
		AND "action" IN ('customers.createCustomer', 'customers.applyInviteCrm')
		AND "outcome" = 'ok'
	ORDER BY "target_type", "target_id", "created_at" ASC, "id" ASC
)
UPDATE "company_customers" AS t
SET "created_via" = earliest."channel"
FROM earliest
WHERE earliest."target_type" = 'customer'
	AND earliest."target_id" = t."id"::text;--> statement-breakpoint
WITH earliest AS (
	SELECT DISTINCT ON ("target_type", "target_id")
		"target_type",
		"target_id",
		"channel"
	FROM "audit_log"
	WHERE "target_type" = 'counterparty'
		AND "action" IN ('customers.createCounterparty')
		AND "outcome" = 'ok'
	ORDER BY "target_type", "target_id", "created_at" ASC, "id" ASC
)
UPDATE "counterparties" AS t
SET "created_via" = earliest."channel"
FROM earliest
WHERE earliest."target_type" = 'counterparty'
	AND earliest."target_id" = t."id"::text;--> statement-breakpoint
WITH earliest AS (
	SELECT DISTINCT ON ("target_type", "target_id")
		"target_type",
		"target_id",
		"channel"
	FROM "audit_log"
	WHERE "target_type" = 'customer_group'
		AND "action" IN ('customers.createGroup')
		AND "outcome" = 'ok'
	ORDER BY "target_type", "target_id", "created_at" ASC, "id" ASC
)
UPDATE "customer_groups" AS t
SET "created_via" = earliest."channel"
FROM earliest
WHERE earliest."target_type" = 'customer_group'
	AND earliest."target_id" = t."id"::text;--> statement-breakpoint
WITH earliest AS (
	SELECT DISTINCT ON ("target_type", "target_id")
		"target_type",
		"target_id",
		"channel"
	FROM "audit_log"
	WHERE "target_type" = 'product'
		AND "action" IN ('catalog.createProduct')
		AND "outcome" = 'ok'
	ORDER BY "target_type", "target_id", "created_at" ASC, "id" ASC
)
UPDATE "products" AS t
SET "created_via" = earliest."channel"
FROM earliest
WHERE earliest."target_type" = 'product'
	AND earliest."target_id" = t."id"::text;--> statement-breakpoint
WITH earliest AS (
	SELECT DISTINCT ON ("target_type", "target_id")
		"target_type",
		"target_id",
		"channel"
	FROM "audit_log"
	WHERE "target_type" = 'variant'
		AND "action" IN ('catalog.createVariant')
		AND "outcome" = 'ok'
	ORDER BY "target_type", "target_id", "created_at" ASC, "id" ASC
)
UPDATE "product_variants" AS t
SET "created_via" = earliest."channel"
FROM earliest
WHERE earliest."target_type" = 'variant'
	AND earliest."target_id" = t."id"::text;--> statement-breakpoint
WITH earliest AS (
	SELECT DISTINCT ON ("target_type", "target_id")
		"target_type",
		"target_id",
		"channel"
	FROM "audit_log"
	WHERE "target_type" = 'price_list'
		AND "action" IN ('pricing.createPriceList')
		AND "outcome" = 'ok'
	ORDER BY "target_type", "target_id", "created_at" ASC, "id" ASC
)
UPDATE "price_lists" AS t
SET "created_via" = earliest."channel"
FROM earliest
WHERE earliest."target_type" = 'price_list'
	AND earliest."target_id" = t."id"::text;--> statement-breakpoint
WITH earliest AS (
	SELECT DISTINCT ON ("target_type", "target_id")
		"target_type",
		"target_id",
		"channel"
	FROM "audit_log"
	WHERE "target_type" = 'document'
		AND "action" IN ('documents.createFromOrder')
		AND "outcome" = 'ok'
	ORDER BY "target_type", "target_id", "created_at" ASC, "id" ASC
)
UPDATE "documents" AS t
SET "created_via" = earliest."channel"
FROM earliest
WHERE earliest."target_type" = 'document'
	AND earliest."target_id" = t."id"::text;--> statement-breakpoint
WITH earliest AS (
	SELECT DISTINCT ON ("target_type", "target_id")
		"target_type",
		"target_id",
		"channel"
	FROM "audit_log"
	WHERE "target_type" = 'invite'
		AND "action" IN ('invites.create')
		AND "outcome" = 'ok'
	ORDER BY "target_type", "target_id", "created_at" ASC, "id" ASC
)
UPDATE "company_customer_invites" AS t
SET "created_via" = earliest."channel"
FROM earliest
WHERE earliest."target_type" = 'invite'
	AND earliest."target_id" = t."id"::text;
