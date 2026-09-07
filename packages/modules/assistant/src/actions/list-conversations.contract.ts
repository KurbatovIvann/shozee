/**
 * Staff conversation list (SHO-321 / feature SHO-318). Mechanical choices
 * copied from `customers.listCustomers` / `catalog.listProducts` — do not
 * invent a second list shape:
 * - Pagination is a stable `(updated_at desc, id desc)` cursor, not offset.
 *   `limit` defaults to 20 and caps at 50.
 * - Cursor payload is `updatedAt|id` (ISO datetime, then uuid).
 * - Author-only page: `company_id` + `user_id` from the verified staff
 *   context. A colleague's conversation is the same not-found as a
 *   foreign company. Review of staff conversations is a separate feature.
 * - `timeout: 5000` matches the golden staff reads.
 * - No `rateLimit` override — staff default 120/min per user.
 * - `idempotent: false` like other staff reads: core.md §5 treats reads as
 *   naturally idempotent (no key, no storage).
 */
import { defineActionContract } from "@showzy/core/contract";
import {
  createCursorCodec,
  listCursorInput,
  listLimitInput,
} from "@showzy/validation/pagination";
import { z } from "zod";

import {
  conversationViewSchema,
  STAFF_CONVERSATION_AUTHOR_INVARIANT,
} from "./conversation-view.contract.js";

export const LIST_CONVERSATIONS_DEFAULT_LIMIT = 20;
export const LIST_CONVERSATIONS_MAX_LIMIT = 50;
export const LIST_CONVERSATIONS_CURSOR_MAX = 80;

const listConversationsCursor = createCursorCodec({
  payload: z.object({
    updatedAt: z.iso.datetime(),
    id: z.uuid(),
  }),
  fields: [
    { key: "updatedAt", kind: "isoDatetime" },
    { key: "id", kind: "uuid" },
  ],
});

export function formatListConversationsCursor(
  updatedAt: Date,
  id: string,
): string {
  return listConversationsCursor.encode({ updatedAt, id });
}

export function parseListConversationsCursor(
  cursor: string,
): { updatedAt: string; id: string } | undefined {
  return listConversationsCursor.decode(cursor);
}

export const listConversationsInputSchema = z.strictObject({
  limit: listLimitInput(
    LIST_CONVERSATIONS_MAX_LIMIT,
    LIST_CONVERSATIONS_DEFAULT_LIMIT,
  ),
  cursor: listCursorInput(
    parseListConversationsCursor,
    LIST_CONVERSATIONS_CURSOR_MAX,
  ),
});

export const listConversationsOutputSchema = z.object({
  items: z.array(conversationViewSchema),
  nextCursor: z.string().min(1).nullable(),
});

export const listConversationsContract = defineActionContract({
  name: "assistant.listConversations",
  description: `${STAFF_CONVERSATION_AUTHOR_INVARIANT} List the calling author's conversations, newest-updated first. Paginate with an updated-at/id cursor and a page size of at most 50. Company id is never input. Does not return messages or tool-run rows.`,
  principal: "staff",
  transport: "client",
  input: listConversationsInputSchema,
  output: listConversationsOutputSchema,
  permissions: ["assistant:use"],
  aiExposure: "internal",
  risk: "read",
  requiresConfirmation: false,
  idempotent: false,
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: ["VALIDATION"],
  audit: false,
  timeout: 5_000,
});
