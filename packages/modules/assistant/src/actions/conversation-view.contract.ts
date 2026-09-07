/**
 * Shared assistant persistence views (SHO-321 / feature SHO-318). Create,
 * list, get, append, and record import these so T4 does not invent a
 * second projection. Mechanical caps the card left unnamed: title 200,
 * message body 16_000, action/tool-call ids 128, 50 tool-runs and result
 * ids per turn. No `companyId` — catalog/customer views also omit tenant
 * id. Tool-run rows store result ids and outcome only — never order or
 * document status, and never `model_trace` (ADR-0034 prompt state lives
 * on the internal `assistant.getModelHistory` read). `challengeId` is the
 * opaque interaction id for both confirmation and choice.
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
export const MESSAGE_BODY_MAX = 16_000;
export const ACTION_NAME_MAX = 128;
export const TOOL_CALL_ID_MAX = 128;
export const TOOL_RUNS_MAX = 50;
export const RESULT_IDS_MAX = 50;

export const COMPANY_ROLE_VALUES = [
  "owner",
  "admin",
  "manager",
  "employee",
] as const;

export const messageRoleSchema = z.enum(["user", "assistant"]);

export const toolRunOutcomeSchema = z.enum([
  "success",
  "error",
  "confirmation_required",
  "choice_required",
]);

export const companyRoleSchema = z.enum(COMPANY_ROLE_VALUES);

export const conversationTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(CONVERSATION_TITLE_MAX);

export const messageBodySchema = z.string().min(1).max(MESSAGE_BODY_MAX);

export const actionNameSchema = z.string().min(1).max(ACTION_NAME_MAX);

export const toolCallIdSchema = z.string().min(1).max(TOOL_CALL_ID_MAX);

export const conversationViewSchema = z.object({
  id: z.uuid(),
  userId: z.string().min(1),
  title: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const messageViewSchema = z.object({
  id: z.uuid(),
  conversationId: z.uuid(),
  role: messageRoleSchema,
  body: z.string(),
  createdAt: z.iso.datetime(),
});

export const toolRunViewSchema = z.object({
  id: z.uuid(),
  conversationId: z.uuid(),
  actionName: z.string(),
  toolCallId: z.string(),
  challengeId: z.uuid().nullable(),
  resultIds: z.array(z.uuid()),
  outcome: toolRunOutcomeSchema,
  createdAt: z.iso.datetime(),
});

export const toolRunInputSchema = z.strictObject({
  actionName: actionNameSchema,
  toolCallId: toolCallIdSchema,
  challengeId: z.uuid().optional(),
  resultIds: z.array(z.uuid()).max(RESULT_IDS_MAX).default([]),
  outcome: toolRunOutcomeSchema,
});
