/**
 * Putting an accepted turn on the assistant queue (ADR-0039, SHO-569).
 *
 * The API produces (SHO-563) and the reconciler re-enqueues a turn that never
 * got a job, so the one way to add a job lives beside the queue contract rather
 * than in either caller. The options a job carries are part of that agreement:
 * BullMQ stores them on the job, so whoever enqueues decides them.
 *
 * It takes the caller's BullMQ `Queue` through the one method it uses rather
 * than importing BullMQ. `bullmq` has peer dependencies (`ioredis`, `pg`), and
 * pnpm installs one copy per peer set: a package with a different set gets a
 * second copy whose `Queue` class is a different type from the app's. Any
 * BullMQ `Queue` satisfies `AssistantTurnQueue` (pinned by the worker's tests),
 * so the apps keep the one `bullmq` they already lock.
 */
import {
  ASSISTANT_TURN_JOB_NAME,
  assistantTurnJobId,
  assistantTurnJobSchema,
  type AssistantTurnJob,
} from "./queue.js";

/**
 * How a turn's job behaves (ADR-0039, starting values).
 *
 * - `attempts: 1`: a turn runs once. The model is not deterministic, and a
 *   re-run after a committed write may choose differently; a turn that failed
 *   is `interrupted`, and Продовжити continues it from saved history.
 * - Removed on completion and on failure, so a re-enqueue under the same
 *   `jobId` — the reconciler rebuilding a lost job — is never a no-op against a
 *   stale record. While a job exists, BullMQ refuses a second under its id.
 */
export const ASSISTANT_TURN_JOB_OPTIONS = {
  attempts: 1,
  removeOnComplete: true,
  removeOnFail: true,
} as const;

/** The part of a BullMQ `Queue` a producer uses. */
export interface AssistantTurnQueue {
  add(
    name: typeof ASSISTANT_TURN_JOB_NAME,
    data: AssistantTurnJob,
    opts: typeof ASSISTANT_TURN_JOB_OPTIONS & { readonly jobId: string },
  ): Promise<unknown>;
}

/**
 * Adds the job for a turn under the id its identity derives. Parsed first, so
 * nothing but the turn's identity reaches the queue's disk.
 */
export async function enqueueAssistantTurn(
  queue: AssistantTurnQueue,
  job: AssistantTurnJob,
): Promise<void> {
  const payload = assistantTurnJobSchema.parse(job);
  await queue.add(ASSISTANT_TURN_JOB_NAME, payload, {
    ...ASSISTANT_TURN_JOB_OPTIONS,
    jobId: assistantTurnJobId(payload),
  });
}
