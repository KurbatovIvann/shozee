ALTER TABLE "product_variants" DROP CONSTRAINT "product_variants_created_via_check";--> statement-breakpoint
ALTER TABLE "products" DROP CONSTRAINT "products_created_via_check";--> statement-breakpoint
ALTER TABLE "company_customers" DROP CONSTRAINT "company_customers_created_via_check";--> statement-breakpoint
ALTER TABLE "counterparties" DROP CONSTRAINT "counterparties_created_via_check";--> statement-breakpoint
ALTER TABLE "customer_groups" DROP CONSTRAINT "customer_groups_created_via_check";--> statement-breakpoint
ALTER TABLE "documents" DROP CONSTRAINT "documents_created_via_check";--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_channel_check";--> statement-breakpoint
ALTER TABLE "domain_events" DROP CONSTRAINT "domain_events_channel_check";--> statement-breakpoint
ALTER TABLE "company_customer_invites" DROP CONSTRAINT "company_customer_invites_created_via_check";--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT "orders_created_via_check";--> statement-breakpoint
ALTER TABLE "price_lists" DROP CONSTRAINT "price_lists_created_via_check";--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_created_via_check" CHECK ("product_variants"."created_via" IN ('ui', 'ai', 'system', 'webhook', 'sho-ai'));--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_created_via_check" CHECK ("products"."created_via" IN ('ui', 'ai', 'system', 'webhook', 'sho-ai'));--> statement-breakpoint
ALTER TABLE "company_customers" ADD CONSTRAINT "company_customers_created_via_check" CHECK ("company_customers"."created_via" IN ('ui', 'ai', 'system', 'webhook', 'sho-ai'));--> statement-breakpoint
ALTER TABLE "counterparties" ADD CONSTRAINT "counterparties_created_via_check" CHECK ("counterparties"."created_via" IN ('ui', 'ai', 'system', 'webhook', 'sho-ai'));--> statement-breakpoint
ALTER TABLE "customer_groups" ADD CONSTRAINT "customer_groups_created_via_check" CHECK ("customer_groups"."created_via" IN ('ui', 'ai', 'system', 'webhook', 'sho-ai'));--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_created_via_check" CHECK ("documents"."created_via" IN ('ui', 'ai', 'system', 'webhook', 'sho-ai'));--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_channel_check" CHECK ("audit_log"."channel" IN ('ui', 'ai', 'system', 'webhook', 'sho-ai'));--> statement-breakpoint
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_channel_check" CHECK ("domain_events"."channel" IN ('ui', 'ai', 'system', 'webhook', 'sho-ai'));--> statement-breakpoint
ALTER TABLE "company_customer_invites" ADD CONSTRAINT "company_customer_invites_created_via_check" CHECK ("company_customer_invites"."created_via" IN ('ui', 'ai', 'system', 'webhook', 'sho-ai'));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_created_via_check" CHECK ("orders"."created_via" IN ('ui', 'ai', 'system', 'webhook', 'sho-ai'));--> statement-breakpoint
ALTER TABLE "price_lists" ADD CONSTRAINT "price_lists_created_via_check" CHECK ("price_lists"."created_via" IN ('ui', 'ai', 'system', 'webhook', 'sho-ai'));