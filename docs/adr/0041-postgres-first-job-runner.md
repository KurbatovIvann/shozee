# ADR-0041: Background jobs are enqueued in the transaction and run from Postgres behind a runner port

- **Status**: Proposed
- **Date**: 2026-09-13
- **Deciders**: Ivan Kurbatov (human) (+ proposing agent)

## Context

**One unit of work lives in two stores.**
- ADR-0007 put every background job on BullMQ.
- ADR-0039 gave the assistant turn a Postgres row (`assistant_turns`) and a
  BullMQ job on a second, persistent Redis.
- The job is enqueued after the accept commits
  (`apps/api/src/http/assistant-kit-http.ts:165`), so:
  - a crash or Redis error between commit and enqueue leaves a committed turn
    with no job; SHO-570's reconciler re-enqueues it on an interval;
  - status in Redis lags the row;
  - the queue Redis holds data that cannot be rebuilt, so it runs with AOF and
    no eviction (`db.md` §6).

**ADR-0007's premise was incomplete.** It rejected pg-boss because "its only
advantage (no Redis dependency) is void since Redis is required anyway". It did
not weigh enqueueing a job **atomically with the domain write**, which removes
the commit-to-enqueue gap instead of repairing it afterwards.

**Spike SHO-617** measured three runners against one requirement list
(branch `spike/operations-runner`, `spikes/operations-runner/SCENARIOS.md`,
`*/FINDINGS.md`; every suite re-run by the proposer).
- **BullMQ 6.2 (12/12).** R1, R4, R5, R7 and R9 hold only through ~250 lines
  of Postgres-side compensation. It re-delivers a killed job by default, and
  open-source BullMQ has no per-group concurrency.
- **pg-boss 12.31 (13/13).**
  - R1 is native: `send(..., { db: fromDrizzle(tx) })` joins the caller's
    Drizzle transaction.
  - Per-key serialisation is index-enforced (`singleton`); `groupConcurrency`
    is not strict (13 of 21 pairs overlapped).
  - `retryLimit: 0` gives no re-run.
  - R4 needed a ~45-line deadline guard. R5 (durable wait) needs ~220 lines.
- **DBOS 4.27 (16/16).** It has atomic enqueue, durable wait and
  per-partition concurrency, but:
  - crash recovery cannot be disabled (`maxRecoveryAttempts: 0` falls back to
    the default, `dbos-executor.js:271`);
  - `executorID` is a deployment invariant;
  - it owns 14 tables and persists step outputs.

**No consumer waits inside a job.** An assistant pause stores its continuation,
and the answer starts a new turn (ADR-0038).

**Current worker jobs** (`apps/worker/src/jobs.ts`, `policy.ts`):
- the `maintenance` queue: `cleanupExpiredIdempotencyKeys`,
  `sweepAbandonedUploads`, `backfillCatalogRenditions`,
  `reconcileAssistantTurns`;
- a `pdf` queue whose processor has no producer (PDFs run through outbox
  delivery);
- the `assistant` queue.

**Scale and practice.**
- Showzy's volume is far below a Postgres queue's limits.
- Current frameworks default to database queues (Rails 8 Solid Queue, Oban,
  River, GoodJob).
- Where a broker is used, the database stays the source of truth and an outbox
  feeds the broker.

## Decision

### 1. Jobs are a declared protocol of the action pipeline

- **Declaring.**
  - An action contract declares `enqueues: string[]`, job **names** only,
    exactly like `emits`. Contract files never import the runner.
  - A job definition (name, payload schema, queue class, options) lives in the
    owning module's `jobs/` folder. It is registered in the composition root as
    events are; the contract check verifies that every declared name has a
    definition.
- **Enqueueing.**
  - `ctx.enqueue(job, payload)` buffers like `ctx.emit`.
  - Core writes the buffer inside the execution transaction, next to the
    outbox write (`execute-action.ts` step 9), through the **job port** — a
    protocol hook filled by the app composition as the idempotency, audit and
    confirmation hooks are.
  - It is refused in `risk: "read"` actions and inside `ctx.call`.
- **Replays and redeliveries.** Enqueueing is a transaction effect.
  - An idempotency replay (`core.md` §5) returns the stored result and enqueues
    nothing, as it emits nothing.
  - An event delivery that enqueues commits the job with its `processed` mark,
    so only an uncommitted delivery is re-run.
  - Job ids derive from the action's idempotency key and the job name, so a
    duplicate send is a no-op.
- **Payload and execution.**
  - A payload is identity only. Core records the enqueuing context's
    `companyId`, `requestId` and `correlationId` beside it; they are never
    taken from input.
  - A job is bound to an internal **`system` action**
    (`defineJobHandler(job, action)`, the same shape as `defineEventHandler`).
    The worker runs it through `executeAction` with a `system` principal scoped
    to the recorded company, `channel: "system"`, and the recorded
    request/correlation ids. Audit follows the action's metadata.
  - A job that must act as a person derives that caller from the owning row,
    as `assistant-turn-for-job.ts` does today (ADR-0039).

### 2. The runner is a plugin chosen per queue class

**`durable`** — user-visible or must-not-be-lost work: assistant turns; later
imports and signing follow-ups.
- Runs on the **pg-boss adapter**. Its settings, all enforced by the adapter:
  - `retryLimit` set on every queue, `0` unless the job definition declares
    retries (pg-boss defaults to 2);
  - `expireInSeconds` = the job's declared deadline plus its drain margin;
  - supervise interval ≤ 60 s;
  - `notify: false` on queues with delayed jobs.
- `singleton` + `singletonKey` is **opt-in per job**, for work with no domain
  uniqueness guard. The assistant turn does not use it: its partial unique
  index already allows one active turn per conversation, and a singleton would
  block **Продовжити** behind a crashed job until expiry.
- The deadline guard found in the spike (claim the row only while it is still
  `queued`; interrupt at the deadline) is part of the adapter, not of each job.
- **Delayed start and declared retries** are port features, not adapter
  accidents.
  - `ctx.enqueue(job, payload, { startAfter })` defers a job to an instant
    computed by the domain.
  - A job definition may declare `retries: { limit, backoff }` (exponential,
    with a cap). Retries are allowed only for jobs whose external effect is
    idempotent (a provider idempotency key derived from the job id).

**`scheduled`** — maintenance on pg-boss `schedule()`, starting now.
- `cleanupExpiredIdempotencyKeys`, `sweepAbandonedUploads`,
  `backfillCatalogRenditions` and `reconcileAssistantTurns` keep their
  intervals and stay safe to miss and safe to re-run.
- Schedules are upserted idempotently on worker boot, as BullMQ Job Schedulers
  are today.

**`bulk`** — high-volume, recoverable work (push fan-out, renditions at scale).
- **Deferred, not specified.** No adapter, table or delivery guarantee is
  decided here. When a criterion under "Revisit when" fires, a new ADR
  specifies a relay that keeps the `enqueue(tx)` contract (job row in
  Postgres, relay to a broker).

**Removed.**
- The `pdf` BullMQ queue is deleted: it has no producer, and PDF rendering stays
  an outbox delivery.
- BullMQ and the queue Redis are removed once the assistant and maintenance
  queues have moved.
- The shared Redis stays for sessions, rate limits, confirmation challenges,
  presence and stream slots.

### 3. Ownership and raw SQL

- **`@showzy/jobs`** (server-only platform package) holds:
  - the job definition type, the port interface, the pg-boss adapter, the
    worker job host API and the scheduler;
  - the **runner conformance suite**: runner properties R1 (atomic enqueue),
    R3 (identity payload), R4 (deadline, no re-run), R7 (per-key serial when
    opted in), R8 (drain), R9 (failure visibility, explicit retry), plus
    delayed start (`startAfter` honoured within the adapter's latency bound)
    and declared retries (limit and backoff respected, none undeclared).
  - Every adapter must pass the suite. R2 and R6 are domain properties, tested
    by consumers.
  - The package owns no tables (ADR-0031's module-kit rule is not stretched).
- **The `pgboss` schema is a foundation protocol schema**, like `domain_events`
  (`db.md` §7).
  - It is created by a drizzle-kit custom migration generated from pg-boss's
    `getConstructionPlans()` for the pinned version; upgrades regenerate from
    `getMigrationPlans()`.
  - It is not modelled in Drizzle. The drift check excludes the `pgboss` schema
    by name, and a CI test asserts that the installed schema version equals
    the pinned library's.
  - The library's migrator never runs (`migrate: false`, `createSchema: false`).
- **Approved raw SQL:**
  - that migration;
  - the statements pg-boss itself issues through the adapter at runtime
    (send, fetch, complete, supervise, queue creation).
  Application code never reads or writes `pgboss` tables. Queues are created
  idempotently at worker boot through the library API.

### 4. Patterns for long, batched and external work

These are the sanctioned shapes. A feature that cannot fit one of them is a
revisit, not a new ad-hoc mechanism.

- **Chained pages.** Long work (a bank statement backfill, a reference-data
  sync) is one job per page or chunk. The job commits the page's rows, its
  cursor on the owning row, and `ctx.enqueue` of the next page in **one**
  transaction. No job runs for minutes, and a crash resumes from the last
  committed cursor.
- **Fan-out / fan-in.** A batch (batch signing follow-ups, batch PDF
  generation) is a parent row owned by the module, with one job per item.
  - Each item job updates the parent's counters in its own transaction.
  - The job that completes the last item moves the parent to its final state.
  - Nothing waits: there is no durable wait and no polling parent job.
- **Provider limits.** A per-credential rate or quota is domain state on the
  credential row (for example `next_allowed_at`). A job that hits it commits
  the new instant and re-enqueues itself with `startAfter`. The runner holds
  no provider knowledge.
- **Inbound webhooks.** The handler verifies the request, stores the raw event
  with its provider id under a unique constraint, and enqueues processing in
  the same transaction. A duplicate delivery is a no-op on the constraint.
- **Write granularity.** Bulk work writes, bumps revisions (ADR-0042) and
  notifies **per chunk transaction**, never per row. This keeps job churn,
  aggregate-root lock hold time and NOTIFY volume proportional to chunks.

### 5. The domain-event outbox is unchanged

ADR-0012 and `core.md` §6 stand. Events are effects between modules; jobs are
work.

## Alternatives considered

- **Keep BullMQ.** Rejected: the correctness-bearing state machine is already in
  Postgres; BullMQ adds a second store and ~250 lines to neutralise it
  (SHO-617).
- **DBOS Transact.** Rejected for now: recovery that cannot be disabled, an
  executor-identity deploy invariant, a library-owned schema and persisted
  step outputs, all for durable waits no consumer needs.
- **Graphile Worker.** Rejected in the SHO-617 desk comparison: raw
  `add_job()` to join a transaction, UUID queue names discouraged, a crashed
  queue lock held for four hours.
- **Durable-execution servers (Temporal, Restate, Inngest, Trigger.dev).**
  Rejected: a stateful service to operate, determinism and versioning
  discipline, data in the engine's history, and state outside our Postgres.
- **A generic `operations` table.** Rejected: it would duplicate each module's
  lifecycle row or cross ADR-0014 ownership. What is generic is the job
  protocol.
- **A global backend switch.** Rejected: only the Postgres write is atomic with
  the domain transaction. The contract is fixed at `enqueue(tx)`, and the
  transport varies per queue class.
- **Enqueue through the outbox.** Rejected: a second hop and a delivery
  principal between the request and the work, with retry semantics built for
  fast effects (ADR-0039).

## Consequences

**ADR-0007** is superseded for background jobs.

**ADR-0039** is amended:
- `assistant.acceptTurn` enqueues the turn job through `ctx.enqueue` in its
  transaction.
- The sentence that a `replayed` accept "enqueues at once" no longer applies:
  a replay enqueues nothing, and the committed accept already holds its job.
- The queue Redis and its AOF policy are removed.
- The reconciler loses its re-enqueue branch (a committed turn always has its
  job). It keeps:
  - the stale-running interrupt;
  - the queued-abandoned interrupt, which still exists when a turn is refused
    at start and its job completes;
  - the one-time hold release for turns that never started.
  Its "the queue no longer holds a job" check reads job state through the
  adapter.

**Core** (a declared core change, approved by this ADR):
- `enqueues` metadata, `ctx.enqueue`, the job port hook;
- a contract-check rule;
- a `core.md` §6 subsection on jobs next to the outbox.

**Dependencies.**
- Added: `pg-boss` (MIT; one maintainer, fast cadence, mitigated by the port
  and the conformance suite).
- Removed: `bullmq` from `apps/api` and `apps/worker`.
- Accepting this ADR approves both.

**Runtime.**
- The API runs a send-only PgBoss (no workers, no supervise) with a small
  dedicated pool.
- The worker's `stop()` timeout is at least `ASSISTANT_DRAIN_TIMEOUT_MS`
  (`policy.ts:166`); otherwise pg-boss fails in-flight turns on stop.
- Completed and failed jobs are deleted after a declared retention, which
  replaces BullMQ's `removeOnComplete` and `removeOnFail`.
- Testcontainers migrations include the `pgboss` schema.

**Notify.** pg-boss LISTEN/NOTIFY shares Postgres's commit-time notify queue
with the `domain_events` trigger and ADR-0042's `live` trigger. The combined
rate is a revisit criterion below.

**Operations, recorded, not built** (`db.md` §6): retention and autovacuum for
the job tables. The queue Redis lines are removed. `apps/worker/AGENTS.md` and
`docs/operations/assistant-kit-path.md` follow.

**Harder.**
- Job throughput is bounded by the primary Postgres, and job churn creates
  dead tuples.
- An opted-in singleton job that crashes blocks its key until expiry.

**Easier.**
- No commit-to-enqueue gap, one backup, and job state readable in the same
  database as domain rows.
- A different runner is an adapter plus a green conformance suite, with no
  change to domain code or contracts.

## Revisit when

- **A `bulk` class is needed** (new ADR for the relay): a queue class sustains
  thousands of jobs per second, job-table bloat outpaces autovacuum, or
  business p99 rises with job peaks.
- **Commit latency** is attributable to NOTIFY load (jobs, outbox and `live`
  together).
- **Durable waits become central** (multi-day approvals, mid-step resume), **or
  sagas multiply.** One or two hand-written multi-step flows with compensation
  are fine; acquiring → fiscalisation → document is the first of these. A
  third, or any flow the §4 patterns cannot express, means re-evaluating DBOS
  or a durable-execution server.
- **A service outside this monorepo** must consume the same work: a broker
  behind a relay adapter.
- **Event streaming with replay** is needed: relay the domain-event outbox to a
  log (Kafka). That is a different contract from jobs.
- **pg-boss** stops being maintained, or a release fails the conformance
  suite: swap the adapter.
