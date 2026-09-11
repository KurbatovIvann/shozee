/**
 * Worker loop and job-host parameters (fnd-T27 / fnd-T29). The notify
 * channel is the db.md §4 trigger contract; BullMQ prefix/queue and
 * intervals are operational defaults, not product knobs — change them
 * only through an ADR or a protocol-manual patch with a proving test.
 */

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
 * How often the maintenance Job Scheduler runs idempotency-key expiry
 * (core.md §5, 48h TTL). BullMQ, not `setInterval`.
 */
export const CLEANUP_INTERVAL_MS = 60 * 60 * 1_000;

/**
 * How often the maintenance Job Scheduler runs
 * `files.sweepAbandonedUploads` (SHO-120). Batch size stays the action
 * default (20). BullMQ, not `setInterval`.
 */
export const SWEEP_INTERVAL_MS = 5 * 60 * 1_000;

/**
 * How often the maintenance Job Scheduler runs
 * `files.backfillCatalogRenditions` (SHO-248). Same 5-minute cadence as
 * the abandoned-upload sweep. Batch size stays the action default (20).
 * BullMQ, not `setInterval`.
 */
export const BACKFILL_CATALOG_RENDITIONS_INTERVAL_MS = 5 * 60 * 1_000;

/**
 * BullMQ Redis key prefix (ADR-0007). Do not set ioredis `keyPrefix` —
 * BullMQ owns prefixing. Email / push / sms / sync queues stay uncreated.
 */
export const BULLMQ_PREFIX = "showzy";

/** Maintenance execution queue. Outbox delivery is not BullMQ. */
export const MAINTENANCE_QUEUE_NAME = "maintenance";

/**
 * PDF execution queue (SHO-236). Production `documents.created` delivery
 * still invokes
 * `docGeneration.renderPdf` through the outbox (chat golden). Redis has
 * no volume (db.md §6), so this host does not enqueue durable one-shot
 * PDF work — the unique `document_generation_jobs` row plus outbox
 * delivery is the retry target (five attempts, 1s/2s/4s/8s). The
 * processor is the thin `executeAction(renderPdf)` wrapper for when a
 * job is added (replay / later persistence policy). Retryable render
 * failures throw so BullMQ does not complete the job; terminal
 * `{status:"failed"}` is an honest ACK. Do not add a second BullMQ
 * attempt budget here.
 */
export const PDF_QUEUE_NAME = "pdf";

/** Job name the pdf worker executes. */
export const PDF_JOB_NAME = "renderPdf";

/**
 * System actor for pdf jobs that invoke `docGeneration.renderPdf`.
 * Not a new principal — `system` + `systemScope: "tenant"`.
 */
export const PDF_SERVICE_NAME = "worker.pdf";

/**
 * Worker lock longer than `docGeneration.renderPdf` timeout (30s) so a
 * replica cannot steal an in-flight render.
 */
export const PDF_LOCK_DURATION_MS = 60_000;

/**
 * Stable Job Scheduler id and job name. Re-upserted on every boot so a
 * flushed Redis only misses ticks (db.md §6: Redis is rebuildable).
 */
export const IDEMPOTENCY_CLEANUP_JOB_NAME = "cleanupExpiredIdempotencyKeys";

/**
 * Second Job Scheduler on the same `maintenance` queue (SHO-120).
 */
export const SWEEP_ABANDONED_UPLOADS_JOB_NAME = "sweepAbandonedUploads";

/**
 * Third Job Scheduler on the same `maintenance` queue (SHO-248).
 */
export const BACKFILL_CATALOG_RENDITIONS_JOB_NAME = "backfillCatalogRenditions";

/**
 * System actor for maintenance jobs that invoke registered actions.
 * Not a new principal — `system` + `systemScope: "global"`.
 */
export const MAINTENANCE_SERVICE_NAME = "worker.maintenance";

/**
 * Worker lock longer than `files.sweepAbandonedUploads` and
 * `files.backfillCatalogRenditions` timeout (30s) so a replica cannot
 * steal an in-flight maintenance job.
 */
export const MAINTENANCE_LOCK_DURATION_MS = 60_000;

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

/** First LISTEN reconnect delay after a dropped connection. */
export const LISTEN_RECONNECT_MIN_MS = 1_000;

/** Cap for exponential LISTEN reconnect backoff. */
export const LISTEN_RECONNECT_MAX_MS = 30_000;

/**
 * Heartbeat while LISTEN is down and the 1s poll is the only wakeup.
 * `docs/operations/alerts.md` pages SEV2 after this signal lasts > 5 min.
 */
export const LISTEN_DOWN_HEARTBEAT_MS = 60_000;
