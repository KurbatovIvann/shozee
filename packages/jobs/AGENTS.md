# @showzy/jobs — Agent Instructions

The pg-boss job runner (ADR-0041, SHO-650/SHO-651). This package owns the
only `pg-boss` import in the repository, the `pgboss` schema migration
generator, queue provisioning, and the worker host that turns one pg-boss job
into one `executeAction` attempt. It owns no tables of its own and no domain
logic: jobs are declared by modules with `defineJob`, bound by `apps/worker`,
and sent by handlers through `ctx.enqueue`.

Protocol manual: [`docs/specs/jobs.md`](../../docs/specs/jobs.md). That file
is the contract; this one is how to work in the package.

## Layout (`src/`)

- `index.ts` — the public surface: `openJobRunner` with its config and role
  types, `exhaustedQueueName`, and the handler types `apps/worker` writes
  against (`JobAttempt`, `JobHandler`, `JobExhaustedHook`,
  `JobWorkerOptions`). Everything else is internal. `createPgBossJobPort`,
  `assertPgBossSchema` and `JobFailureCode` are **not** exported: the runner
  is the one mount path, and a second way to build a port or to check the
  schema is a second protocol (SHO-706).
- `job-runner.ts` — `openJobRunner(config, role)`: asserts the installed
  schema version, builds the one `PgBoss` with the library migrator disabled,
  provisions and verifies queues against the declarations, starts, and hands
  back the `JobPort` core enqueues through. The `api` role only sends; only
  the `worker` role works jobs.
- `worker-host.ts` — one attempt: the envelope, the `AbortSignal`, the drain
  latch, the failure classification, and the exhausted queue that runs a job's
  `onExhausted` action and its `afterExhausted` hook.
- `pgboss-job-port.ts` — core's `JobPort` over pg-boss `send` through
  `fromDrizzle(tx)`, so the job row commits with the enqueuing transaction.
  `storedJobDataSchema` is what a stored job may carry: ids only.
- `queue-provisioning.ts` — queue declarations derived from `defineJob`,
  provisioning, the schedule, and `exhaustedQueueName`.
- `pgboss-schema.ts` / `pgboss-migration.ts` — the boot version check and the
  generator behind `pnpm --filter @showzy/jobs pgboss:generate`.
- `conformance.ts` — the shared suite a port implementation must pass.

## A change here must not break

- **`pg-boss` stays inside this package.** No static, dynamic, re-export or
  `require` import of `pg-boss` anywhere else, tests and scripts included
  (J15, enforced by `showzy/import-boundaries`). The version is pinned
  exactly; upgrading it is a new generated migration, never `start()`.
- **The library migrator never runs.** `migrate: false`,
  `createSchema: false`. `packages/db/migrations/<n>_pgboss.sql` is
  generated, never hand-edited, and `pgboss-migration.test.ts` regenerates it
  and requires a byte-for-byte match.
- **A job row commits with the write that justified it.** The port enqueues
  on the caller's transaction; never open a second connection to send.
- **Stored job data is identity only** — company, actor, channel, request and
  correlation ids, and an identity-only payload. Postgres is the source of
  everything else; a job payload is never a caller or an access grant.
- **Server-only.** Client apps and the client-safe packages (`contract`,
  `validation`, `ui`) may not import this package; only `apps/api` and
  `apps/worker` do.
- Queue shape, concurrency, retries and timeouts come from the module's
  `defineJob`. Do not add a policy knob here that a job cannot declare.
