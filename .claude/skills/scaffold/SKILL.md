---
name: scaffold
description: Leftover phase 0–1 foundation work on allowlisted packages (core, db, contract, config, tooling, minimal api/worker composition, CI). Not for domain features — those use /feature.
argument-hint: <foundation task>
disable-model-invocation: true
---

# /scaffold — leftover foundation (phases 0–1 only)

Task: **$ARGUMENTS**

Unlike `/ticket`, you ARE allowed to create and modify the foundation
packages — that is the point of this stage. New domain features use
`/feature` (ADR-0023), including any golden slice. Editing `packages/core`
or `packages/db/migrations/` is guarded by design: approve the prompt in the
main checkout, or start a worktree session with `SHOWZY_ALLOW_CORE_EDIT=1` /
`SHOWZY_ALLOW_MIGRATION_EDIT=1` (e.g. in `.claude/settings.local.json` `env`)
only for scaffold work.

## Allowlist — create/modify ONLY

- `packages/core` — `defineAction`, principal contexts (ADR-0013), registry,
  `ctx.call` (ADR-0015), outbox client, event bus, idempotency, audit, typed
  errors.
- `packages/db` — Drizzle schema (`src/schema/<module>.ts` + `foundation.ts`,
  ADR-0014), migrations, seed, Testcontainers harness. Domain schema for a
  golden slice only when the `/feature` ticket says so.
- `packages/contract` — oRPC router derived from the registry; the
  client-safe contract layer (no Node/DB imports reachable from clients).
- `packages/config` (validated env) and `packages/tooling` (eslint presets
  incl. boundaries, tsconfig, prettier).
- Minimal `apps/api` transport/auth composition, `apps/worker` outbox
  dispatcher, and the client bundle-probe fixture required to execute the
  foundation protocols; no product UI.
- CI workflows, Docker Compose, root monorepo config, per-package `AGENTS.md`.

Anything else (domain modules, mobile/web features) is out of scope — stop
and report. Payments / feature-flag skeletons wait on a `/feature` card.

## Process

1. Work from the protocol manuals in `docs/specs/` (`core`, `db`, `contract`,
   `security-operations`, `money`, `companies-foundation`), accepted ADRs
   (especially ADR-0016), and the ownership map. Patch a protocol manual in
   this PR only when a test proves it wrong. Unresolved product decisions stop
   the task.
2. One foundation PR at a time (you may prepare the next non-conflicting task
   in a separate worktree). ~300 lines is review comfort. Sensitive and
   first-core PRs get `/guard` plus full human review; mechanical scaffold PRs
   get CI + a human skim.
3. Tests for the foundation invariants (blueprint §2.1) that modules inherit:
   the cross-tenant harness is parameterized over all principal modes
   (ADR-0013). Red-then-green is not required for schema or config.
4. `node .claude/scripts/verify.mjs --full` before opening the PR; for core
   changes also check `tsconfig.contract.json` typecheck and API
   `contract:check` (see `packages/core/AGENTS.md`).

## Exit gates

- `tsc`, ESLint boundaries, Vitest (unit + Testcontainers), and the contract
  check are green in CI, with branch protection enabled.
- Foundation invariant suites pass: tenant isolation (all principal modes),
  idempotency, money snapshot immutability, audit records, projection
  ownership.
