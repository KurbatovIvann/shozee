CREATE TABLE "assistant_chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"message_id" uuid NOT NULL,
	"bind" text NOT NULL,
	"message" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assistant_chat_messages_company_id_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "assistant_chat_messages_conversation_seq_uq" UNIQUE("company_id","conversation_id","seq"),
	CONSTRAINT "assistant_chat_messages_conversation_message_uq" UNIQUE("company_id","conversation_id","message_id"),
	CONSTRAINT "assistant_chat_messages_seq_check" CHECK ("assistant_chat_messages"."seq" > 0)
);
--> statement-breakpoint
ALTER TABLE "assistant_chat_messages" ADD CONSTRAINT "assistant_chat_messages_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_chat_messages" ADD CONSTRAINT "assistant_chat_messages_conversations_company_fk" FOREIGN KEY ("company_id","conversation_id") REFERENCES "public"."assistant_conversations"("company_id","id") ON DELETE cascade ON UPDATE no action;