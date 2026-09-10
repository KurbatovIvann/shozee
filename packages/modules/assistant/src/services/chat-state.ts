/**
 * The stored chat document and provider history for one conversation.
 *
 * Both are opaque here. This module owns the row and the ownership rule; what
 * is inside the payloads belongs to the runtime that writes them, and parsing
 * it here would be a second definition of a shape that already has one.
 */
import type { ActionCtx } from "@showzy/core";
import { assistantChatState } from "@showzy/db/schema/assistant";
import { and, eq } from "drizzle-orm";

import { loadOwnConversation } from "./load-conversation.js";
import { requireWritable } from "./writable.js";

type StaffCtx = Extract<ActionCtx, { principal: "staff" }>;

export interface StaffChatState {
  readonly document: unknown;
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
      .select({
        document: assistantChatState.document,
        history: assistantChatState.history,
      })
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
  return {
    document: row?.document ?? null,
    history: row?.history ?? null,
  };
}

export async function writeStaffChatState(env: {
  readonly ctx: StaffCtx;
  readonly conversationId: string;
  /** Absent leaves the stored value alone. Present — including null — sets it. */
  readonly document?: unknown;
  readonly history?: unknown;
}): Promise<void> {
  await loadOwnConversation({
    db: env.ctx.db,
    companyId: env.ctx.companyId,
    userId: env.ctx.userId,
    conversationId: env.conversationId,
  });
  const db = requireWritable(env.ctx.db);

  const setsDocument = "document" in env;
  const setsHistory = "history" in env;
  if (!setsDocument && !setsHistory) {
    return;
  }

  const now = new Date();
  await db
    .insert(assistantChatState)
    .values({
      companyId: env.ctx.companyId,
      conversationId: env.conversationId,
      document: setsDocument ? (env.document ?? null) : null,
      history: setsHistory ? (env.history ?? null) : null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [assistantChatState.companyId, assistantChatState.conversationId],
      // Only the halves this call carries. Writing both every time would let a
      // document write blank the history it never saw.
      set: {
        ...(setsDocument ? { document: env.document ?? null } : {}),
        ...(setsHistory ? { history: env.history ?? null } : {}),
        updatedAt: now,
      },
    });
}
