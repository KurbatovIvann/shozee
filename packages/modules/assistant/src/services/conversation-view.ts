/**
 * The one projection of a conversation row. Create and list share it so a
 * second shape cannot drift into existence between them.
 */
import { assistantConversations } from "@showzy/db/schema/assistant";
import type { InferColumnsDataTypes } from "drizzle-orm";
import type { z } from "zod";

import type { conversationViewSchema } from "../actions/conversation-view.contract.js";

type ConversationView = z.output<typeof conversationViewSchema>;

export const conversationColumns = {
  id: assistantConversations.id,
  userId: assistantConversations.userId,
  title: assistantConversations.title,
  createdAt: assistantConversations.createdAt,
  updatedAt: assistantConversations.updatedAt,
};

export type ConversationRow = InferColumnsDataTypes<typeof conversationColumns>;

export function toConversationView(row: ConversationRow): ConversationView {
  return {
    id: row.id,
    userId: row.userId,
    title: row.title,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
