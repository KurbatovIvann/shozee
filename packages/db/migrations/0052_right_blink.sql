ALTER TABLE "product_variants" ADD COLUMN "name_fts" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple'::regconfig, coalesce("name", '')), 'A')) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "name_fts" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple'::regconfig, coalesce("name", '')), 'A')) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "company_customers" ADD COLUMN "name_fts" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple'::regconfig, coalesce("name", '')), 'A')) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "counterparties" ADD COLUMN "name_fts" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple'::regconfig, coalesce("name", '')), 'A')) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_groups" ADD COLUMN "name_fts" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple'::regconfig, coalesce("name", '')), 'A')) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "price_lists" ADD COLUMN "name_fts" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple'::regconfig, coalesce("name", '')), 'A')) STORED NOT NULL;--> statement-breakpoint
CREATE INDEX "product_variants_name_trgm_idx" ON "product_variants" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "product_variants_name_fts_gin_idx" ON "product_variants" USING gin ("name_fts");--> statement-breakpoint
CREATE INDEX "products_name_fts_gin_idx" ON "products" USING gin ("name_fts");--> statement-breakpoint
CREATE INDEX "company_customers_name_fts_gin_idx" ON "company_customers" USING gin ("name_fts");--> statement-breakpoint
CREATE INDEX "counterparties_name_trgm_idx" ON "counterparties" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "counterparties_name_fts_gin_idx" ON "counterparties" USING gin ("name_fts");--> statement-breakpoint
CREATE INDEX "customer_groups_name_trgm_idx" ON "customer_groups" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "customer_groups_name_fts_gin_idx" ON "customer_groups" USING gin ("name_fts");--> statement-breakpoint
CREATE INDEX "price_lists_name_trgm_idx" ON "price_lists" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "price_lists_name_fts_gin_idx" ON "price_lists" USING gin ("name_fts");