# @showzy/worker — Agent Instructions

Outbox dispatcher, delivery executor, and BullMQ execution-job host
(fnd-T27 / fnd-T29). Core exposes libraries only (`dispatchOutboxBatch`,
`findClaimableDeliveries`, `executeDelivery`,
`cleanupExpiredIdempotencyKeys`); this package owns the loops, LISTEN/NOTIFY
wakeup, polling fallback, graceful drain, and the job host.

## Layout

- `src/index.ts` — process entry. `loadServerConfig()` once. Default
  command runs the worker; `replay-deliveries --consumer <id>` is the
  fnd-T18 admin replay CLI. An invalid environment crashes before work
  starts. Shutdown is latched (second SIGINT/SIGTERM is a no-op): drain
  in-flight BullMQ jobs, then the outbox close latch, then flush Sentry.
- `src/boot.ts` — binds the files object store from validated `config.s3`
  (same as the API; do not import API internals), opens Postgres + Redis
  (confirmation/rate-limit) plus a **dedicated** BullMQ Redis connection,
  composes the action pipeline, starts the job host, LISTENs on
  `domain_events`, starts the outbox loop. Close the object store after
  draining jobs.
- `src/jobs.ts` — BullMQ job host. Prefix `showzy`, queues `maintenance`
  and `pdf`. On boot, upserts Job Schedulers for
  `cleanupExpiredIdempotencyKeys` (`CLEANUP_INTERVAL_MS`, 1 h),
  `sweepAbandonedUploads` (`SWEEP_INTERVAL_MS`, 5 min, action batch
  default 20), and `backfillCatalogRenditions`
  (`BACKFILL_CATALOG_RENDITIONS_INTERVAL_MS`, 5 min, action batch
  default 20). The sweep processor invokes `files.sweepAbandonedUploads`
  as system/global with a fresh idempotency key per `job.id`. The
  backfill processor invokes `files.backfillCatalogRenditions` the same
  way. The pdf
  processor invokes `docGeneration.renderPdf` as system/tenant from the
  envelope `companyId` (`executeAction` only — no domain SQL). When the
  assistant is mounted it also upserts `reconcileAssistantTurns`
  (`ASSISTANT_RECONCILE_INTERVAL_MS`, 60 s), and removes that scheduler when it
  is not: the reconciler's pass is a maintenance job like any other (safe to
  miss, safe to run again), and it is handed this host's assistant queue so a
  turn it re-enqueues is added exactly as an accept adds it (SHO-570).
  Production
  `documents.created` delivery still runs through the outbox (chat
  golden), so this host does not enqueue durable one-shot PDF jobs. Do not
  pre-create email / push / sms / sync queues. Processors stay thin (no
  domain SQL, no module service imports). Named exception: the `assistant`
  processor (SHO-561) runs a whole turn through `@showzy/assistant-runtime`,
  because the turn is the work — still only `executeAction` as the staff
  member, never domain SQL.
- `src/loop.ts` — `createOutboxWorker` / `createWorkerLoop`: one tick
  dispatches then executes due deliveries; shutdown waits for in-flight
  work and does not claim further. Executor lookup is keyed by
  `(consumer, eventName)` so one consumer id may bind multiple events.
  After `executeDelivery`, `maybeFinalizeDeadPdfGeneration` persists a
  durable failed PDF job via `docGeneration.markFailed` when the
  `docGeneration.pdf-renderer` delivery is dead (`retryAt: null`). Scope
  comes from `PdfGenerationRetryableError`, not a domain-table query.
  Idempotency cleanup is **not** on this loop.
- `src/listen.ts` — dedicated `pg.Client` for `LISTEN domain_events`.
  A dropped listen connection reconnects with backoff, logs recovery, and
  emits `outbox listen down, poll-only` while degraded; the 1s poll is
  the fallback either way.
- `src/shutdown.ts` — SIGINT/SIGTERM latch so `close()` cannot run twice.
- `src/pipeline.ts` — fills every protocol hook slot (same composition
  as `apps/api`).
- `src/stores/redis.ts` — confirmation `GETDEL` and Lua token-bucket
  stores. Must stay behaviorally identical to `apps/api/src/stores/redis.ts`.
  Never reuse this client as the blocking BullMQ connection.
- `src/subscriptions.ts` — re-exports `@showzy/api/subscriptions`.
  Register subscriptions once in `apps/api/src/subscriptions.ts`; both
  API contract checks and worker delivery derive from that array. Do not
  introduce a second hand-maintained list (SHO-279).
- `src/observability.ts` — `createProcessObservability` (redacting pino
  logger + optional Sentry). Keep in lockstep with
  `apps/api/src/observability.ts`. `flushProcessObservability` drains
  Sentry on shutdown.
- `src/policy.ts` — poll/cleanup/sweep/backfill intervals, notify channel,
  BullMQ prefix and queue name. Values change only through an ADR or a
  protocol-manual patch with a proving test.

## Rules

- Config comes from `@showzy/config` at the entrypoint; this package
  never reads `process.env` except inside `loadServerConfig`.
- Do not query `domain_events` / `event_deliveries` directly — go
  through the core libraries.
- Domain event delivery is not BullMQ (ADR-0007/ADR-0012). BullMQ is the
  execution job host (maintenance and PDF today; email, push, sync later).
  Outbox stays on core libraries.
- Two Redis instances (db.md §6, ADR-0039). The shared Redis (`REDIS_URL`)
  never persists: it holds plaintext OTP codes among other short-lived state.
  The maintenance and pdf queues stay on it and stay safe to miss and re-run;
  re-upsert the schedulers on every boot. **Durable assistant-turn jobs** live
  on the dedicated queue Redis (AOF `appendfsync everysec` on a volume,
  `maxmemory-policy noeviction`): an accepted turn is a Postgres row, and the
  assistant reconciler rebuilds a lost job from it. Never put a durable job on
  the shared Redis. Any other durable one-shot job needs its own ticket and
  its own recovery story — AOF alone is not one. The queue Redis is
  `config.queueRedis.url` (`REDIS_QUEUE_URL`); the job host opens its own
  BullMQ connection to it only when the assistant is mounted (SHO-569). Worker-side queue policy (concurrency 4, lock 60 s,
  `maxStalledCount: 0`) lives in `policy.ts`; the job options a turn is
  enqueued with (`attempts: 1`, removed on completion and on failure) live
  with the producer, `enqueueAssistantTurn` in `@showzy/assistant-runtime`.
- **Shutdown drains turns.** `close()` waits for the assistant worker first,
  and for at most `ASSISTANT_DRAIN_TIMEOUT_MS` (the turn timeout plus room for
  a stopped turn's last writes). Past it the process logs
  `assistant turns still running at the drain timeout` and goes; that turn's
  row is then the reconciler's to interrupt. BullMQ keeps one close per worker,
  so the bound is a race against that close, never a second forced one.
  **Requirement for when infrastructure exists:** the stop grace period the
  platform gives this process must be at least `ASSISTANT_DRAIN_TIMEOUT_MS`,
  or a deploy kills turns the drain was waiting for (ADR-0039; no production
  environment yet, so this is recorded, not configured).
- The assistant processor is `createAssistantTurnProcessor` and the reconciler
  `createAssistantTurnReconciler`, both from
  `@showzy/assistant-runtime`, composed in `src/assistant.ts` and mounted by
  boot on the API's rule (`staffAssistantMount`: `AI_ASSISTANT_KIT` on and a
  language model configured), with the same `assistant-kit path` log line.
  The runtime runs against the worker pipeline and the API's registry
  (`@showzy/api/registry`, `assertPaired()` at boot); its pauses, budget
  counters and published events use the shared Redis, never the queue Redis.
  One `composeAssistantTurns` builds both, so a turn and the reconciler that
  recovers it share one runtime, publisher and budget store. The reconciler is
  held for the life of the process: its re-enqueue backoff is its memory.
  The job host only parses the payload and hands it over. A payload that does
  not parse is dropped, never retried. Whatever the processor throws is logged
  and the job completes as `errored`: a thrown message would be stored as
  `failedReason` on the queue Redis, and can name a person or a company.
- The worker is an AI process for assistant turns (ADR-0039): it may import
  `@showzy/assistant-runtime` (and through it `@showzy/ai` and
  `@showzy/assistant-kit`), and from the API only the approved
  `@showzy/api/subscriptions` and `@showzy/api/registry` subpaths — never API
  runtime internals, and nothing provider-related through the API
  (`showzy/import-boundaries`). The queue name, prefix, payload schema and
  `jobId` derivation come from the runtime package;
  `assistant-queue-contract.test.ts` pins its prefix to `BULLMQ_PREFIX`. The
  payload is the turn's identity only: the processor reads the turn and its
  company from Postgres, and the actor is the turn's `user_id`. Requirement
  for when infrastructure exists: the stop grace period is at least the turn
  timeout, so a deploy drains in-flight turns.
- OTP codes, tokens, and secrets never reach logs. Process loggers are
  `createProcessLogger` from `@showzy/config`. Sentry is initialized
  only when `SENTRY_DSN` is set; `beforeSend` scrubs the event. Do not
  construct a raw `pino()`.
