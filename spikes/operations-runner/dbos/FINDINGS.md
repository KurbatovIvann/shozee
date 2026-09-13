# DBOS Transact — FINDINGS (SHO-617)

Pinned: `@dbos-inc/dbos-sdk@4.27.6` (npm latest, 2026-08-25), MIT. System database = the app database (`dbos` schema).
Suite: `npx vitest run dbos` → 16 passed (~96 s; files r1-r3, r4-r5, r6-r9). No decorators: `DBOS.registerWorkflow`,
`DBOS.runStep`, `new WorkflowQueue`, `DBOSClient` are plain functions. Port extension: `ctx.step` (DBOS resumes by replay).

| # | Verdict | Evidence |
|---|---|---|
| R1 | PASS | `DBOSClient.enqueueInTransaction(pgClient, …)` writes `dbos.workflow_status` inside our Drizzle tx. Rollback: no row/workflow after 3 s; commit: runs once. Needs the private `pg` client pulled out of the Drizzle tx (9 lines). |
| R2 | PASS | `ON CONFLICT DO NOTHING` on repeat command; one-active index aborts the tx, the workflow rolls back with it. |
| R3 | PASS | Stored input `{operationId, subjectId}` only; DBOS also persists every step's return value. |
| R4 | PARTIAL (compensation) | Recovery re-runs by default and cannot be disabled (runs on launch; `maxRecoveryAttempts: 0` falls back to 100). Control test re-ran the unfinished step. Attempt guard + deadline sweep: killed run `interrupted` 3.2 s after kill (3 s deadline), restart does not run it. |
| R5 | PASS | `DBOS.recv(topic, {timeoutSeconds})` / `client.send` across SIGKILL, including a send while no worker was alive; pre-wait effects not repeated; timeout survives restart (fired at 10.08 s after a 2 s outage). |
| R6 | PASS | One REPEATABLE READ tx joins our row with `dbos.workflow_status`: 0 violations / 100. DBOS state not needed for status. |
| R7 | PASS | `workerConcurrency: 4`, `partitionConcurrency: 1` keyed by subject; 0 overlaps, 20/20 split across two workers. |
| R8 | PASS | `DBOS.shutdown({workflowCompletionTimeoutMS})` finished the running op; one accepted during stop stayed queued. |
| R9 | PASS | Row `failed` + DBOS `ERROR` with error text; no retry; `forkWorkflow` replays on request. |
| R10 | PARTIAL | No extra service (Conductor/cloud optional). DBOS owns 14 tables and migrates on launch unless `runMigrations: false`; `dbos schema` SQL (647 lines) could become a drizzle-kit migration, but upgrades add more (ADR exception for raw SQL). ~11.3 MB with deps. No Windows issues. |

## R4 vs R5
Native conflict: the recovery that resumes a wait also re-runs a model call. Resolution: every effect goes through `ctx.step`;
each process keeps a set of runs it genuinely started (filled only when `claim` or the end of a wait executes, not replays).
A recovered run reaching a real step outside that set marks itself `interrupted`; a run parked in a wait resumes.

## Compensations needed
- Attempt guard ≈46 lines, deadline sweep 18, pg client extraction 9, replay 17 (in `runner.ts`).
- Each process needs a fixed `executorID` and `applicationVersion`: recovery keys on both; a dead worker's runs return only when a process with the same ID restarts. A live second worker sharing an ID re-queued the first's running op (hazard test).

## Risks
- Deployment identity (`executorID`, `applicationVersion`) becomes correctness-bearing: container naming and rolling deploys must preserve it.
- Replay model: effects outside `ctx.step` repeat; step outputs persisted (PII in the dbos schema).
- Library-owned schema with its own migrations; one vendor's execution model inside the worker.

## Verdict
Only candidate with native atomic enqueue, durable wait/signal and per-subject concurrency.
Costs: an attempt guard against automatic recovery, a library-owned schema, and executor identity as an ops invariant.
