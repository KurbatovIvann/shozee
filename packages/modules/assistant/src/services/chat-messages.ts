/**
 * A conversation's message log: read a page, append one, replace the payload of
 * one.
 *
 * Payloads are opaque here, as the chat state beside them is. This module owns
 * the rows, the author rule and the ordering; what a message contains belongs
 * to the runtime that writes it, and parsing it here would be a second
 * definition of a shape that already has one.
 */
import type { ActionCtx } from "@showzy/core";
import {
  ConflictError,
  CoreInvariantError,
  NotFoundError,
} from "@showzy/core/errors";
import { assistantChatMessages } from "@showzy/db/schema/assistant";
import { postgresError } from "@showzy/module-kit/postgres-unique";
import { and, desc, eq, lt, sql } from "drizzle-orm";

import { loadOwnConversation } from "./load-conversation.js";
import { requireWritable } from "./writable.js";

type StaffCtx = Extract<ActionCtx, { principal: "staff" }>;

export interface StaffChatMessageRecord {
  readonly seq: number;
  readonly messageId: string;
  readonly bind: string;
  readonly message: Record<string, unknown>;
  readonly revision: number;
}

function isPayload(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One past the last sequence number of a conversation, as an expression of the
 * insert that uses it. Two inserts that race compute the same number and the
 * unique key refuses the second, which is the point: the runtime serialises
 * turns, and a failure of that must surface.
 */
export function nextChatMessageSeq(env: {
  readonly companyId: string;
  readonly conversationId: string;
}) {
  return sql<number>`(
    select coalesce(max(${assistantChatMessages.seq}), 0) + 1
    from ${assistantChatMessages}
    where ${assistantChatMessages.companyId} = ${env.companyId}
      and ${assistantChatMessages.conversationId} = ${env.conversationId}
  )`;
}

function toRecord(row: {
  readonly seq: number;
  readonly messageId: string;
  readonly bind: string;
  readonly message: unknown;
  readonly revision: number;
}): StaffChatMessageRecord {
  // Every write goes through a schema that only admits an object, so anything
  // else in the column was put there around this module.
  if (!isPayload(row.message)) {
    throw new CoreInvariantError(
      `assistant chat message ${String(row.seq)} is not an object`,
    );
  }
  return {
    seq: row.seq,
    messageId: row.messageId,
    bind: row.bind,
    message: row.message,
    revision: row.revision,
  };
}

export async function readStaffChatMessages(env: {
  readonly ctx: StaffCtx;
  readonly conversationId: string;
  readonly beforeSeq?: number;
  readonly limit: number;
}): Promise<{
  readonly records: StaffChatMessageRecord[];
  readonly hasOlder: boolean;
}> {
  // Not-found for a foreign author or a foreign company, before any read of the
  // log itself: a conversation id is not a secret.
  await loadOwnConversation({
    db: env.ctx.db,
    companyId: env.ctx.companyId,
    userId: env.ctx.userId,
    conversationId: env.conversationId,
  });

  const rows = await env.ctx.db
    .select({
      seq: assistantChatMessages.seq,
      messageId: assistantChatMessages.messageId,
      bind: assistantChatMessages.bind,
      message: assistantChatMessages.message,
      revision: assistantChatMessages.revision,
    })
    .from(assistantChatMessages)
    .where(
      and(
        eq(assistantChatMessages.companyId, env.ctx.companyId),
        eq(assistantChatMessages.conversationId, env.conversationId),
        env.beforeSeq === undefined
          ? undefined
          : lt(assistantChatMessages.seq, env.beforeSeq),
      ),
    )
    .orderBy(desc(assistantChatMessages.seq))
    .limit(env.limit + 1);

  // Read newest first so the limit cuts the old end, then hand the page back in
  // the order it is read in.
  const hasOlder = rows.length > env.limit;
  const page = hasOlder ? rows.slice(0, env.limit) : rows;
  return { records: page.toReversed().map(toRecord), hasOlder };
}

export async function insertStaffChatMessage(env: {
  readonly ctx: StaffCtx;
  readonly conversationId: string;
  readonly messageId: string;
  readonly bind: string;
  readonly message: Record<string, unknown>;
}): Promise<number> {
  await loadOwnConversation({
    db: env.ctx.db,
    companyId: env.ctx.companyId,
    userId: env.ctx.userId,
    conversationId: env.conversationId,
  });
  const db = requireWritable(env.ctx.db);

  // One past the last, in the same statement as the insert.
  const next = nextChatMessageSeq({
    companyId: env.ctx.companyId,
    conversationId: env.conversationId,
  });

  try {
    // A nested savepoint, so a refused insert does not abort the action's own
    // transaction before its audit row is written.
    return await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(assistantChatMessages)
        .values({
          companyId: env.ctx.companyId,
          conversationId: env.conversationId,
          seq: next,
          messageId: env.messageId,
          bind: env.bind,
          message: env.message,
        })
        .returning({ seq: assistantChatMessages.seq });
      const row = inserted[0];
      if (row === undefined) {
        throw new CoreInvariantError(
          "assistant.insertChatMessage insert returned no row",
        );
      }
      return row.seq;
    });
  } catch (error) {
    if (postgresError(error)?.code === "23505") {
      throw new ConflictError(
        "This message is already stored, or another write took its place.",
      );
    }
    throw error;
  }
}

export async function updateStaffChatMessage(env: {
  readonly ctx: StaffCtx;
  readonly conversationId: string;
  readonly seq: number;
  readonly messageId: string;
  readonly message: Record<string, unknown>;
}): Promise<{ readonly seq: number; readonly revision: number }> {
  await loadOwnConversation({
    db: env.ctx.db,
    companyId: env.ctx.companyId,
    userId: env.ctx.userId,
    conversationId: env.conversationId,
  });
  const db = requireWritable(env.ctx.db);

  const updated = await db
    .update(assistantChatMessages)
    .set({
      message: env.message,
      // One more per write, in the statement that writes, so two updates can
      // never both claim the same revision.
      revision: sql`${assistantChatMessages.revision} + 1`,
    })
    .where(
      and(
        eq(assistantChatMessages.companyId, env.ctx.companyId),
        eq(assistantChatMessages.conversationId, env.conversationId),
        // Both, never one: a sequence number alone could name a message the
        // caller did not read, and a message id alone could name an old one.
        eq(assistantChatMessages.seq, env.seq),
        eq(assistantChatMessages.messageId, env.messageId),
      ),
    )
    .returning({
      seq: assistantChatMessages.seq,
      revision: assistantChatMessages.revision,
    });
  const row = updated[0];
  if (row === undefined) {
    throw new NotFoundError();
  }
  return row;
}
