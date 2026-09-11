/**
 * Staff assistant persistence (SHO-320 / feature SHO-318, ADR-0038). Owned
 * by the assistant module (ADR-0014). Three tables: the conversation, the
 * messages a person reads, and the provider state the next turn is built from.
 *
 * There used to be a third and a fourth — `assistant_messages` and
 * `assistant_tool_runs` — holding a turn row by row so the model
 * conversation could be rebuilt from them on resume. Nothing rebuilds it:
 * a pause stores the exact provider messages and replays them. They were
 * not the audit trail either; what the assistant did is in `audit_log`
 * under `channel = 'ai'`, and stays there.
 *
 * ON DELETE: `user_id → user` is RESTRICT (files/chat staff-user
 * convention). The composite FK to conversations is CASCADE so deleting a
 * conversation removes its state. `company_id → companies` stays CASCADE
 * for tenant wipe.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
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
 * The transcript of an `assistant-kit` conversation, one row per message.
 *
 * A log, not a document. A message is written by the request that produced it
 * and never touched once that request ends, so the conversation is an
 * append-only sequence plus one live message at its end. Storing it as one
 * value replaced whole made every turn read, validate and rewrite the entire
 * history, and let one message nobody could parse turn the whole history empty
 * on the next write (SHO-555).
 *
 * `message` is opaque here, exactly as the document was: the runtime that
 * writes it owns its shape, and it is returned as stored. The columns are only
 * what ordering and ownership need.
 *
 * - `seq` orders the log within a conversation. It is assigned on insert and
 *   never reused, so it is also what a page cursor points at.
 * - `message_id` is the runtime's own id for the message; an insert that
 *   repeats one is refused rather than becoming an update.
 * - `bind` is the runtime's opaque owner token, compared by the runtime and
 *   never interpreted here.
 * - `revision` counts the writes of this message: 1 on insert, one more on
 *   every update. A client holding two copies of the live message — an accept's
 *   window and an event that overtook it — keeps the higher one (ADR-0039).
 */
export const assistantChatMessages = pgTable(
  "assistant_chat_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: tenantCompanyId(),
    conversationId: uuid("conversation_id").notNull(),
    seq: integer("seq").notNull(),
    messageId: uuid("message_id").notNull(),
    bind: text("bind").notNull(),
    message: jsonb("message").notNull(),
    revision: integer("revision").notNull().default(1),
    ...timestampColumns(),
  },
  (table) => [
    tenantRowUnique("assistant_chat_messages_company_id_id_uq", table),
    // Also the index a page read walks: newest first within one conversation.
    unique("assistant_chat_messages_conversation_seq_uq").on(
      table.companyId,
      table.conversationId,
      table.seq,
    ),
    unique("assistant_chat_messages_conversation_message_uq").on(
      table.companyId,
      table.conversationId,
      table.messageId,
    ),
    check("assistant_chat_messages_seq_check", sql`${table.seq} > 0`),
    check("assistant_chat_messages_revision_check", sql`${table.revision} > 0`),
    foreignKey({
      name: "assistant_chat_messages_conversations_company_fk",
      columns: [table.companyId, table.conversationId],
      foreignColumns: [
        assistantConversations.companyId,
        assistantConversations.id,
      ],
    }).onDelete("cascade"),
  ],
);

/** Which accept produced a turn (ADR-0039). Stored, never inferred. */
export const ASSISTANT_TURN_KINDS = ["chat", "answer"] as const;

export type AssistantTurnKind = (typeof ASSISTANT_TURN_KINDS)[number];

/** Every status a turn can hold. */
export const ASSISTANT_TURN_STATUSES = [
  "queued",
  "running",
  "done",
  "failed",
  "interrupted",
] as const;

export type AssistantTurnStatus = (typeof ASSISTANT_TURN_STATUSES)[number];

/**
 * The one definition of "the conversation's active turn": a turn row in one of
 * these statuses. The partial unique index below and every query of the active
 * turn read this list, so the two cannot disagree.
 */
export const ASSISTANT_TURN_ACTIVE_STATUSES = [
  "queued",
  "running",
] as const satisfies readonly AssistantTurnStatus[];

/** How a turn ended. A turn in one of these no longer holds its conversation. */
export const ASSISTANT_TURN_FINAL_STATUSES = [
  "done",
  "failed",
  "interrupted",
] as const satisfies readonly AssistantTurnStatus[];

function sqlInList(values: readonly string[]) {
  return sql.raw(values.map((value) => `'${value}'`).join(", "));
}

/**
 * One accepted turn per row (SHO-560, ADR-0039): the lease, the command
 * receipt, and everything a worker or the reconciler needs to run or end the
 * turn with no request in hand.
 *
 * - **The lease.** A turn in an active status holds its conversation; the
 *   partial unique index allows one per conversation. `finish` moves it to a
 *   final status, which frees the conversation. The status and its deadline
 *   are Postgres facts, so the reconciler compares them to Postgres `now()`.
 * - **The receipt.** `(conversation, kind, command)` is unique and the row is
 *   kept after the turn ends, so a repeated command finds its turn whenever it
 *   arrives. A send and an answer are different attempts under one client
 *   token, which is why the kind is part of it.
 * - **The request it replaces.** The BullMQ job carries only the turn's
 *   identity (`kind`, conversation, command), so the row carries the rest: the
 *   company, the author (`user_id`, the turn's only actor), the session the
 *   worker checks for liveness, the request id the
 *   turn's actions are audited under, the placeholder the worker writes into,
 *   the budget hold, and a continuation's original command. No client IP: it
 *   is transport-only (`security-operations.md` §3), and core does not need it
 *   for a staff action.
 *
 * The budget hold is integer micro-USD. Floats are refused on schema files
 * (`db.md` §3), and a reservation is a small decimal of dollars that a
 * million-fold integer holds exactly.
 *
 * ON DELETE: the conversation, its messages and the company CASCADE, as the
 * rest of the conversation does; the staff user is RESTRICT.
 */
export const assistantTurns = pgTable(
  "assistant_turns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: tenantCompanyId(),
    conversationId: uuid("conversation_id").notNull(),
    kind: text("kind").$type<AssistantTurnKind>().notNull(),
    commandId: uuid("command_id").notNull(),
    status: text("status").$type<AssistantTurnStatus>().notNull(),
    userId: userIdColumn("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    /**
     * better-auth `session.id` of the accepting request — never
     * `session.token`. Unverified on write and never an identity: the actor is
     * `user_id`, taken from the verified context. The worker runs the turn only
     * while this session exists, is unexpired and has `session.user_id =
     * user_id` (ADR-0039). Set while the turn is active, cleared when it ends.
     * No FK: sessions expire.
     */
    sessionId: text("session_id"),
    requestId: text("request_id").notNull(),
    /** The person's message. A chat accept stores one; an answer none. */
    userMessageId: uuid("user_message_id"),
    placeholderMessageId: uuid("placeholder_message_id").notNull(),
    /**
     * The command whose idempotency keys a continuation's tools derive — the
     * first turn of the chain, so continuing a continuation replays the same
     * writes (ADR-0039, SHO-547).
     */
    continuesCommandId: uuid("continues_command_id"),
    companyReservedMicroUsd: bigint("company_reserved_micro_usd", {
      mode: "number",
    }).notNull(),
    globalReservedMicroUsd: bigint("global_reserved_micro_usd", {
      mode: "number",
    }).notNull(),
    /** Europe/Kyiv day the hold was reserved on; release uses this day. */
    budgetKyivDate: date("budget_kyiv_date", { mode: "string" }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    ...timestampColumns(),
  },
  (table) => [
    tenantRowUnique("assistant_turns_company_id_id_uq", table),
    unique("assistant_turns_command_uq").on(
      table.companyId,
      table.conversationId,
      table.kind,
      table.commandId,
    ),
    uniqueIndex("assistant_turns_active_uq")
      .on(table.companyId, table.conversationId)
      .where(
        sql`${table.status} IN (${sqlInList(ASSISTANT_TURN_ACTIVE_STATUSES)})`,
      ),
    check(
      "assistant_turns_kind_check",
      sql`${table.kind} IN (${sqlInList(ASSISTANT_TURN_KINDS)})`,
    ),
    check(
      "assistant_turns_status_check",
      sql`${table.status} IN (${sqlInList(ASSISTANT_TURN_STATUSES)})`,
    ),
    check(
      "assistant_turns_lifecycle_check",
      sql`(${table.status} = 'queued' AND ${table.startedAt} IS NULL AND ${table.deadlineAt} IS NULL AND ${table.finishedAt} IS NULL)
        OR (${table.status} = 'running' AND ${table.startedAt} IS NOT NULL AND ${table.deadlineAt} IS NOT NULL AND ${table.finishedAt} IS NULL)
        OR (${table.status} IN (${sqlInList(ASSISTANT_TURN_FINAL_STATUSES)}) AND ${table.finishedAt} IS NOT NULL)`,
    ),
    check(
      "assistant_turns_session_check",
      sql`(${table.status} IN (${sqlInList(ASSISTANT_TURN_ACTIVE_STATUSES)})) = (${table.sessionId} IS NOT NULL)`,
    ),
    check(
      "assistant_turns_user_message_check",
      sql`(${table.kind} = 'chat') = (${table.userMessageId} IS NOT NULL)`,
    ),
    check(
      "assistant_turns_continues_check",
      sql`${table.continuesCommandId} IS NULL OR ${table.continuesCommandId} <> ${table.commandId}`,
    ),
    check(
      "assistant_turns_reserved_check",
      sql`${table.companyReservedMicroUsd} >= 0 AND ${table.globalReservedMicroUsd} >= 0`,
    ),
    foreignKey({
      name: "assistant_turns_conversations_company_fk",
      columns: [table.companyId, table.conversationId],
      foreignColumns: [
        assistantConversations.companyId,
        assistantConversations.id,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "assistant_turns_placeholder_message_fk",
      columns: [
        table.companyId,
        table.conversationId,
        table.placeholderMessageId,
      ],
      foreignColumns: [
        assistantChatMessages.companyId,
        assistantChatMessages.conversationId,
        assistantChatMessages.messageId,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "assistant_turns_user_message_fk",
      columns: [table.companyId, table.conversationId, table.userMessageId],
      foreignColumns: [
        assistantChatMessages.companyId,
        assistantChatMessages.conversationId,
        assistantChatMessages.messageId,
      ],
    }).onDelete("cascade"),
  ],
);

/**
 * The provider messages the next `assistant-kit` turn is built from.
 *
 * One value per conversation, replaced whole. The history is a working set,
 * not a record: the runtime saves exactly what a turn ran with and windows it
 * on the way out, so there is nothing to append to. Opaque here by design, and
 * a budget question for whoever sends it.
 *
 * The transcript a person reads used to live here too, as one document
 * replaced whole on every write. It is a log, and is stored as one now, in
 * `assistant_chat_messages` (SHO-555).
 *
 * Deliberately absent: the open interaction. A pause has a deadline measured
 * in minutes and one atomic claim, which is a Redis job, not a table.
 */
export const assistantChatState = pgTable(
  "assistant_chat_state",
  {
    companyId: tenantCompanyId(),
    conversationId: uuid("conversation_id").notNull(),
    /** `ModelMessage[]` for the next turn. Null until the first turn. */
    history: jsonb("history"),
    ...timestampColumns(),
  },
  (table) => [
    unique("assistant_chat_state_company_conversation_uq").on(
      table.companyId,
      table.conversationId,
    ),
    foreignKey({
      name: "assistant_chat_state_conversations_company_fk",
      columns: [table.companyId, table.conversationId],
      foreignColumns: [
        assistantConversations.companyId,
        assistantConversations.id,
      ],
    }).onDelete("cascade"),
  ],
);
