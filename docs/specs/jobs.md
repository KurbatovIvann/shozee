# Jobs protocol manual (`@showzy/jobs`)

Decision: [ADR-0041](../adr/0041-postgres-first-job-runner.md). This manual
records how the runner package is built; the ADR's invariants (J1–J16) are the
contract. Later sections arrive with the tickets that build them (job port,
queue provisioning, worker host, scheduler, conformance suite).

## 1. Package boundary

- `packages/jobs` is a server-only platform package. Client apps and the
  client-safe packages (`contract`, `validation`, `ui`) may not import it
  (`packages/tooling/eslint`, `SERVER_ONLY_PACKAGES`).
- `pg-boss` is pinned to exactly `12.31.0` and is imported only inside
  `packages/jobs`. `showzy/import-boundaries` refuses a static, re-export or
  dynamic import of `pg-boss` or any `pg-boss/*` subpath anywhere else,
  tests and scripts included (J15).
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
  that framing fails generation instead of being edited.
- Drift: `src/pgboss-migration.test.ts` regenerates the SQL and requires the
  committed file to match byte for byte, and the tag to be in the journal.
- The library migrator never runs. Every pg-boss instance is built with
  `migrate: false` and `createSchema: false`. Upgrading pg-boss is a new
  migration generated from `getMigrationPlans`, never `start()`; the drift
  test and the pinned version change in that same PR.

## 3. Boot check

`assertPgBossSchema(db)` reads the installed version through pg-boss with the
migrator disabled and throws `CoreInvariantError` unless it equals the pinned
library's schema version (`41` for `12.31.0`). A lower or higher version fails
and is left untouched. Proof: `src/pgboss-schema.db.test.ts`.

## 4. Grants

- The migration grants `showzy_app` `USAGE` on schema `pgboss`, `SELECT`,
  `INSERT`, `UPDATE`, `DELETE` on its tables, and the same on tables later
  created in it by the migrating role. No `CREATE`, no `TRUNCATE`.
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
  `AssistantRuntime.forCaller(caller, claim)`; only the turn processor does.
- The terminal transition (`finishTurn`, `interruptTurn`) locks the same row
  `FOR UPDATE`, so a writer that holds the claim commits before the end, and
  a writer that asks after the end finds no running row. A status read
  without the lock would let an ended worker overwrite a later accept.
- `finishTurn` is fenced by its own statement: it ends only an active row it
  has locked, and a turn ended first answers `already_finished`.
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
- The declared jobs are `registeredJobs` in `apps/api/src/registry.ts`, the
  one list composition checks and both apps open the runner with.
- One queue per job, named after the job. Stored settings derive from the
  declaration: `retryLimit` = `retries`, `expireInSeconds` =
  `ceil(attemptTimeoutMs / 1000)`, policy `standard`, `partition: false`,
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
