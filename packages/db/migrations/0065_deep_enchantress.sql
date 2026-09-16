ALTER TABLE "assistant_turns" ADD COLUMN "end_reason" text;--> statement-breakpoint
ALTER TABLE "assistant_turns" ADD CONSTRAINT "assistant_turns_end_reason_check" CHECK ("assistant_turns"."end_reason" IS NULL
        OR ("assistant_turns"."end_reason" IN ('not_started', 'job_exhausted', 'timeout') AND "assistant_turns"."status" = 'interrupted'
          AND ("assistant_turns"."end_reason" <> 'not_started' OR "assistant_turns"."started_at" IS NULL)));