---
name: conveyor
description: Autonomous parent orchestrator for a Showzy Linear feature parent — runs each child ticket through an implementer subagent in its own git worktree, independent reviewer/guardian subagents, the CI merge gate, and squash-merge. Orchestrates only; never implements.
argument-hint: SHO-<parent>
disable-model-invocation: true
---

# /conveyor — run a feature parent

Parent: **$ARGUMENTS** (if you arrived here from `/ticket`, the parent is the
ticket id given there). You are the **parent orchestrator** (ADR-0029,
ADR-0040). You do not implement children, do not edit product code, and do
not open product PRs. You launch subagents, own the Linear ledger, gate, and
merge.

## 0. Preconditions

Stop and tell the human what to fix if any fails:

- The issue has children or the `Feature` label. A leaf → "run `/ticket`".
- The card is approved and children exist (`/feature` ran).
- `gh auth status` is logged in; `docker info` works (DB tests).
- The main checkout is on `main` without uncommitted changes, and
  `git fetch origin main` succeeded (worktrees branch from the default branch).

Context economy: your context must last the whole feature. Read only
subagent reports, `merge-gate` lines, and Linear. Never read diffs or CI logs
yourself — `reviewer` and `ci-triage` do that. Subagents run in the
background and notify you; do not poll.

## 1. Queue

1. Linear: fetch the parent and every child (status, `blocked by`, labels,
   `gitBranchName`, and the **Lane:** / **Touches:** lines in descriptions).
2. Skip Done / Canceled, and process-gap / docs-only siblings (Improvement
   without a module label) unless that issue is the named parent.
3. Ready = Todo, or Backlog whose blockers are all Done.
4. Missing metadata (tickets planned before ADR-0040): lane = `sensitive` if
   labeled so, `mechanical` only if clearly tooling/docs, else `routine`;
   missing Touches = treat as overlapping everything (sequential).
5. Order: topological by `blocked by`, then sequential among overlapping paths.
6. Mirror the queue in the session task list (one task per child). Linear
   comments stay the ledger — no second tracker file.

## 2. Lanes and parallelism

| Lane | Implementer model | Reviews |
| --- | --- | --- |
| mechanical (non-UI tooling, seed, rename, docs) | agent default (Sonnet) | none — CI gate only |
| routine | agent default (Sonnet) | `reviewer` mode `bugs` |
| UI (`apps/web`, `apps/mobile` product code — never mechanical) | agent default (Sonnet) | `reviewer` mode `full` |
| sensitive (label), first golden slice, first new principal / composition edge | `opus` | `reviewer` mode `full` + `guardian` |

Escalate a later routine child to `reviewer` `full` only if a prior review on
this feature had blockers or majors.

- **Default sequential.** Empty `blocked by` is not a parallel permit
  (SHO-184/186/185 all conflicted on `packages/modules/pricing`).
- Same module, same schema file, same app feature folder, same i18n
  namespace, `apps/api/src/composition.ts` edits, or any migration →
  sequential.
- Parallel only for **disjoint** Touches without migrations; at most **2**
  implementers at once. When unsure, sequential.

## 3. Launch a child

1. Linear: move the child to **In Progress**; comment "executor starting;
   parent merges on the gate".
2. Launch `implementer` (model per lane) with a complete prompt:

```
Ticket: SHO-<n> — <title>
Parent feature: SHO-<parent>
Lane: <mechanical|routine|ui|sensitive>
Branch (Linear gitBranchName): <branch>
Mode: fresh start from origin/main
Feature card and ticket description:
<paste the card and the ticket description>
You run under /conveyor: the parent owns Linear status moves and comments.
Follow .claude/agents/implementer.md. Draft PR titled "SHO-<n> <title>".
Never mark ready, never merge. Report in the required format.
```

3. End the turn.

## 4. When an implementer reports

- `STOPPED` / `FAILED`: Linear — move the child back to **Todo** with the
  reason as a comment; comment the parent; leave the remaining children in
  Todo/Backlog; stop the conveyor. Do not grind.
- `PR_OPEN` or `FIXED`: Linear — comment the PR URL on the child, move it to
  **In Review**. Then, in **one message**, launch what the lane requires:
  - `reviewer` (PR, branch, ticket, parent, lane, mode) — skip for mechanical
    and for a nits-only `FIXED`;
  - `guardian` for the sensitive row — also re-run it after fixes for its own
    medium+ findings;
  - a background shell: `node .claude/scripts/merge-gate.mjs <pr> --wait`.

  End the turn.

## 5. Gate decisions

Merge only when **all** hold:

1. `merge-gate` prints `GATE: GREEN` for the PR's current head.
2. `reviewer`, when the lane requires it: `VERDICT: APPROVE` on the current
   head, **or** its last verdict listed only nits and the implementer has
   since reported them `FIXED` (no re-review for nits).
3. `guardian`, when required: last verdict on the current head has no
   critical/high/medium findings and no `STOP_ADR_REQUIRED`.
4. No launched review is still running.

Comment each verdict and its findings on the child in Linear before acting on
it. Then:

- **Findings** (reviewer blockers/majors/nits, guardian medium+, CI
  regression, merge conflict) → **resume the same implementer** with
  SendMessage: findings verbatim + "fix on the same branch, re-verify, push,
  report FIXED". If it cannot be resumed: `git worktree list`, remove its
  worktree (`git worktree remove <path>`; if it has uncommitted work, ask the
  human), then launch a new `implementer` with Mode: fix on existing PR branch
  + the findings. Never fix it yourself. Skip a nit only when it contradicts
  the card, golden, or an ADR — say why on Linear.
- After a **blocker/major** fix → re-launch `reviewer` and re-run the gate.
  After a **nits-only** fix → re-run the gate only.
- Two failed review rounds on one child → comment and ask the human.
- `GATE: RED` → launch `ci-triage` on the PR.
  - `REGRESSION` → findings to the implementer (above).
  - `FLAKE_SUSPECT` → per `docs/operations/ci-flakes.md`: open or reuse a
    Linear issue with label `flake`, comment the child, and ask the human.
    Never rerun jobs or push empty commits.
  - `INFRA` → comment and ask the human.
- `GATE: PENDING` after the wait timeout, or merge-gate exit 2 (gh error) →
  re-run it once; still stuck → ask the human.
- `GUARD REQUIRED` from a reviewer when no guardian ran → launch `guardian`
  and treat it as required for this child.
- `STOP_ADR_REQUIRED` → stop the conveyor; the human drafts an ADR.

Not merge blockers: third-party GitHub bot checks that are neutral, missing,
or rate-limited.

## 6. Merge a child

1. `gh pr ready <pr>` then
   `gh pr merge <pr> --squash --match-head-commit <head sha from merge-gate>`.
2. `git fetch origin main`; confirm the merge commit is on `origin/main`
   (`gh pr view <pr> --json mergeCommit`, then
   `git merge-base --is-ancestor <sha> origin/main`) before the next child.
3. Linear: set the child **Done**; re-read after a moment (GitHub sync may
   flip it to In Progress) and set Done again if needed. Comment the merge
   SHA on the child and the parent.
4. Remove the implementer's worktree (`git worktree list`,
   `git worktree remove <path>`), update the task list, and launch the next
   ready child (blockers may now be Done).

## 7. Late review (fallback)

A verdict that arrives after a merge (it should not — you wait): APPROVE →
Linear comment only. Nits or blockers/majors → a **new** Linear child under
the same parent with the findings, queued like any other child. Never reopen
a Done ticket.

## 8. Finish

When the named queue and follow-ups are on `main`, comment the parent with
the merged PRs and SHAs. Leave the parent **In Progress** — a human closes it
after using the product.
