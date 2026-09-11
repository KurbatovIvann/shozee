/**
 * The turn a queued job names, and the only way to get the caller it runs as
 * (SHO-561, ADR-0039).
 *
 * A job's payload is the turn's identity and nothing else, and anyone who can
 * write to the queue can write one. So a job never says who a turn acts as.
 * The accept stored that under its verified staff context — `user_id`,
 * `company_id`, `request_id` — and this read gives it back. The session is not
 * read: the actor is `user_id`, core checks that user's membership again on
 * every action the turn runs, and a turn accepted before sign-out may finish.
 *
 * `VerifiedAssistantCaller` carries a brand no other module can write, so code
 * that asks for one cannot be handed a caller assembled from a job payload.
 */
import { readTurnForJob } from "@showzy/assistant";
import { executeAction } from "@showzy/core";

import type { StaffAssistantBudgetHold } from "../assistant-budget-guard.js";
import type { AssistantTurnJob } from "../queue.js";
import {
  ASSISTANT_RECONCILER_SERVICE,
  assistantBudgetHoldFromStored,
  type AssistantTurnRef,
  type AssistantTurnView,
} from "./assistant-turn-store.js";
import type { AssistantKitCaller, AssistantKitStoreDeps } from "./caller.js";

/** The system service name the worker's reads are logged under. */
export const ASSISTANT_WORKER_SERVICE = "assistant-worker";

const verifiedCaller: unique symbol = Symbol("VerifiedAssistantCaller");

/**
 * Who a worker-run turn acts as: the turn row's `user_id`, in its `company_id`,
 * under its `request_id`, with no client IP. Made only by
 * `createPostgresAssistantTurnForJob`.
 */
export interface VerifiedAssistantCaller extends AssistantKitCaller {
  readonly [verifiedCaller]: true;
}

export interface AssistantTurnForJob {
  readonly companyId: string;
  readonly turn: AssistantTurnRef;
  readonly status: AssistantTurnView["status"];
  readonly placeholderMessageId: string;
  /** Null while the turn is queued. */
  readonly deadlineAt: string | null;
  /** What the row still holds: zero once the turn has been finalised. */
  readonly budgetHold: StaffAssistantBudgetHold;
  /** The command the turn's tools derive their idempotency keys from. */
  readonly continuationRootCommandId: string;
  /**
   * Who the turn runs as — only while it is still queued, the one state a
   * worker starts a turn from. A running or ended turn gives no caller, so a
   * replayed or forged job naming it is no way to act as its author.
   */
  readonly caller: VerifiedAssistantCaller | null;
}

/** The author of a turn the reconciler has just interrupted, and its message. */
export interface InterruptedTurnAuthor {
  readonly companyId: string;
  readonly placeholderMessageId: string;
  readonly caller: VerifiedAssistantCaller;
}

/**
 * Who ends the message of a turn the reconciler interrupted (SHO-570).
 *
 * The placeholder's `streaming` text has to be settled, and a message is domain
 * content: a system job may not write it. So the write is made as the turn's
 * author — the row's `user_id`, exactly as the worker runs the turn — and the
 * caller is produced here, from the row, like every other one. Only for a turn
 * that has already ended as `interrupted`: nothing that is still running can be
 * written to through this, and the reconciler asks only after its own
 * interrupt.
 *
 * Core checks that person's membership on the write, as it does for every
 * action of a turn. An author who has since been removed cannot be acted as,
 * and the placeholder keeps the status it has.
 */
export function createPostgresInterruptedTurnAuthor(
  deps: AssistantKitStoreDeps,
): {
  read(options: {
    readonly turn: AssistantTurnRef;
    readonly requestId: string;
  }): Promise<InterruptedTurnAuthor | null>;
} {
  return {
    async read(options) {
      const { turn } = await executeAction(deps.pipeline, {
        action: readTurnForJob,
        input: {
          conversationId: options.turn.conversationId,
          kind: options.turn.kind,
          commandId: options.turn.commandId,
        },
        request: {
          requestId: options.requestId,
          correlationId: options.requestId,
          channel: "system",
        },
        principal: {
          mode: "system",
          serviceName: ASSISTANT_RECONCILER_SERVICE,
          scope: { scope: "global" },
        },
      });
      if (turn === null || turn.status !== "interrupted") {
        return null;
      }
      return {
        companyId: turn.companyId,
        placeholderMessageId: turn.placeholderMessageId,
        caller: {
          userId: turn.userId,
          companySelector: turn.companyId,
          // The turn's own request: the ending write belongs to that turn, and
          // is audited under it, as the worker's writes are.
          requestId: turn.requestId,
          [verifiedCaller]: true,
        },
      };
    },
  };
}

export function createPostgresAssistantTurnForJob(
  deps: AssistantKitStoreDeps,
): {
  /**
   * Null when no turn has this identity — a conversation deleted since, or a
   * job nobody accepted.
   */
  read(options: {
    readonly job: AssistantTurnJob;
    /** The worker's own request id for this read. */
    readonly requestId: string;
  }): Promise<AssistantTurnForJob | null>;
} {
  return {
    async read(options) {
      const { turn } = await executeAction(deps.pipeline, {
        action: readTurnForJob,
        input: {
          conversationId: options.job.conversationId,
          kind: options.job.kind,
          commandId: options.job.commandId,
        },
        request: {
          requestId: options.requestId,
          correlationId: options.requestId,
          channel: "system",
        },
        principal: {
          mode: "system",
          serviceName: ASSISTANT_WORKER_SERVICE,
          scope: { scope: "global" },
        },
      });
      if (turn === null) {
        return null;
      }
      return {
        companyId: turn.companyId,
        turn: {
          conversationId: turn.conversationId,
          kind: turn.kind,
          commandId: turn.commandId,
        },
        status: turn.status,
        placeholderMessageId: turn.placeholderMessageId,
        deadlineAt: turn.deadlineAt,
        budgetHold: assistantBudgetHoldFromStored(turn.budgetHold),
        continuationRootCommandId: turn.continuationRootCommandId,
        caller:
          turn.status === "queued"
            ? {
                userId: turn.userId,
                companySelector: turn.companyId,
                requestId: turn.requestId,
                [verifiedCaller]: true,
              }
            : null,
      };
    },
  };
}
