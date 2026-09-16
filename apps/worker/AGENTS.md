# @showzy/worker — Agent Instructions

Outbox dispatcher, delivery executor, and every pg-boss job — maintenance, the
assistant turn and the overdue sweep (fnd-T27 / fnd-T29 / SHO-650 / SHO-651).
There is no BullMQ. Core exposes libraries only (`dispatchOutboxBatch`,
`findClaimableDeliveries`, `executeDelivery`,
`cleanupExpiredIdempotencyKeys`); this package owns the loops, LISTEN/NOTIFY
wakeup, polling fallback, graceful drain, and the job handlers.

## Layout

- `src/index.ts` — process entry. `loadServerConfig()` once. Default
  command runs the worker; `replay-deliveries --consumer <id>` is the
  fnd-T18 admin replay CLI. An invalid environment crashes before work
  starts. Shutdown is latched (second SIGINT/SIGTERM is a no-op): drain
  in-flight jobs, then the outbox close latch, then flush Sentry.
- `src/boot.ts` — binds the files object store from validated `config.s3`
  (same as the API; do not import API internals), opens Postgres + Redis
  (confirmation/rate-limit), composes the action pipeline, opens the pg-boss
  runner with `workerJobs` (provisioning queues and schedules) and works
  `maintenanceHandlers` together with `composeAssistantJobs`, LISTENs on
  `domain_events`, starts the outbox loop. Close the object store after
  draining the job runner. `close()` and a failed boot release through one
  ordered list (drain jobs, stop the loop, object store, Redis, database),
  skipping what was never acquired and attempting every release even when one
  fails; a failed boot rethrows its own error.
- `src/maintenance.ts` — maintenance on pg-boss (`docs/specs/jobs.md` §12).
  The worker-owned job and action `worker.cleanupIdempotencyKeys` (hourly,
  internal system/global audited write calling core's
  `cleanupExpiredIdempotencyKeys` in its action transaction); `workerJobs`
  (`registeredJobs` from `@showzy/api/registry` plus worker-owned jobs,
  duplicates refused); `createWorkerActionRegistry` (the API registry plus
  worker-owned actions); `maintenanceHandlers` for `files.sweepAbandonedUploads`,
  `files.backfillCatalogRenditions` (both every 5 min) and the cleanup. A
  handler only runs its action and logs counts. A new worker-owned job adds
  its handler here, its coverage to `src/suite-coverage.ts`, and passes
  `pnpm --filter @showzy/worker contract:check`.
- `src/assistant-jobs.ts` — `composeAssistantJobs`: the two assistant
  `JobHandler`s this worker binds, on the API's rule (`staffAssistantMount`)
  for the log line only. Both are bound whether or not a model is configured,
  because recovery and maintenance are model-free (SHO-698): the
  `assistant.turn` handler refuses before it starts anything when there is no
  model (a typed `CONFLICT`), so the attempt fails, the job is exhausted and
  `assistant.interruptTurn` closes the turn as `not_started` with its hold
  refunded. The runtime runs against the worker pipeline and the API's registry
  (`@showzy/api/registry`, `assertPaired()` at boot); its pauses, budget
  counters and published events use the shared Redis. One composition builds
  the processor, the recovery helper and the sweep, so a turn and the recovery
  that closes it share one runtime, publisher and budget store. The turn
  handler binds `onExhausted: assistant.interruptTurn` and an `afterExhausted`
  hook that hands that action's own output to the recovery helper; the sweep
  handler logs the pass's summary, failed turns and companies included, and
  does not fail its attempt — nothing would retry it.
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
  Never reuse this client for a blocking command.
- `src/subscriptions.ts` — re-exports `@showzy/api/subscriptions`.
  Register subscriptions once in `apps/api/src/subscriptions.ts`; both
  API contract checks and worker delivery derive from that array. Do not
  introduce a second hand-maintained list (SHO-279).
- `src/observability.ts` — `createProcessObservability` (redacting pino
  logger + optional Sentry). Keep in lockstep with
  `apps/api/src/observability.ts`. `flushProcessObservability` drains
  Sentry on shutdown.
- `src/policy.ts` — poll interval, the job drain timeout and the notify
  channel. Job cadence is each job's `cron`. Values change only through an ADR
  or a protocol-manual patch with a proving test.

## Rules

- Config comes from `@showzy/config` at the entrypoint; this package
  never reads `process.env` except inside `loadServerConfig`.
- Do not query `domain_events` / `event_deliveries` directly — go
  through the core libraries.
- Domain event delivery is not a job runner (ADR-0007/ADR-0012). Every job —
  maintenance, the assistant turn, the overdue sweep — runs on pg-boss in
  Postgres (ADR-0041, SHO-651). Outbox stays on core libraries. There is no
  BullMQ and no queue Redis: an accepted turn and its job commit in the same
  transaction, so the job is as durable as the row.
- One Redis (db.md §6): the shared, non-persistent `REDIS_URL` for the
  assistant's pauses, budget counters, published events, confirmations and
  rate limits. Nothing durable goes on it. There is no second Redis and no
  `REDIS_QUEUE_URL` (SHO-655).
- **Shutdown drains jobs.** `close()` drains the one job runner first, for at
  most `JOB_DRAIN_TIMEOUT_MS` = `ASSISTANT_TURN_ATTEMPT_TIMEOUT_MS` (210 s:
  the 180 s turn timeout plus room for a stopped turn's last writes), before
  the outbox loop stops and the object store, Redis and the database close.
  The runner stops accepting new work first and keeps its own settle margin.
  Past the bound an in-flight turn's row is the overdue sweep's to interrupt,
  as any crashed worker's is.
  **Requirement for when infrastructure exists:** the stop grace period the
  platform gives this process must be at least `JOB_DRAIN_TIMEOUT_MS`, or a
  deploy kills turns the drain was waiting for (ADR-0039; no production
  environment yet, so this is recorded, not configured).
- The assistant processor, the recovery helper and the overdue sweep pass come
  from `@showzy/assistant-runtime`, composed in `src/assistant-jobs.ts` and
  bound by boot together with `maintenanceHandlers`. A failure reaches pg-boss:
  the handler throws, the attempt fails with its typed code, and on exhaustion
  `assistant.interruptTurn` ends the turn and the post-commit hook recovers it.
  Nothing is swallowed and logged as a successful outcome. The sweep pass is
  the one place a failure stops there: a dropped recovery is counted in the
  summary and logged, and the pass still returns, because a turn it already
  ended is no longer overdue and no tick would retry it.
- The worker is an AI process for assistant turns (ADR-0039): it may import
  `@showzy/assistant-runtime` (and through it `@showzy/ai` and
  `@showzy/assistant-kit`), and from the API only the approved
  `@showzy/api/subscriptions` and `@showzy/api/registry` subpaths — never API
  runtime internals, and nothing provider-related through the API
  (`showzy/import-boundaries`). The job declarations come from the assistant
  module through the runtime package's `assistant-jobs.ts` re-export. The
  payload is the turn's identity only: the processor reads the turn in the
  job's **recorded company**, and the actor is the turn's `user_id`. The stop
  grace period is the drain bullet above; it is stated there and nowhere else.
- OTP codes, tokens, and secrets never reach logs. Process loggers are
  `createProcessLogger` from `@showzy/config`. Sentry is initialized
  only when `SENTRY_DSN` is set; `beforeSend` scrubs the event. Do not
  construct a raw `pino()`.
