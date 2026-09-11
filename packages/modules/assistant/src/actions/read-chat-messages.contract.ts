/**
 * Staff read: one page of a conversation's message log, newest last.
 *
 * `beforeSeq` omitted is the latest page. The page is returned oldest first so
 * a reader can append it as it stands, and `hasOlder` says whether a page
 * before it exists — `limit + 1` rows are read to know, and the extra one is
 * not returned.
 *
 * Mechanical: `timeout: 5000` is one index range scan.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import {
  CHAT_MESSAGES_PAGE_MAX,
  chatMessageRecordSchema,
  chatMessageSeqSchema,
} from "./chat-message-record.contract.js";
import { STAFF_CONVERSATION_AUTHOR_INVARIANT } from "./conversation-view.contract.js";

export const readChatMessagesInputSchema = z.strictObject({
  conversationId: z.uuid(),
  beforeSeq: chatMessageSeqSchema.optional(),
  limit: z.number().int().min(1).max(CHAT_MESSAGES_PAGE_MAX),
});

export const readChatMessagesOutputSchema = z.strictObject({
  records: z.array(chatMessageRecordSchema),
  hasOlder: z.boolean(),
});

export const readChatMessagesContract = defineActionContract({
  name: "assistant.readChatMessages",
  description: `${STAFF_CONVERSATION_AUTHOR_INVARIANT} Read one page of a conversation's stored messages, oldest first within the page. Without beforeSeq the page is the latest one; with it, the page ends just before that sequence number. hasOlder says whether an earlier page exists. Messages are opaque payloads owned by the assistant runtime. A conversation with no messages reads as an empty page, not as not-found; a conversation belonging to another author or another company is not-found. Company id is never input.`,
  principal: "staff",
  transport: "internal",
  input: readChatMessagesInputSchema,
  output: readChatMessagesOutputSchema,
  permissions: ["assistant:use"],
  aiExposure: "internal",
  risk: "read",
  requiresConfirmation: false,
  idempotent: false,
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: ["VALIDATION", "NOT_FOUND"],
  audit: false,
  timeout: 5_000,
});
