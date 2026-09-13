# postgres-queue — FINDINGS (SHO-617)

## Library choice: pg-boss 12.31.0 over graphile-worker 0.18.0 (desk, installed packages)
| Axis | graphile-worker 0.18.0 | pg-boss 12.31.0 |
|---|---|---|
| Enqueue in Drizzle tx | WorkerUtils.addJob uses own pool; in-tx = raw `SELECT graphile_worker.add_job(...)` | `send(..., { db: fromDrizzle(tx, sql) })` shipped adapter, no raw SQL |
| Serial per subject | `queue_name`; docs: avoid UUID names (interfaces.d.ts); crashed lock held 4 h (dist/sql/resetLockedAt.js) | `singleton` policy + `singletonKey` (unique index job_i2); `groupConcurrency` not strict (R7) |
| Job keys / dedupe | `job_key` replace / preserve_run_at / unsafe_dedupe | caller `id`, `singletonKey`, short/singleton/stately/exclusive policies |
| No auto-retry | `max_attempts` default 25 → 1 | `retryLimit` default 2 → 0 |
| LISTEN/NOTIFY | always on | opt-in (`useListenNotify` + queue `notify`); poll floor 0.5 s |
| Schema | own migrator, sql/000001..000020 | own migrator; `getConstructionPlans()`/`getMigrationPlans()` export SQL; `migrate:false` |
| Cron | crontab + backfill | `schedule()` cron/RRULE + missed policy |
| License / activity | MIT; 0.18.0 2026-09-08; 1 maintainer | MIT; 12.31.0 2026-09-10 (4 releases in 17 days); 1 maintainer |

pg-boss wins: R1 without raw SQL, index-enforced per-key serialization that UUID subjects can use, exportable schema SQL.

## Results (pg-boss@12.31.0, Postgres 17; runner.test.ts, 13 tests, green in 2 consecutive runs, ~47 s)
| # | Verdict | Test | Evidence |
|---|---|---|---|
| R1 | PASS | R1 transactional enqueue | Rollback: no row/job/effect after 3 s. Commit→handler 7–30 ms. Public fromDrizzle adapter; API side needs a started PgBoss (queue cache, own pool). |
| R2 | PASS | R2 idempotent accept… | Same command_id: 1 row, 1 job, runs 1. Same subject active: 23505 from spike_operations_one_active. Other subject ran concurrently. |
| R3 | PASS | R3 runner persists only… | job.data keys = {operationId,subjectId}. Also stored: singleton_key = subjectId; failed output = {name,message,stack}. |
| R4 | PASS | R4 deadline: SIGKILL… | interrupted 4.3 s after kill (deadline 4 s) via delayed deadline job; runs 1; restart ran nothing. Killed job stays active until expireInSeconds, then supervise sets failed "job timed out". Default 2 retries, off via retryLimit 0; row claim `status='queued'` also blocks re-run. |
| R5 | PARTIAL (compensation) | R5 wait survives SIGKILL…; R5 no signal… | Resume after SIGKILL: signal→done 47–76 ms, `before` once; timeout → failed at 10.1 s. Needs suspend-by-throw, 3 own tables, timeout + continuation jobs, replay from top: pre-wait code re-runs unless in step() (`invoked` recorded twice). |
| R6 | PASS | R6 one REPEATABLE READ snapshot | 100 snapshots during writes: queued row ⇒ job created/active; job completed ⇒ row done; row done while job active in 0–7/~85 (completion is a separate tx). Runner state not needed. |
| R7 | PASS | R7 two worker processes x4…; R7 library singleton…; R7 library groupConcurrency (measured) | 2×4, 40 ops/10 subjects: no overlap, max 8 concurrent, ~1 s. groupConcurrency:1 overlapped 13–14 of 21 pairs (READ COMMITTED NOT EXISTS + SKIP LOCKED, plans.js ~1547); singleton policy 0. |
| R8 | PASS | R8 stop() lets the running… | stop() waited 1.55 s, row done; op accepted during stop stayed queued. After timeout, failWip marks in-flight jobs failed (index.js #doStop). |
| R9 | PASS | R9 failure is visible… | Row failed; job failed with error output; no retry in 3 s; replay() (failed→queued + new job, one tx) re-ran, runs 2. boss.retry and dead letters also exist. |
| R10 | PASS | R10 schema can be owned… | No new service. pgboss schema: 12 tables, created by start(). getConstructionPlans() 18 KB; migrate:false + createSchema:false worked. As drizzle-kit custom migration = raw SQL → ADR exception; re-export per version. No decorators. ~7.5 MB install (luxon 4.5 MB). No Windows library issues. |

## Compensations needed
- R5: wait.ts 116 + schema.ts 58 + ~45 in runner.ts ≈ 220 lines; 2 extra jobs per wait; port extended with step(key, effect(tx)).
- R4: deadline queue + interruptIfOverdue + row-claim guard ≈ 45 lines. R9 replay ≈ 19 lines. runner.ts 280 total.
- Supervise must run on workers (default 60 s, 1 s in spike); it frees a crashed singleton key.

## Risks
- Delayed jobs on a notify:true queue wait up to notifyPollingIntervalSeconds (30 s); fixed with notify:false on delayed queues.
- groupConcurrency is not strict; only singleton/exclusive/key_strict_fifo are index-enforced; key_strict_fifo lets a failed job block its key.
- Crashed singleton job blocks its subject until expireInSeconds; handler aborted in-process at expiry.
- Replay-from-top: catching Suspended or effects outside step() repeat work. One maintainer, fast cadence, versioned schema.

## Verdict
pg-boss covers R1–R4 and R6–R10 natively via a shipped Drizzle adapter, index-enforced per-key serialization and no re-run.
Durable wait (R5) is ~220 lines of our own replay/step/signal code; status stays on our row (R6).
Good fit if waits are rare; if durable waits are central, a durable-execution engine avoids owning that code.
