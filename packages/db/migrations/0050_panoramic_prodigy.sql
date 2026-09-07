ALTER TABLE "assistant_tool_runs" ADD COLUMN "message_id" uuid;--> statement-breakpoint
UPDATE "assistant_tool_runs" AS "run" SET "message_id" = (
  SELECT "message"."id"
  FROM "assistant_messages" AS "message"
  WHERE "message"."company_id" = "run"."company_id"
    AND "message"."conversation_id" = "run"."conversation_id"
    AND "message"."role" = 'assistant'
    AND "message"."created_at" <= "run"."created_at"
  ORDER BY "message"."created_at" DESC
  LIMIT 1
) WHERE "message_id" IS NULL;--> statement-breakpoint
ALTER TABLE "assistant_tool_runs" ALTER COLUMN "message_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "assistant_tool_runs" ADD CONSTRAINT "assistant_tool_runs_messages_company_fk" FOREIGN KEY ("company_id","message_id") REFERENCES "public"."assistant_messages"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assistant_tool_runs_company_message_idx" ON "assistant_tool_runs" USING btree ("company_id","message_id");
