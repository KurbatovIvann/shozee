/**
 * What recovers a turn nobody is running any more (ADR-0039, SHO-570).
 *
 * A turn is accepted into Postgres and executed from a BullMQ job. Between the
 * two, things go missing: a queue restart loses a job, a worker dies mid-turn,
 * a job is refused at start because its author lost membership. Postgres still
 * holds the turn, so one pass over the turns the database itself calls stale —
 * `assistant.listStaleTurns` — is enough to put every one of them right.
 *
 * Three things happen here, and nothing else:
 *
 * 1. **A queued turn with no job is enqueued again**, its job rebuilt from the
 *    row alone. The job id a turn derives is the one the accept derived, so
 *    BullMQ refuses a second job while the first exists, and a turn never runs
 *    twice. Re-enqueue backs off per turn, because a turn whose start is
 *    refused every time would otherwise be enqueued on every pass for as long
 *    as it existed.
 * 2. **A turn the database judges stale is interrupted**, through the module's
 *    guarded write, which ends it only while it is still stale and zeroes its
 *    budget hold in the same statement. Staleness is never judged here: this
 *    file has no threshold and no clock of its own.
 *    - For a **queued** turn there is one extra condition, and it can only
 *      narrow what the database would allow: the queue must no longer hold its
 *      job. Age alone does not mean abandoned — one worker drains about 1.33
 *      turns a minute at the declared values, so a backlog of twenty ages a
 *      healthy turn past any threshold — while a job that is gone means the
 *      turn ran to a refusal and was removed. The same question decides the
 *      re-enqueue above, asked once per turn.
 * 3. **The hold that interrupt handed back is released — once — only for a turn
 *    that never started.** A turn that started may have reached the model, and
 *    its reservation stands as the charge (ADR-0039, amended SHO-561). Nobody
 *    else holds it: the row gave it up in the statement that ended the turn.
 *
 * Two more rules, both about what a system job may do:
 *
 * - **The message is written as the turn's author, never as the system.** The
 *   placeholder's `streaming` text has to be settled, and a message is domain
 *   content. So the ending write goes through `executeAction` as the row's
 *   `user_id`, exactly as the worker's writes do, and core checks that person's
 *   membership again. An author who was removed cannot be acted as; the turn is
 *   still ended, and its placeholder keeps the status it has.
 * - **It publishes no more than the interrupted status.** The reconciler has no
 *   reader's window to send: what a conversation contains is read as the person
 *   whose conversation it is, and this pass acts for no person (SHO-562). The
 *   event says which turn ended and how; a client reads the conversation itself.
 */
import { randomUUID } from "node:crypto";

import { CoreError } from "@showzy/core/errors";
import type { Logger } from "pino";

import { releaseStaffAssistantBudgetHold } from "./assistant-budget-guard.js";
import {
  assistantTurnJobPending,
  enqueueAssistantTurn,
  type AssistantTurnQueue,
} from "./assistant-queue-producer.js";
import type { AssistantConversationAddress } from "./events.js";
import { assistantTurnJobId } from "./queue.js";
import type { AssistantRuntime } from "./runtime-types.js";
import type { AssistantEventPublisher } from "./stores/assistant-events-redis.js";
import { createPostgresInterruptedTurnAuthor } from "./stores/assistant-turn-for-job.js";
import { readTurnPlaceholderBind } from "./stores/assistant-turn-placeholder.js";
import {
  ASSISTANT_TURN_QUEUED_STALE_MS,
  createPostgresAssistantStaleTurns,
  type AssistantStaleTurn,
} from "./stores/assistant-turn-store.js";
import type { AiBudgetStore } from "./stores/budget.js";

/**
 * How long after a re-enqueue the same turn may be enqueued again, doubling per
 * attempt up to the cap. The first attempt is immediate: the common case is a
 * job the queue lost, and that turn should run now. A turn whose start is
 * refused — a lost membership, a rate limit, a timeout — comes back on the next
 * pass, and the doubling keeps a permanently unstartable turn from taking a
 * pass's work every minute until the abandon threshold ends it.
 */
export const ASSISTANT_REENQUEUE_BACKOFF_MS = ASSISTANT_TURN_QUEUED_STALE_MS;

/** The longest a re-enqueue waits, well inside the abandon threshold. */
export const ASSISTANT_REENQUEUE_BACKOFF_MAX_MS = 8 * 60_000;

/**
 * Turns one pass takes. The next pass takes the rest: every one of them is
 * still stale, and a bounded read is what keeps a backlog from becoming one
 * enormous statement.
 */
export const ASSISTANT_RECONCILE_PAGE = 100;

export interface AssistantReconcileSummary {
  readonly listed: number;
  readonly reenqueued: number;
  /** Listed, but enqueued again too recently to try now. */
  readonly backedOff: number;
  readonly interrupted: number;
  /** Interrupts whose hold went back to the counters: turns that never started. */
  readonly released: number;
  /** Started, finished or renewed since the list: left as they are. */
  readonly left: number;
  readonly failed: number;
}

export interface AssistantTurnReconcilerDeps {
  readonly runtime: AssistantRuntime;
  readonly pipeline: AssistantRuntimePipeline;
  /** The T4 publisher, on the shared Redis. */
  readonly publisher: AssistantEventPublisher;
  /** The counters the accept reserved on. */
  readonly budgetStore: AiBudgetStore;
  /** Turns one pass takes; the next pass takes the rest. */
  readonly limit?: number;
  readonly now?: () => number;
  /** The pass's own request id. */
  readonly newRequestId?: () => string;
}

type AssistantRuntimePipeline = Parameters<
  typeof createPostgresAssistantStaleTurns
>[0]["pipeline"];

interface Backoff {
  readonly attempts: number;
  readonly nextAtMs: number;
}

/**
 * One reconciler, held for the life of the process: the re-enqueue backoff is
 * its memory. It is per process and lost on restart, which costs at most one
 * extra enqueue per turn — the abandon threshold is what bounds a turn that can
 * never start, not this.
 */
export function createAssistantTurnReconciler(
  deps: AssistantTurnReconcilerDeps,
): (queue: AssistantTurnQueue) => Promise<AssistantReconcileSummary> {
  const storeDeps = { pipeline: deps.pipeline };
  const staleTurns = createPostgresAssistantStaleTurns(storeDeps);
  const authors = createPostgresInterruptedTurnAuthor(storeDeps);
  const logger: Logger = deps.runtime.logger;
  const now = deps.now ?? (() => Date.now());
  const newRequestId = deps.newRequestId ?? (() => randomUUID());
  const backoff = new Map<string, Backoff>();

  /** Log fields that name a turn and never what anyone wrote. */
  function fieldsOf(stale: AssistantStaleTurn, requestId: string) {
    return {
      request_id: requestId,
      conversation_id: stale.turn.conversationId,
      turn_kind: stale.turn.kind,
      staleness: stale.staleness,
    };
  }

  async function reenqueue(
    stale: AssistantStaleTurn,
    queue: AssistantTurnQueue,
    fields: Record<string, string>,
  ): Promise<"reenqueued" | "backed_off"> {
    const jobId = assistantTurnJobId(stale.job);
    const held = backoff.get(jobId);
    const at = now();
    if (held !== undefined && at < held.nextAtMs) {
      return "backed_off";
    }
    await enqueueAssistantTurn(queue, stale.job);
    const attempts = (held?.attempts ?? 0) + 1;
    backoff.set(jobId, {
      attempts,
      nextAtMs:
        at +
        Math.min(
          ASSISTANT_REENQUEUE_BACKOFF_MS * 2 ** (attempts - 1),
          ASSISTANT_REENQUEUE_BACKOFF_MAX_MS,
        ),
    });
    logger.info({ ...fields, attempt: attempts }, "assistant turn re-enqueued");
    return "reenqueued";
  }

  /**
   * Settles the interrupted turn's placeholder as its author. Best effort by
   * design: the turn has ended either way, and the one reason this fails in
   * practice — an author who is no longer a member — is not a fault to retry.
   */
  async function endPlaceholder(
    stale: AssistantStaleTurn,
    requestId: string,
    fields: Record<string, string>,
  ): Promise<void> {
    try {
      const author = await authors.read({ turn: stale.turn, requestId });
      if (author === null) {
        logger.warn({ ...fields }, "assistant turn text was not ended");
        return;
      }
      const bind = await readTurnPlaceholderBind(storeDeps, author.caller, {
        conversationId: stale.turn.conversationId,
        placeholderMessageId: author.placeholderMessageId,
      });
      if (bind === null) {
        // The conversation moved on between the interrupt and this write.
        logger.warn({ ...fields }, "assistant turn text was not ended");
        return;
      }
      const written = await deps.runtime
        .forCaller(author.caller)
        .kit.messages.write(
          { conversationId: stale.turn.conversationId, bind },
          {
            kind: "end_text",
            messageId: author.placeholderMessageId,
            status: "interrupted",
          },
        );
      if (written.kind !== "written" && written.kind !== "unchanged") {
        logger.warn(
          { ...fields, refusal: written.kind },
          "assistant turn text was not ended",
        );
      }
    } catch (error) {
      logger.warn(
        {
          ...fields,
          ...(error instanceof CoreError ? { code: error.code } : {}),
        },
        "assistant turn text was not ended",
      );
    }
  }

  async function publishInterrupted(
    stale: AssistantStaleTurn,
    fields: Record<string, string>,
  ): Promise<void> {
    const address: AssistantConversationAddress = {
      companyId: stale.companyId,
      conversationId: stale.turn.conversationId,
    };
    try {
      // The status, and nothing of the conversation: this pass read no window
      // as the person whose conversation it is.
      await deps.publisher.publish(address, {
        type: "turn.finished",
        kind: stale.turn.kind,
        commandId: stale.turn.commandId,
        status: "interrupted",
      });
    } catch (error) {
      logger.warn(
        { ...fields, err: error },
        "assistant event was not published",
      );
    }
  }

  async function interrupt(
    stale: AssistantStaleTurn,
    requestId: string,
    fields: Record<string, string>,
  ): Promise<"interrupted" | "released" | "left"> {
    const ended = await staleTurns.interrupt({
      companyId: stale.companyId,
      turn: stale.turn,
      requestId,
    });
    if (ended.outcome !== "interrupted") {
      logger.info(
        { ...fields, outcome: ended.outcome, status: ended.status },
        "assistant turn was left as it is",
      );
      return "left";
    }
    // Exactly the hold that statement took off the row, and only when the turn
    // never started: a started turn may have reached the model.
    if (ended.from === "queued") {
      await releaseStaffAssistantBudgetHold({
        logger,
        requestId,
        companyId: stale.companyId,
        hold: ended.releasedHold,
        budgetStore: deps.budgetStore,
      });
    }
    logger.info(
      { ...fields, from: ended.from },
      "assistant turn interrupted by the reconciler",
    );
    await endPlaceholder(stale, requestId, fields);
    await publishInterrupted(stale, fields);
    return ended.from === "queued" ? "released" : "interrupted";
  }

  return async (queue) => {
    const requestId = newRequestId();
    const limit = deps.limit ?? ASSISTANT_RECONCILE_PAGE;
    const listed = await staleTurns.list({ requestId, limit });
    const summary = {
      listed: listed.length,
      reenqueued: 0,
      backedOff: 0,
      interrupted: 0,
      released: 0,
      left: 0,
      failed: 0,
    };
    const seen = new Set<string>();
    for (const stale of listed) {
      const fields = fieldsOf(stale, requestId);
      try {
        // Whether the queue still holds this turn's job is the one thing that
        // separates a turn waiting behind a backlog from one waiting for
        // nothing. Both queued branches ask it, once, the same way.
        if (
          stale.staleness === "queued_without_start" ||
          stale.staleness === "queued_abandoned"
        ) {
          if (await assistantTurnJobPending(queue, stale.job)) {
            seen.add(assistantTurnJobId(stale.job));
            summary.left += 1;
            logger.info(
              fields,
              "assistant turn is queued behind its job and was left as it is",
            );
            continue;
          }
        }
        if (stale.staleness === "queued_without_start") {
          seen.add(assistantTurnJobId(stale.job));
          const done = await reenqueue(stale, queue, fields);
          if (done === "reenqueued") {
            summary.reenqueued += 1;
          } else {
            summary.backedOff += 1;
          }
          continue;
        }
        const done = await interrupt(stale, requestId, fields);
        if (done === "released") {
          summary.interrupted += 1;
          summary.released += 1;
        } else if (done === "interrupted") {
          summary.interrupted += 1;
        } else {
          summary.left += 1;
        }
      } catch (error) {
        // One turn that cannot be put right must not cost the rest of the pass.
        summary.failed += 1;
        logger.error(
          { ...fields, err: error },
          "assistant turn not reconciled",
        );
      }
    }
    // A turn that is no longer listed has started, ended or been interrupted;
    // its backoff is spent. A truncated page prunes nothing: the turns it did
    // not reach are not absent, only unseen.
    if (listed.length < limit) {
      for (const jobId of backoff.keys()) {
        if (!seen.has(jobId)) {
          backoff.delete(jobId);
        }
      }
    }
    return summary;
  };
}
