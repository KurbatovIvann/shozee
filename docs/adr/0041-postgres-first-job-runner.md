# ADR-0041: Background jobs are enqueued in the transaction and run from Postgres behind a runner port

- **Status**: Accepted
- **Amended**: 2026-09-14 — a job orchestrates actions and declares its time
  limits and lifecycle (`expires` and `periodic` now, `recoverable` planned),
  every protected write is fenced, there is no "active" company, and external
  I/O includes storage (see Amendment below)
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
   - **A job orchestrates actions; it is not one.** Every read and write of
     domain state it makes goes through `executeAction`: a claim, then any
     external I/O outside every transaction (J10), then a separate action that
     records the result. A job with no external I/O may be a single `system`
     action. Each action keeps the principal its contract declares, so the
     assistant turn's business actions still run as its author and are checked
     like any staff request. *(Amended 2026-09-14: the earlier wording made
     every job one `system` action, which `core.md` §4 runs inside its
     transaction, so no job with external I/O could meet J10.)*
2. **The runner is a plugin chosen per queue class.**
   - **`durable`** (user-visible or must-not-be-lost work) runs on a **pg-boss
     adapter**, straight from Postgres. Workers pick jobs up by polling, not
     LISTEN/NOTIFY, so jobs add no load to Postgres's notify queue (ADR-0042).
   - **`scheduled`** maintenance moves to pg-boss schedules now.
   - **`bulk`** (high-volume, recoverable) is **deferred**: a later ADR
     specifies a relay that keeps the `enqueue(tx)` contract.
   - The `pdf` queue is deleted. BullMQ and the queue Redis are removed once
     the assistant and maintenance queues have moved.
   - The shared Redis keeps only losable data: sessions, rate limits, AI budget
     counters, confirmation challenges, presence, stream slots and ADR-0042's
     ephemeral frames.
   - Each job type runs on its own queue with its own concurrency, so one load
     cannot starve another. Fairness between companies inside one queue is
     recorded, not built. *(Amended 2026-09-14.)*
3. **A job is declared once.** Core owns what the pipeline reads from that
   declaration (name, scope, identity-only payload, discriminator, lifecycle,
   on-exhausted action) and the job port. **`@showzy/jobs`** (server-only
   platform package) reads the declaration's runner settings (retries, attempt
   timeout) and holds the pg-boss adapter, the worker host, the scheduler and
   the **conformance suite** every adapter must pass. No field is declared
   twice.
   *(Amended 2026-09-14: the earlier wording gave "the port" and the definition
   type to both core and this package, and core cannot import it.)*
   The package owns no tables. The `pgboss` schema is a foundation protocol
   schema, created by a drizzle-kit custom migration generated from the pinned
   library. That migration, and the statements pg-boss issues from inside
   `@showzy/jobs`, are the approved raw SQL (J15).
4. **The domain-event outbox is unchanged** (ADR-0012). Events are effects
   between modules; jobs are work.
5. **Every job declares its time limits and its lifecycle.** *(Added
   2026-09-14.)*
   - **Time.**
     - *Attempt timeout*, required: how long one claimed attempt may run (per
       chunk for chunked work). It is the runner's expiry plus an in-process
       abort (J7).
     - *Start deadline*, optional: after it the work may no longer start. It
       is a fact on the owning row, checked atomically by the claim and by the
       sweep (J9).
     - *Expected start*, optional: a soft threshold that makes a delay visible
       and never ends work. Alerting on it is recorded, not built.
     - *Runner retention*: when the runner deletes its own records. It never
       decides a business outcome.
   - **Lifecycle**, from the implemented set `expires | periodic`. It also
     picks the runner class (§2): `periodic` runs from schedules, `expires` on
     the durable adapter.
     - `expires`: an owning row with a start deadline. Work that cannot start
       in time, or whose attempts are exhausted, ends in the row's domain
       terminal outcome. First consumer: the assistant turn.
     - `periodic`: no owning row. A failed run is visible in the runner and the
       logs, and the next run picks up what is left. First consumers: the
       maintenance tasks.
   - **`recoverable` is planned, not implemented.** Its semantics are fixed
     here; its tests come with its first consumer (PDF generation, imports).
     - The owning row keeps the intent. Attempts retry under the declared
       policy, then the row stays visibly failed until an explicit retry.
     - Automatic recovery is allowed only when the domain row proves the work
       never started. Started work recovers through its claim (J8) and the
       external-effect rules (J10–J12). A missing runner record proves
       nothing: it may have been deleted after an attempt that had an effect.
     - A stable job id stops a second enqueue only while the runner still
       holds the record. Whether the id comes from a J2 origin or is stored on
       the row is chosen with the first consumer.
     - Acceptance scenarios for that consumer: a row that never started is
       re-enqueued once; a row that started is never re-run blindly; exhausted
       retries leave a visible failure that only an explicit retry reopens; a
       re-enqueue while the original job exists adds no job, and after the
       record is gone the claim still lets one attempt run.
   - Whether an external effect happened is not a lifecycle property: J11 and
     J12 decide it for every lifecycle.

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
  - The worker verifies that the recorded company exists, and fails closed.
    Every action the job runs applies the access rules it already has: a staff
    actor's membership is checked exactly as on a request.
  - Companies have no status. Deactivating a company is a separate
    product change, and it decides what deactivation stops, jobs included.
  *Inherited cross-tenant suite: a payload naming a foreign row fails closed; a
  job whose recorded company does not exist fails closed; a job whose staff
  actor lost membership is refused at its first staff action.*
  *(Amended 2026-09-14: the earlier wording checked an "active" company and let
  the J9 sweep act for an inactive one; `companies` has no such state.)*
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
- **J8 Claims are domain code, and every protected write is fenced.**
  - A job claims its owning row under a claim identity that is never reused:
    the row's own id when the row is claimed at most once, otherwise an attempt
    id.
  - Every write made under the claim (results, history, cards, the terminal
    transition) checks atomically that the claim still holds. A worker whose
    row was ended or claimed again can neither claim nor record, and a retry of
    a thrown attempt is not refused as "already running".
  - Zero retries do not remove the fence: a sweep can end a row while its
    worker still runs, and a continuation can start before that worker returns.
  - The claim also serialises work per subject (one active row), not a runner
    singleton. Cancelling is a domain transition that ends the claim, so the
    runner needs no cancel call.
  *Domain tests per consumer: a worker keeps running, the sweep ends its row, a
  continuation starts, and each of the worker's later writes is refused.*
  *(Amended 2026-09-14: the earlier wording tied the fence to runner attempts,
  which read as unneeded for a job with zero retries; ADR-0039's SHO-575
  amendment records the overwrite it must stop.)*
- **J9 Exhausted or overdue work is never silently stuck.** The job's declared
  lifecycle (§5) decides what happens, and runner state never does.
  - **`expires`.** When retries are exhausted, whether the last attempt threw
    or expired, a declared **on-exhausted** `system` action moves the owning
    row to its domain terminal outcome with a typed reason (`interrupted` for
    an assistant turn). The claim refuses a row past its start deadline. If
    the on-exhausted action fails, or the runner drops a job without failing
    it, the **owning module's** scheduled sweep catches the row:
    - it fans out one tenant-scoped `system` action per company, taken from
      its own overdue rows (J5);
    - that action may only move `running` or `queued` rows to their terminal
      outcome with a typed reason, and is audited with the row's company;
    - no row stays `queued` past its start deadline, or `running` past its
      attempt timeout, by more than one sweep interval.
  - **`periodic`.** A failed run leaves a typed code in the runner and a log
    line, and the next run covers the remainder. Runs that overlap must be
    safe.
  - Runner retention only cleans the queue: pg-boss can still start a job past
    its retention until a maintenance pass deletes it, and that deletion sends
    nothing to a dead letter.
  *Conformance: thrown and expired last attempts; a failing on-exhausted
  action; a job dropped by retention; overlapping `periodic` runs; a
  cross-tenant case in which the sweep's tenant action cannot touch another
  company's row. Domain tests per `expires` consumer: a claim refused past the
  start deadline, and a late job that finds its row ended starts nothing and
  writes nothing.*
  *(Amended 2026-09-14: the earlier wording treated every job alike, marked
  rows `failed`, gave the sweep an inactive-company exception, and left a
  queued row's deadline undefined.)*

**External effects.**
- **J10 A new job's external I/O never runs inside a transaction.** External
  I/O is any call outside Postgres: a model, a payment or fiscal provider, a
  carrier, object storage. A claim commits, the call runs, and a separate
  transaction records the result. Being safe to repeat does not exempt a call:
  the transaction still waits on it and holds its locks and connection, and a
  rollback does not undo it.
  - **Named temporary exception.** `files.sweepAbandonedUploads` and
    `files.backfillCatalogRenditions` write object storage inside their action
    transaction and move to schedules as they are. Each leaves this list
    through its own migration, which must keep the guarantee its row lock gives
    today, as `files.finalizeUpload` writes the catalog key only while it holds
    the `pending` row (SHO-113, SHO-118). Nothing joins this list.
  *Integration test: no open transaction exists on the job's connection during
  the stub call.* *(Amended 2026-09-14: "provider call" was undefined, and two
  maintenance workflows already broke the rule.)*
- **J11 and J12 are rules of the effect, for every lifecycle.** They bind
  effects that are unsafe to repeat: money, fiscal records, messages, carrier
  orders, model calls. What an attempt leaves depends on what is known: a
  request refused before the call, or refused unambiguously by the provider,
  is a known failure; a request that may have run but whose answer was lost is
  `outcome_unknown` (J12). An effect that is safe to repeat (a storage write
  under a fixed key, an idempotent delete) needs neither a provider key nor
  `outcome_unknown`. A provider that accepts no key, such as a model, is never
  re-run: its job declares zero retries. *(Amended 2026-09-14.)*
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
- **ADR-0039** is amended *(completed 2026-09-14; each change is also noted
  where ADR-0039 states the old rule)*:
  - the turn job is enqueued through `ctx.enqueue` in `assistant.acceptTurn`; a
    `replayed` accept enqueues nothing, and the job id follows J2, not the
    command;
  - company scope comes from the job's recorded company (J5): the worker reads
    the turn filtered by it, not through a global read;
  - a turn ends in `interrupted` through its on-exhausted action or the sweep
    (J9), and every history save, card write and finish is fenced by the turn's
    claim (J8), which closes ADR-0039's SHO-575 residue;
  - the turn's job has the `expires` lifecycle: a turn must start within its
    start deadline, which `startTurn` and the sweep check atomically. This
    replaces the job-presence check, and an accepted turn may now end before it
    starts, a product change accepted with this amendment;
  - the reconciler becomes the assistant's J9 sweep: no re-enqueue and no job
    check, but the stale-running interrupt and the one-time hold release stay;
  - the queue Redis and its AOF policy are removed.

**Core** (approved by this ADR):
- the declaration fields the pipeline reads (§3), `enqueues`, `ctx.enqueue`
  and the job port;
- execution ids and job identity;
- recorded scope;
- contract checks and a job case in the inherited cross-tenant suite;
- a `core.md` §6 subsection.

**Spec.** `docs/specs/jobs.md` is written with the first implementing feature
and holds only what that feature's tests prove:
- the claim, fenced-write and terminal-outcome shapes of `expires`;
- the sweep's per-company fan-out, and `periodic` runs;
- pg-boss settings (polling, supervise, expiry, retention);
- queue provisioning, which must exist before the API's first send.

`recoverable` and the chained-page, provider-limit, batch and webhook
patterns are written with their first consumer, each with the test that proves
it. *(Amended 2026-09-14: the earlier list put the patterns in the first
feature, where no test could prove them.)*

**Later, with `recoverable`.** Slow work leaves outbox deliveries: a
subscription records the intent and enqueues a job, and the job's lifecycle
owns its retries. PDF generation, which renders inside a delivery today
(`apps/worker/src/pdf-delivery.ts`), is the expected first consumer.

It changes via ADR or a same-PR patch when a test proves it wrong.

**Dependencies.** `pg-boss` is added (MIT; one maintainer, mitigated by the port
and the suite), and `bullmq` is removed. Accepting this ADR approves both.

**Grants are built.** The `pgboss` migration grants `showzy_app` what enqueue,
fetch and completion need, because CI runs tests under that role (`db.md` §6).
*(Amended 2026-09-14: the earlier wording listed the grants as recorded, not
built.)*

**Operations, recorded, not built** (`db.md` §6):
- job retention and autovacuum;
- production credentials for the `pgboss` schema;
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

## Amendment, 2026-09-14 — contradictions found planning the first feature

Found while planning `@showzy/jobs` against the code, then corrected by the
owner against pg-boss 12.31.0, `files.finalizeUpload` and the work other
workers will carry.

**What no longer holds.**
- "A job runs as an internal `system` action": `core.md` §4 runs every handler
  inside its transaction, so a job with external I/O could not meet J10.
- "The company exists and is active": `companies` has no status column.
- A fence tied to runner attempts: with zero retries, an abandoned worker still
  writes after the sweep ends its row.
- One J9 for every job: an assistant turn, a PDF and a maintenance run need
  different answers when work cannot run, and "marks the owning row failed"
  fits none of them exactly.
- An undefined "provider call", while two maintenance workflows write object
  storage inside their transaction.
- "The port" owned by both core and `@showzy/jobs`.
- A reconciler that "keeps the queued-abandoned interrupt", whose ADR-0039 rule
  needs the BullMQ job check this ADR removes, while J9 demanded a deadline no
  rule defined.
- `pgboss` grants recorded but not built, while CI runs as `showzy_app`.
- A spec holding patterns that no test in the first feature can prove, and a
  shared Redis list without the AI budget counters.

**What now holds.** §1, §2, §3, §5, J5, J8, J9, J10–J12 and the Consequences
above, each marked where it changed. `recoverable` is planned: its semantics
and acceptance scenarios are in §5, and it has no implementation or test yet.

**Unchanged.** J1–J4, J6, J7, J13–J16, the outbox, and the choice of
pg-boss.
