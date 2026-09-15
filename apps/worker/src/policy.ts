/**
 * Worker loop and job-host parameters (fnd-T27 / fnd-T29). The notify
 * channel is the db.md §4 trigger contract; BullMQ prefix/queue and
 * intervals are operational defaults, not product knobs — change them
 * only through an ADR or a protocol-manual patch with a proving test.
 */

import { ASSISTANT_TURN_TIMEOUT_MS } from "@showzy/assistant-runtime";

/** Postgres NOTIFY channel fired on `domain_events` INSERT. */
export const OUTBOX_NOTIFY_CHANNEL = "domain_events";

/** Polling fallback when LISTEN is quiet (retries, expired claims). */
export const POLL_INTERVAL_MS = 1_000;

/**
 * Bounded concurrent delivery executions per tick (SHO-279). Small on
 * purpose: enough that one slow consumer (a 30 s PDF render) does not
 * head-of-line block the batch, small enough that a burst cannot starve
 * the pool. Per-aggregate ordering stays with core's claim logic
 * (advisory lock + earliest-first defer).
 */
export const DELIVERY_CONCURRENCY = 4;

/**
 * Cap for the exponential tick-failure backoff (SHO-279): a transient
 * dispatch/findDue error logs and skips ticks for
 * `pollInterval * 2^(failures-1)` up to this cap, instead of crashing the
 * process with an unhandled rejection.
 */
export const TICK_FAILURE_BACKOFF_MAX_MS = 30_000;

/**
 * BullMQ Redis key prefix (ADR-0007). Do not set ioredis `keyPrefix` —
 * BullMQ owns prefixing. Email / push / sms / sync queues stay uncreated.
 */
export const BULLMQ_PREFIX = "showzy";

/** Maintenance execution queue. Outbox delivery is not BullMQ. */
export const MAINTENANCE_QUEUE_NAME = "maintenance";

export const MAINTENANCE_LOCK_DURATION_MS = 60_000;

export const JOB_DRAIN_TIMEOUT_MS = 30_000;

/**
 * Turns one worker process runs at once (ADR-0039, starting values). The
 * assistant queue — its name, prefix and job payload — is the contract in
 * `@showzy/assistant-runtime`; these are the consumer's half of its policy.
 */
export const ASSISTANT_QUEUE_CONCURRENCY = 4;

/**
 * A turn's job lock (ADR-0039). BullMQ renews it at half this while the
 * processor runs, so it bounds how long a dead worker's job looks alive, not
 * how long a turn may take (the turn's own deadline is 180 s).
 */
export const ASSISTANT_LOCK_DURATION_MS = 60_000;

/**
 * A job whose worker disappeared fails instead of re-running (ADR-0039): a
 * turn that has started is never run twice. Its turn stays `running` until the
 * reconciler interrupts it past its deadline.
 */
export const ASSISTANT_MAX_STALLED_COUNT = 0;

/**
 * How often the reconciler passes over the turns the database calls stale
 * (ADR-0039, starting values). On the maintenance scheduler, like every other
 * periodic job: a missed pass costs nothing, because the next one finds the
 * same rows. It bounds how long a crashed worker's turn stays `running` — up to
 * the turn timeout plus one of these.
 */
export const ASSISTANT_RECONCILE_INTERVAL_MS = 60_000;

/** Stable Job Scheduler id and job name for the reconciler's pass. */
export const ASSISTANT_RECONCILE_JOB_NAME = "reconcileAssistantTurns";

/**
 * How long shutdown waits for the turns this worker is running (ADR-0039:
 * deploys drain in-flight turns). A turn's own deadline stops it after the turn
 * timeout, and it still has its last writes to make, so this is that timeout
 * plus room for them. Past it the process stops waiting and says so; the turn's
 * row is then the reconciler's to interrupt, as any crashed worker's is.
 *
 * The stop grace period the platform gives this process must be at least this
 * long. There is no production environment yet, so that is a recorded
 * requirement (`AGENTS.md`), not a setting here.
 */
export const ASSISTANT_DRAIN_TIMEOUT_MS = ASSISTANT_TURN_TIMEOUT_MS + 30_000;

/** First LISTEN reconnect delay after a dropped connection. */
export const LISTEN_RECONNECT_MIN_MS = 1_000;

/** Cap for exponential LISTEN reconnect backoff. */
export const LISTEN_RECONNECT_MAX_MS = 30_000;

/**
 * Heartbeat while LISTEN is down and the 1s poll is the only wakeup.
 * `docs/operations/alerts.md` pages SEV2 after this signal lasts > 5 min.
 */
export const LISTEN_DOWN_HEARTBEAT_MS = 60_000;
