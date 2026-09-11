/**
 * A conversation's turns: accept one, start it, finish it, and find the ones
 * that a crashed worker left behind (SHO-560, ADR-0039).
 *
 * The turn row is the lease and the receipt at once. Which turn is active is
 * `ASSISTANT_TURN_ACTIVE_STATUSES` from the owned schema and nothing else — the
 * partial unique index reads the same list — so a query here and the database
 * cannot hold two ideas of it.
 *
 * Ids are lowercased before they are written or compared. Postgres already
 * compares a `uuid` without regard to case; lowercasing here is what makes the
 * ids this module returns the ones a job id is derived from.
 */
import type { ActionCtx } from "@showzy/core";
import {
  ConflictError,
  CoreInvariantError,
  NotFoundError,
} from "@showzy/core/errors";
import {
  ASSISTANT_TURN_ACTIVE_STATUSES,
  assistantChatMessages,
  assistantTurns,
} from "@showzy/db/schema/assistant";
import { postgresError } from "@showzy/module-kit/postgres-unique";
import { and, asc, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import type { z } from "zod";

import type {
  acceptTurnInputSchema,
  acceptTurnOutputSchema,
} from "../actions/accept-turn.contract.js";
import type {
  finishTurnInputSchema,
  finishTurnOutputSchema,
} from "../actions/finish-turn.contract.js";
import type {
  listStaleTurnsInputSchema,
  listStaleTurnsOutputSchema,
} from "../actions/list-stale-turns.contract.js";
import type {
  startTurnInputSchema,
  startTurnOutputSchema,
} from "../actions/start-turn.contract.js";
import { nextChatMessageSeq } from "./chat-messages.js";
import { loadOwnConversation } from "./load-conversation.js";
import { requireWritable, type WritableStaffDb } from "./writable.js";

type StaffCtx = Extract<ActionCtx, { principal: "staff" }>;
type SystemCtx = Extract<ActionCtx, { principal: "system" }>;

type AcceptTurnOutput = z.output<typeof acceptTurnOutputSchema>;

interface TurnIdentity {
  readonly companyId: string;
  readonly conversationId: string;
  readonly kind: "chat" | "answer";
  readonly commandId: string;
}

const turnViewColumns = {
  conversationId: assistantTurns.conversationId,
  kind: assistantTurns.kind,
  commandId: assistantTurns.commandId,
  status: assistantTurns.status,
  placeholderMessageId: assistantTurns.placeholderMessageId,
  userMessageId: assistantTurns.userMessageId,
  continuesCommandId: assistantTurns.continuesCommandId,
};

function isActive() {
  return inArray(assistantTurns.status, [...ASSISTANT_TURN_ACTIVE_STATUSES]);
}

function byIdentity(identity: TurnIdentity) {
  return and(
    eq(assistantTurns.companyId, identity.companyId),
    eq(assistantTurns.conversationId, identity.conversationId),
    eq(assistantTurns.kind, identity.kind),
    eq(assistantTurns.commandId, identity.commandId),
  );
}

/** `now()` plus a number of milliseconds, computed by Postgres. */
function nowPlusMs(ms: number) {
  return sql`now() + (${ms}::integer * interval '1 millisecond')`;
}

/**
 * The conversation is the caller's, and the identity in the one casing this
 * module stores. Not-found for a foreign author or company, before anything
 * about a turn is read.
 */
async function ownTurnIdentity(
  ctx: StaffCtx,
  ref: {
    readonly conversationId: string;
    readonly kind: "chat" | "answer";
    readonly commandId: string;
  },
): Promise<TurnIdentity> {
  const conversationId = ref.conversationId.toLowerCase();
  await loadOwnConversation({
    db: ctx.db,
    companyId: ctx.companyId,
    userId: ctx.userId,
    conversationId,
  });
  return {
    companyId: ctx.companyId,
    conversationId,
    kind: ref.kind,
    commandId: ref.commandId.toLowerCase(),
  };
}

/**
 * What an accept answers without writing: this command's turn, if it was
 * accepted before, or `busy` when another turn holds the conversation.
 */
async function settledAccept(
  db: WritableStaffDb,
  identity: TurnIdentity,
): Promise<AcceptTurnOutput | null> {
  const receipt = (
    await db
      .select(turnViewColumns)
      .from(assistantTurns)
      .where(byIdentity(identity))
      .limit(1)
  )[0];
  if (receipt !== undefined) {
    return {
      outcome: "replayed",
      conversationId: identity.conversationId,
      turn: receipt,
    };
  }
  const active = (
    await db
      .select({ id: assistantTurns.id })
      .from(assistantTurns)
      .where(
        and(
          eq(assistantTurns.companyId, identity.companyId),
          eq(assistantTurns.conversationId, identity.conversationId),
          isActive(),
        ),
      )
      .limit(1)
  )[0];
  return active === undefined
    ? null
    : { outcome: "busy", conversationId: identity.conversationId };
}

/**
 * The command a continuation's tools derive their keys from: the first turn of
 * the chain. Continuing a continuation must replay the writes of the turn that
 * first made them, not name a second attempt at them.
 */
async function continuationRoot(
  db: WritableStaffDb,
  identity: TurnIdentity,
  interruptedCommandId: string,
): Promise<string> {
  const interrupted = (
    await db
      .select({
        commandId: assistantTurns.commandId,
        continuesCommandId: assistantTurns.continuesCommandId,
      })
      .from(assistantTurns)
      .where(
        and(
          eq(assistantTurns.companyId, identity.companyId),
          eq(assistantTurns.conversationId, identity.conversationId),
          eq(assistantTurns.commandId, interruptedCommandId),
          eq(assistantTurns.status, "interrupted"),
        ),
      )
      .orderBy(desc(assistantTurns.createdAt))
      .limit(1)
  )[0];
  if (interrupted === undefined) {
    throw new ConflictError(
      "There is no interrupted turn with this command to continue.",
    );
  }
  return interrupted.continuesCommandId ?? interrupted.commandId;
}

export async function acceptStaffTurn(env: {
  readonly ctx: StaffCtx;
  readonly input: z.output<typeof acceptTurnInputSchema>;
}): Promise<AcceptTurnOutput> {
  const { ctx, input } = env;
  const identity = await ownTurnIdentity(ctx, input);
  const db = requireWritable(ctx.db);

  const settled = await settledAccept(db, identity);
  if (settled !== null) {
    return settled;
  }

  const continuesCommandId =
    input.continuesCommandId === undefined
      ? null
      : await continuationRoot(
          db,
          identity,
          input.continuesCommandId.toLowerCase(),
        );

  const userMessageId = input.userMessage?.messageId.toLowerCase() ?? null;
  const placeholderMessageId = input.placeholder.messageId.toLowerCase();

  try {
    // A nested savepoint, so a refused insert leaves the action's transaction
    // usable for the re-read below and for its audit row.
    return await db.transaction(async (tx) => {
      if (input.userMessage !== undefined && userMessageId !== null) {
        await tx.insert(assistantChatMessages).values({
          companyId: identity.companyId,
          conversationId: identity.conversationId,
          seq: nextChatMessageSeq(identity),
          messageId: userMessageId,
          bind: input.userMessage.bind,
          message: input.userMessage.message,
        });
      }
      await tx.insert(assistantChatMessages).values({
        companyId: identity.companyId,
        conversationId: identity.conversationId,
        seq: nextChatMessageSeq(identity),
        messageId: placeholderMessageId,
        bind: input.placeholder.bind,
        message: input.placeholder.message,
      });
      const inserted = await tx
        .insert(assistantTurns)
        .values({
          ...identity,
          status: "queued",
          userId: ctx.userId,
          sessionId: input.sessionId,
          requestId: ctx.requestId,
          userMessageId,
          placeholderMessageId,
          continuesCommandId,
          companyReservedMicroUsd: input.budgetHold.companyReservedMicroUsd,
          globalReservedMicroUsd: input.budgetHold.globalReservedMicroUsd,
          budgetKyivDate: input.budgetHold.kyivDate,
        })
        .returning(turnViewColumns);
      const turn = inserted[0];
      if (turn === undefined) {
        throw new CoreInvariantError(
          "assistant.acceptTurn insert returned no row",
        );
      }
      return {
        outcome: "accepted" as const,
        conversationId: identity.conversationId,
        turn,
      };
    });
  } catch (error) {
    if (postgresError(error)?.code !== "23505") {
      throw error;
    }
    // A concurrent accept committed between the read above and these inserts:
    // the same command, or another turn taking the conversation. A unique
    // violation waits for the other transaction to commit, so it is visible now.
    const raced = await settledAccept(db, identity);
    if (raced !== null) {
      return raced;
    }
    throw new ConflictError(
      "This message is already stored, or another write took its place.",
    );
  }
}

async function currentStatus(
  db: WritableStaffDb,
  identity: TurnIdentity,
): Promise<(typeof assistantTurns.$inferSelect)["status"]> {
  const row = (
    await db
      .select({ status: assistantTurns.status })
      .from(assistantTurns)
      .where(byIdentity(identity))
      .limit(1)
  )[0];
  if (row === undefined) {
    throw new NotFoundError();
  }
  return row.status;
}

export async function startStaffTurn(env: {
  readonly ctx: StaffCtx;
  readonly input: z.output<typeof startTurnInputSchema>;
}): Promise<z.output<typeof startTurnOutputSchema>> {
  const identity = await ownTurnIdentity(env.ctx, env.input);
  const db = requireWritable(env.ctx.db);

  const started = (
    await db
      .update(assistantTurns)
      .set({
        status: "running",
        startedAt: sql`now()`,
        deadlineAt: nowPlusMs(env.input.timeoutMs),
      })
      .where(and(byIdentity(identity), eq(assistantTurns.status, "queued")))
      .returning({ deadlineAt: assistantTurns.deadlineAt })
  )[0];
  if (started === undefined) {
    return {
      outcome: "not_queued",
      conversationId: identity.conversationId,
      status: await currentStatus(db, identity),
    };
  }
  if (started.deadlineAt === null) {
    throw new CoreInvariantError("assistant.startTurn set no deadline");
  }
  return {
    outcome: "started",
    conversationId: identity.conversationId,
    deadlineAt: started.deadlineAt.toISOString(),
  };
}

export async function finishStaffTurn(env: {
  readonly ctx: StaffCtx;
  readonly input: z.output<typeof finishTurnInputSchema>;
}): Promise<z.output<typeof finishTurnOutputSchema>> {
  const identity = await ownTurnIdentity(env.ctx, env.input);
  const db = requireWritable(env.ctx.db);

  const finished = (
    await db
      .update(assistantTurns)
      .set({
        status: env.input.status,
        finishedAt: sql`now()`,
        // Only an active turn needs its session: the worker's liveness check.
        // An ended turn keeps no pointer to a person's session.
        sessionId: null,
      })
      .where(and(byIdentity(identity), isActive()))
      .returning({ status: assistantTurns.status })
  )[0];
  if (finished === undefined) {
    return {
      outcome: "already_finished",
      conversationId: identity.conversationId,
      status: await currentStatus(db, identity),
    };
  }
  return {
    outcome: "finished",
    conversationId: identity.conversationId,
    status: env.input.status,
  };
}

export async function listStaleTurns(env: {
  readonly ctx: SystemCtx;
  readonly input: z.output<typeof listStaleTurnsInputSchema>;
}): Promise<z.output<typeof listStaleTurnsOutputSchema>> {
  const rows = await env.ctx.db
    .select({
      companyId: assistantTurns.companyId,
      conversationId: assistantTurns.conversationId,
      kind: assistantTurns.kind,
      commandId: assistantTurns.commandId,
      status: assistantTurns.status,
      placeholderMessageId: assistantTurns.placeholderMessageId,
      companyReservedMicroUsd: assistantTurns.companyReservedMicroUsd,
      globalReservedMicroUsd: assistantTurns.globalReservedMicroUsd,
      budgetKyivDate: assistantTurns.budgetKyivDate,
    })
    .from(assistantTurns)
    .where(
      and(
        isActive(),
        or(
          and(
            eq(assistantTurns.status, "queued"),
            lt(
              assistantTurns.createdAt,
              sql`now() - (${env.input.queuedStaleAfterMs}::integer * interval '1 millisecond')`,
            ),
          ),
          and(
            eq(assistantTurns.status, "running"),
            lt(assistantTurns.deadlineAt, sql`now()`),
          ),
        ),
      ),
    )
    .orderBy(asc(assistantTurns.createdAt), asc(assistantTurns.id))
    .limit(env.input.limit);

  return {
    turns: rows.map((row) => ({
      companyId: row.companyId,
      conversationId: row.conversationId,
      kind: row.kind,
      commandId: row.commandId,
      status: row.status,
      placeholderMessageId: row.placeholderMessageId,
      budgetHold: {
        companyReservedMicroUsd: row.companyReservedMicroUsd,
        globalReservedMicroUsd: row.globalReservedMicroUsd,
        kyivDate: row.budgetKyivDate,
      },
      staleness:
        row.status === "queued"
          ? ("queued_without_start" as const)
          : ("running_past_deadline" as const),
    })),
  };
}
