/**
 * The provider history for one conversation: what the next turn is built from.
 *
 * Opaque here. This module owns the row and the ownership rule; what is inside
 * the payload belongs to the runtime that writes it, and parsing it here would
 * be a second definition of a shape that already has one.
 *
 * The transcript a person reads is not here. It is a log of messages, in
 * `chat-messages.ts` (SHO-555).
 */
import type { ActionCtx } from "@showzy/core";
import { assistantChatState } from "@showzy/db/schema/assistant";
import { and, eq } from "drizzle-orm";

import { loadOwnConversation } from "./load-conversation.js";
import { requireWritable, type WritableStaffDb } from "./writable.js";

type StaffCtx = Extract<ActionCtx, { principal: "staff" }>;

export interface StaffChatState {
  readonly history: unknown;
}

export async function readStaffChatState(env: {
  readonly ctx: StaffCtx;
  readonly conversationId: string;
}): Promise<StaffChatState> {
  // Not-found for a foreign author or a foreign company, before any read of
  // the state itself: a conversation id is not a secret.
  await loadOwnConversation({
    db: env.ctx.db,
    companyId: env.ctx.companyId,
    userId: env.ctx.userId,
    conversationId: env.conversationId,
  });

  const row = (
    await env.ctx.db
      .select({ history: assistantChatState.history })
      .from(assistantChatState)
      .where(
        and(
          eq(assistantChatState.companyId, env.ctx.companyId),
          eq(assistantChatState.conversationId, env.conversationId),
        ),
      )
      .limit(1)
  )[0];

  // A conversation with no turns yet is empty, not missing.
  return { history: row?.history ?? null };
}

export async function writeStaffChatState(env: {
  readonly ctx: StaffCtx;
  readonly conversationId: string;
  readonly history: unknown;
}): Promise<void> {
  await loadOwnConversation({
    db: env.ctx.db,
    companyId: env.ctx.companyId,
    userId: env.ctx.userId,
    conversationId: env.conversationId,
  });
  const db = requireWritable(env.ctx.db);

  await upsertChatState(db, {
    companyId: env.ctx.companyId,
    conversationId: env.conversationId,
    history: env.history,
  });
}

export async function upsertChatState(
  db: WritableStaffDb,
  scope: {
    readonly companyId: string;
    readonly conversationId: string;
    readonly history: unknown;
  },
): Promise<void> {
  // `updated_at` is the shared trigger's (db.md §5): one clock, Postgres's.
  const history = scope.history ?? null;
  await db
    .insert(assistantChatState)
    .values({
      companyId: scope.companyId,
      conversationId: scope.conversationId,
      history,
    })
    .onConflictDoUpdate({
      target: [assistantChatState.companyId, assistantChatState.conversationId],
      set: { history },
    });
}
