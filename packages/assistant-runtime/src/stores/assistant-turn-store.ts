/**
 * Postgres behind accepting, starting and finishing a turn (SHO-560, ADR-0039).
 *
 * The turn lease and the command receipt used to be Redis keys beside the
 * pause. They are one Postgres row now, written in the same transaction as the
 * person's message and the placeholder, so an accepted turn cannot exist
 * without its messages, and a queue that lost its job still has the turn to
 * rebuild it from.
 *
 * What this file owns and the module does not: the ids of a turn's messages,
 * the placeholder's shape, and the conversion of a budget hold to the integer
 * the row stores. The module stores all three as given.
 *
 * Additive in this slice: the routes still use the Redis lease and receipts
 * until the switch (SHO-563).
 */
import { createHash } from "node:crypto";

import {
  acceptTurn,
  finishTurn,
  listStaleTurns,
  readChatMessages,
  startTurn,
} from "@showzy/assistant";
import type { ChatMessage, ChatPart } from "@showzy/assistant-kit";
import { executeAction } from "@showzy/core";
import { CoreError } from "@showzy/core/errors";

import type { StaffAssistantBudgetHold } from "../assistant-budget-guard.js";
import {
  ASSISTANT_TURN_TIMEOUT_MS,
  assistantTurnJobSchema,
  type AssistantTurnJob,
  type AssistantTurnKind,
} from "../queue.js";
import {
  AssistantKitConversationGoneError,
  asCaller,
  asJsonObject,
  callFor,
  type AssistantKitCaller,
  type AssistantKitStoreDeps,
} from "./caller.js";

/**
 * Whether a failed accept proves that no turn row holds this request's
 * reservation, so the reservation may be given back.
 *
 * Every core code except `INTERNAL` is raised before the execution transaction
 * opens (validation, rate limit, preflight, the confirmation and idempotency
 * gates) or inside it, where a throw rolls it back (authorization, a handler's
 * refusal, a deadline): core.md §4. After COMMIT only `INTERNAL` can surface —
 * a telemetry error, a connection lost between the server's commit and its
 * acknowledgement — and anything that is not a core error is unknown too.
 *
 * Written as "not `INTERNAL`" rather than a list of codes, so a code core adds
 * later releases by default instead of stranding reservations silently. An
 * unknown error releases nothing: the row may hold the hold, and releasing
 * would leave the counter below real spend.
 */
export function acceptProvedRollback(error: unknown): boolean {
  if (error instanceof AssistantKitConversationGoneError) {
    return true;
  }
  return error instanceof CoreError && error.code !== "INTERNAL";
}

/**
 * How long a turn may sit accepted and unstarted before the reconciler treats
 * its job as lost. One reconciler interval: a job that exists is picked up in
 * well under that, and a lost one costs at most two intervals to notice.
 */
export const ASSISTANT_TURN_QUEUED_STALE_MS = 60_000;

/** The system service name the reconciler's reads are logged under. */
export const ASSISTANT_RECONCILER_SERVICE = "assistant-reconciler";

const TURN_MESSAGE_NAMESPACE = "showzy.assistant.turn-message";

/**
 * The id of one of a turn's messages, derived from the command that accepted
 * it.
 *
 * Derived rather than random, so a repeated command names the same messages
 * and the log refuses a second copy of them even if the receipt were ever
 * bypassed. Lowercased first: `ABC…` and `abc…` are one command. The kind and
 * the role are part of the name, so a send and an answer under one client token,
 * and a turn's two messages, never share an id.
 *
 * A name-based uuid in the RFC 9562 version 8 layout over SHA-256.
 */
export function assistantTurnMessageId(
  turn: { readonly kind: AssistantTurnKind; readonly commandId: string },
  role: ChatMessage["role"],
): string {
  const bytes = createHash("sha256")
    .update(
      `${TURN_MESSAGE_NAMESPACE}:${turn.kind}:${role}:${turn.commandId.toLowerCase()}`,
    )
    .digest()
    .subarray(0, 16);
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x80, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/**
 * The assistant's message as an accept stores it: whatever the turn already
 * earned — an answer's card — followed by an empty text part still being
 * written. The worker writes into it (SHO-561).
 */
export function assistantTurnPlaceholder(options: {
  readonly messageId: string;
  readonly createdAt: string;
  readonly earned?: readonly ChatPart[];
}): ChatMessage {
  return {
    messageId: options.messageId,
    role: "assistant",
    createdAt: options.createdAt,
    parts: [
      ...(options.earned ?? []),
      { kind: "text", text: "", status: "streaming" },
    ],
  };
}

const MICRO_USD_PER_USD = 1_000_000;

/**
 * A budget hold as the turn row stores it. A reservation is a small decimal of
 * dollars; a million-fold integer holds any of up to six decimals exactly, and
 * `assistantBudgetHoldFromStored` gives back the same number.
 */
export function assistantBudgetHoldToStored(hold: StaffAssistantBudgetHold): {
  readonly companyReservedMicroUsd: number;
  readonly globalReservedMicroUsd: number;
  readonly kyivDate: string;
} {
  return {
    companyReservedMicroUsd: Math.round(
      hold.companyReservedUsd * MICRO_USD_PER_USD,
    ),
    globalReservedMicroUsd: Math.round(
      hold.globalReservedUsd * MICRO_USD_PER_USD,
    ),
    kyivDate: hold.kyivDate,
  };
}

export function assistantBudgetHoldFromStored(stored: {
  readonly companyReservedMicroUsd: number;
  readonly globalReservedMicroUsd: number;
  readonly kyivDate: string;
}): StaffAssistantBudgetHold {
  return {
    companyReservedUsd: stored.companyReservedMicroUsd / MICRO_USD_PER_USD,
    globalReservedUsd: stored.globalReservedMicroUsd / MICRO_USD_PER_USD,
    kyivDate: stored.kyivDate,
  };
}

/** A turn, named the way its job names it. */
export interface AssistantTurnRef {
  readonly conversationId: string;
  readonly kind: AssistantTurnKind;
  readonly commandId: string;
}

interface AcceptCommon {
  readonly conversationId: string;
  readonly commandId: string;
  /** The kit's owner token, stored on both messages. */
  readonly bind: string;
  /** The accepting request's better-auth session id. */
  readonly sessionId: string;
  readonly budgetHold: StaffAssistantBudgetHold;
  /** Продовжити: the interrupted turn's command. */
  readonly continuesCommandId?: string;
  /**
   * Gives back the budget reservation this request made for the turn
   * (`releaseStaffAssistantBudgetHold`). The store calls it at most once, and
   * only when it knows no row holds this reservation: replayed, busy, wrong
   * owner, or a core refusal other than `INTERNAL` (`acceptProvedRollback`). Never after
   * `accepted` (the row holds the hold and the worker or the reconciler settles
   * it), and never after an unknown error, which may have followed COMMIT.
   * Must not throw; the budget guard's release never does.
   */
  readonly releaseUnusedHold: () => Promise<void>;
}

export type AssistantTurnAcceptInput =
  | (AcceptCommon & { readonly kind: "chat"; readonly text: string })
  | (AcceptCommon & {
      readonly kind: "answer";
      /** The parts the resolved action already earned, stored first. */
      readonly earned: readonly ChatPart[];
    });

export interface AssistantTurnView {
  readonly conversationId: string;
  readonly kind: AssistantTurnKind;
  readonly commandId: string;
  readonly status: "queued" | "running" | "done" | "failed" | "interrupted";
  readonly placeholderMessageId: string;
  readonly userMessageId: string | null;
  readonly continuesCommandId: string | null;
}

export type AssistantTurnAcceptResult =
  | {
      /**
       * `accepted`: stored now. `replayed`: this command was accepted before and
       * nothing was written. Either way the job is the one to enqueue — BullMQ
       * refuses a second job under its id.
       */
      readonly outcome: "accepted" | "replayed";
      readonly turn: AssistantTurnView;
      readonly job: AssistantTurnJob;
    }
  /** Another turn holds the conversation. Nothing was written. */
  | { readonly outcome: "busy" }
  /**
   * The conversation's log was written under another owner token. Same answer
   * the kit gives a write; nothing was written.
   */
  | { readonly outcome: "wrong_owner" };

export interface AssistantTurnStore {
  /**
   * On replayed, busy, wrong owner and a rolled-back refusal the request's own
   * reservation was not used, and the store releases it through
   * `releaseUnusedHold`. An unknown error releases nothing (fail closed).
   */
  accept(input: AssistantTurnAcceptInput): Promise<AssistantTurnAcceptResult>;
  start(
    ref: AssistantTurnRef,
    options?: { readonly timeoutMs?: number },
  ): Promise<
    | { readonly outcome: "started"; readonly deadlineAt: string }
    | { readonly outcome: "not_queued"; readonly status: string }
  >;
  /**
   * `finished` hands back the hold this call took off the row, for the caller
   * to settle or release; `already_finished` took nothing (SHO-561). Only one
   * call ever gets a turn's hold.
   */
  finish(
    ref: AssistantTurnRef,
    status: "done" | "failed" | "interrupted",
  ): Promise<
    | {
        readonly outcome: "finished";
        readonly status: string;
        readonly releasedHold: StaffAssistantBudgetHold;
      }
    | {
        readonly outcome: "already_finished";
        readonly status: string;
        readonly releasedHold: null;
      }
  >;
}

/**
 * Exactly the identity a job carries. A caller naturally hands over the turn it
 * was given — a view with its status and message ids — and the action's input
 * is strict, so the identity is picked rather than spread.
 */
function identityOf(ref: AssistantTurnRef): AssistantTurnRef {
  return {
    conversationId: ref.conversationId,
    kind: ref.kind,
    commandId: ref.commandId,
  };
}

function jobOf(turn: AssistantTurnRef): AssistantTurnJob {
  return assistantTurnJobSchema.parse({
    version: 1,
    kind: turn.kind,
    conversationId: turn.conversationId,
    commandId: turn.commandId,
  });
}

export function createPostgresAssistantTurnStore(
  deps: AssistantKitStoreDeps,
  caller: AssistantKitCaller,
  clock: { now(): Date } = { now: () => new Date() },
): AssistantTurnStore {
  const call = callFor(caller);
  return {
    accept: async (input) => {
      // The store, not each caller, owns giving back a reservation that no row
      // holds: after the switch every reconnect replays its command, and a
      // forgotten release would strand the reservation until the Kyiv day ends
      // where no reconciler can see it.
      let release = false;
      try {
        const result = await asCaller(
          async (): Promise<AssistantTurnAcceptResult> => {
            // The kit's owner rule, kept for this write path as `messages.write`
            // keeps it: a log written under another token is not appended to.
            const latest = (
              await executeAction(deps.pipeline, {
                action: readChatMessages,
                input: { conversationId: input.conversationId, limit: 1 },
                ...call,
              })
            ).records[0];
            if (latest !== undefined && latest.bind !== input.bind) {
              return { outcome: "wrong_owner" };
            }

            const createdAt = clock.now().toISOString();
            const placeholderId = assistantTurnMessageId(input, "assistant");
            const userMessage =
              input.kind === "chat"
                ? (() => {
                    const messageId = assistantTurnMessageId(input, "user");
                    const message: ChatMessage = {
                      messageId,
                      role: "user",
                      createdAt,
                      parts: [
                        { kind: "text", text: input.text, status: "complete" },
                      ],
                    };
                    return {
                      messageId,
                      bind: input.bind,
                      message: asJsonObject(message),
                    };
                  })()
                : undefined;

            const accepted = await executeAction(deps.pipeline, {
              action: acceptTurn,
              input: {
                conversationId: input.conversationId,
                kind: input.kind,
                commandId: input.commandId,
                sessionId: input.sessionId,
                ...(userMessage === undefined ? {} : { userMessage }),
                placeholder: {
                  messageId: placeholderId,
                  bind: input.bind,
                  message: asJsonObject(
                    assistantTurnPlaceholder({
                      messageId: placeholderId,
                      createdAt,
                      ...(input.kind === "answer"
                        ? { earned: input.earned }
                        : {}),
                    }),
                  ),
                },
                budgetHold: assistantBudgetHoldToStored(input.budgetHold),
                ...(input.continuesCommandId === undefined
                  ? {}
                  : { continuesCommandId: input.continuesCommandId }),
              },
              ...call,
            });
            if (accepted.outcome === "busy") {
              return { outcome: "busy" };
            }
            return {
              outcome: accepted.outcome,
              turn: accepted.turn,
              job: jobOf(accepted.turn),
            };
          },
        );
        // Replayed, busy and wrong owner stored nothing: the row, if any, holds
        // an earlier request's reservation, never this one.
        release = result.outcome !== "accepted";
        return result;
      } catch (error) {
        // A core refusal (any code but INTERNAL) came before COMMIT, so this
        // reservation is on no row. An unknown error may have come after COMMIT;
        // releasing then would leave the counter below what the stored turn
        // holds, which lifts the cap instead of failing closed. Such a
        // reservation is left to expire with its Kyiv day: at most one turn's
        // hold per failed attempt, so retries under the same command add up
        // (SHO-563 must bound that).
        release = acceptProvedRollback(error);
        throw error;
      } finally {
        if (release) {
          await input.releaseUnusedHold();
        }
      }
    },

    /** Not through `asCaller`: a missing turn is not a gone conversation. */
    start: async (ref, options) => {
      const started = await executeAction(deps.pipeline, {
        action: startTurn,
        input: {
          ...identityOf(ref),
          timeoutMs: options?.timeoutMs ?? ASSISTANT_TURN_TIMEOUT_MS,
        },
        ...call,
      });
      return started.outcome === "started"
        ? { outcome: "started", deadlineAt: started.deadlineAt }
        : { outcome: "not_queued", status: started.status };
    },

    finish: async (ref, status) => {
      const finished = await executeAction(deps.pipeline, {
        action: finishTurn,
        input: { ...identityOf(ref), status },
        ...call,
      });
      return finished.outcome === "finished"
        ? {
            outcome: "finished",
            status: finished.status,
            releasedHold: assistantBudgetHoldFromStored(finished.releasedHold),
          }
        : {
            outcome: "already_finished",
            status: finished.status,
            releasedHold: null,
          };
    },
  };
}

export interface AssistantStaleTurn {
  readonly companyId: string;
  readonly staleness: "queued_without_start" | "running_past_deadline";
  readonly turn: AssistantTurnRef;
  readonly placeholderMessageId: string;
  readonly budgetHold: StaffAssistantBudgetHold;
  /** Rebuilt from the row alone, as the reconciler re-enqueues it. */
  readonly job: AssistantTurnJob;
}

/**
 * The reconciler's read, as the system across companies (ADR-0039). No caller:
 * the turns it finds were left behind by a worker that has no request any more.
 */
export function createPostgresAssistantStaleTurns(
  deps: AssistantKitStoreDeps,
): {
  list(options: {
    /** The reconciler run's own request id. */
    readonly requestId: string;
    readonly limit?: number;
  }): Promise<readonly AssistantStaleTurn[]>;
} {
  return {
    async list(options) {
      const page = await executeAction(deps.pipeline, {
        action: listStaleTurns,
        input: {
          queuedStaleAfterMs: ASSISTANT_TURN_QUEUED_STALE_MS,
          limit: options.limit ?? 100,
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
      return page.turns.map((row) => {
        const turn = {
          conversationId: row.conversationId,
          kind: row.kind,
          commandId: row.commandId,
        };
        return {
          companyId: row.companyId,
          staleness: row.staleness,
          turn,
          placeholderMessageId: row.placeholderMessageId,
          budgetHold: assistantBudgetHoldFromStored(row.budgetHold),
          job: jobOf(turn),
        };
      });
    },
  };
}
