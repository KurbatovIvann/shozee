/**
 * Staff assistant persistence (SHO-320 / feature SHO-318). Owned by the
 * assistant module (ADR-0014). Conversations, user/assistant text, and
 * tool-run traces (action names, tool-call ids, challenge ids, result
 * ids, outcome, bounded `model_trace` prompt state, bounded `tool_input`
 * façade args, `execution_id` attempt identity, `seq` call order).
 * Deliberately absent: FKs to orders/documents, order or document status
 * snapshots, prompts in audit/logs, SSE/session columns.
 *
 * ON DELETE: `user_id → user` is RESTRICT (files/chat staff-user
 * convention). Composite FKs to conversations are CASCADE so deleting a
 * conversation removes its messages and tool runs, and `assistant_tool_runs
 * → assistant_messages` is CASCADE for the same reason. `company_id →
 * companies` stays CASCADE for tenant wipe.
 */
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { userIdColumn } from "./auth-ids.js";
import { user } from "./auth.js";
import {
  tenantCompanyId,
  tenantRowUnique,
  timestampColumns,
} from "./tenant-columns.js";

/**
 * One staff conversation per row. A staff assistant conversation is a
 * company record with one author. The author reads and writes it under
 * `assistant:use`. Nobody else in the company — owner included — can
 * list, read, append to, or record into it. Review of staff conversations
 * is a separate feature with its own actions and permission. A foreign
 * author and a foreign company fail with the same not-found.
 */
export const assistantConversations = pgTable(
  "assistant_conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: tenantCompanyId(),
    userId: userIdColumn("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    title: text("title"),
    ...timestampColumns(),
  },
  (table) => [
    tenantRowUnique("assistant_conversations_company_id_id_uq", table),
    index("assistant_conversations_company_updated_at_idx").on(
      table.companyId,
      table.updatedAt.desc(),
    ),
  ],
);

/**
 * User/assistant text for a conversation. Role is forced by later write
 * actions; the CHECK is the closed set. Tool results live on
 * `assistant_tool_runs`, not here.
 */
export const assistantMessages = pgTable(
  "assistant_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: tenantCompanyId(),
    conversationId: uuid("conversation_id").notNull(),
    role: text("role").notNull(),
    body: text("body").notNull(),
    ...timestampColumns(),
  },
  (table) => [
    tenantRowUnique("assistant_messages_company_id_id_uq", table),
    index("assistant_messages_company_conversation_idx").on(
      table.companyId,
      table.conversationId,
    ),
    foreignKey({
      name: "assistant_messages_conversations_company_fk",
      columns: [table.companyId, table.conversationId],
      foreignColumns: [
        assistantConversations.companyId,
        assistantConversations.id,
      ],
    }).onDelete("cascade"),
    check(
      "assistant_messages_role_check",
      sql`${table.role} IN ('user', 'assistant')`,
    ),
  ],
);

/**
 * One tool invocation inside a conversation. `result_ids` is a uuid array
 * of produced resource ids (traces, not projections). Outcome is the
 * closed HITL/tool set (started, success, error, confirmation_required,
 * choice_required). `challenge_id` is the opaque interaction id for
 * confirmation or choice. Never order/document status.
 * `model_trace` is ADR-0034 prompt state: the post-clip façade output the
 * model already saw (success, error, choice_required,
 * confirmation_required; typically null on `started`). Nullable; no
 * client renders it; CHECK `length(model_trace::text) <= 22000`.
 * `tool_input` is the façade/tool args for this call (same CHECK class).
 * Nullable on pre-T2 rows; history reconstructs `input: {}` when absent.
 * `execution_id` is the server-minted attempt identity (unique per
 * tenant). Nullable on old rows; required when `outcome = started`.
 * `seq` is call order on the turn; nullable on old rows; required on
 * `started`. `tool_name` is the live ToolSet key (`orders_list_page`) for
 * reconstruction; `action_name` stays the executeAction registry identity.
 * `message_id` is the assistant turn that produced the run. Do not infer
 * order from `created_at` alone — use `seq` ascending.
 */
export const assistantToolRuns = pgTable(
  "assistant_tool_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: tenantCompanyId(),
    conversationId: uuid("conversation_id").notNull(),
    messageId: uuid("message_id").notNull(),
    actionName: text("action_name").notNull(),
    toolCallId: text("tool_call_id").notNull(),
    challengeId: uuid("challenge_id"),
    resultIds: uuid("result_ids")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    outcome: text("outcome").notNull(),
    modelTrace: jsonb("model_trace"),
    toolName: text("tool_name"),
    toolInput: jsonb("tool_input"),
    executionId: text("execution_id"),
    seq: integer("seq"),
    ...timestampColumns(),
  },
  (table) => [
    tenantRowUnique("assistant_tool_runs_company_id_id_uq", table),
    unique("assistant_tool_runs_company_execution_id_uq").on(
      table.companyId,
      table.executionId,
    ),
    index("assistant_tool_runs_company_conversation_idx").on(
      table.companyId,
      table.conversationId,
    ),
    index("assistant_tool_runs_company_message_idx").on(
      table.companyId,
      table.messageId,
    ),
    foreignKey({
      name: "assistant_tool_runs_conversations_company_fk",
      columns: [table.companyId, table.conversationId],
      foreignColumns: [
        assistantConversations.companyId,
        assistantConversations.id,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "assistant_tool_runs_messages_company_fk",
      columns: [table.companyId, table.messageId],
      foreignColumns: [assistantMessages.companyId, assistantMessages.id],
    }).onDelete("cascade"),
    check(
      "assistant_tool_runs_outcome_check",
      sql`${table.outcome} IN ('started', 'success', 'error', 'confirmation_required', 'choice_required')`,
    ),
    check(
      "assistant_tool_runs_model_trace_length_check",
      sql`length(${table.modelTrace}::text) <= 22000`,
    ),
    check(
      "assistant_tool_runs_tool_input_length_check",
      sql`length(${table.toolInput}::text) <= 22000`,
    ),
    check(
      "assistant_tool_runs_started_identity_check",
      sql`${table.outcome} <> 'started' OR (${table.executionId} IS NOT NULL AND ${table.seq} IS NOT NULL)`,
    ),
  ],
);
