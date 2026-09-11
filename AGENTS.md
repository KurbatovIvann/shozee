# Shozee 2.0 — Agent Instructions

Ground-up rewrite of Showzy v1: a business operating platform for Ukrainian
small businesses. Classic UI and AI chat execute the same actions
(ADR-0008, ADR-0033).

## Destination

The staff UI and the staff assistant finish the **same jobs** through the
**same executeAction handlers**. An action is a staff job, not a screen
widget: a list answers a bounded question (page or aggregate); a write
accepts a stable id or a unique human reference. The assistant may see a
narrower mapped schema in `packages/ai`; that is not a second domain API.
Cross-module phrases stay several writes. Composition-only reads are not
AI tools. Details: `.claude/rules/actions-and-ai.md` and
`docs/adr/0033-channel-neutral-actions.md`.

## How we work

You are part of the team that builds and runs this system, not a service
that closes tickets. The ticket is how the work is divided; the system is
what we are responsible for. A green PR that makes the next three changes
harder is not done. If the ticket, the card, or a rule looks wrong, say so
with evidence — silent compliance and silent deviation are both failures.

**Think past the ticket.** Before changing something others depend on — a
contract, a protocol, a schema, a shared package — find its readers and
ask what the change makes true for them. Name consequences in the PR even
when fixing them is out of scope. When two places derive the same fact,
one will eventually disagree: prefer one source.

**ADRs are dated decisions, not laws.** An ADR records what was right given
its Context on its date. Follow it by default; do not reopen it on taste.
Reopen it when you hold a fact its Context did not: the task cannot be done
without working around it, the code shows its premise no longer holds, or
a clearly better design requires changing it. Then stop and bring it to
the human: which ADR, which sentence of its Context no longer holds, what
you would otherwise have to build, and the alternative. That stop is a good
outcome. Keeping an ADR's wording while defeating its purpose is not
compliance.

**Fix causes, not symptoms.** A workaround is code whose job is to
compensate for a decision made elsewhere: reconstructing state that was
never stored, a second copy of a protocol on a client, a flag that skips a
check, a retry over a race. When a bug appears, find out why it is possible
before fixing it, and fix it at the level of the cause. If the cause is a
decision — an ADR, a contract, a schema shape — stop instead of patching
around it. A second fix for the same class of defect means the problem is
not the code in front of you.

Judgment is not licence to redesign. Mechanics and taste inside the rules
are yours to settle; decisions (ADRs, contracts, schemas, invariants) belong
to the team and change through the human.

Why this is written down: ADR-0034–0037 were all superseded by ADR-0038.
Six of the eight commits after ADR-0037 shipped fixed one defect class, and
none were bugs in the loop — they came from resume being a reconstruction
and the client owning a copy of the protocol. Each fix was reasonable on
its own; together they hid that the decision underneath was wrong.

## No production yet

There is no production environment: no production database and no deployed
infrastructure (owner, 2026-09-11). The eventual database is created fresh
and migrated from `0001`. Until that changes, do not spend a ticket on what
only production would feel.

- **Out of scope now:** Redis persistence and what a restart loses, deploy
  drain and stop grace periods, backups and restore, ingress and proxy
  settings, capacity, and backfills of existing data.
- **Record, do not build.** When a change has a production consequence,
  write it down as a requirement where the topic lives (`docs/specs/db.md`
  §6, the feature's runbook in `docs/operations/`) and move on. Reviewers
  and guardians report such an item as a production requirement, not as a
  finding to fix, and it never blocks a merge.
- **Still in scope, fully:** correctness, tenant isolation, idempotency,
  security of the code and its data paths, and anything that fails in
  development, CI or tests.

When a production environment is being built, every recorded requirement is
checked then.

## Contract of this thread

The executable contract is the Linear feature card plus `*.contract.ts` and
the tests in the definition of done. Protocol manuals for frozen packages
live in `docs/specs/` (`core`, `db`, `contract`, `money`,
`security-operations`, `companies-foundation`). **Do not open
`docs/archive/`** unless the human names a file. For v1 column archaeology
use `docs/reference/`. Do not contradict an accepted ADR in `docs/adr/`;
deviations need a new ADR first.

Documentation map: [`docs/README.md`](docs/README.md). Read the root and
nearest package/feature `AGENTS.md`, then the task context pack.

Repository rules live in `.claude/rules/`. `constitution.md` (prohibitions
and conventions) and `definition-of-done.md` always apply; the area rules
(`actions-and-ai.md`, `web.md`, `mobile.md`, `mobile-ui-state.md`) apply
when their paths are touched. Claude Code injects them; any other tool must
load them explicitly.

## Non-negotiable invariants (blueprint §2.1)

1. **Tenant isolation.** Tenant scope comes from a verified action context
   (staff membership, typed customer/public/share target resolver, explicit
   system scope, or null company for `consumer` and declared public global
   discovery projections — ADR-0013, ADR-0018, ADR-0020, ADR-0022), never
   from an input identifier as an access grant.
   Cross-tenant access must be impossible and is verified by tests every
   module inherits.
2. **Idempotency.** Orders, payments, document generation, webhooks, and
   AI-invoked actions are safely retryable.
3. **Money snapshots.** Order items store immutable price/discount/tax
   snapshots captured at creation time. Never recompute old orders from
   current pricing.
4. **Observability / audit.** Authorized tenant actions carry `request_id`,
   accountable `actor_id` (user/system), invocation `channel`,
   `company_id`, and `action`; global system work has null company and public
   reads use log-only actor `anonymous` (never audit/events).
5. **Projections never own domain state.** Chat is the primary interaction
   surface for orders, but the order domain is the source of truth. A chat
   message stores `orderId`, never order status. `orders` emits events
   (`orders.confirmed`); `chat` subscribes and materializes cards.

## Core rules

- **One data path.** `defineActionContract` describes an action;
  `implementAction` binds it; `executeAction` runs it. Clients never touch
  the DB directly. Authorization lives in action `permissions`.
- **TypeScript strict end-to-end.** No `any`, no `as unknown as`.
- Module server barrels export actions/events, not internals. Cross-module
  reads use declared `ctx.call` edges through public action exports
  (ADR-0015); writes use events or declared `ctx.callAtomic` capabilities
  (ADR-0021). Import boundaries and approved subpaths are enforced by
  ESLint; ownership is in `docs/module-ownership.md`. Shared server
  micro-utilities belong to `@showzy/module-kit` (ADR-0031).
- Explicit code, no magic: no decorators with hidden behavior, no DI
  containers.
- All code, comments, and documentation are in **English**.

## CI flakes

A red Vitest on an unrelated file is a **flake or a real regression**,
not a reason to retrigger CI. Open or reuse a Linear issue with the
`flake` label. Never push `--allow-empty` (or an equivalent no-op
commit) to turn CI green. Do not add Vitest `retry` or GitHub Actions
rerun-on-failure — those hide the same bugs. Details:
`docs/operations/ci-flakes.md`.

## Area skills

When the task touches `apps/mobile`, load
`.claude/skills/showzy-mobile/SKILL.md` before writing code. Do not load
Expo skills for backend or module work.

When the task touches `apps/web`, load
`.claude/skills/showzy-web/SKILL.md` and `apps/web/AGENTS.md` before
writing code. Do not load Expo skills for web work. The panel is a Vite
SPA (ADR-0030), not the mobile client and not the future storefront.

When the task adds or changes a module action, event, owned schema, or
module tests, load `.claude/skills/showzy-backend/SKILL.md` (golden-file
map) instead of rediscovering the golden slice.

## Feature pipeline

`/feature <capability>` plans a Linear feature card and ticket graph.
`/conveyor SHO-<parent>` runs the autonomous parent orchestrator: one
`implementer` subagent per child in its own git worktree, independent
`reviewer` / `guardian` subagents from the parent, squash-merge on the
merge gate. `/ticket SHO-<n>` runs one leaf interactively (a human merges).
Children on one feature are sequential by default; parallel only for
disjoint declared paths without migrations, at most two at a time. Manual:
`docs/pipeline.md`; decisions: ADR-0029, ADR-0040.
A human closes the feature parent.

Local CI-equivalent checks: `node .claude/scripts/verify.mjs` (affected
packages only, compact output). PR merge gate:
`node .claude/scripts/merge-gate.mjs <pr>`.

## Legacy reference (Showzy v1)

The previous implementation lives in a separate repository (locally at
`E:\showzy`). **Never modify it.** Curated extracts in this repo are
usually enough:

- `docs/reference/v1-backend-audit.md`
- `docs/reference/v1-database.types.ts`
- `docs/reference/v1-migrations/`

The v1 schema is a reference, not a template. V2 uses code-level
permissions and Drizzle in action handlers (blueprint §6).
