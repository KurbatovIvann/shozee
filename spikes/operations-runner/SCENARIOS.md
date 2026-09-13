# Operations runner spike — scenarios (SHO-617)

Every candidate implements `shared/port.ts` (it may extend the port and must say
why in its FINDINGS.md) and proves each requirement with a Vitest test in its
own folder, against the compose Postgres (`:55432`) and Redis (`:56379`). Each
candidate uses its own database: `freshDatabase("spike_<candidate>")`.

The accept is the same for all: one Drizzle transaction inserts a
`spike_operations` row (`queued`, `deadline_at` = now + deadline) and calls
`runner.enqueue(tx, ref)`. The handler records effects in `spike_effects` and
moves the row's status. A worker that must be killed runs as a child process
(`tsx <candidate>/worker.ts`) killed with SIGKILL.

| # | Requirement | Pass when |
|---|---|---|
| R1 | Transactional enqueue | Accept then ROLLBACK → no job ever runs (wait 3 s). Accept COMMIT → the job runs. No reconciler allowed for this proof. If impossible natively, state what compensates and measure the gap. |
| R2 | Idempotent accept, one active per subject | The same `command_id` twice → one row, one run. Two commands for one subject while the first is active → the second is refused by the DB, not the runner. A different subject runs concurrently. |
| R3 | Identity-only payload | Only `operationId`/`subjectId` are persisted by the runner (inspect its tables/keys). |
| R4 | Deadline, no automatic re-run | SIGKILL the worker mid-run. Within deadline + one sweep, the row is `interrupted`, the handler's `runs` stays 1, and restarting a worker does not run it again. Say whether the library re-runs by default and how that was turned off. |
| R5 | Durable wait/signal | The handler calls `waitForSignal("answer", 10_000)`, row `waiting`. SIGKILL the worker, restart, `signal(...)` → the handler continues with the payload **without repeating effects recorded before the wait**. A second test: no signal → timeout → row `failed` or `interrupted`. If R4 (no re-run) and R5 (resume) conflict in this library, say how. |
| R6 | One snapshot | In one `REPEATABLE READ` read-only transaction, read the operation row and any runner state needed to know the status; both agree while a writer races (100 iterations). State whether the runner's own state is needed at all. |
| R7 | Concurrency | Two worker processes, concurrency 4 each, 40 operations over 10 subjects: at no instant are two operations of one subject running (record start/end effects and check overlaps); all finish. |
| R8 | Drain | `stop()` during a run lets it finish (or reports what happens) and takes no new work. |
| R9 | Failure visibility and replay | A handler that throws: where is the failure visible, and can it be retried explicitly? No silent auto-retry for this job type. |
| R10 | Ops (desk + measured) | New service needed? Schema: who creates it (library migrator vs drizzle-kit; our constitution allows raw SQL only in drizzle-kit migrations or ADR-approved primitives). Decorators required? License, latest version and release date, maintainers/activity, install size (`du` of node_modules delta), Windows dev issues seen. |

## Rules for the spike code

- TypeScript strict, no `any`, no `as unknown as`, **no comments in .ts files** (a hook blocks them).
- Keep everything inside your candidate folder; do not edit `shared/` (report if it blocks you).
- Do not modify anything outside `spikes/operations-runner/`.
- Pin the exact library version you installed in FINDINGS.md.

## FINDINGS.md (each candidate folder, ≤ 80 lines)

A table R1–R10 with: PASS / PARTIAL / FAIL, the proving test name (or doc link for R10 desk items), and one line of evidence. Then "Compensations needed" (code we would still own), "Risks", and "Verdict" in three lines.
