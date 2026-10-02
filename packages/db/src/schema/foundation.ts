/**
 * Platform foundation tables (docs/specs/db.md §4) — scaffold-owned, frozen
 * for module tasks (ADR-0014). These back the core runtime protocols:
 * transactional outbox + per-consumer delivery (ADR-0012, core.md §6),
 * idempotency (core.md §5), and audit (core.md §8). No business logic here —
 * only structure; the protocols themselves live in `packages/core`.
 *
 * Column semantics follow core.md; keep the two in sync via spec rework, not
 * ad-hoc edits.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Transactional outbox (ADR-0012, carried over from v1). Events are written
 * by `ctx.emit` in the emitting action's transaction and claimed by the
 * worker dispatcher via FOR UPDATE SKIP LOCKED. Processed rows are kept as
 * the audit-grade event history (core.md §6 retention).
 */
export const domainEvents = pgTable(
  "domain_events",
  {
    /** App-generated UUIDv7 (time-ordered) — deliberately no DB default. */
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    /** Payload schema version; bumped on breaking payload change. */
    version: integer("version").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    /** Null only for declared global system events (core.md §6). */
    companyId: uuid("company_id"),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: uuid("aggregate_id").notNull(),
    /** Monotonic per aggregate via event_aggregate_sequences. */
    aggregateSequence: bigint("aggregate_sequence", {
      mode: "bigint",
    }).notNull(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    channel: text("channel").notNull(),
    requestId: text("request_id").notNull(),
    correlationId: text("correlation_id").notNull(),
    /** The eventId or requestId that caused this event. */
    causationId: text("causation_id").notNull(),
    payload: jsonb("payload").notNull(),
    /** SKIP LOCKED claim bookkeeping for the outbox dispatcher. */
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    claimedBy: text("claimed_by"),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("domain_events_aggregate_sequence_uq").on(
      table.aggregateType,
      table.aggregateId,
      table.aggregateSequence,
    ),
    // Partial index: the dispatcher only ever scans undispatched rows.
    index("domain_events_undispatched_idx")
      .on(table.dispatchedAt)
      .where(sql`${table.dispatchedAt} IS NULL`),
    index("domain_events_company_occurred_at_idx").on(
      table.companyId,
      table.occurredAt,
    ),
    check(
      "domain_events_actor_type_check",
      sql`${table.actorType} IN ('user', 'system')`,
    ),
    check(
      "domain_events_channel_check",
      sql`${table.channel} IN ('ui', 'ai', 'system', 'webhook', 'sho-ai')`,
    ),
  ],
);

/**
 * Per-aggregate ordering state, incremented transactionally by `ctx.emit`
 * (core.md §6). Infrastructure, not a domain projection.
 */
export const eventAggregateSequences = pgTable(
  "event_aggregate_sequences",
  {
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: uuid("aggregate_id").notNull(),
    companyId: uuid("company_id"),
    lastSequence: bigint("last_sequence", { mode: "bigint" }).notNull(),
  },
  (table) => [
    primaryKey({
      name: "event_aggregate_sequences_pk",
      columns: [table.aggregateType, table.aggregateId],
    }),
  ],
);

/**
 * Per-consumer delivery, retry, and dedup state (core.md §6). The PK is the
 * mandatory consumer dedup: a redelivery of (consumer, eventId) is a no-op.
 * For event-bound system actions this row doubles as the idempotency
 * reservation. Transition to `processed` commits in the same transaction as
 * the consumer's effects.
 */
export const eventDeliveries = pgTable(
  "event_deliveries",
  {
    /** Stable consumer id, e.g. "chat.order-card-updater". */
    consumer: text("consumer").notNull(),
    eventId: uuid("event_id")
      .notNull()
      // Deliveries must never point at a missing outbox row; RESTRICT keeps
      // outbox archival honest (archive deliveries first). Recorded in
      // db.md §4.
      .references(() => domainEvents.id, { onDelete: "restrict" }),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    claimedBy: text("claimed_by"),
    lastError: text("last_error"),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({
      name: "event_deliveries_pk",
      columns: [table.consumer, table.eventId],
    }),
    // Executor scan: claimable work ordered by due time.
    index("event_deliveries_status_next_attempt_at_idx").on(
      table.status,
      table.nextAttemptAt,
    ),
    // All deliveries of one event (dispatch fan-out, FK lookups).
    index("event_deliveries_event_id_idx").on(table.eventId),
    check(
      "event_deliveries_status_check",
      sql`${table.status} IN ('pending', 'processing', 'processed', 'dead')`,
    ),
  ],
);

/**
 * Idempotency reservations and response snapshots (core.md §5). The PK spans
 * accountable principal + tenant scope + action + caller key: one staff
 * member can never replay another's stored response, and a system service
 * cannot collide across companies.
 */
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    /** "staff:<userId>" | "customer:<userId>" | "consumer:<userId>" | "account:<userId>" | "system:<serviceName>". */
    principalKey: text("principal_key").notNull(),
    /** "company:<uuid>" | "user:<userId>" | "global". */
    scopeKey: text("scope_key").notNull(),
    companyId: uuid("company_id"),
    action: text("action").notNull(),
    /** Caller-supplied idempotency key — never generated server-side. */
    key: text("key").notNull(),
    /** SHA-256 over RFC 8785 canonical JSON of input + principal + scope. */
    requestHash: text("request_hash").notNull(),
    status: text("status").notNull(),
    /** Owner of the current attempt; lease takeover swaps it atomically. */
    attemptId: uuid("attempt_id").notNull(),
    leaseExpiresAt: timestamp("lease_expires_at", {
      withTimezone: true,
    }).notNull(),
    /** Consumed confirmation grant (core.md §5/§7), persisted for crash-safe resume. */
    confirmationChallengeId: uuid("confirmation_challenge_id"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    confirmationExpiresAt: timestamp("confirmation_expires_at", {
      withTimezone: true,
    }),
    /** JSON-safe validated response; set with `completed` inside the handler tx. */
    response: jsonb("response"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** 48h retention; expired keys are cleaned by a worker job and re-execute. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      name: "idempotency_keys_pk",
      columns: [table.principalKey, table.scopeKey, table.action, table.key],
    }),
    index("idempotency_keys_expires_at_idx").on(table.expiresAt),
    // Recovery scan: expired in_progress leases eligible for takeover.
    index("idempotency_keys_status_lease_expires_at_idx").on(
      table.status,
      table.leaseExpiresAt,
    ),
    index("idempotency_keys_company_created_at_idx").on(
      table.companyId,
      table.createdAt,
    ),
    check(
      "idempotency_keys_status_check",
      sql`${table.status} IN ('in_progress', 'completed', 'failed')`,
    ),
  ],
);

/**
 * Audit trail (core.md §8): one row per audited action execution, written in
 * the handler transaction (denials in their own tx). Append-only for the
 * runtime role — the UPDATE/DELETE revoke lives in the roles migration.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: text("request_id").notNull(),
    correlationId: text("correlation_id").notNull(),
    action: text("action").notNull(),
    /** AI acts as the initiating user over the `ai` channel — never an actor type. */
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    channel: text("channel").notNull(),
    aiTraceId: text("ai_trace_id"),
    toolCallId: text("tool_call_id"),
    /** Null for global system work (blueprint §2.1-4). */
    companyId: uuid("company_id"),
    targetType: text("target_type").notNull(),
    /** Text, not uuid: audit targets may be composite ids (e.g. "override:<companyId>:<key>"). */
    targetId: text("target_id").notNull(),
    /** Hash only by default; redacted snapshots are a separate opt-in (core.md §8). */
    inputHash: text("input_hash").notNull(),
    /** Populated only by the action's explicit `auditSnapshot` callback; null when hash-only (core.md §8). */
    inputSnapshot: jsonb("input_snapshot"),
    /** "ok" or the typed error code (e.g. "PERMISSION_DENIED"). */
    outcome: text("outcome").notNull(),
    durationMs: integer("duration_ms").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("audit_log_company_created_at_idx").on(
      table.companyId,
      table.createdAt,
    ),
    index("audit_log_actor_created_at_idx").on(
      table.actorType,
      table.actorId,
      table.createdAt,
    ),
    index("audit_log_action_created_at_idx").on(table.action, table.createdAt),
    check(
      "audit_log_actor_type_check",
      sql`${table.actorType} IN ('user', 'system')`,
    ),
    check(
      "audit_log_channel_check",
      sql`${table.channel} IN ('ui', 'ai', 'system', 'webhook', 'sho-ai')`,
    ),
  ],
);
