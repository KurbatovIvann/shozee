/**
 * Worker loop (fnd-T27 — core.md §6): dispatch undispatched outbox rows,
 * execute due deliveries, drain in-flight claims on shutdown. Idempotency
 * key expiry is the BullMQ maintenance scheduler (fnd-T29), not this loop.
 * Core owns the libraries; this owns the outbox process.
 */
import {
  dispatchOutboxBatch,
  executeDelivery,
  findClaimableDeliveries,
  type ActionPipelineDeps,
  type ClaimableDelivery,
  type DeliveryOutcome,
  type EventSubscription,
  type OutboxDispatchResult,
} from "@showzy/core";
import { CoreInvariantError } from "@showzy/core/errors";
import type { Database } from "@showzy/db";
import type { Logger } from "pino";

import type { OutboxListener } from "./listen.js";
import { maybeFinalizeDeadPdfGeneration } from "./pdf-delivery.js";
import {
  DELIVERY_CONCURRENCY,
  POLL_INTERVAL_MS,
  TICK_FAILURE_BACKOFF_MAX_MS,
} from "./policy.js";

export interface TickResult {
  readonly claimedEvents: number;
  readonly createdDeliveries: number;
  readonly processed: number;
  readonly alreadyProcessed: number;
  readonly deferred: number;
  readonly failed: number;
}

const EMPTY_TICK: TickResult = {
  claimedEvents: 0,
  createdDeliveries: 0,
  processed: 0,
  alreadyProcessed: 0,
  deferred: 0,
  failed: 0,
};

export interface WorkerLoop {
  readonly workerId: string;
  tick(): Promise<TickResult>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface WorkerLoopDeps {
  readonly workerId: string;
  readonly logger: Logger;
  readonly pollIntervalMs: number;
  readonly listen?: OutboxListener;
  /**
   * Bounded concurrent delivery executions per tick (defaults to
   * `DELIVERY_CONCURRENCY`). Per-aggregate ordering stays with core: the
   * claim logic serializes one consumer's work on one aggregate via the
   * advisory lock and defers out-of-order deliveries.
   */
  readonly deliveryConcurrency?: number;
  /** Clock override for tests; defaults to `Date.now`. */
  readonly now?: () => number;
  dispatch(): Promise<OutboxDispatchResult>;
  findDue(): Promise<ClaimableDelivery[]>;
  execute(delivery: ClaimableDelivery): Promise<DeliveryOutcome>;
}

export function createWorkerLoop(deps: WorkerLoopDeps): WorkerLoop {
  const now = deps.now ?? Date.now;
  const state = {
    stopping: false,
    started: false,
    ticking: false,
    consecutiveTickFailures: 0,
    /** Epoch ms before which ticks are skipped after repeated failures. */
    backoffUntil: 0,
  };
  /** Filled by poll/LISTEN while a tick is in flight; opaque so CFA cannot
   *  collapse `size > 0` after `clear()` (requestTick mutates during await). */
  const pendingWakes = new Set<"tick">();
  let chain = Promise.resolve();
  let pollTimer: ReturnType<typeof setInterval> | undefined;

  function serialized<T>(work: () => Promise<T>): Promise<T> {
    const run = chain.then(work, work);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function executeOne(
    delivery: ClaimableDelivery,
    counts: {
      processed: number;
      alreadyProcessed: number;
      deferred: number;
      failed: number;
    },
  ): Promise<void> {
    try {
      const outcome = await deps.execute(delivery);
      countOutcome(counts, outcome);
      if (outcome.status === "failed") {
        deps.logger.error(
          {
            worker_id: deps.workerId,
            consumer: delivery.consumer,
            event_id: delivery.eventId,
            retry_at: outcome.retryAt,
            err: outcome.error,
          },
          "outbox delivery failed",
        );
      }
    } catch (error) {
      counts.failed += 1;
      deps.logger.error(
        {
          worker_id: deps.workerId,
          consumer: delivery.consumer,
          event_id: delivery.eventId,
          err: error,
        },
        "outbox delivery threw",
      );
    }
  }

  async function runOnce(): Promise<TickResult> {
    const dispatched = await deps.dispatch();
    const due = state.stopping ? [] : await deps.findDue();
    const counts = {
      processed: 0,
      alreadyProcessed: 0,
      deferred: 0,
      failed: 0,
    };
    // A shared-cursor pool: a slow delivery (30 s PDF render) no longer
    // head-of-line blocks the rest of the batch. Per-aggregate ordering is
    // core's job — the claim logic serializes one consumer's work on one
    // aggregate (advisory lock) and defers out-of-order deliveries.
    const concurrency = Math.max(
      1,
      Math.min(deps.deliveryConcurrency ?? DELIVERY_CONCURRENCY, due.length),
    );
    let nextIndex = 0;
    const lane = async (): Promise<void> => {
      while (!state.stopping) {
        const index = nextIndex;
        nextIndex += 1;
        const delivery = due[index];
        if (delivery === undefined) {
          return;
        }
        await executeOne(delivery, counts);
      }
    };
    if (due.length > 0) {
      await Promise.all(Array.from({ length: concurrency }, lane));
    }
    const result: TickResult = {
      claimedEvents: dispatched.claimedEvents,
      createdDeliveries: dispatched.createdDeliveries,
      ...counts,
    };
    if (result.claimedEvents > 0 || result.processed > 0 || result.failed > 0) {
      deps.logger.info(
        {
          worker_id: deps.workerId,
          claimed_events: result.claimedEvents,
          created_deliveries: result.createdDeliveries,
          processed: result.processed,
          already_processed: result.alreadyProcessed,
          deferred: result.deferred,
          failed: result.failed,
        },
        "outbox worker tick",
      );
    }
    return result;
  }

  async function tick(): Promise<TickResult> {
    if (state.stopping) {
      return EMPTY_TICK;
    }
    if (now() < state.backoffUntil) {
      // Recent tick failures — let the poll timer retry after the backoff
      // window instead of hammering a struggling database.
      return EMPTY_TICK;
    }
    if (state.ticking) {
      pendingWakes.add("tick");
      return EMPTY_TICK;
    }
    return serialized(async () => {
      state.ticking = true;
      try {
        let last = EMPTY_TICK;
        do {
          pendingWakes.clear();
          if (state.stopping) {
            return last;
          }
          try {
            last = await runOnce();
            state.consecutiveTickFailures = 0;
            state.backoffUntil = 0;
          } catch (error) {
            // A transient dispatch/findDue error must never become an
            // unhandled rejection (every caller fires `void tick()`): log,
            // back off exponentially, and let the poll timer keep the loop
            // alive.
            state.consecutiveTickFailures += 1;
            const backoffMs = Math.min(
              deps.pollIntervalMs * 2 ** (state.consecutiveTickFailures - 1),
              TICK_FAILURE_BACKOFF_MAX_MS,
            );
            state.backoffUntil = now() + backoffMs;
            deps.logger.error(
              {
                worker_id: deps.workerId,
                consecutive_failures: state.consecutiveTickFailures,
                backoff_ms: backoffMs,
                err: error,
              },
              "outbox tick failed",
            );
            return EMPTY_TICK;
          }
        } while (pendingWakes.size > 0);
        return last;
      } finally {
        state.ticking = false;
      }
    });
  }

  function requestTick(): void {
    pendingWakes.add("tick");
    void tick();
  }

  return {
    workerId: deps.workerId,
    tick,
    async start() {
      if (state.started || state.stopping) {
        return;
      }
      state.started = true;
      if (deps.listen !== undefined) {
        await deps.listen.start(requestTick);
      }
      deps.logger.info(
        {
          worker_id: deps.workerId,
          poll_interval_ms: deps.pollIntervalMs,
          listen: deps.listen !== undefined,
        },
        "outbox worker started",
      );
      void tick();
      pollTimer = setInterval(() => {
        requestTick();
      }, deps.pollIntervalMs);
    },
    async stop() {
      state.stopping = true;
      if (pollTimer !== undefined) {
        clearInterval(pollTimer);
        pollTimer = undefined;
      }
      if (deps.listen !== undefined) {
        await deps.listen.stop();
      }
      await chain;
      deps.logger.info({ worker_id: deps.workerId }, "outbox worker stopped");
    },
  };
}

export interface CreateOutboxWorkerOptions {
  readonly db: Database;
  readonly pipeline: ActionPipelineDeps;
  readonly subscriptions: readonly EventSubscription[];
  readonly workerId: string;
  readonly logger: Logger;
  readonly listen?: OutboxListener;
  readonly pollIntervalMs?: number;
  readonly deliveryConcurrency?: number;
  readonly now?: () => number;
}

/**
 * Worker executor lookup key. One consumer id may bind multiple events
 * (duplicate is only `(consumer, event)`); indexing by consumer alone
 * overwrites the first binding (core.md §6, SHO-95).
 */
export function consumerEventKey(consumer: string, eventName: string): string {
  return `${consumer}\u0000${eventName}`;
}

/**
 * Indexes subscriptions by `(consumer, eventName)`. Duplicate keys are a
 * composition bug — the contract check already rejects them; failing here
 * keeps a mis-composed worker from silently dropping a binding.
 */
export function indexSubscriptionsByConsumerEvent(
  subscriptions: readonly EventSubscription[],
): ReadonlyMap<string, EventSubscription> {
  const indexed = new Map<string, EventSubscription>();
  for (const subscription of subscriptions) {
    const key = consumerEventKey(
      subscription.consumer,
      subscription.event.name,
    );
    if (indexed.has(key)) {
      throw new CoreInvariantError(
        `duplicate event subscription for consumer "${subscription.consumer}" of "${subscription.event.name}" — executor composition bug`,
      );
    }
    indexed.set(key, subscription);
  }
  return indexed;
}

/**
 * Binds the core dispatcher/executor/cleanup libraries to the process loop.
 */
export function createOutboxWorker(
  options: CreateOutboxWorkerOptions,
): WorkerLoop {
  const byConsumerAndEvent = indexSubscriptionsByConsumerEvent(
    options.subscriptions,
  );
  const clock = options.now !== undefined ? { now: options.now } : {};
  const listen = options.listen !== undefined ? { listen: options.listen } : {};

  return createWorkerLoop({
    workerId: options.workerId,
    logger: options.logger,
    pollIntervalMs: options.pollIntervalMs ?? POLL_INTERVAL_MS,
    ...(options.deliveryConcurrency !== undefined
      ? { deliveryConcurrency: options.deliveryConcurrency }
      : {}),
    ...clock,
    ...listen,
    dispatch: () =>
      dispatchOutboxBatch(
        { db: options.pipeline.db, ...clock },
        {
          subscriptions: options.subscriptions,
          claimedBy: options.workerId,
        },
      ),
    findDue: () =>
      findClaimableDeliveries(
        { db: options.pipeline.db },
        { subscriptions: options.subscriptions, ...clock },
      ),
    execute: async (delivery) => {
      const subscription = byConsumerAndEvent.get(
        consumerEventKey(delivery.consumer, delivery.eventName),
      );
      if (subscription === undefined) {
        options.logger.error(
          {
            worker_id: options.workerId,
            consumer: delivery.consumer,
            event_id: delivery.eventId,
            event_name: delivery.eventName,
          },
          "no subscription for claimable delivery",
        );
        return { status: "deferred" };
      }
      const outcome = await executeDelivery(options.pipeline, {
        subscription,
        eventId: delivery.eventId,
        claimedBy: options.workerId,
      });
      await maybeFinalizeDeadPdfGeneration({
        pipeline: options.pipeline,
        delivery,
        outcome,
        logger: options.logger,
        workerId: options.workerId,
      });
      return outcome;
    },
  });
}

function countOutcome(
  counts: {
    processed: number;
    alreadyProcessed: number;
    deferred: number;
    failed: number;
  },
  outcome: DeliveryOutcome,
): void {
  switch (outcome.status) {
    case "processed":
      counts.processed += 1;
      break;
    case "alreadyProcessed":
      counts.alreadyProcessed += 1;
      break;
    case "deferred":
      counts.deferred += 1;
      break;
    case "failed":
      counts.failed += 1;
      break;
  }
}
