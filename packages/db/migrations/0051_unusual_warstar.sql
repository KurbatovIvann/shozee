ALTER TABLE "assistant_tool_runs" DROP CONSTRAINT "assistant_tool_runs_outcome_check";--> statement-breakpoint
ALTER TABLE "assistant_tool_runs" ADD COLUMN "tool_input" jsonb;--> statement-breakpoint
ALTER TABLE "assistant_tool_runs" ADD COLUMN "execution_id" text;--> statement-breakpoint
ALTER TABLE "assistant_tool_runs" ADD COLUMN "seq" integer;--> statement-breakpoint
ALTER TABLE "assistant_tool_runs" ADD CONSTRAINT "assistant_tool_runs_company_execution_id_uq" UNIQUE("company_id","execution_id");--> statement-breakpoint
ALTER TABLE "assistant_tool_runs" ADD CONSTRAINT "assistant_tool_runs_tool_input_length_check" CHECK (length("assistant_tool_runs"."tool_input"::text) <= 22000);--> statement-breakpoint
ALTER TABLE "assistant_tool_runs" ADD CONSTRAINT "assistant_tool_runs_started_identity_check" CHECK ("assistant_tool_runs"."outcome" <> 'started' OR ("assistant_tool_runs"."execution_id" IS NOT NULL AND "assistant_tool_runs"."seq" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "assistant_tool_runs" ADD CONSTRAINT "assistant_tool_runs_outcome_check" CHECK ("assistant_tool_runs"."outcome" IN ('started', 'success', 'error', 'confirmation_required', 'choice_required'));