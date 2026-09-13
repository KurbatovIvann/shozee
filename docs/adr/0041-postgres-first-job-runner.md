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

**Declaring.**
- An action contract declares `enqueues: string[]`, job **names** only, exactly
  like `emits`. Contract files never import the runner.
- A job definition lives in the **enqueuing module's** `jobs/` folder:
  - name, payload schema, queue class, deadline, retries;
  - the payload fields that identify one send (its **discriminator**).
- It is registered in the composition root as events are. The contract check
  verifies that every declared job has a definition **owned by the declaring
  module**, and ESLint forbids importing another module's `jobs/`. Work for
  another module goes through events (ADR-0015), never through its jobs.

**Enqueueing.**
- `ctx.enqueue(job, payload, { startAfter? })` buffers like `ctx.emit`.
- Core writes the buffer inside the execution transaction, next to the outbox
  write (`execute-action.ts` step 9), through the **job port**. The port is a
  protocol hook filled by the app composition, as the idempotency, audit and
  confirmation hooks are.
- It is refused in `risk: "read"` actions and in `ctx.call` and
  `ctx.callAtomic` callees; only the root action of a transaction enqueues.
- `startAfter` is computed from the database clock (a value the transaction
  reads from Postgres), never from the Node clock.

**Job identity.** A job id is UUIDv5 over:
- the enqueuing module, the job name, and the scope key (company id, or
  `global`);
- the **origin**:
  - an idempotent action: its full idempotency tuple (`core.md` §5:
    principal key, scope, action, key);
  - a non-idempotent action: its `requestId`;
  - an event delivery: consumer + event id;
  - a job action enqueuing a follow-up: the parent job id;
- the discriminator values (an item id, a page cursor).

Two sends with the same id in one transaction throw, so a fan-out that forgets
its discriminator fails in its first test instead of silently dropping items.

**Replays and redeliveries.** Enqueueing is a transaction effect.
- An idempotency replay returns the stored result and enqueues nothing, as it
  emits nothing.
- An event delivery commits its jobs with its `processed` mark.
- A duplicate id at the runner is a no-op.

**Execution.**
- A payload is identity only. Core records the enqueuing context's `companyId`,
  actor id, channel, `requestId` and `correlationId` beside it, never from
  input.
- A job is bound to an internal **`system` action**
  (`defineJobHandler(job, action)`, the same shape as `defineEventHandler`).
- The worker runs it through `executeAction` with:
  - a `system` principal scoped to the recorded company;
  - `channel: "system"`;
  - the recorded ids;
  - the enqueuing actor and channel in its log fields.
- Audit follows the action's metadata and correlates by `correlationId`.
- **The handler loads every owning row filtered by the recorded company and
  fails closed on a miss.** A payload id never reaches another tenant's row.
- A job that must act as a person derives that caller from such a row, as
  `assistant-turn-for-job.ts` does (ADR-0039).
- Scheduled jobs run with global system scope. Per-tenant work is fanned out
  as tenant-scoped jobs.
- The inherited cross-tenant suite gains a job case: a payload naming a foreign
  row must fail closed.

**Claims are domain code.**
- The runner cannot know module rows. A job action starts by claiming its row
  with a conditional update (`UPDATE … SET status = 'running', attempt =
  attempt + 1 WHERE id = $id AND company_id = $company AND <claimable>
  RETURNING …`).
- `<claimable>` admits `queued`, and admits `running` only when the job
  declares retries and the previous attempt's deadline has passed.
- A job without retries that finds its row already claimed does nothing. That
  claim, not the runner, is what makes "no re-run" hold.

### 2. The runner is a plugin chosen per queue class

**`durable`** — user-visible or must-not-be-lost work: assistant turns; later
imports and signing follow-ups.
- Runs on the **pg-boss adapter**, which enforces:
  - `retryLimit` set on every queue from the job definition, `0` by default
    (pg-boss itself defaults to 2);
  - `retryDelay`/`retryBackoff`/`retryDelayMax` from the declared backoff;
  - `expireInSeconds` = the declared deadline plus its drain margin, where an
    expired attempt counts as a failed attempt and consumes a retry;
  - supervise interval ≤ 60 s;
  - LISTEN/NOTIFY **off** (`useListenNotify: false`): jobs are fetched by
    polling at ≤ 1 s. This also removes the delayed-job wake-up gap the spike
    found.
- **Declared retries** are allowed only for work whose effects are idempotent:
  - its database effects, through the claim and a cursor;
  - its external effects, through a provider idempotency key derived from the
    job id (§4).
- **`singleton` + `singletonKey`** is **opt-in per job**, for work with no
  domain uniqueness guard. The assistant turn does not use it: its partial
  unique index already allows one active turn per conversation, and a
  singleton would block **Продовжити** behind a crashed job until expiry.
- **Failure output.** The adapter stores no error message, stack or return
  value in `pgboss` rows, only a typed error code. Messages go to logs under
  the redaction policy (`security-operations.md` §4). Completed jobs are kept
  7 days and failed jobs 30 days, as `db.md` §6 policy values.

**`scheduled`** — maintenance on pg-boss `schedule()`, starting now.
- `cleanupExpiredIdempotencyKeys`, `sweepAbandonedUploads`,
  `backfillCatalogRenditions` and `reconcileAssistantTurns` keep their
  intervals and stay safe to miss and safe to re-run.
- Schedules are upserted idempotently on worker boot, as BullMQ Job Schedulers
  are today.

**`bulk`** — high-volume, recoverable work (push fan-out, renditions at scale).
- **Deferred, not specified.** No adapter, table or delivery guarantee is
  decided here. When a criterion under "Revisit when" fires, a new ADR
  specifies a relay that keeps the `enqueue(tx)` contract (job row in Postgres,
  relay to a broker).

**Removed.**
- The `pdf` BullMQ queue is deleted: it has no producer, and PDF rendering stays
  an outbox delivery.
- BullMQ and the queue Redis are removed once the assistant and maintenance
  queues have moved.
- The shared Redis stays for sessions, rate limits, confirmation challenges,
  presence and stream slots, and — when built — ADR-0042's best-effort
  ephemeral frames. It holds nothing that cannot be lost.

### 3. Ownership and raw SQL

**`@showzy/jobs`** (server-only platform package).
- Holds:
  - the job definition type, the port interface, the pg-boss adapter, the
    worker job host API and the scheduler;
  - the **runner conformance suite**:
    - atomic enqueue (R1) and identity-only payload (R3);
    - no redelivery beyond the declared retries (R4);
    - per-key serial execution when opted in (R7);
    - drain (R8) and failure visibility with explicit retry (R9);
    - `startAfter` honoured within the polling bound;
    - declared retry limits and backoff respected, and no undeclared retry;
    - failure rows holding no message, stack or output;
    - duplicate ids being no-ops.
- Every adapter must pass the suite. Claims (R2) and snapshots (R6) are domain
  properties, tested by consumers.
- The package owns no tables (ADR-0031's module-kit rule is not stretched).
- ESLint allows importing `pg-boss` only inside `@showzy/jobs`.

**The `pgboss` schema is a foundation protocol schema,** like `domain_events`
(`db.md` §7).
- A drizzle-kit custom migration creates it from pg-boss's
  `getConstructionPlans()` for the pinned version. The migration file carries
  the approval comment citing this ADR. Upgrades regenerate it from
  `getMigrationPlans()`.
- It is not modelled in Drizzle. The drift check excludes the `pgboss` schema
  by name, and a CI test asserts that the installed schema version equals the
  pinned library's.
- The library's migrator never runs (`migrate: false`, `createSchema: false`).

**Approved raw SQL:**
- that migration;
- the statements pg-boss itself issues through the adapter at runtime (send,
  fetch, complete, supervise, queue creation).

Application code never reads or writes `pgboss` tables. Queues are created
idempotently at worker boot through the library API.

### 4. Patterns for long, batched and external work

These are the sanctioned shapes. A feature that cannot fit one of them is a
revisit, not a new ad-hoc mechanism.

**External calls: claim, commit, call, record.** A call to a provider
(Monobank, QES services, PRRO fiscalisation, push) never runs inside an
`executeAction` transaction, because it would hold row and revision locks for
the provider's latency.
1. A transaction claims the item and commits.
2. The job calls the provider with an idempotency key derived from the job id,
   the same key on every attempt.
3. A second transaction records the result.

A crash between 2 and 3 retries with the same key. A provider without
idempotency keys gets no retries: before any repeat, the job asks the provider
by our reference whether the call already happened.

**Chained pages.** Long work (a bank statement backfill, a reference-data sync)
is one job per page or chunk.
- A page job claims the owning row and fetches the page (an external call, as
  above).
- In **one** transaction it commits the page's rows, the new cursor and
  `ctx.enqueue` of the next page. The discriminator is the cursor.
- Page jobs declare retries: a crashed or expired attempt re-runs from the last
  committed cursor, and re-applying a page is idempotent on its natural keys.
- When the retries are exhausted, the job's failure handler marks the owning
  row `failed` with the cursor it stopped at. A person or a scheduled sweep may
  resume it explicitly.

**Fan-out / fan-in.** A batch (batch signing follow-ups, batch PDF generation)
is a parent row and **one item row per item**, both owned by the module, with
one job per item (discriminator: the item id).
- An item job claims its item row, does its work, and records the item's final
  state.
- In the same transaction it runs one conditional finalise: `UPDATE parent SET
  status = … WHERE id = $id AND status = 'running' AND NOT EXISTS (open
  items)`.
- Progress is counted from item rows, never incremented, so a retried item
  cannot double-count.
- A crashed item without retries is marked `failed` by the deadline sweep,
  which runs the same finalise.
- Nothing waits: there is no durable wait and no polling parent job.
- The parent is the ADR-0042 revision root: item transactions are short and
  bounded by worker concurrency, and hints coalesce.

**Provider limits.** A per-credential rate or quota is domain state on the
credential row (`next_allowed_at`).
- A job takes a slot with a conditional update (`… SET next_allowed_at =
  now() + interval WHERE credential_id = $id AND next_allowed_at <= now()
  RETURNING …`) before calling.
- A job that gets no slot re-enqueues itself with `startAfter` at the returned
  instant. Concurrent chains on one credential therefore never race to a 429.

**Inbound webhooks** (`security-operations.md` §4). The webhook action:
- verifies the signature over the raw body, and the provider timestamp within a
  replay window, before any system context exists;
- checks that the event belongs to a connected provider account;
- deduplicates through core idempotency with the provider delivery id as the
  key, so a duplicate replays and enqueues nothing;
- stores the raw event under a declared retention;
- enqueues processing in the same transaction.

**Write granularity.** A single job that writes many rows (a page of
transactions) commits them, bumps revisions (ADR-0042) and notifies **per chunk
transaction**, never per row.

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
- `enqueues` metadata, `ctx.enqueue` with `startAfter`, the job port hook;
- job identity derivation and duplicate-id detection;
- recording actor, channel and correlation beside the job;
- contract-check rules (a definition exists and is owned by the declaring
  module; no enqueue from reads or callees);
- a job case in the inherited cross-tenant suite;
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

**Notify.** pg-boss runs without LISTEN/NOTIFY, so jobs add no notify load. The
commit-time notify queue carries only the `domain_events` trigger and
ADR-0042's `live` trigger. Job pickup latency is the polling interval (≤ 1 s),
which is acceptable for work that takes seconds or more.

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
- **Polling at ≤ 1 s** becomes a visible latency for some queue class:
  enable pg-boss notify for that class and count it in ADR-0042's notify
  budget.
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
