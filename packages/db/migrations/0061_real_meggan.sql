CREATE TABLE "assistant_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"command_id" uuid NOT NULL,
	"status" text NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text,
	"request_id" text NOT NULL,
	"user_message_id" uuid,
	"placeholder_message_id" uuid NOT NULL,
	"continues_command_id" uuid,
	"company_reserved_micro_usd" bigint NOT NULL,
	"global_reserved_micro_usd" bigint NOT NULL,
	"budget_kyiv_date" date NOT NULL,
	"started_at" timestamp with time zone,
	"deadline_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assistant_turns_company_id_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "assistant_turns_command_uq" UNIQUE("company_id","conversation_id","kind","command_id"),
	CONSTRAINT "assistant_turns_kind_check" CHECK ("assistant_turns"."kind" IN ('chat', 'answer')),
	CONSTRAINT "assistant_turns_status_check" CHECK ("assistant_turns"."status" IN ('queued', 'running', 'done', 'failed', 'interrupted')),
	CONSTRAINT "assistant_turns_lifecycle_check" CHECK (("assistant_turns"."status" = 'queued' AND "assistant_turns"."started_at" IS NULL AND "assistant_turns"."deadline_at" IS NULL AND "assistant_turns"."finished_at" IS NULL)
        OR ("assistant_turns"."status" = 'running' AND "assistant_turns"."started_at" IS NOT NULL AND "assistant_turns"."deadline_at" IS NOT NULL AND "assistant_turns"."finished_at" IS NULL)
        OR ("assistant_turns"."status" IN ('done', 'failed', 'interrupted') AND "assistant_turns"."finished_at" IS NOT NULL)),
	CONSTRAINT "assistant_turns_session_check" CHECK (("assistant_turns"."status" IN ('queued', 'running')) = ("assistant_turns"."session_id" IS NOT NULL)),
	CONSTRAINT "assistant_turns_user_message_check" CHECK (("assistant_turns"."kind" = 'chat') = ("assistant_turns"."user_message_id" IS NOT NULL)),
	CONSTRAINT "assistant_turns_continues_check" CHECK ("assistant_turns"."continues_command_id" IS NULL OR "assistant_turns"."continues_command_id" <> "assistant_turns"."command_id"),
	CONSTRAINT "assistant_turns_reserved_check" CHECK ("assistant_turns"."company_reserved_micro_usd" >= 0 AND "assistant_turns"."global_reserved_micro_usd" >= 0)
);
--> statement-breakpoint
ALTER TABLE "assistant_chat_messages" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "assistant_turns" ADD CONSTRAINT "assistant_turns_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_turns" ADD CONSTRAINT "assistant_turns_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_turns" ADD CONSTRAINT "assistant_turns_conversations_company_fk" FOREIGN KEY ("company_id","conversation_id") REFERENCES "public"."assistant_conversations"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_turns" ADD CONSTRAINT "assistant_turns_placeholder_message_fk" FOREIGN KEY ("company_id","conversation_id","placeholder_message_id") REFERENCES "public"."assistant_chat_messages"("company_id","conversation_id","message_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_turns" ADD CONSTRAINT "assistant_turns_user_message_fk" FOREIGN KEY ("company_id","conversation_id","user_message_id") REFERENCES "public"."assistant_chat_messages"("company_id","conversation_id","message_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_turns_active_uq" ON "assistant_turns" USING btree ("company_id","conversation_id") WHERE "assistant_turns"."status" IN ('queued', 'running');--> statement-breakpoint
ALTER TABLE "assistant_chat_messages" ADD CONSTRAINT "assistant_chat_messages_revision_check" CHECK ("assistant_chat_messages"."revision" > 0);