# ADR-0041: Background jobs are enqueued in the transaction and run from Postgres behind a runner port

- **Status**: Proposed
- **Date**: 2026-09-13
- **Deciders**: Ivan Kurbatov (human) (+ proposing agent)

## Context

- **One unit of work lives in two stores.** ADR-0007 put every background job
  on BullMQ. ADR-0039 gave the assistant turn a Postgres row (`assistant_turns`)
  and a BullMQ job on a second, persistent Redis. The job is enqueued after the
  accept commits (`apps/api/src/http/assistant-kit-http.ts:165`), so:
  - a crash or Redis error in between leaves a committed turn with no job,
    which SHO-570's reconciler repairs on an interval;
  - Redis status lags the row;
  - the queue Redis holds unrebuildable data, which forces AOF and no eviction
    (`db.md` §6).
- **ADR-0007's premise was incomplete.** It rejected pg-boss because "its only
  advantage (no Redis dependency) is void since Redis is required anyway". It
  never weighed enqueueing **atomically with the domain write**.
- **Spike SHO-617** (branch `spike/operations-runner`, `SCENARIOS.md`,
  `*/FINDINGS.md`, suites re-run by the proposer):
  - **BullMQ 6.2 (12/12):** correctness holds only through about 250 lines of
    Postgres-side compensation; a killed job is re-delivered by default; there
    is no open-source group concurrency.
  - **pg-boss 12.31 (13/13):** atomic enqueue through `fromDrizzle(tx)`,
    index-enforced per-key serialisation, no re-run with `retryLimit: 0`.
    Durable waits are weak.
  - **DBOS 4.27 (16/16):** atomic enqueue, durable waits and partitions, but
    crash recovery cannot be disabled, `executorID` becomes a deploy invariant,
    it owns 14 tables and it persists step outputs.
- **No consumer waits inside a job.** A pause stores its continuation, and the
  answer starts a new turn (ADR-0038).
- **Current worker jobs** (`apps/worker/src/jobs.ts`, `policy.ts`):
  - `maintenance`: idempotency-key cleanup, the upload sweep, the rendition
    backfill, the assistant reconciler;
  - `pdf`: a queue with no producer;
  - `assistant`.
- **Scale and practice.** Showzy's volume is far below a Postgres queue's
  limits. Current frameworks default to database queues (Rails 8 Solid Queue,
  Oban, River, GoodJob). Where a broker is used, the database stays the source
  of truth.
- **Three review rounds** (PR #461) showed that queue mechanics written as prose
  keep producing defects no test can catch. This ADR therefore decides the
  architecture and its **invariants**. The mechanics live in
  `docs/specs/jobs.md`, written with the first implementing feature and proven
  by the conformance suite.

## Decision

1. **Jobs are a declared protocol of the action pipeline.**
   - An action declares `enqueues` (job names, like `emits`) and calls
     `ctx.enqueue`. Core writes the job inside the execution transaction,
     beside the outbox, through a **job port** filled by the app composition.
   - A job runs as an internal `system` action bound to its definition, through
     `executeAction`.
2. **The runner is a plugin chosen per queue class.**
   - **`durable`** (user-visible or must-not-be-lost work) runs on a **pg-boss
     adapter**, straight from Postgres.
   - **`scheduled`** maintenance moves to pg-boss schedules now.
   - **`bulk`** (high-volume, recoverable) is **deferred**: a later ADR
     specifies a relay that keeps the `enqueue(tx)` contract.
   - The `pdf` queue is deleted. BullMQ and the queue Redis are removed once
     the assistant and maintenance queues have moved.
   - The shared Redis keeps only losable data: sessions, rate limits,
     confirmation challenges, presence, stream slots and ADR-0042's ephemeral
     frames.
3. **`@showzy/jobs`** (server-only platform package) holds:
   - the job definition type, the port, the pg-boss adapter, the worker host and
     the scheduler;
   - the **conformance suite** every adapter must pass.
   It owns no tables. The `pgboss` schema is a foundation protocol schema,
   created by a drizzle-kit custom migration generated from the pinned
   library. That migration, and the statements pg-boss issues from inside
   `@showzy/jobs`, are the approved raw SQL (J15).
4. **The domain-event outbox is unchanged** (ADR-0012). Events are effects
   between modules; jobs are work.

### Invariants

Each invariant names the test that proves it. A violation is a defect, not a
spec detail.

**Enqueue and identity.**
- **J1 Atomic enqueue.** A job exists if and only if its enqueuing transaction
  committed. *Conformance: rollback leaves no job; commit runs it.*
- **J2 Identity is server-derived and collision-free.** A job id is derived
  from:
  - the enqueuing module, job name and verified scope;
  - an **origin**: an idempotency tuple, a **core-minted execution id** (never
    a client-supplied request id), an event delivery, or a parent job;
  - the job definition's **discriminator**.
  Two sends with one id in one transaction throw. *Core: fan-out without a
  discriminator throws; two tenants and two executions never collide.*
- **J3 Replays and redeliveries do not enqueue twice.** An idempotency replay
  enqueues nothing, and a delivery commits its jobs with its processed mark.
  *Core tests.*
- **J4 Only the root action of a transaction enqueues, and only its own
  module's jobs.** Enqueueing is refused in reads and in `ctx.call` and
  `ctx.callAtomic` callees. *Contract check + ESLint for ownership; core
  runtime test for reads and callees.*

**Scope and execution.**
- **J5 Scope never comes from input.** The recorded company, actor, channel and
  correlation come from the verified enqueuing context.
  - A job handler loads and claims every owning row filtered by the recorded
    company, and fails closed on a miss.
  - A scheduled job that fans out tenant work takes each company from a row its
    module owns, read in the same transaction.
  - The worker's system context verifies that the company exists and is active,
    and fails closed.
  - **The only exception** is a module's declared J9 sweep action. It may run
    for an existing inactive company, only on that module's own overdue rows,
    and only to mark them failed. The exception is a property of that declared
    action, not a flag a caller can pass.
  *Inherited cross-tenant suite: a payload naming a foreign row fails closed;
  for an inactive company, every action except the declared sweep fails closed,
  and the sweep fails closed on another module's rows or on any other write.*
- **J6 Payloads are identity only, and job rows hold no free text.**
  - Payload schemas contain only ids and discriminators.
  - The runner's error and output columns hold a typed code or null, except
    the library's fixed status strings, which the spec lists.
  - Secrets never enter payloads, job rows or logs; provider credentials live
    outside this protocol.
  *Contract check on payload schemas; conformance on stored columns.*

**Retries and claims.**
- **J7 No undeclared re-run.** A job runs at most `1 + declared retries` times.
  Expiry counts as a failed attempt. The adapter proves at boot that each
  queue's stored settings equal its definition, because pg-boss ignores changed
  options on an existing queue. *Conformance, including a changed-definition
  boot test.*
- **J8 Claims are domain code and fenced by attempt.** A job action claims its
  row for a specific runner attempt. A stale attempt can neither claim nor
  record, and a retry of a thrown attempt is not refused as "already running".
  *Domain tests per consumer, modelled in the spec.*
- **J9 Exhausted work is visible.** When retries are exhausted, whether the
  last attempt threw or expired, a declared **on-exhausted** `system` action
  marks the owning row failed.
  - If that action fails, or its company is inactive (J5), the **owning
    module's** scheduled sweep catches the row.
    - The sweep fans out one tenant-scoped `system` action per company, taken
      from its own overdue rows (J5).
    - That action may only move `running` or `queued` rows to failed with a
      typed reason, and is audited with the row's company.
    - It is the one transition allowed for an inactive company.
  - No owning row stays `running` or `queued` longer than its deadline plus
    one sweep interval.
  *Conformance: thrown and expired last attempts; a failing on-exhausted
  action; an inactive company; a cross-tenant case in which the sweep's
  tenant action cannot touch another company's row.*

**External effects.**
- **J10 Provider calls never run inside a transaction.** A claim commits, the
  call runs, and a separate transaction records the result. *Integration test:
  no open transaction exists on the job's connection during the stub provider
  call.*
- **J11 One opaque provider key per logical effect.**
  - The key and our provider reference are generated at the item's **first**
    claim and committed **before** the first call.
  - Every later attempt, resume or sweep reuses them.
  - The key is random: it is not derived from the job id, company or actor.
  *Integration test: attempt, retry, resume and sweep send the same key; the
  key row is committed before the stub provider receives the request.*
- **J12 An unknown outcome is a state, not a retry.**
  - An item holds a committed provider key but no recorded result. On any
    re-claim, whatever ended the previous attempt (a crash, a throw, a timeout,
    an expiry), it moves to `outcome_unknown` and does **not** call.
  - Only a reconciliation lookup against the provider, or a person, clears it.
  - The single exception is an integration that declares
    `dedupesConcurrentCalls` and proves it with a test against the provider's
    sandbox. Money-moving and fiscal integrations cannot declare it.
  *Integration test per provider: a timed-out attempt followed by a re-claim
  makes no second call. For a declared `dedupesConcurrentCalls` integration, a
  retry yields exactly one provider-side effect.*

**Batches and inputs.**
- **J13 Fan-in cannot stall or double-count.** Item state lives in item rows.
  Progress is derived, never incremented. The parent is locked before its
  finalise is decided, so concurrent last items cannot both miss it. Item work
  runs outside any transaction that holds the parent lock. *Domain tests: two
  last items committing together finalise once.*
- **J14 Webhooks are verified before the pipeline.** Signature over the raw
  body, timestamp window, provider account and company resolution happen at the
  transport, **before** `executeAction`. An unverified request can never
  reserve an idempotency key. *Transport test: a forged request leaves no key
  row.*

**Boundaries and records.**
- **J15 The runner's SQL stays inside the runner.**
  - `pg-boss` is imported only in `@showzy/jobs`, and application code never
    reads or writes `pgboss` tables.
  - The library's migrator never runs; the schema comes only from the
    drizzle-kit migration.
  *ESLint; a boot test that the installed schema version equals the pinned
  library's, with the migrator disabled.*
- **J16 Business records never live only in job rows.** Fiscal receipts, bank
  transactions, payment results and raw webhook events live in module rows
  under their own retention. Deleting job rows loses no business record. *Per
  integration: the recorded result survives job-row retention.*

## Alternatives considered

- **Keep BullMQ.** Rejected: the state machine is already in Postgres; BullMQ
  adds a second store plus the code to neutralise it (SHO-617).
- **DBOS Transact.** Rejected for now: recovery that cannot be disabled, an
  executor-identity deploy invariant, a library-owned schema and persisted step
  outputs, all for durable waits no consumer needs.
- **Graphile Worker.** Rejected: raw `add_job()` to join a transaction, UUID
  queue names discouraged, a crashed queue lock held for four hours (SHO-617
  desk comparison).
- **Durable-execution servers (Temporal, Restate, Inngest, Trigger.dev).**
  Rejected: a stateful service to operate, determinism discipline, data in the
  engine's history, and state outside our Postgres.
- **A generic `operations` table.** Rejected: it would duplicate lifecycle rows
  or cross ADR-0014. The job protocol is what is generic.
- **A global backend switch.** Rejected: only the Postgres write is atomic with
  the domain transaction. The contract is `enqueue(tx)`, and the transport
  varies per class.
- **Enqueue through the outbox.** Rejected: a second hop and a delivery
  principal between request and work (ADR-0039).
- **Mechanics in this ADR.** Rejected after three review rounds: SQL, pg-boss
  settings and step-by-step patterns belong in a spec that tests can prove
  wrong.

## Consequences

**Superseded and amended.**
- **ADR-0007** is superseded for background jobs.
- **ADR-0039** is amended:
  - the turn job is enqueued through `ctx.enqueue` in `assistant.acceptTurn`;
  - a `replayed` accept enqueues nothing;
  - the queue Redis and its AOF policy are removed;
  - the reconciler loses its re-enqueue branch, but keeps the stale-running
    and queued-abandoned interrupts and the one-time hold release.

**Core** (approved by this ADR):
- `enqueues`, `ctx.enqueue`, the job port;
- execution ids and job identity;
- recorded scope;
- contract checks and a job case in the inherited cross-tenant suite;
- a `core.md` §6 subsection.

**Spec.** `docs/specs/jobs.md` is written with the first implementing feature.
It holds:
- claim and finalise shapes;
- the chained-page, fan-out, provider-limit and webhook patterns;
- pg-boss settings (polling, supervise, expiry, retention);
- queue provisioning, which must exist before the API's first send.

It changes via ADR or a same-PR patch when a test proves it wrong.

**Dependencies.** `pg-boss` is added (MIT; one maintainer, mitigated by the port
and the suite), and `bullmq` is removed. Accepting this ADR approves both.

**Operations, recorded, not built** (`db.md` §6):
- job retention and autovacuum;
- `pgboss` schema grants;
- the worker stop grace ≥ the assistant drain bound;
- the queue Redis lines are removed.

**Easier.** No commit-to-enqueue gap, one backup, and job state beside domain
rows. A new runner is an adapter plus a green conformance suite.

**Harder.** Throughput is bounded by the primary Postgres, and job churn creates
dead tuples. Invariants J8–J13 put real design work into each integration; they
are not free.

## Revisit when

- **A `bulk` class is needed:** thousands of jobs per second, job-table bloat
  outpacing autovacuum, or business p99 rising with job peaks.
- **Polling latency** becomes visible for a queue class.
- **Durable waits become central, or sagas multiply:** a third hand-written
  multi-step flow with compensation, or one the spec's patterns cannot express.
  Re-evaluate DBOS or a durable-execution server.
- **A service outside this monorepo** must consume the same work: a broker
  behind a relay adapter.
- **Event streaming with replay** is needed: relay the outbox to a log. That is
  a different contract.
- **pg-boss** is unmaintained, or fails the conformance suite: swap the adapter.
