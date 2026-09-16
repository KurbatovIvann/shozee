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
  ASSISTANT_TURN_TIMEOUT_MS,
  acceptTurn,
  finishTurn,
  readActiveTurn,
  readChatMessages,
  readLatestInterruptedTurn,
  startTurn,
  type AssistantTurnKind,
} from "@showzy/assistant";
import type {
  ChatMessage,
  ChatPart,
  ModelMessage,
  ToolOutcome,
} from "@showzy/assistant-kit";
import { executeAction } from "@showzy/core";
import type { AssistantChatInterruptedTurn } from "@showzy/validation/assistant-chat";
import {
  ConflictError,
  CoreError,
  CoreInvariantError,
} from "@showzy/core/errors";

import type { StaffAssistantBudgetHold } from "../assistant-budget-guard.js";
import {
  AssistantKitConversationGoneError,
  asCaller,
  asJson,
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

export const ASSISTANT_RECOVERY_SERVICE = "assistant-recovery";

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

/**
 * What an answer's resolved action already earned, as the placeholder stores it
 * (SHO-563).
 *
 * The same shape the kit writes for a card mid-turn, kept here because this
 * file owns the placeholder an accept stores and the answer route has no other
 * way to hand the card over: the action runs in the request, the reply runs in
 * the worker, and the card must be stored before either can fail.
 */
export function assistantTurnEarnedCard(
  card: NonNullable<Extract<ToolOutcome, { kind: "ok" }>["card"]> | undefined,
): readonly ChatPart[] {
  return card === undefined
    ? []
    : [
        {
          kind: "card",
          cardId: card.cardId,
          revision: 1,
          type: card.type,
          payload: card.payload,
        },
      ];
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
  /**
   * Gives back the budget reservation this request made for the turn
   * (`releaseStaffAssistantBudgetHold`). The store calls it at most once, and
   * only when it knows no row holds this reservation: replayed, busy, wrong
   * owner, or a core refusal other than `INTERNAL` (`acceptProvedRollback`). Never after
   * `accepted` (the row holds the hold and the worker or the reconciler
   * releases it), and never after an unknown error, which may have followed
   * COMMIT.
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
      readonly history: readonly ModelMessage[];
    })
  | (AcceptCommon & { readonly kind: "continue" });

export function assistantAskedMessage(text: string): ModelMessage {
  return { role: "user", content: text };
}

type AcceptedHistoryInstruction =
  | { readonly kind: "append"; readonly message: unknown }
  | { readonly kind: "replace"; readonly history: unknown };

function acceptedHistoryInstruction(
  input: AssistantTurnAcceptInput,
): AcceptedHistoryInstruction | undefined {
  if (input.kind === "chat") {
    return {
      kind: "append",
      message: asJson(assistantAskedMessage(input.text)),
    };
  }
  if (input.kind === "answer") {
    return { kind: "replace", history: asJson(input.history) };
  }
  return undefined;
}

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
      readonly outcome: "accepted" | "replayed";
      readonly turn: AssistantTurnView;
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
    | { readonly outcome: "expired" }
  >;
  /**
   * `finished` hands back the hold this call took off the row, for the caller
   * to release; `already_finished` took nothing (SHO-561). Only one call ever
   * gets a turn's hold.
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
  activeTurn(scope: {
    readonly conversationId: string;
  }): Promise<AssistantTurnActiveView | null>;
  latestInterrupted(scope: {
    readonly conversationId: string;
  }): Promise<AssistantChatInterruptedTurn | null>;
}

export interface AssistantTurnActiveView {
  readonly id: string;
  readonly status: "queued" | "running";
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

async function resolveContinuation(
  deps: AssistantKitStoreDeps,
  call: ReturnType<typeof callFor>,
  conversationId: string,
): Promise<string> {
  const found = await executeAction(deps.pipeline, {
    action: readLatestInterruptedTurn,
    input: { conversationId },
    ...call,
  });
  if (found.commandId === null) {
    throw new ConflictError(
      "There is no interrupted turn of this conversation to continue.",
    );
  }
  return found.commandId;
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

            const dbKind: AssistantTurnKind =
              input.kind === "continue" ? "answer" : input.kind;
            const continuesCommandId =
              input.kind === "continue"
                ? await resolveContinuation(deps, call, input.conversationId)
                : undefined;
            const history = acceptedHistoryInstruction(input);
            const createdAt = clock.now().toISOString();
            const placeholderId = assistantTurnMessageId(
              { kind: dbKind, commandId: input.commandId },
              "assistant",
            );
            const userMessage =
              input.kind === "chat"
                ? (() => {
                    const messageId = assistantTurnMessageId(
                      { kind: dbKind, commandId: input.commandId },
                      "user",
                    );
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
                kind: dbKind,
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
                        : input.kind === "continue"
                          ? { earned: [] }
                          : {}),
                    }),
                  ),
                },
                budgetHold: assistantBudgetHoldToStored(input.budgetHold),
                ...(history === undefined ? {} : { history }),
                ...(continuesCommandId === undefined
                  ? {}
                  : { continuesCommandId }),
              },
              ...call,
            });
            if (accepted.outcome === "busy") {
              return { outcome: "busy" };
            }
            return { outcome: accepted.outcome, turn: accepted.turn };
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
        // reservation is left to expire with its Kyiv day.
        //
        // That no longer accumulates across retries. `/kit/chat` gives its
        // command back on any failed accept, so a retry is the expected path
        // rather than a rare one — and the reservation is recorded under this
        // turn's own identity (`aiBudgetHoldKey`), so every retry of this
        // command finds the first attempt's reservation and takes none of its
        // own. At most one turn's hold is stranded per command, and it expires
        // with its Kyiv-day key: the day's cap is reached early, never lifted
        // (SHO-572).
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
      if (started.outcome === "started") {
        return { outcome: "started", deadlineAt: started.deadlineAt };
      }
      return started.outcome === "expired"
        ? { outcome: "expired" }
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

    activeTurn: async (scope) =>
      asCaller(async () => {
        const read = await executeAction(deps.pipeline, {
          action: readActiveTurn,
          input: { conversationId: scope.conversationId },
          ...call,
        });
        return read.turn;
      }),

    latestInterrupted: async (scope) =>
      asCaller(async () => {
        const read = await executeAction(deps.pipeline, {
          action: readLatestInterruptedTurn,
          input: { conversationId: scope.conversationId },
          ...call,
        });
        return read.commandId === null
          ? null
          : { id: read.commandId, endReason: read.endReason };
      }),
  };
}

/**
 * The message log an accept writes through, as the memory store below needs it.
 *
 * Narrow on purpose: naming the kit's own type here would tie this file to the
 * runtime types that already name this one.
 */
export interface AssistantTurnMessageWriter {
  write(
    scope: { readonly conversationId: string; readonly bind: string },
    write: {
      readonly kind: "append";
      readonly messageId: string;
      readonly role: ChatMessage["role"];
      readonly parts: readonly ChatPart[];
    },
  ): Promise<{ readonly kind: string }>;
}

/**
 * A turn store that lives in this process only.
 *
 * The same role `memoryAssistantKitCommands` plays for receipts: correct for a
 * single-process run, and what the route tests accept turns through. It keeps
 * the parts that decide how a route behaves — one unfinished turn holds a
 * conversation, a repeated command is `replayed` and writes nothing, the
 * message ids come from the command — and leaves durability to the Postgres
 * store, which has its own test against a real database.
 */
export interface AssistantTurnHistoryWriter {
  load(scope: {
    readonly conversationId: string;
    readonly bind: string;
  }): Promise<ModelMessage[]>;
  save(
    scope: { readonly conversationId: string; readonly bind: string },
    messages: readonly ModelMessage[],
  ): Promise<void>;
}

export function memoryAssistantTurnStore(
  messages: AssistantTurnMessageWriter,
  history: AssistantTurnHistoryWriter,
  clock: { now(): Date } = { now: () => new Date() },
): AssistantTurnStore {
  const byCommand = new Map<string, AssistantTurnView>();
  const statuses = new Map<string, AssistantTurnView["status"]>();
  const key = (ref: AssistantTurnRef): string =>
    `${ref.kind}:${ref.conversationId.toLowerCase()}:${ref.commandId.toLowerCase()}`;

  return {
    async accept(input) {
      const dbKind: AssistantTurnKind =
        input.kind === "continue" ? "answer" : input.kind;
      const ref = {
        conversationId: input.conversationId,
        kind: dbKind,
        commandId: input.commandId,
      };
      const replayed = byCommand.get(key(ref));
      if (replayed !== undefined) {
        await input.releaseUnusedHold();
        return { outcome: "replayed", turn: replayed };
      }
      const holder = [...byCommand.values()].find(
        (turn) =>
          turn.conversationId.toLowerCase() ===
            input.conversationId.toLowerCase() &&
          (statuses.get(key(turn)) === "queued" ||
            statuses.get(key(turn)) === "running"),
      );
      if (holder !== undefined) {
        await input.releaseUnusedHold();
        return { outcome: "busy" };
      }

      let continuesCommandId: string | undefined;
      if (input.kind === "continue") {
        const interrupted = [...byCommand.values()]
          .filter(
            (turn) =>
              turn.conversationId.toLowerCase() ===
                input.conversationId.toLowerCase() &&
              statuses.get(key(turn)) === "interrupted",
          )
          .at(-1);
        if (interrupted === undefined) {
          await input.releaseUnusedHold();
          throw new ConflictError(
            "There is no interrupted turn of this conversation to continue.",
          );
        }
        continuesCommandId =
          interrupted.continuesCommandId ?? interrupted.commandId;
      }

      const createdAt = clock.now().toISOString();
      const scope = {
        conversationId: input.conversationId,
        bind: input.bind,
      };
      const storedHistory = await history.load(scope);
      const undoHistory = async (): Promise<void> => {
        try {
          await history.save(scope, storedHistory);
        } catch {
          return;
        }
      };
      if (input.kind === "chat") {
        await history.save(scope, [
          ...storedHistory,
          assistantAskedMessage(input.text),
        ]);
      } else if (input.kind === "answer") {
        await history.save(scope, input.history);
      }
      const placeholderMessageId = assistantTurnMessageId(
        { kind: dbKind, commandId: input.commandId },
        "assistant",
      );
      let userMessageId: string | null = null;
      if (input.kind === "chat") {
        userMessageId = assistantTurnMessageId(
          { kind: dbKind, commandId: input.commandId },
          "user",
        );
        const stored = await messages.write(scope, {
          kind: "append",
          messageId: userMessageId,
          role: "user",
          parts: [{ kind: "text", text: input.text, status: "complete" }],
        });
        if (stored.kind === "wrong_owner") {
          await undoHistory();
          await input.releaseUnusedHold();
          return { outcome: "wrong_owner" };
        }
        if (stored.kind !== "written") {
          await undoHistory();
          // The real accept is one transaction: a refused write fails it, and
          // nothing — no turn row, no placeholder — is stored.
          throw new CoreInvariantError(
            `assistant accept could not store the person's message: ${stored.kind}`,
          );
        }
      }
      const placeholder = await messages.write(scope, {
        kind: "append",
        messageId: placeholderMessageId,
        role: "assistant",
        parts: assistantTurnPlaceholder({
          messageId: placeholderMessageId,
          createdAt,
          ...(input.kind === "answer"
            ? { earned: input.earned }
            : input.kind === "continue"
              ? { earned: [] }
              : {}),
        }).parts,
      });
      if (placeholder.kind === "wrong_owner") {
        await undoHistory();
        await input.releaseUnusedHold();
        return { outcome: "wrong_owner" };
      }
      if (placeholder.kind !== "written") {
        await undoHistory();
        throw new CoreInvariantError(
          `assistant accept could not store the placeholder: ${placeholder.kind}`,
        );
      }

      const turn: AssistantTurnView = {
        conversationId: input.conversationId,
        kind: dbKind,
        commandId: input.commandId,
        status: "queued",
        placeholderMessageId,
        userMessageId,
        continuesCommandId: continuesCommandId ?? null,
      };
      byCommand.set(key(ref), turn);
      statuses.set(key(ref), "queued");
      return { outcome: "accepted", turn };
    },

    start(ref) {
      const status = statuses.get(key(ref));
      if (status !== "queued") {
        return Promise.resolve({
          outcome: "not_queued",
          status: status ?? "missing",
        });
      }
      statuses.set(key(ref), "running");
      return Promise.resolve({
        outcome: "started",
        deadlineAt: new Date(
          clock.now().getTime() + ASSISTANT_TURN_TIMEOUT_MS,
        ).toISOString(),
      });
    },

    finish(ref, status) {
      const current = statuses.get(key(ref));
      if (current !== "queued" && current !== "running") {
        return Promise.resolve({
          outcome: "already_finished",
          status: current ?? "missing",
          releasedHold: null,
        });
      }
      statuses.set(key(ref), status);
      return Promise.resolve({
        outcome: "finished",
        status,
        releasedHold: {
          companyReservedUsd: 0,
          globalReservedUsd: 0,
          kyivDate: "1970-01-01",
        },
      });
    },

    activeTurn(scope) {
      for (const turn of byCommand.values()) {
        if (
          turn.conversationId.toLowerCase() !==
          scope.conversationId.toLowerCase()
        ) {
          continue;
        }
        const status = statuses.get(key(turn));
        if (status === "queued" || status === "running") {
          return Promise.resolve({ id: turn.commandId, status });
        }
      }
      return Promise.resolve(null);
    },

    latestInterrupted(scope) {
      const interrupted = [...byCommand.values()]
        .filter(
          (turn) =>
            turn.conversationId.toLowerCase() ===
              scope.conversationId.toLowerCase() &&
            statuses.get(key(turn)) === "interrupted",
        )
        .at(-1);
      return Promise.resolve(
        interrupted === undefined
          ? null
          : { id: interrupted.commandId, endReason: null },
      );
    },
  };
}
