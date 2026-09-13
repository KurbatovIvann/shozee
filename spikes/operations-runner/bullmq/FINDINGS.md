# BullMQ candidate — FINDINGS (SHO-617)

Pinned: `bullmq@6.2.0` (npm 2026-08-21), `ioredis@6.0.0`, Redis `:56379`, prefix `spike-bullmq`, DB `spike_bullmq`.
Suite: `npx vitest run bullmq` → 12/12 pass (~50 s, two consecutive runs). Port extension: `RunContext.step(key, fn(tx))`,
because a resumed BullMQ job re-executes the handler from the top; without a Postgres step journal R5 repeats pre-wait effects.
Extra runner API: `retryFailed(id)` (R9), `dispose()`; free function `sweepDeadlines(db)` (R4).

| # | Verdict | Proving test | Evidence |
|---|---|---|---|
| R1 | FAIL native / PASS with compensation | `R1a native…`, `R1b compensated…` | `queue.add` is a Redis write outside the tx: rollback → orphan job ran the handler (`start`=1). Compensation: `pg_advisory_xact_lock(op)` in accept tx + Postgres claim in worker → orphan delivered but dropped; pre-commit fetch blocks on the lock (519–525 ms for a 500 ms commit delay). No reconciler. Gap: job lost in Redis after commit → row `queued` until deadline sweep marks `interrupted`. |
| R2 | PASS | `R2 same command once…` | `ON CONFLICT (command_id)` returns existing op, one row, `start`=1; second active command → `23505 spike_operations_one_active`; other subject started before first ended. `jobId = operationId` also dedups in Redis. |
| R3 | PASS | `R3 the Redis job hash…` | Job `data` keys = `operationId,subjectId`. Hash also: `opts,name,timestamp,processedOn,finishedOn,returnvalue,atm,ats,delay,priority`; on failure `failedReason`+`stacktrace` (error text leaves Postgres). |
| R4 | PASS with compensation | `R4a maxStalledCount 0…`, `R4b library default…` | Library re-runs by default: `maxStalledCount` default 1 → R4b re-delivered after SIGKILL+restart (deliveries=2). Off via `maxStalledCount: 0` → R4a job `failed` "job stalled more than allowable limit", deliveries=1. `interrupted` comes only from our sweeper (3.0 s after kill; deadline 3 s, sweep 1 s); `runs`=1. Claim guard is what makes R4b safe. |
| R5 | PASS with compensation | `R5a SIGKILL while waiting…`, `R5b no signal…` | No native durable wait. Built: `bullmq_waits`+`bullmq_steps`, park = `job.moveToDelayed`+`DelayedError`, signal = Postgres upsert + `job.promote()`. Kill while `waiting` (job `delayed`, no lock → no stall) → restart → signal → `done`; `before-wait`=1, `after-wait:{"value":42}`=1, handler invoked twice (replay). R5b: timeout at 10 s → `failed`, BullMQ `failedReason` "answer timed out". R4/R5 do not conflict: a delayed job holds no lock, the claim admits `waiting`. |
| R6 | PASS (runner state not needed) | `R6 row and effects agree…` | 100 RR read-only iterations vs racing writer: 0 disagreements. Status lives only in Postgres; Redis cannot join the snapshot and lags (first run: row `failed` while `failedReason` still undefined). |
| R7 | PASS via Postgres, not BullMQ | `R7 two workers x4…` | 2 procs × 4, 40 ops/10 subjects: overlaps=0, peak=8, both workers used; serialization is the `one_active` index (190–232 driver retries). OSS BullMQ has no group concurrency: no `group` in `dist/esm/interfaces` or `Worker` types; README table lists Group Support / Group Rate Limit for BullMQ-Pro only. |
| R8 | PASS | `R8 stop() during a run…` | `worker.close()` waited for the 2 s run (`end`, row `done`); op accepted after stop: 0 deliveries, job `waiting`, row `queued`. |
| R9 | PASS with compensation | `R9 a throwing handler…` | `attempts: 1` → no auto-retry. Visible in Postgres (row `failed`, our wrapper) and Redis (`failed`, `failedReason`, `stacktrace`, `attemptsMade`=1). Explicit retry `retryFailed`: row `failed→queued` then `job.retry("failed")` → `done`, `runs`=2; two stores, not atomic. |
| R10 | desk | npm registry, node_modules | Service: Redis. Schema: none for Redis; compensation tables via drizzle-kit, advisory lock is an `sql` primitive needing ADR approval. No decorators. MIT (Pro commercial). Latest 6.3.4 (2026-09-10); one npm maintainer (Taskforce.sh). Install ≈13 MB (bullmq 3.8 M, luxon 4.5 M, msgpackr 1.9 M, ioredis 1.5 M). Windows: pnpm skipped `msgpackr-extract` build (JS fallback, no failure); `node --import tsx` worker died cleanly on SIGKILL. 6.x ships a Postgres backend (own `runMigrations` SQL); connection type `PgPool | config | string` cannot join a caller tx (desk only). |

## Compensations needed (code we would own)
- Claim guard (R1/R4): advisory lock in accept tx + `FOR UPDATE` claim, ≈34 lines.
- Deadline sweeper (R4, only cover for Redis job loss): 16 lines + a scheduler.
- Durable wait/signal + step journal (R5): ≈117 lines + 2 tables (`schema.ts` 60).
- Replay across two stores (R9): 26 lines; Postgres status writes 15. `runner.ts` 321 total, ≈70 BullMQ plumbing.

## Risks
- Two job-state stores (Postgres row, Redis job) that lag and disagree; every read path must ignore Redis.
- Default `maxStalledCount: 1` silently re-delivers killed jobs; safety depends on every job type keeping the claim guard.
- Resume = full handler replay; any effect outside `step()` repeats.
- Advisory lock holds a worker slot during a slow accept tx; Redis loss after commit recovered only by the sweep.
- `failedReason`/`stacktrace` copy error text into Redis.

## Verdict
Meets R2/R3/R6/R8 natively; R1, R4, R5, R7, R9 only through Postgres-side compensation (~250 lines).
BullMQ contributes delivery, delay and stall detection; the correctness-bearing state machine is already ours in Postgres.
Keeping it means owning a second queue store plus the code that neutralizes it.
