# ADR-0040: Claude Code is the agent harness

- **Status**: Accepted
- **Date**: 2026-09-11
- **Deciders**: owner (+ Claude)

## Context

ADR-0023 defines the roles (Planner, Executor, Verifier, Guardian) and
ADR-0029 the autonomous parent conveyor. Both were encoded for Cursor:
rules in `.cursor/rules/*.mdc`, playbooks in `.cursor/commands/`, cloud
Task executors, Cursor Bugbot / security-review Task tools, and Grok 4.6 as
the only working model.

The owner is moving day-to-day development to Claude Code on a Claude Max
plan and running the conveyor locally (Windows workstation, Docker Desktop,
`gh`). Cursor-specific mechanics do not exist there:

- There is no `alwaysApply` / `globs` `.mdc` format. Claude Code loads
  `CLAUDE.md` (which can import `AGENTS.md`), `.claude/rules/*.md` (always,
  or lazily by `paths`), nested `CLAUDE.md` lazily, skills only on
  invocation, and subagents from `.claude/agents/`.
- Subagents can run in their own git worktree and in the background, and the
  parent launches reviewers directly — the SHO-197 nested-Task gap that
  forced self-checks in cloud children does not exist.
- A single model family is no longer a constraint; roles can use Opus,
  Sonnet, or Haiku.
- Token usage is a cost driver: repeated context loading, raw CI/test logs,
  and relaunching executors that re-read the same context dominated
  conveyor runs.

## Decision

Claude Code is the agent harness for this repository. `.claude/` replaces
`.cursor/` and `.agents/` as the single source of agent configuration, and
ADR-0023/ADR-0029 run through it:

- `CLAUDE.md` imports `AGENTS.md`; nested `CLAUDE.md` files import package
  `AGENTS.md`. `AGENTS.md` stays tool-agnostic.
- Constitution = `.claude/rules/constitution.md` + `definition-of-done.md`
  (always loaded); area rules are path-scoped.
- Playbooks are skills: `/feature`, `/ticket`, `/conveyor`, `/verify`,
  `/review-pr`, `/guard`, `/scaffold`. `/implement` is retired (`/ticket`
  dispatches feature parents to `/conveyor`).
- Roles are subagents: `implementer` (worktree, Sonnet by default, Opus for
  sensitive/first-slice), `reviewer` and `guardian` (read-only, Opus; the
  guardian absorbs security review), `ci-triage` (Haiku).
- Conveyor mechanics: one background `implementer` per child in its own
  worktree; reviews launched by the parent; findings return to the **same**
  implementer via resume; merge on `merge-gate.mjs` GREEN + launched review
  verdicts; squash-merge with `gh`. Sequential by default; parallel only for
  disjoint declared **Touches** without migrations, at most two at a time.
- Local verification is `node .claude/scripts/verify.mjs` (affected gates,
  compact output, logs on disk).
- Team permissions and a path guard hook live in `.claude/settings.json`;
  personal overrides in `.claude/settings.local.json` (gitignored).

ADR-0029's decisions (parent orchestrates, writer ≠ reviewer, sequential
default, review verdict gates merge, nits fixed before merge, late verdicts
become new children, a human closes the parent) are unchanged.

## Alternatives considered

- **Keep Cursor and mirror rules into `.claude/`** — rejected by the owner:
  two rule trees drift, and every rule change doubles.
- **Claude Code on the web as the conveyor runtime** (analogue of Cursor
  cloud agents) — deferred: needs a cloud environment with Docker for the
  Testcontainers suite; local worktrees reuse the owner's Docker and pnpm
  store. Revisit when parallel capacity matters more than setup cost.
- **One model for every role** — rejected: Opus for implementation of
  routine tickets spends limits without a measurable quality gain once an
  independent Opus reviewer gates merge; Haiku is sufficient for log triage.
- **Per-edit formatting hook** — rejected: one prettier pass in
  `verify.mjs` over changed files is cheaper and avoids stale-read edits.
- **GitHub MCP for PR operations** — rejected: `gh` output is smaller and
  scriptable (`merge-gate.mjs`).

## Consequences

- `.cursor/`, `.agents/`, and `.cursorignore` are removed; historical ADRs
  keep their original `.cursor/...` references as records.
- `docs/pipeline.md` and blueprint §7 describe the Claude Code loop and the
  per-role model table. ADR-0029's SHO-197 section is historical.
- `apps/web/src/test/architecture-contract.test.ts` pins the web skill and
  rule at their `.claude/` paths.
- Worktrees live under `.claude/worktrees/` (gitignored). Repository scripts
  that walk the whole tree must skip `.claude/`
  (`packages/tooling/ci/test-suite-files.mjs`).
- Each contributor installs Claude Code, logs in with the Max account,
  connects Linear and Magic Patterns, and authenticates `gh`; see
  `docs/operations/claude-code-setup.md`.
