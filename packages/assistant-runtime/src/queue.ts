/**
 * The assistant queue contract (ADR-0039).
 *
 * The API produces into this queue and the worker consumes it. The worker may
 * import only the approved `@showzy/api/subscriptions` subpath, never the API's
 * runtime internals, so the agreement lives here: the queue's name and BullMQ
 * prefix, the job payload, and how a job id is derived from a turn.
 *
 * Pure constants and a schema. No `bullmq` here: the producer and the processor
 * arrive with the slices that run them (SHO-561, SHO-563).
 */
import { z } from "zod";

/** The BullMQ queue a turn runs on. */
export const ASSISTANT_QUEUE_NAME = "assistant";

/**
 * BullMQ key prefix. The same prefix as the worker's job host (ADR-0007), so
 * every queue of this system uses one namespace. The assistant queue itself
 * lives on the dedicated queue Redis, not the shared one (`db.md` §6). Do not
 * set an ioredis `keyPrefix` beside it — BullMQ owns prefixing.
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
 * A uuid in the one casing both producers of a job id see. Postgres returns a
 * `uuid` lowercase; a client may send one in any case.
 */
const canonicalUuidSchema = z.uuid().transform((value) => value.toLowerCase());

/**
 * A pointer to an accepted turn, not the turn.
 *
 * The payload carries only the turn's identity. Postgres is the source of
 * everything else: the worker loads the turn row, checks its session row —
 * which gives the verified user — and reads the company, the request id, the
 * answer's earned card and the rest from Postgres (SHO-560, SHO-561). The
 * reconciler rebuilds a lost job from the turn row alone, so nothing belongs
 * here that the row cannot give back.
 *
 * No person, session, company or client IP: a job is not an access grant, and
 * the queue Redis persists to disk (`db.md` §6).
 *
 * Strict, so a producer and a consumer that disagree about a field fail at the
 * boundary. Ids are lowercased on parse, as `assistantTurnJobId` does.
 */
export const assistantTurnJobSchema = z.strictObject({
  version: z.literal(1),
  kind: assistantTurnKindSchema,
  conversationId: canonicalUuidSchema,
  commandId: canonicalUuidSchema,
});

export type AssistantTurnJob = z.infer<typeof assistantTurnJobSchema>;

/**
 * The BullMQ job id of a turn, derived from its identity.
 *
 * The same turn always names the same job, so a repeated enqueue — a retry of
 * the accept, or the reconciler re-enqueuing a turn that never got a job — is
 * deduplicated by BullMQ rather than run twice (blueprint §2.1, invariant 2).
 *
 * Both ids are lowercased here, not only in the schema: the accept derives the
 * id from what the client sent and the reconciler from the Postgres row, and
 * the two must agree whatever casing either side holds.
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
  return `turn.${job.kind}.${job.conversationId.toLowerCase()}.${job.commandId.toLowerCase()}`;
}
