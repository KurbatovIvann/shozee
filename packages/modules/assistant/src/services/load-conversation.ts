/**
 * Load one staff conversation the verified caller authored. Missing,
 * foreign-author, and foreign-company ids fail with the same not-found.
 */
import type { ActionCtx } from "@showzy/core";
import { NotFoundError } from "@showzy/core/errors";
import { assistantConversations } from "@showzy/db/schema/assistant";
import { and, eq } from "drizzle-orm";

import {
  conversationColumns,
  type ConversationRow,
} from "./conversation-view.js";

type StaffDb = Extract<ActionCtx, { principal: "staff" }>["db"];

export async function loadOwnConversation(env: {
  readonly db: StaffDb;
  readonly companyId: string;
  readonly userId: string;
  readonly conversationId: string;
}): Promise<ConversationRow> {
  const row = (
    await env.db
      .select(conversationColumns)
      .from(assistantConversations)
      .where(
        and(
          eq(assistantConversations.companyId, env.companyId),
          eq(assistantConversations.userId, env.userId),
          eq(assistantConversations.id, env.conversationId),
        ),
      )
      .limit(1)
  )[0];
  if (row === undefined) {
    throw new NotFoundError();
  }
  return row;
}
