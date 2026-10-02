/**
 * The claim-and-execute half of event delivery (fnd-T17/T18 — core.md §6,
 * ADR-0012). `executeDelivery` is the special delivery entrypoint (not
 * `ctx.call`): it runs the bound system action through the **normal
 * execution pipeline inside the delivery transaction**. The pipeline's
 * own transaction nests as a savepoint of the delivery transaction, and
 * the delivery row doubles as the idempotency reservation (key = event
 * ID) — the transition to `processed`, the action's effects, its audit
 * row, and its emitted events commit together; a failure rolls all of
 * them back before separate retry/dead-letter bookkeeping commits.
 *
 * Ordering (core.md §6): a consumer handles only its earliest
 * non-processed delivery for an aggregate, and holds a transaction-scoped
 * `(consumer, aggregate)` advisory lock while applying effects — both
 * enforced through the `delivery-shared.ts` helpers the claim phase uses
 * too. Discovery selects due **aggregate heads** before LIMIT so a
 * bounded batch of blocked successors cannot starve independent work
 * (SHO-435); claim still re-validates ordering. Nothing is guaranteed
 * across aggregates; handlers must still tolerate replays. The loops that
 * call these live in `apps/worker` (fnd-T27); core still owns no process
 * loop.
 */
import { randomUUID } from "node:crypto";

import { domainEvents, eventDeliveries, type Tx } from "@showzy/db";
import { and, asc, eq, isNull, lte, notExists, or, sql } from "drizzle-orm";

import { CoreError, CoreInvariantError } from "../../errors/index.js";
import type {
  ActionPipelineDeps,
  PrincipalInvocation,
} from "../pipeline/types.js";
import type { EventSubscription } from "./define-event-handler.js";
import { createDeliveryReservationHook } from "./delivery-reservation-hook.js";
import {
  acquireAggregateAdvisoryLock,
  assertDeliveryRouting,
  earlierUnprocessedDeliverySubquery,
  hasEarlierUnprocessedDelivery,
  lockDeliveryRow,
  ownedProcessingDelivery,
  type OutboxEventRow,
} from "./delivery-shared.js";
import type { EventEnvelope } from "./envelope.js";

/** Bounded discovery batch. Raising this is not a starvation fix (SHO-435). */
export const DELIVERY_DISCOVERY_BATCH_SIZE = 100;

/** Five failed handler attempts park one consumer's delivery (core.md §6). */
export const DELIVERY_MAX_ATTEMPTS = 5;
/** Retry delays are 1s, 2s, 4s, and 8s after failures one through four. */
export const DELIVERY_RETRY_BASE_MS = 1_000;
/**
 * A claim remains live for the bound action timeout plus this commit/clock
 * margin. That prevents a second worker from stealing an action that is
 * still inside its declared whole-pipeline deadline.
 */
export const DELIVERY_CLAIM_MARGIN_MS = 30_000;

/** What one `executeDelivery` call did. */
export type DeliveryOutcome =
  | { readonly status: "processed" }
  /** The `(consumer, eventId)` row is already processed — redelivery no-op. */
  | { readonly status: "alreadyProcessed" }
  /**
   * Not runnable now: not due, actively claimed, dead, or blocked by an
   * earlier non-processed delivery for the aggregate.
   */
  | { readonly status: "deferred" }
  /** The bound action failed; `retryAt: null` means this attempt parked dead. */
  | {
      readonly status: "failed";
      readonly error: CoreError;
      readonly retryAt: string | null;
    };

export interface ClaimableDelivery {
  readonly consumer: string;
  readonly eventId: string;
  /**
   * Outbox event name (`domain_events.name`). The worker executor keys
   * subscriptions by `(consumer, eventName)` so one consumer id may bind
   * multiple events without querying foundation tables (core.md §6).
   */
  readonly eventName: string;
}

/**
 * Finds a bounded batch that `executeDelivery` may attempt to claim. This
 * is a non-authoritative discovery read: concurrent workers may see the
 * same row, while the short claim transaction below chooses one owner.
 *
 * Rows are due **aggregate heads** — no earlier non-processed delivery
 * exists for the same `(consumer, aggregate)` — then ordered by due time
 * and limited. Claim still re-checks predecessors, leases, and due time.
 * Keeping discovery in core means the fnd-T27 worker loop never queries
 * foundation tables directly. Each row includes `eventName` so the worker
 * can select the matching `EventSubscription` when one consumer binds
 * more than one event.
 */
export async function findClaimableDeliveries(
  deps: Pick<ActionPipelineDeps, "db">,
  options: {
    readonly subscriptions: readonly EventSubscription[];
    readonly now?: () => number;
    readonly batchSize?: number;
  },
): Promise<ClaimableDelivery[]> {
  if (options.subscriptions.length === 0) {
    return [];
  }
  const nowMs = (options.now ?? Date.now)();
  const batchSize = options.batchSize ?? DELIVERY_DISCOVERY_BATCH_SIZE;
  return await deps.db.transaction(async (tx) => {
    const query = buildClaimableDeliveriesQuery(tx, {
      subscriptions: options.subscriptions,
      nowMs,
      batchSize,
    });
    if (query === undefined) {
      return [];
    }
    return await query;
  });
}

/**
 * The discovery SELECT used by `findClaimableDeliveries`. Exported so
 * tests can EXPLAIN the same SQL the worker runs (SHO-435).
 */
export function buildClaimableDeliveriesQuery(
  db: Pick<Tx, "select">,
  options: {
    readonly subscriptions: readonly EventSubscription[];
    readonly nowMs: number;
    readonly batchSize: number;
  },
) {
  const nowDate = new Date(options.nowMs);
  const consumerConditions = options.subscriptions.map((subscription) =>
    and(
      eq(eventDeliveries.consumer, subscription.consumer),
      eq(domainEvents.name, subscription.event.name),
      or(
        and(
          eq(eventDeliveries.status, "pending"),
          or(
            isNull(eventDeliveries.nextAttemptAt),
            lte(eventDeliveries.nextAttemptAt, nowDate),
          ),
        ),
        and(
          eq(eventDeliveries.status, "processing"),
          or(
            isNull(eventDeliveries.claimedAt),
            lte(
              eventDeliveries.claimedAt,
              new Date(
                options.nowMs -
                  subscription.contract.timeout -
                  DELIVERY_CLAIM_MARGIN_MS,
              ),
            ),
          ),
        ),
      ),
    ),
  );
  const predicate = or(...consumerConditions);
  if (predicate === undefined) {
    return undefined;
  }

  return db
    .select({
      consumer: eventDeliveries.consumer,
      eventId: eventDeliveries.eventId,
      eventName: domainEvents.name,
    })
    .from(eventDeliveries)
    .innerJoin(domainEvents, eq(eventDeliveries.eventId, domainEvents.id))
    .where(
      and(
        predicate,
        // Filter heads *before* LIMIT so a dead/delayed predecessor's
        // due successors cannot monopolize the bounded batch (SHO-435).
        notExists(
          earlierUnprocessedDeliverySubquery(db, {
            consumer: eventDeliveries.consumer,
            aggregateType: domainEvents.aggregateType,
            aggregateId: domainEvents.aggregateId,
            aggregateSequence: domainEvents.aggregateSequence,
          }),
        ),
      ),
    )
    .orderBy(asc(eventDeliveries.nextAttemptAt), asc(eventDeliveries.eventId))
    .limit(options.batchSize);
}

/**
 * Executes one delivery: locks its row, enforces per-aggregate ordering
 * under the `(consumer, aggregate)` advisory lock, and runs the bound
 * action through the normal pipeline inside the delivery transaction.
 *
 * `deps` are the same pipeline dependencies the apps compose at boot
 * (audit hook, telemetry, …); the `idempotency` slot is replaced here —
 * the delivery row **is** the reservation (core.md §6), so no
 * `idempotency_keys` row is written for event-bound actions.
 *
 * The short claim transaction commits before the action transaction. A
 * process crash therefore leaves `processing` plus an owner/timestamp;
 * another worker may reclaim it only after the action timeout plus
 * `DELIVERY_CLAIM_MARGIN_MS`.
 */
export async function executeDelivery(
  deps: ActionPipelineDeps,
  options: {
    readonly subscription: EventSubscription;
    readonly eventId: string;
    /** Unique worker/process instance id persisted as the claim owner. */
    readonly claimedBy: string;
  },
): Promise<DeliveryOutcome> {
  const { subscription, eventId, claimedBy } = options;
  const now = deps.now ?? Date.now;

  let claim: ClaimResult;
  try {
    claim = await claimDelivery(deps, {
      subscription,
      eventId,
      claimedBy,
      now,
    });
  } catch (error) {
    return {
      status: "failed",
      error: toCoreError(error),
      retryAt: null,
    };
  }
  if (claim !== "claimed") {
    return { status: claim };
  }

  try {
    return await deps.db.transaction(async (tx) => {
      const row = await lockDeliveryRow(tx, {
        consumer: subscription.consumer,
        eventId,
      });
      assertDeliveryRouting({
        eventId,
        storedEventName: row.event.name,
        subscribedEventName: subscription.event.name,
      });
      if (row.status !== "processing" || row.claimedBy !== claimedBy) {
        // A newer worker took the lease between the claim commit and this
        // transaction (core.md §6). Leave their row alone.
        return { status: "deferred" } as const;
      }

      // Per-aggregate ordering, wall 1: the transaction-scoped advisory
      // lock serializes this consumer's work on one aggregate.
      await acquireAggregateAdvisoryLock(tx, {
        consumer: subscription.consumer,
        aggregateType: row.event.aggregateType,
        aggregateId: row.event.aggregateId,
      });

      // Wall 2: only the earliest non-processed delivery of this aggregate
      // may run. A later delivery claimed first defers and retries after
      // the earlier one lands (or parks dead and blocks the aggregate for
      // this consumer until replayed).
      const blocked = await hasEarlierUnprocessedDelivery(tx, {
        consumer: subscription.consumer,
        aggregateType: row.event.aggregateType,
        aggregateId: row.event.aggregateId,
        aggregateSequence: row.event.aggregateSequence,
      });
      if (blocked) {
        // A rare dispatcher race can materialize an earlier event after
        // this delivery's short claim transaction. Release this claim and
        // undo the claim-attempt count because no handler ran.
        await tx
          .update(eventDeliveries)
          .set({
            status: "pending",
            attempts: sql`GREATEST(${eventDeliveries.attempts} - 1, 0)`,
            nextAttemptAt: new Date(now()),
            claimedAt: null,
            claimedBy: null,
          })
          .where(
            ownedProcessingDelivery({
              consumer: subscription.consumer,
              eventId,
              claimedBy,
            }),
          );
        return { status: "deferred" } as const;
      }

      const envelope = buildEnvelope(row.event);
      const principal: PrincipalInvocation = {
        mode: "system",
        serviceName: subscription.consumer,
        // The event's stored company scope decides the context scope
        // (core.md §6): a null company exists only on declared global
        // events, whose bound actions declare systemScope "global".
        scope:
          row.event.companyId !== null
            ? { scope: "tenant", companyId: row.event.companyId }
            : { scope: "global" },
      };

      // The pipeline runs with this delivery transaction as its runner, so
      // its "execution transaction" nests as a savepoint here; the
      // idempotency slot becomes the delivery row itself.
      await subscription.invoke(
        {
          ...deps,
          db: tx,
          hooks: {
            ...deps.hooks,
            idempotency: createDeliveryReservationHook({
              consumer: subscription.consumer,
              eventId,
              claimedBy,
              now,
            }),
          },
        },
        {
          input: envelope,
          request: {
            // A fresh id per delivery attempt; correlation stays the
            // emitting request's chain and causation is the delivered
            // event (core.md §6) — the consumer's own emissions carry it.
            requestId: randomUUID(),
            correlationId: row.event.correlationId,
            causationId: row.event.id,
            channel: "system",
            // The reservation key is the event ID (core.md §6). The hook
            // below never reads it, but the pipeline meta says so
            // explicitly for logs and later protocol slots.
            idempotencyKey: row.event.id,
          },
          principal,
        },
      );

      return { status: "processed" } as const;
    });
  } catch (error) {
    const coreError = toCoreError(error);
    const recorded = await recordDeliveryFailure(deps, {
      consumer: subscription.consumer,
      eventId,
      claimedBy,
      error: coreError,
      now,
    });
    if (!recorded.recorded) {
      return { status: "deferred" };
    }
    return {
      status: "failed",
      error: coreError,
      retryAt: recorded.retryAt?.toISOString() ?? null,
    };
  }
}

type ClaimResult = "claimed" | "alreadyProcessed" | "deferred";

/**
 * Acquires one due delivery. This is intentionally per-delivery: fnd-T27's
 * worker loop discovers due rows, while this transaction remains the single
 * authority for due-time checks, stale-claim takeover, attempt increments,
 * and aggregate ordering.
 */
async function claimDelivery(
  deps: ActionPipelineDeps,
  options: {
    readonly subscription: EventSubscription;
    readonly eventId: string;
    readonly claimedBy: string;
    readonly now: () => number;
  },
): Promise<ClaimResult> {
  const { subscription, eventId, claimedBy, now } = options;

  return await deps.db.transaction(async (tx) => {
    const row = await lockDeliveryRow(tx, {
      consumer: subscription.consumer,
      eventId,
    });
    assertDeliveryRouting({
      eventId,
      storedEventName: row.event.name,
      subscribedEventName: subscription.event.name,
    });
    if (row.status === "processed") {
      return "alreadyProcessed";
    }
    if (row.status === "dead") {
      return "deferred";
    }

    const nowMs = now();
    if (
      row.status === "pending" &&
      row.nextAttemptAt !== null &&
      row.nextAttemptAt.getTime() > nowMs
    ) {
      return "deferred";
    }
    if (row.status === "processing") {
      if (row.claimedAt === null || row.claimedBy === null) {
        throw new CoreInvariantError(
          `processing delivery for consumer "${subscription.consumer}" of event ${eventId} has incomplete claim ownership`,
        );
      }
      const claimExpiresAt =
        row.claimedAt.getTime() +
        subscription.contract.timeout +
        DELIVERY_CLAIM_MARGIN_MS;
      if (claimExpiresAt > nowMs) {
        return "deferred";
      }
    }

    // Serialize claim/order decisions with execution on this consumer's
    // aggregate. This avoids spending an attempt on a known-later event.
    await acquireAggregateAdvisoryLock(tx, {
      consumer: subscription.consumer,
      aggregateType: row.event.aggregateType,
      aggregateId: row.event.aggregateId,
    });
    const blocked = await hasEarlierUnprocessedDelivery(tx, {
      consumer: subscription.consumer,
      aggregateType: row.event.aggregateType,
      aggregateId: row.event.aggregateId,
      aggregateSequence: row.event.aggregateSequence,
    });
    if (blocked) {
      return "deferred";
    }

    const claimedAt = new Date(nowMs);
    const [claimed] = await tx
      .update(eventDeliveries)
      .set({
        status: "processing",
        attempts: sql`${eventDeliveries.attempts} + 1`,
        nextAttemptAt: null,
        claimedAt,
        claimedBy,
      })
      .where(
        and(
          eq(eventDeliveries.consumer, subscription.consumer),
          eq(eventDeliveries.eventId, eventId),
        ),
      )
      .returning({ eventId: eventDeliveries.eventId });
    if (claimed === undefined) {
      throw new CoreInvariantError(
        `delivery claim for consumer "${subscription.consumer}" of event ${eventId} vanished while locked`,
      );
    }
    return "claimed";
  });
}

/** Exponential retry schedule after one-based failed attempt numbers. */
export function deliveryRetryDelayMs(attempt: number): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new CoreInvariantError(
      `delivery retry attempt must be a positive integer, received ${String(attempt)}`,
    );
  }
  return DELIVERY_RETRY_BASE_MS * 2 ** (attempt - 1);
}

type DeliveryFailureRecord =
  | { readonly recorded: true; readonly retryAt: Date | null }
  | { readonly recorded: false };

/**
 * Failure bookkeeping runs after the action transaction rolled back. The
 * owner predicate prevents a stale worker from overwriting a newer claim —
 * that race returns `recorded: false` so the caller can defer instead of
 * throwing out of the executor.
 */
async function recordDeliveryFailure(
  deps: ActionPipelineDeps,
  options: {
    readonly consumer: string;
    readonly eventId: string;
    readonly claimedBy: string;
    readonly error: CoreError;
    readonly now: () => number;
  },
): Promise<DeliveryFailureRecord> {
  const result = await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .select({ attempts: eventDeliveries.attempts })
      .from(eventDeliveries)
      .where(
        ownedProcessingDelivery({
          consumer: options.consumer,
          eventId: options.eventId,
          claimedBy: options.claimedBy,
        }),
      )
      .limit(1)
      .for("update");
    if (row === undefined) {
      return { recorded: false } as const;
    }

    const dead = row.attempts >= DELIVERY_MAX_ATTEMPTS;
    const retryAt = dead
      ? null
      : new Date(options.now() + deliveryRetryDelayMs(row.attempts));
    await tx
      .update(eventDeliveries)
      .set({
        status: dead ? "dead" : "pending",
        nextAttemptAt: retryAt,
        claimedAt: null,
        claimedBy: null,
        // Persist only typed, client-safe text; causes/internal diagnostics
        // stay in structured runtime telemetry and never enter the DB.
        lastError: `${options.error.code}: ${options.error.clientMessage}`,
      })
      .where(
        and(
          eq(eventDeliveries.consumer, options.consumer),
          eq(eventDeliveries.eventId, options.eventId),
        ),
      );
    return { recorded: true, attempts: row.attempts, dead, retryAt } as const;
  });

  if (!result.recorded) {
    return { recorded: false };
  }
  if (result.dead) {
    deps.logger.error(
      {
        consumer: options.consumer,
        event_id: options.eventId,
        attempts: result.attempts,
        error_code: options.error.code,
      },
      "event delivery dead-lettered",
    );
  }
  return { recorded: true, retryAt: result.retryAt };
}

/** Builds the JSON-safe envelope (envelope.ts) from the stored outbox row. */
function buildEnvelope(event: OutboxEventRow): EventEnvelope {
  return {
    eventId: event.id,
    name: event.name,
    version: event.version,
    occurredAt: event.occurredAt.toISOString(),
    companyId: event.companyId,
    aggregate: {
      type: event.aggregateType,
      id: event.aggregateId,
      sequence: event.aggregateSequence.toString(),
    },
    actor: {
      type: narrowStored(event.id, "actor_type", event.actorType, [
        "user",
        "system",
      ] as const),
      id: event.actorId,
      channel: narrowStored(event.id, "channel", event.channel, [
        "ui",
        "ai",
        "system",
        "webhook",
        "sho-ai",
      ] as const),
    },
    requestId: event.requestId,
    correlationId: event.correlationId,
    causationId: event.causationId,
    payload: event.payload,
  };
}

/**
 * Narrows a stored text column to its CHECK-constrained union without a
 * cast. Failing is a server bug — the DB CHECK makes it impossible.
 */
function narrowStored<const TValues extends readonly string[]>(
  eventId: string,
  column: string,
  value: string,
  values: TValues,
): TValues[number] {
  for (const candidate of values) {
    if (value === candidate) {
      return candidate;
    }
  }
  throw new CoreInvariantError(
    `outbox row ${eventId} carries ${column} "${value}" outside its CHECK constraint`,
  );
}

/** Everything leaving the executor is a typed core error (core.md §11). */
function toCoreError(error: unknown): CoreError {
  if (error instanceof CoreError) {
    return error;
  }
  return new CoreInvariantError(
    "event delivery failed outside the typed error vocabulary",
    { cause: error },
  );
}
