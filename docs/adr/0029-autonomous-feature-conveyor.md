# ADR-0029: Autonomous parent conveyor

- **Status**: Accepted (tooling mechanics amended by [ADR-0040](0040-claude-code-agent-harness.md): Claude Code subagents replace Cursor cloud Tasks; decisions unchanged)
- **Date**: 2026-08-28
- **Deciders**: owner (encoded from the SHO-183 staff price-lists run)

## Context

ADR-0023 and `docs/pipeline.md` assumed the human is the conductor: one
`/ticket` thread per child, **a human merges**, and “there is no automatic
orchestrator.” Writer ≠ reviewer when `/review` or `/guard` runs.

The SHO-183 feature run used a **parent** Cloud Agent as orchestrator:
one isolated cloud `/ticket` executor per child, sequential because
`pricing` and `apps/mobile` files overlapped, squash-merge when GitHub
Actions was green. That worked for backend and UI, including `sensitive`
children. Isolated `/review` often finished **after** squash-merge;
REQUEST CHANGES then became new children (SHO-198–SHO-200) instead of
blocking the merge. Majors from SHO-189 / SHO-190 therefore landed on
`main` first.

Two process facts that run contradicted the old manual:

1. **Nested Task tools fail in cloud executors.** A child launched with
   Task `environment: cloud` cannot launch nested Task `bugbot`, isolated
   `/review`, or `security-review`. Executors that treated that as a
   ticket failure (or that applied `review.md` / `guard.md` and called it
   independent review) made the writer the reviewer. Filed as SHO-197.
2. **GitHub-hosted Cursor Bugbot / Security Reviewer checks are not a
   reliable merge gate.** They often land `neutral`, after merge, or as
   “usage limit reached.” The seven GitHub Actions jobs plus parent-launched
   Task Bugbot / security-review gated SHO-183 merges. The owner then
   decided isolated `/review`, **when launched**, must also gate merge
   (2026-08-28): do not launch a review you are willing to ignore.

Waiting for Cursor to allow nested Task from a cloud child would block
every autonomous feature run. Requiring a human merge on every child
throws away the run that already shipped SHO-184–SHO-190 and SHO-198–SHO-200.

## Decision

A **parent orchestrator** may run the feature loop for a Linear feature
parent (`/implement SHO-<parent>` or `/ticket SHO-<parent>` when that
issue has children or label `Feature`). The parent does not implement
and does not edit product code on a child branch. It launches one cloud
`/ticket` executor per child, attaches independent reviews from **its**
conversation, and squash-merges when the merge gate in
`.cursor/commands/conveyor.md` is green.

Children on one feature are **sequential by default**. Linear `blocked
by` is not a parallel permit: same module, schema, mobile feature folder,
or i18n namespace overlap (SHO-184 / 186 / 185 were all Todo and still
had to run one at a time). Parallel only when path sets are disjoint.

If Actions is red or parent Task Bugbot / security-review is blocking,
the parent relaunches a cloud executor on the **same** PR branch. It
does not fix the child itself. After merge, wait until `origin/main`
has the merge SHA before starting the next child.

Process-gap siblings (docs / Improvement with no module label, like
SHO-197) stay off the product queue unless they **are** the named
parent.

**Writer ≠ reviewer** is the parent’s independent Task Bugbot,
security-review, and `/review` — not nested tools inside the child, and
not the child’s in-process self-check.

Launch isolated `/review` when the lane requires it (`sensitive`,
first-slice, UI, or a prior REQUEST CHANGES on this feature). Do not
launch it on mechanical or ordinary routine backend. **If it is
launched, wait for the verdict before squash-merge.** REQUEST CHANGES
with blockers/majors **and nits** are same-branch fixes (parent
relaunches a cloud executor on that PR). After majors, `/review` again.
After a nits-only apply, merge on green CI — do not start an infinite
taste loop. Skip a nit only when it contradicts the card, golden, or an
ADR. A verdict that arrives only **after** merge (hung agent, dropped
notification) becomes a **new** child — fallback, not the happy path —
including leftover nits, so they are not comments on Done.

Nested Task unavailability in cloud executors is **expected**. Children
must not fail the ticket for it. They self-check `review.md` / `guard.md`
and leave independent review to the parent.

A human still closes the **feature parent**. Children go Done on merge.
A leaf `/ticket` that is not under a parent conveyor still does not
merge itself.

## Alternatives considered

- **Wait for nested Task in cloud executors** — rejected: it blocked
  SHO-183; the parent can already launch those tools.
- **Keep “human merges every PR”** — rejected for the parent-conveyor
  path: the owner ran autonomous squash-merge on green Actions. Leaf
  `/ticket` without a parent still does not merge.
- **Treat executor self-check as independent `/review`** — rejected:
  writer = reviewer. Self-check is extra; parent Task tools are the
  independent pass.
- **Block merge on GitHub Cursor Bugbot / Security Reviewer checks** —
  rejected: usage limits and late/neutral checks stalled PRs that already
  had parent Task Bugbot + security-review + green Actions.
- **Parallelize every Linear-unblocked child** — rejected: SHO-183
  backend tickets shared `packages/modules/pricing` and would have
  collided. Default sequential.
- **Parent implements CI / Bugbot fixes** — rejected: that collapses
  isolation and makes the conductor the writer. Relaunch a cloud
  executor on the same branch.
- **Merge while isolated `/review` is still running; file follow-ups
  after** — how SHO-183 ran; rejected by the owner: majors reached
  `main` (SHO-189 / SHO-190). Wait when `/review` is launched. Post-merge
  children are fallback only.
- **Leave nits as Linear comments** — rejected by the owner: comments on
  Done tickets are never seen. Fix nits on the same branch before merge.
  After merge (fallback), nits get a follow-up child too.

## Consequences

- Commands: `/implement`, `/ticket` on a Feature parent, and `/conveyor`
  all run `.cursor/commands/conveyor.md`. Leaf path is unchanged except
  draft PRs, Linear `In Review`, Linear `gitBranchName` +
  `skip_branch_prefix_check`, and the SHO-197 nested-Task rule. Default
  sequential; same-branch cloud relaunch for CI/Bugbot fixes.
- `docs/pipeline.md` describes the optional parent conductor. ADR-0023’s
  four roles stay; this ADR adds who launches them on a whole feature.
- When `/review` is launched, it is a merge gate. Nits are same-branch
  fixes before merge, not comments and not happy-path tickets. Post-merge
  findings (majors or nits) become a **new** child only as fallback;
  never reopen Done.
- Process-gap tickets like SHO-197 are documentation, not module work.
