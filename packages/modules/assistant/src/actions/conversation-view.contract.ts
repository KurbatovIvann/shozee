/**
 * Shared assistant conversation views (SHO-321 / feature SHO-318). Create,
 * list and the chat-state reads import these so there is one projection
 * rather than one per action. No `companyId` — catalog and customer views
 * also omit the tenant id.
 *
 * It used to carry message and tool-run views as well, for the actions that
 * stored a turn row by row. The conversation is one stored document now
 * (ADR-0038), so those went with them.
 */
import { z } from "zod";

/**
 * Author-only visibility (SHO-503). Quoted on `assistant_conversations`
 * and on the five conversation-action descriptions so the next reader
 * does not re-open company-wide list/get.
 */
export const STAFF_CONVERSATION_AUTHOR_INVARIANT =
  "A staff assistant conversation is a company record with one author. The author reads and writes it under `assistant:use`. Nobody else in the company — owner included — can list, read, append to, or record into it. Review of staff conversations is a separate feature with its own actions and permission. A foreign author and a foreign company fail with the same not-found.";

export const CONVERSATION_TITLE_MAX = 200;

export const COMPANY_ROLE_VALUES = [
  "owner",
  "admin",
  "manager",
  "employee",
] as const;

export const companyRoleSchema = z.enum(COMPANY_ROLE_VALUES);

export const conversationTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(CONVERSATION_TITLE_MAX);

export const conversationViewSchema = z.object({
  id: z.uuid(),
  userId: z.string().min(1),
  title: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
