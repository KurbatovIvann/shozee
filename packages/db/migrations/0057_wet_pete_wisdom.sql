CREATE TABLE "assistant_chat_state" (
	"company_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"document" jsonb,
	"history" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assistant_chat_state_company_conversation_uq" UNIQUE("company_id","conversation_id")
);
--> statement-breakpoint
ALTER TABLE "assistant_chat_state" ADD CONSTRAINT "assistant_chat_state_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_chat_state" ADD CONSTRAINT "assistant_chat_state_conversations_company_fk" FOREIGN KEY ("company_id","conversation_id") REFERENCES "public"."assistant_conversations"("company_id","id") ON DELETE cascade ON UPDATE no action;