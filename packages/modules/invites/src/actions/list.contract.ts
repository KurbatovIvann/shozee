/**
 * Staff invite list (SHO-203 / feature SHO-201). Mechanical choices the
 * feature card left unnamed — copy `customers.listCustomers`, do not
 * invent a second list shape:
 * - Pagination is a stable `(updated_at desc, id desc)` cursor, not
 *   offset. `limit` defaults to 20 and caps at 50.
 * - Cursor payload is `updatedAt|id` (ISO datetime, then uuid).
 * - Output rows are the shared invite view (derived status, no token, no
 *   hash, no copy URL).
 * - `timeout: 5000` matches the golden catalog/customer reads.
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

import { inviteViewSchema } from "./invite-view.contract.js";

export const LIST_INVITES_DEFAULT_LIMIT = 20;
export const LIST_INVITES_MAX_LIMIT = 50;
export const LIST_INVITES_CURSOR_MAX = 80;

const listInvitesCursor = createCursorCodec({
  payload: z.object({
    updatedAt: z.iso.datetime(),
    id: z.uuid(),
  }),
  fields: [
    { key: "updatedAt", kind: "isoDatetime" },
    { key: "id", kind: "uuid" },
  ],
});

export function formatListInvitesCursor(updatedAt: Date, id: string): string {
  return listInvitesCursor.encode({ updatedAt, id });
}

export function parseListInvitesCursor(
  cursor: string,
): { updatedAt: string; id: string } | undefined {
  return listInvitesCursor.decode(cursor);
}

export const listInvitesInputSchema = z.object({
  limit: listLimitInput(LIST_INVITES_MAX_LIMIT, LIST_INVITES_DEFAULT_LIMIT),
  cursor: listCursorInput(parseListInvitesCursor, LIST_INVITES_CURSOR_MAX),
});

export const listInvitesOutputSchema = z.object({
  items: z.array(inviteViewSchema),
  nextCursor: z.string().min(1).nullable(),
});

export const listInvitesContract = defineActionContract({
  name: "invites.list",
  description:
    "List customer-entry invites in the staff member's active company. Paginate with an updated-at/id cursor and a page size of at most 50. Each row is the invite view (id, reusable flag, max uses, use count, expiry, derived status pending/revoked/expired/exhausted, optional group and price-list assignments, optional identity fields, invited-by, timestamps). Never returns the plaintext token, token hash, or copy URL. Company id is never input.",
  principal: "staff",
  transport: "client",
  input: listInvitesInputSchema,
  output: listInvitesOutputSchema,
  permissions: ["customers:view"],
  aiExposure: "exposed",
  risk: "read",
  requiresConfirmation: false,
  idempotent: false,
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: [],
  audit: false,
  timeout: 5_000,
});
