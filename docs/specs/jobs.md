# Jobs protocol manual (`@showzy/jobs`)

Decision: [ADR-0041](../adr/0041-postgres-first-job-runner.md). This manual
records how the runner package is built; the ADR's invariants (J1–J16) are the
contract. Later sections arrive with the tickets that build them.

## 1. Package boundary

- `packages/jobs` is a server-only platform package. Client apps and the
  client-safe packages (`contract`, `validation`, `ui`) may not import it
  (`packages/tooling/eslint`, `SERVER_ONLY_PACKAGES`).
- `pg-boss` is pinned to exactly `12.31.0` and is imported only inside
  `packages/jobs`. `showzy/import-boundaries` refuses a static, re-export or
  dynamic import, or a literal `require`, of `pg-boss` or any `pg-boss/*`
  subpath anywhere else, tests and scripts included (J15).
- The package owns no tables. Application code never reads or writes
  `pgboss` tables; the SQL pg-boss issues from inside the package is approved
  raw SQL (J15).

## 2. The `pgboss` schema

- One drizzle-kit custom migration, `packages/db/migrations/<n>_pgboss.sql`,
  creates the schema. It is generated, never typed:
  `pnpm --filter @showzy/jobs pgboss:generate` asks drizzle-kit for the
  custom migration slot (journal and snapshot) when none exists, then writes
  the SQL from `getConstructionPlans("pgboss")` of the installed library.
- The file carries the ADR-0041 J15 approval header. The library wraps its
  plans in `BEGIN`/`COMMIT`; the generator drops exactly that framing, because
  the drizzle migrator already runs every pending migration in one
  transaction and a nested `COMMIT` would end it. A library whose plans lose
  that framing fails generation instead of being edited. It also drops the
  `SET LOCAL` lock and idle timeouts and the advisory lock the plans open with,
  which would otherwise hold for every later migration in that transaction;
  plans that stop opening with exactly those three statements fail generation.
- The schema keeps the stock Postgres layout (`job` and `queue_stats` are
  partitioned): 12.31.0 derives `noTablePartitioning` only from `backend`,
  and the runtime must use the layout the schema was built with. Nothing the
  runtime role runs creates a partition while queues stay `partition: false`
  and `persistQueueStats` stays off; proof: the db test runs a supervise and
  monitor pass as `showzy_app`.
- Drift: `src/pgboss-migration.test.ts` regenerates the SQL and requires the
  committed file to match byte for byte, and the tag to be in the journal.
- The library migrator never runs. Every pg-boss instance is built with
  `migrate: false` and `createSchema: false`. Upgrading pg-boss is a new
  migration generated from `getMigrationPlans`, never `start()`. That PR
  pins the drift check of `0064` to the old library's plan, checks the new
  migration against `getMigrationPlans` separately, and changes the pinned
  version.

## 3. Boot check

`assertPgBossSchema(db)` reads the installed version through pg-boss with the
migrator disabled and throws `CoreInvariantError` unless it equals the pinned
library's schema version (`41` for `12.31.0`). A lower or higher version fails
and is left untouched. Proof: `src/pgboss-schema.db.test.ts`.

## 4. Grants

- The migration grants `showzy_app` `USAGE` on schema `pgboss`, `SELECT`,
  `INSERT`, `UPDATE`, `DELETE` on its tables, and the same on tables later
  created in it by the migrating role. No `CREATE`, no `TRUNCATE`.
- `INSERT`, `UPDATE` and `DELETE` on `pgboss.version` are revoked, so the
  runtime role cannot install, change or remove the version the boot check
  reads; `UPDATE` is granted back only on the maintenance stamps the runner
  writes (`cron_on`, `bam_on`, `flow_on`, `reindex_on`, `monitor_backoff_on`).
- That is what send, fetch and completion need; proof: the same db test sends,
  fetches and completes a job as the runtime role.
- `showzy_app` runs no DDL, so a queue with `partition: true` (which creates a
  table) cannot be provisioned by the runtime role; unpartitioned queues are
  one `pgboss.queue` row.

## 5. Fenced writes (J8): the assistant turn

- A turn's history (`assistant_chat_state`) has two legitimate writers.
  `assistant.acceptTurn` writes the initial history and the placeholder in
  its own transaction while the turn is `queued`; the active-turn index
  serialises it (SHO-575). The worker writes everything after that under the
  turn's claim.
- The claim is the turn row itself: `running`, this conversation, kind and
  command id. A turn starts at most once, so the identity is never reused.
- Every worker write carries the claim: `assistant.writeChatState`,
  `assistant.insertChatMessage` and `assistant.updateChatMessage` take
  `claim: { kind, commandId }` and, in the same transaction, lock the turn row
  `FOR SHARE` where it is still `running` before they write. No row is
  `CONFLICT` and nothing is stored. The runtime passes it through
  `AssistantRuntime.forTurn(caller, claim)`, whose claim is required; only the
  turn processor calls it. `forCaller(caller)` takes no claim and serves the
  API and the reconciler (SHO-663).
- The terminal transition (`finishTurn`, `interruptTurn`, `sweepOverdueTurns`)
  locks the same row
  `FOR UPDATE`, so a writer that holds the claim commits before the end, and
  a writer that asks after the end finds no running row. A status read
  without the lock would let an ended worker overwrite a later accept.
- `finishTurn` is fenced by its own statement: it ends only an active row it
  has locked, and a turn ended first answers `already_finished`.
- The interrupting transitions classify from the locked row and store
  `assistant_turns.end_reason`: a queued turn that never started ends
  `not_started`, a running turn past its deadline `timeout`. A queued turn is
  overdue at `created_at + 15 minutes` (`ASSISTANT_TURN_START_DEADLINE_MS`),
  the one predicate both the sweep and the start claim read.
- Writes without a claim (the API's synchronous paths, the reconciler
  settling an interrupted placeholder) are unchanged.
- Proof: `packages/modules/assistant/src/actions/turn-claim.db.test.ts`
  (forced interleaving of a history save, a card write and a finish against
  an interrupt followed by a new accept).

## 6. Job data and the job port

- `createPgBossJobPort(boss)` implements core's `JobPort`. `enqueue(tx,
  envelopes)` sends each envelope with pg-boss `send` through
  `fromDrizzle(tx)`, so the job row commits or rolls back with the
  enqueuing transaction (J1). The pg-boss job id is the envelope id (J2).
- Stored job data is the envelope without `id` and `name`: `companyId`,
  `actor`, `channel`, `requestId`, `correlationId`, `executionId` and the
  identity-only `payload`. Every value is an id, a uuid or a fixed enum; no
  free text reaches a job row (J6, SHO-659).
- J6 assumes trusted, reviewed in-process module code: registered schemas
  must not be mutated; payload and envelope data remain untrusted and must be
  validated at runtime boundaries, while deliberate replacement or mutation
  of validators by module code is outside J6's threat model.
- A send whose id the runner still holds (pg-boss answers `null`) throws
  `CoreInvariantError` and rolls the enqueuing transaction back; it is never
  dropped silently. That happens only when an idempotency key is reused
  after its idempotency record expired while pg-boss still retains the job
  (SHO-681). Retention is not matched to the idempotency TTL: two stores
  with one number are not synchronised, and the domain row stays the source
  of truth.

## 7. Runner settings and queue provisioning

- `openJobRunner({ db, jobs, onError }, role)` builds one `PgBoss` over the
  app's Drizzle pool with the migrator off (§2), `useListenNotify: false`
  (workers poll, ADR-0041 §2), and `supervise`/`schedule` on only for the
  `worker` role. The `api` role is send-only.
- Jobs have two declaration sources, each job declared once. Module jobs are
  `registeredJobs` in `apps/api/src/registry.ts`, spread from each module
  barrel's `<module>Jobs` export like its actions (`registry.test.ts` fails on
  a barrel job that is not registered); API composition checks them and the
  API opens its runner with them. The worker opens its runner with
  `workerJobs` (`apps/worker/src/maintenance.ts`): `registeredJobs` plus the
  worker-owned jobs, merged by `mergeJobDeclarations`, which refuses a name
  both sources declare. Worker-owned jobs, actions and coverage go through
  `runContractCheck` in `pnpm --filter @showzy/worker contract:check` (a CI
  step). The API never depends on `apps/worker`.
- One queue per job, named after the job. Stored settings derive from the
  declaration: `retryLimit` = `retries`, `expireInSeconds` =
  `ceil(attemptTimeoutMs / 1000) + 5` (the margin lets the in-process timeout
  settle first, so a timed-out attempt stores `ATTEMPT_TIMEOUT`), policy `standard`, `partition: false`,
  `notify: false`, no retry delay or backoff, no heartbeat,
  `retentionSeconds` and `deleteAfterSeconds` one day. Concurrency is a
  worker-host `work` option, not a stored setting.
- An `expires` job also gets a dead letter `<job>.exhausted` (zero retries,
  same expiry), provisioned before its queue; `periodic` jobs have none.
- The `worker` role creates missing queues (`createQueue`: one
  `pgboss.queue` row under an advisory transaction lock, no DDL, so
  `showzy_app` suffices). Both roles then compare every stored setting with
  the declaration and throw `CoreInvariantError` on a missing queue or any
  difference, before `start()`: pg-boss ignores changed options on an
  existing queue, so boot refuses instead (J7). The `api` role never creates
  a queue; an API booted before the worker provisioned fails fast.
- Proof: the conformance suite `@showzy/jobs/conformance`
  (`describeJobRunnerConformance`), run against pg-boss by
  `src/pgboss-conformance.db.test.ts`: J1 rollback and commit, a held id
  refused, J6 stored data, J7 changed declaration and unprovisioned API
  boot. Declarations: `src/queue-provisioning.test.ts`.

## 8. Worker host

- `runner.work({ deps, handlers, drainTimeoutMs })` on a `worker`-role runner
  (`createJobWorker`, `src/worker-host.ts`) registers one pg-boss `work` per
  handler (`perJobResults`, `includeMetadata`, `batchSize: 1`, polling). An
  `api` runner, a second `work` call, a handler for an undeclared job, a
  handler whose job is not the declared definition object, a
  declared job without a handler, a duplicate handler, an `onExhausted` binding whose action name differs from
  the declaration, or a non-global `periodic` job throw `CoreInvariantError`.
- A handler receives `{ envelope, signal, run(action, input, fanOutCompanyId?) }`.
  `run` is `executeJobAction` with the handler's job and recorded envelope, so
  every step is a claim, external I/O outside any transaction, or a recording
  action (ADR-0041 §1, J10); the host opens no transaction of its own.
- The envelope is the stored job data plus the job id (for a dead-letter job,
  its `sourceId`, the original id). A `periodic` run has no stored data: its
  envelope is global, actor `system:<job name>`, channel `system`, and the run's
  pg-boss id as request, correlation and execution id.

## 9. Typed failures (J6)

- The host never throws into pg-boss; a throw there would store the error's
  message and stack. Every attempt settles as `completed` (output null) or
  `failed` with output `{ code }`: a `CoreError` code, `INTERNAL` for any other
  throw, `ATTEMPT_TIMEOUT`, `DRAINED`, or `ABORTED` (pg-boss aborted the
  attempt). The error itself goes to the log line only.
- A failure returned as success (the BullMQ host's `"errored"`) is not a
  settlement: it would skip retries, the dead letter and on-exhausted.
- The library's fixed status strings that can still reach `output`:
  `{ value: { message: "job timed out" } }` (supervisor expiry) and
  `{ value: "pg-boss shut down while active" }` (stop after the drain bound
  plus settle margin).
- pg-boss re-inserts a failed job without `source_id`, so a dead-letter job
  loses its source id once it fails; dead letters have zero retries, so that
  job never runs again.

## 10. Attempt timeout and exhaustion (J7, J9)

- An attempt is abandoned in process after `attemptTimeoutMs` (the signal
  aborts and the attempt fails with `ATTEMPT_TIMEOUT`); the queue's
  `expireInSeconds` covers a dead worker, whose attempt the supervisor fails.
  Both count as an attempt, so a job runs at most `1 + retries` times.
  Abandoning does not stop the handler's promise: once the signal aborted,
  `run` throws `CoreInvariantError` before starting an action, and writes
  already started are refused by the owning row's claim (J8).
- An `expires` job whose last attempt failed or expired moves to
  `<job>.exhausted`. Its worker runs the declared on-exhausted action through
  `executeJobAction` with the payload as input, in the recorded scope. A
  failing on-exhausted action leaves the dead-letter job `failed` with its code
  and the row to the module's sweep.
- A handler may bind `afterExhausted` next to its on-exhausted action: a
  post-commit callback the host calls with the recorded envelope and the
  action's validated output, only after `executeJobAction` committed. It never
  replaces the mandatory action and is not called when that action fails. A
  hook that throws fails its dead-letter job like any attempt; the terminal
  state it was told about is already committed and is not undone. A hook bound
  without an on-exhausted action is refused when the worker starts.
- Retention deletion sends nothing to the dead letter, and pg-boss may still
  start a job past `keep_until` until that pass deletes it; the domain row
  decides, never the runner record.

## 11. Drain and `periodic` schedules

- `runner.close()` on a worker stops fetching and waits for running attempts
  up to `drainTimeoutMs`; attempts still running then fail with `DRAINED`, and
  pg-boss gets a 5 s settle margin before it fails what is left. The platform
  grace period must exceed that sum: recorded, not configured (no production).
- `work` schedules each `periodic` handler from its declaration
  (`schedule(name, cron, null, { tz: "UTC" })`). pg-boss files one occurrence
  per minute slot under a singleton key, so one tick runs once across workers.
  Runs of one job can still overlap (a run longer than the interval); handlers
  must be safe to overlap. A removed declaration's schedule is not
  unscheduled: recorded, not built.
- `defineJob` accepts a stricter cron subset than pg-boss's cron-parser: 5 or
  6 fields of `*`, numbers or three-letter month/day names, ranges, `/` steps
  and `,` lists, each within its field's range; `?`, `L`, `W`, `#` and `@`
  macros are refused at define time.
- Tuning: `openJobRunner({ intervals: { pollingSeconds, superviseSeconds,
  cronSeconds } })`; absent, the library defaults apply.
- Proof: the conformance suite's J7 (thrown attempts, in-process timeout), J9
  (expired last attempt, failing on-exhausted, the post-commit hook and a
  failing one, retention drop), periodic (two
  workers, one tick) and drain cases, run by `src/pgboss-conformance.db.test.ts`.

## 12. Maintenance jobs

All maintenance runs from `periodic`, `global` pg-boss schedules with zero
retries; a failed run waits for the next tick. The worker boots the runner
(`openJobRunner(..., "worker")`), then `work` with `maintenanceHandlers`,
whose handlers only run the declared action with the empty payload and log
its counts; drain waits `JOB_DRAIN_TIMEOUT_MS` (30 s).

| Job | Cron (UTC) | Action | Owner |
| --- | --- | --- | --- |
| `files.sweepAbandonedUploads` | `*/5 * * * *` | `files.sweepAbandonedUploads` | files module |
| `files.backfillCatalogRenditions` | every `BACKFILL_CATALOG_RENDITIONS_INTERVAL_MS` (5 min) | `files.backfillCatalogRenditions` | files module |
| `worker.cleanupIdempotencyKeys` | `0 * * * *` | `worker.cleanupIdempotencyKeys` | `apps/worker` |

- The two files actions run unchanged, under ADR-0041 J10's named storage
  exception. Overlapping runs are safe: the sweep locks rows `FOR UPDATE SKIP
  LOCKED`, the backfill writes fixed keys.
- `worker.cleanupIdempotencyKeys` is app infrastructure: an internal
  `system`/`global` audited write whose handler passes its execution
  transaction to core's `cleanupExpiredIdempotencyKeys` (typed
  `Pick<Database, "delete">`), so no second transaction or global client.
- The BullMQ `pdf` queue is deleted. The assistant reconciler stays on the
  BullMQ `maintenance` queue until jobs-T11.
- Proof: `apps/worker/src/jobs.db.test.ts` (two workers provision each queue
  and schedule once; one tick runs each action once, audit rows per run and
  one send-it slot per occurrence; cleanup deletes only expired keys), the
  files job cases and overlapping runs in
  `packages/modules/files/src/actions/files.db.test.ts`, and
  `apps/api/src/boot.db.test.ts` (an API booted before the worker fails fast).
