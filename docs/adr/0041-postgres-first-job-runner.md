# ADR-0041: Background jobs are enqueued in the transaction and run from Postgres behind a runner port

- **Status**: Proposed
- **Date**: 2026-09-13
- **Deciders**: Ivan Kurbatov (human) (+ proposing agent)

## Context

- **Two stores for one job.** ADR-0007 put every background job on BullMQ.
  ADR-0039 then gave the assistant turn a Postgres row (`assistant_turns`) and a
  BullMQ job on a second, persistent Redis. Accepting a turn is therefore two
  writes to two stores, and every defect in the async-turn slice traces back to
  that split:
  - a committed turn with no job, which needed the SHO-570 reconciler;
  - a job whose row was rolled back;
  - status that lags between the row and Redis;
  - a queue Redis that must never lose data, and so needs AOF and no eviction.
- **ADR-0007's premise was incomplete.** It rejected pg-boss because "its only
  advantage (no Redis dependency) is void since Redis is required anyway". It
  did not weigh the advantage that decides correctness: enqueueing a job
  **atomically with the domain write**.
- **Spike SHO-617** measured three runners against one requirement list
  (`spike/operations-runner`, `spikes/operations-runner/*/FINDINGS.md`; every
  suite was re-run by the proposer). R1–R10 are defined in
  `spikes/operations-runner/SCENARIOS.md`.
  - **BullMQ 6.2** (12/12 tests): R1, R4, R5, R7 and R9 hold only through about
    250 lines of our own Postgres-side code. It re-delivers a killed job by
    default, and open-source BullMQ has no per-group concurrency.
  - **pg-boss 12.31** (13/13 tests):
    - R1 is native: `send(..., { db: fromDrizzle(tx) })` joins our Drizzle
      transaction.
    - Per-subject serialization is index-enforced (the `singleton` policy);
      `groupConcurrency` is not strict and must not be used.
    - Setting `retryLimit: 0` means no re-run.
    - Weak only on durable waits (R5).
  - **DBOS 4.27** (16/16 tests): atomic enqueue, durable wait, per-partition
    concurrency. Against that:
    - its crash recovery cannot be disabled, which is unsafe for a
      non-deterministic model call;
    - `executorID` becomes a deployment invariant;
    - it owns 14 tables and persists step outputs.
- **Durable waits are not needed here.** The first consumer does not wait
  inside a job: a pause stores its continuation, and the answer starts a new
  turn (ADR-0038).
- **Scale.** Showzy's job volume (small-business tenants, a few assistant turns
  and PDFs per minute) is orders of magnitude below what a Postgres queue
  handles.
- **Industry practice.** Frameworks now default to database-backed queues
  (Rails 8 Solid Queue, Oban, River, GoodJob). Where a broker is used for
  throughput, the database stays the source of truth and a transactional
  outbox feeds the broker.

## Decision

**Jobs are a declared protocol of the action pipeline.**
- An action declares `enqueues: [...]`, as it declares `emits`.
- The handler calls `ctx.enqueue(job, payload)`, and core writes the job inside
  the execution transaction through an injected **job port**, beside the
  outbox write.
- A job payload is identity only; state is read from the owning module's rows.

**The runner is a plugin chosen per queue class, not globally.**
- **`durable`** (user-visible or must-not-be-lost work: assistant turns, later
  document generation, imports, signing follow-ups):
  - the **pg-boss adapter** runs these straight from Postgres;
  - `retryLimit: 0` unless a job declares retries;
  - per-subject serialization via `singleton` + `singletonKey`;
  - `notify: false` on delayed queues.
- **`bulk`** (high-volume, recoverable work such as push fan-out or renditions
  at scale): a **Redis relay adapter** is specified, not built.
  - The job is still written to Postgres in the transaction, and a relay moves
    it to BullMQ.
  - Built only when a queue class meets a criterion under "Revisit when".
- **Scheduled maintenance** moves to pg-boss `schedule()` now:
  `cleanupExpiredIdempotencyKeys`, `sweepAbandonedUploads`,
  `backfillCatalogRenditions`, and the assistant stale-turn sweep. Each job
  stays safe to miss and safe to re-run.
- **BullMQ and the queue Redis are removed** once the assistant queue and
  maintenance have moved. The shared Redis stays for sessions, rate limits,
  confirmation challenges and the event channel.

**Ownership.**
- **`@showzy/jobs`** (server-only platform package, registered like
  `@showzy/module-kit` in ADR-0031) holds:
  - the job contract type, the port, the pg-boss adapter and the worker job
    host API;
  - the scheduler;
  - a **runner conformance suite**, which every adapter must pass: the SHO-617
    requirements R1–R4 and R6–R9 as tests.
- **Operation state stays with the owning module** (ADR-0014).
  `assistant_turns` remains the assistant's table; there is no generic
  operations table.
- **pg-boss's schema** is created by a drizzle-kit custom migration generated
  from `getConstructionPlans()` for the pinned version.
  - This ADR approves that SQL as a raw-SQL primitive (constitution); the
    migration file cites this ADR.
  - Upgrades regenerate it from `getMigrationPlans()`.
  - The library never runs its own migrator (`migrate: false`).

**The domain-event outbox is unchanged** (ADR-0012, `core.md` §6). Events are
effects between modules; jobs are work.

## Alternatives considered

- **Keep BullMQ (status quo).** Rejected. The correctness-bearing state machine
  already lives in Postgres. BullMQ adds a second store that lags and disagrees,
  plus ~250 lines to neutralise it (SHO-617).
- **DBOS Transact.** Rejected for now:
  - automatic crash recovery cannot be disabled and must be fought with an
    attempt guard;
  - executor identity becomes a deploy invariant;
  - it owns a library schema and persists step outputs.
  Its advantage, durable waits, is not needed by any consumer. Revisit under
  "Revisit when".
- **Graphile Worker.** Rejected in the SHO-617 desk comparison:
  - enqueueing in our transaction needs raw `graphile_worker.add_job()`;
  - its docs advise against UUID queue names;
  - a crashed worker holds its queue lock for four hours.
- **Durable-execution servers (Temporal, Restate, Inngest, Trigger.dev).**
  Rejected:
  - a stateful service to run, back up and upgrade;
  - determinism and versioning discipline;
  - business and personal data in the engine's history;
  - operation state outside our Postgres.
- **A generic `operations` table owned by a platform module.** Rejected. It
  would duplicate each domain's lifecycle row (placeholder messages, budget
  holds) or force cross-module ownership (ADR-0014). The generic part is the
  job protocol, not the domain state.
- **A global backend switch (`queue: redis | postgres`).** Rejected: the two
  cannot promise the same contract. Only the Postgres write is atomic with the
  domain transaction, so the contract is fixed at `enqueue(tx)` and the
  transport varies per queue class.
- **Enqueue through the domain-event outbox** (an event whose subscriber
  enqueues). Rejected for jobs:
  - a second hop and a system principal between the request and the work;
  - retry semantics built for fast idempotent effects (ADR-0039).

## Consequences

**Superseded and amended decisions.**
- **ADR-0007** is superseded for background jobs: BullMQ is no longer the
  default runner. Redis stays for sessions, rate limits and the event channel.
- **ADR-0039** is amended:
  - the turn job is enqueued by `assistant.acceptTurn` in its transaction;
  - the queue Redis instance and its AOF policy are removed;
  - the SHO-570 reconciler keeps only the stale-running sweep, because a
    queued turn without a job can no longer exist.
- **The worker gains a scheduler** for maintenance jobs (`schedule()`).

**Core (a declared core change, not a module workaround).**
- New contract metadata: `enqueues`.
- New context method: `ctx.enqueue`.
- New protocol hook: the job port, filled by the app composition as the other
  hooks are.
- The contract check verifies that declared jobs have a definition, as it
  does for `emits`.
- `core.md` gains the job protocol section.

**Dependencies.**
- Added: `pg-boss` (MIT; one maintainer, fast release cadence).
- Removed: `bullmq` from `apps/api` and `apps/worker`, after migration.
- Human approval of the dependency change is part of accepting this ADR.

**Operations.**
- `db.md` §6 records the production requirements for the job tables:
  completed-job retention/archival and autovacuum settings.
- The queue Redis requirement lines are removed.
- `apps/worker/AGENTS.md` and `docs/operations/assistant-kit-path.md` follow.

**Harder.**
- Job throughput is bounded by the primary Postgres.
- Queue churn creates dead tuples that vacuum must keep up with.
- A crashed `singleton` job blocks its subject until `expireInSeconds`.

**Easier.**
- No dual-write bugs, one backup, and job state readable in the same snapshot
  as domain rows.
- Replacing the runner is an adapter plus a green conformance suite. Domain
  code and contracts do not change.

## Revisit when

- **The Redis relay adapter, for a queue class:**
  - its jobs sustain thousands per second;
  - job-table bloat outpaces autovacuum;
  - p99 of business requests rises with job peaks.
- **Durable waits** become central, such as multi-step approvals lasting days,
  or workflows that must resume mid-step after a crash: re-evaluate DBOS or a
  durable-execution server.
- **A second service** outside this monorepo must consume the same work: a
  broker (RabbitMQ) becomes the shared bus behind the relay adapter.
- **Event streaming** with replay across consumers is needed: relay the
  domain-event outbox to Kafka. That is a different contract from jobs.
- **pg-boss** stops being maintained, or a release breaks the conformance
  suite: swap the adapter.
