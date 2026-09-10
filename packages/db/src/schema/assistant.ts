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
 * `turn_key` is the host begin identity on assistant rows (chat
 * `begin:${userMessageId}`, Phase B `begin:resume:${pendingId}`, Phase A
 * `begin:phase-a:${pendingId}`, replace/successor keys). Nullable on
 * pre-SHO-539 rows; recovery must not auto-execute `started` runs whose
 * message `turn_key` is null. Immutable after begin — complete does not
 * update it. UNIQUE `(company_id, conversation_id, turn_key)` allows
 * multiple NULLs (PostgreSQL NULL DISTINCT).
 */
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

/**
 * The durable half of an `assistant-kit` conversation: the chat document a
 * person reads, and the provider messages the next turn is built from.
 *
 * Two blobs rather than rows per message, because neither is reconstructed
 * from parts any more. The document is stored settled and read back as
 * stored — that identity is the point of the path, and splitting it into
 * columns would put a second derivation back in. The history is provider
 * payload: opaque here by design, and a budget question for whoever sends it.
 *
 * One row per conversation, replaced in whole. There is no append: the kit
 * applies a write to the document it read and stores the result, so the row
 * is always a complete document rather than a fold over deltas.
 *
 * Deliberately absent: the open interaction. A pause has a deadline measured
 * in minutes and one atomic claim, which is a Redis job, not a table.
 */
export const assistantChatState = pgTable(
  "assistant_chat_state",
  {
    companyId: tenantCompanyId(),
    conversationId: uuid("conversation_id").notNull(),
    /** `ChatDocument` as the kit stores it. Null until the first write. */
    document: jsonb("document"),
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
