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
