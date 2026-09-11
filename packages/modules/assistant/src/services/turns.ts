/**
 * A conversation's turns: accept one, start it, finish it, find the ones that a
 * crashed worker left behind (SHO-560, ADR-0039), read the one a job names and
 * interrupt one (SHO-561).
 *
 * The turn row is the lease and the receipt at once. Which turn is active is
 * `ASSISTANT_TURN_ACTIVE_STATUSES` from the owned schema and nothing else — the
 * partial unique index reads the same list — so a query here and the database
 * cannot hold two ideas of it. Which row is a command's receipt is decided in
 * SQL, once per query, and returned as a column rather than decided again here.
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
  assistantConversations,
  assistantTurns,
  type AssistantTurnKind,
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
  interruptTurnInputSchema,
  interruptTurnOutputSchema,
} from "../actions/interrupt-turn.contract.js";
import type {
  listStaleTurnsInputSchema,
  listStaleTurnsOutputSchema,
} from "../actions/list-stale-turns.contract.js";
import type {
  readTurnForJobInputSchema,
  readTurnForJobOutputSchema,
} from "../actions/read-turn-for-job.contract.js";
import type {
  startTurnInputSchema,
  startTurnOutputSchema,
} from "../actions/start-turn.contract.js";
import type { assistantTurnBudgetHoldSchema } from "../actions/turn-record.contract.js";
import { nextChatMessageSeq } from "./chat-messages.js";
import { loadOwnConversation } from "./load-conversation.js";
import {
  requireWritable,
  requireWritableSystem,
  type WritableStaffDb,
} from "./writable.js";

type StaffCtx = Extract<ActionCtx, { principal: "staff" }>;
type SystemCtx = Extract<ActionCtx, { principal: "system" }>;
/**
 * Staff and system actions receive the same writable transaction. The system
 * interrupt passes its own through this type, so the compiler says so here if
 * core ever gives them different ones.
 */
type WritableDb = WritableStaffDb;

type AcceptTurnOutput = z.output<typeof acceptTurnOutputSchema>;
type BudgetHold = z.output<typeof assistantTurnBudgetHoldSchema>;

interface TurnIdentity {
  readonly companyId: string;
  readonly conversationId: string;
  readonly kind: AssistantTurnKind;
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
 *
 * The receipt and the lease are read in one statement (SHO-567). Under READ
 * COMMITTED every statement takes its own snapshot, and an accept of the same
 * command writes both in one commit: two reads could straddle that commit,
 * find no receipt and then the lease, and answer `busy` for the caller's own
 * command. One statement sees that commit for both or for neither.
 */
async function settledAccept(
  db: WritableStaffDb,
  identity: TurnIdentity,
): Promise<AcceptTurnOutput | null> {
  // Whether a row is this command's receipt, said once: the filter and the
  // answer below both read this expression, so they cannot disagree about it.
  const isThisCommand = sql<boolean>`(${assistantTurns.kind} = ${identity.kind} and ${assistantTurns.commandId} = ${identity.commandId})`;
  // At most two rows: the receipt is unique per command and the lease per
  // conversation, and they are one row when this command holds the lease.
  const rows = await db
    .select({ turn: turnViewColumns, isThisCommand })
    .from(assistantTurns)
    .where(
      and(
        eq(assistantTurns.companyId, identity.companyId),
        eq(assistantTurns.conversationId, identity.conversationId),
        or(isThisCommand, isActive()),
      ),
    )
    .limit(2);
  const receipt = rows.find((row) => row.isThisCommand);
  if (receipt !== undefined) {
    return {
      outcome: "replayed",
      conversationId: identity.conversationId,
      turn: receipt.turn,
    };
  }
  return rows.length === 0
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
  db: WritableDb,
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

/**
 * Ends an active turn and takes its budget hold off the row, in one statement,
 * and returns the hold it took — or null when the turn was no longer active and
 * nothing was taken.
 *
 * `RETURNING` sees only the updated row, whose hold is now zero, so the hold is
 * read from the same row locked in a sub-select. A second finaliser of the same
 * turn waits on that lock, then finds the row no longer active and takes
 * nothing: a hold leaves the row at most once, whichever of the worker and the
 * reconciler gets there first.
 */
async function finaliseTurn(
  db: WritableDb,
  identity: TurnIdentity,
  status: "done" | "failed" | "interrupted",
): Promise<BudgetHold | null> {
  const held = db
    .select({
      id: assistantTurns.id,
      companyReservedMicroUsd: assistantTurns.companyReservedMicroUsd,
      globalReservedMicroUsd: assistantTurns.globalReservedMicroUsd,
      budgetKyivDate: assistantTurns.budgetKyivDate,
    })
    .from(assistantTurns)
    .where(and(byIdentity(identity), isActive()))
    .for("update")
    .as("held");
  const finished = (
    await db
      .update(assistantTurns)
      .set({
        status,
        finishedAt: sql`now()`,
        // An ended turn keeps no pointer to a person's session.
        sessionId: null,
        companyReservedMicroUsd: 0,
        globalReservedMicroUsd: 0,
      })
      .from(held)
      .where(eq(assistantTurns.id, held.id))
      .returning({
        companyReservedMicroUsd: held.companyReservedMicroUsd,
        globalReservedMicroUsd: held.globalReservedMicroUsd,
        kyivDate: held.budgetKyivDate,
      })
  )[0];
  return finished ?? null;
}

export async function finishStaffTurn(env: {
  readonly ctx: StaffCtx;
  readonly input: z.output<typeof finishTurnInputSchema>;
}): Promise<z.output<typeof finishTurnOutputSchema>> {
  const identity = await ownTurnIdentity(env.ctx, env.input);
  const db = requireWritable(env.ctx.db);

  const releasedHold = await finaliseTurn(db, identity, env.input.status);
  if (releasedHold === null) {
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
    releasedHold,
  };
}

/**
 * The reconciler's interrupt, inside the company the stale turn belongs to. No
 * author rule: a system job acts for no person, and the company scope is the
 * whole of its reach.
 */
export async function interruptSystemTurn(env: {
  readonly ctx: SystemCtx;
  readonly input: z.output<typeof interruptTurnInputSchema>;
}): Promise<z.output<typeof interruptTurnOutputSchema>> {
  if (env.ctx.scope !== "tenant") {
    throw new CoreInvariantError(
      "assistant.interruptTurn expects tenant system",
    );
  }
  const db = requireWritableSystem(env.ctx.db);
  const identity: TurnIdentity = {
    companyId: env.ctx.companyId,
    conversationId: env.input.conversationId.toLowerCase(),
    kind: env.input.kind,
    commandId: env.input.commandId.toLowerCase(),
  };

  const releasedHold = await finaliseTurn(db, identity, "interrupted");
  if (releasedHold === null) {
    return {
      outcome: "already_finished",
      conversationId: identity.conversationId,
      status: await currentStatus(db, identity),
    };
  }
  return {
    outcome: "interrupted",
    conversationId: identity.conversationId,
    releasedHold,
  };
}

/**
 * The turn a job names, across companies. The turn's own unique key leads with
 * its company, which a job does not carry, so the row is reached through its
 * conversation's primary key; the join is also the company the turn belongs to.
 * Whether a row is the job's turn is decided by this query alone.
 */
export async function readTurnForJob(env: {
  readonly ctx: SystemCtx;
  readonly input: z.output<typeof readTurnForJobInputSchema>;
}): Promise<z.output<typeof readTurnForJobOutputSchema>> {
  const row = (
    await env.ctx.db
      .select({
        companyId: assistantTurns.companyId,
        conversationId: assistantTurns.conversationId,
        kind: assistantTurns.kind,
        commandId: assistantTurns.commandId,
        userId: assistantTurns.userId,
        requestId: assistantTurns.requestId,
        status: assistantTurns.status,
        placeholderMessageId: assistantTurns.placeholderMessageId,
        deadlineAt: assistantTurns.deadlineAt,
        companyReservedMicroUsd: assistantTurns.companyReservedMicroUsd,
        globalReservedMicroUsd: assistantTurns.globalReservedMicroUsd,
        budgetKyivDate: assistantTurns.budgetKyivDate,
        continuationRootCommandId: sql<string>`coalesce(${assistantTurns.continuesCommandId}, ${assistantTurns.commandId})`,
      })
      .from(assistantTurns)
      .innerJoin(
        assistantConversations,
        and(
          eq(assistantConversations.companyId, assistantTurns.companyId),
          eq(assistantConversations.id, assistantTurns.conversationId),
        ),
      )
      .where(
        and(
          eq(assistantConversations.id, env.input.conversationId.toLowerCase()),
          eq(assistantTurns.kind, env.input.kind),
          eq(assistantTurns.commandId, env.input.commandId.toLowerCase()),
        ),
      )
      .limit(1)
  )[0];
  if (row === undefined) {
    return { turn: null };
  }
  return {
    turn: {
      companyId: row.companyId,
      conversationId: row.conversationId,
      kind: row.kind,
      commandId: row.commandId,
      userId: row.userId,
      requestId: row.requestId,
      status: row.status,
      placeholderMessageId: row.placeholderMessageId,
      deadlineAt: row.deadlineAt?.toISOString() ?? null,
      budgetHold: {
        companyReservedMicroUsd: row.companyReservedMicroUsd,
        globalReservedMicroUsd: row.globalReservedMicroUsd,
        kyivDate: row.budgetKyivDate,
      },
      continuationRootCommandId: row.continuationRootCommandId,
    },
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
