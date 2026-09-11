/**
 * The assistant queue contract (ADR-0039).
 *
 * The API produces into this queue and the worker consumes it, and neither app
 * may import the other, so the agreement lives here: the queue's name and
 * BullMQ prefix, the job payload, and how a job id is derived from a command.
 *
 * Pure constants and a schema. No `bullmq` here: the producer and the processor
 * arrive with the slices that run them (SHO-561, SHO-563).
 */
import { z } from "zod";

/** The BullMQ queue a turn runs on. */
export const ASSISTANT_QUEUE_NAME = "assistant";

/**
 * BullMQ key prefix. The same prefix as the worker's job host (ADR-0007), so
 * every queue of this system sits under one namespace in Redis. Do not set an
 * ioredis `keyPrefix` beside it — BullMQ owns prefixing.
 */
export const ASSISTANT_QUEUE_PREFIX = "showzy";

/** The one job name the assistant queue carries. */
export const ASSISTANT_TURN_JOB_NAME = "runTurn";

/**
 * Which accept produced the turn.
 *
 * `chat` stored the person's message and a placeholder; `answer` claimed a
 * pause and ran the resolved action in the request, then stored only the
 * placeholder (ADR-0039). A send and an answer are different attempts even
 * under one client token, which is why the kind is part of the job id.
 */
export const assistantTurnKindSchema = z.enum(["chat", "answer"]);

export type AssistantTurnKind = z.infer<typeof assistantTurnKindSchema>;

/**
 * What a worker needs to run a turn as the person who asked, and nothing the
 * Postgres turn row already holds.
 *
 * - `userId` and `companySelector` become the staff principal; core verifies
 *   membership on every action, so neither is an access grant.
 * - `sessionId` is checked against the `session` table at job start.
 * - `requestId` is the accepting request's id: the turn's actions are audited
 *   under it as `ai_trace_id`.
 * - `clientIp` is for the audit trail of the turn's actions. It reaches the AOF
 *   disk, and jobs are removed on completion and on failure so it does not
 *   outlive the turn (`db.md` §6).
 *
 * Strict, so a producer and a consumer that disagree about a field fail at the
 * boundary instead of running a turn with a missing context.
 */
export const assistantTurnJobSchema = z.strictObject({
  version: z.literal(1),
  kind: assistantTurnKindSchema,
  userId: z.string().min(1),
  sessionId: z.string().min(1),
  companySelector: z.string().min(1),
  conversationId: z.uuid(),
  commandId: z.uuid(),
  requestId: z.string().min(1),
  clientIp: z.string().min(1),
});

export type AssistantTurnJob = z.infer<typeof assistantTurnJobSchema>;

/**
 * The BullMQ job id of a turn, derived from its command.
 *
 * The same command always names the same job, so a repeated enqueue — a retry
 * of the accept, or the reconciler re-enqueuing a turn that never got a job —
 * is deduplicated by BullMQ rather than run twice.
 *
 * The conversation is part of the id because a `commandId` is the client's
 * token; the conversation is the server's, and belongs to one author in one
 * company, which the accept has already verified. Dots, not colons: BullMQ
 * refuses a custom id containing `:` (it is its own key separator), and a
 * purely numeric one.
 */
export function assistantTurnJobId(
  job: Pick<AssistantTurnJob, "kind" | "conversationId" | "commandId">,
): string {
  return `turn.${job.kind}.${job.conversationId}.${job.commandId}`;
}
