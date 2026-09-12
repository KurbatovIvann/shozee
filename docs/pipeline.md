# Agent Pipeline — Operations Manual

How the feature loop from `docs/blueprint.md` §7 and ADR-0023 runs in
**Claude Code** (ADR-0040). The blueprint defines *what* the roles are; this
file is the day-to-day checklist: which skill, which subagent, what goes in,
what comes out, and when a role is done.

Everything agent-facing lives in `.claude/`:

| Path | Holds |
| --- | --- |
| `CLAUDE.md` → `AGENTS.md` | Entry point (imports the tool-agnostic `AGENTS.md`); nested `CLAUDE.md` files import the nearest package `AGENTS.md` lazily |
| `.claude/rules/` | Constitution (`constitution.md`, `definition-of-done.md` — always loaded) and path-scoped area rules (`actions-and-ai.md`, `web.md`, `mobile.md`, `mobile-ui-state.md`) |
| `.claude/skills/` | Workflow playbooks (`/feature`, `/ticket`, `/conveyor`, `/verify`, `/review-pr`, `/guard`, `/scaffold`) and code-pattern skills (`showzy-backend`, `showzy-web`, `showzy-mobile`, vendored Expo/RN skills) |
| `.claude/agents/` | Subagent roles: `implementer`, `reviewer`, `guardian`, `ci-triage` |
| `.claude/scripts/` | `verify.mjs` (local CI-equivalent, affected-only, compact output) and `merge-gate.mjs` (required Actions jobs on a PR) |
| `.claude/settings.json` | Team permissions (allow/ask/deny) and the path guard hook |

**Two ways to run the loop.**

1. **Leaf** — `/ticket SHO-<n>` in a session (use `claude -w sho-<n>` for a
   separate worktree). The session implements, verifies, opens a draft PR,
   and launches independent `reviewer` / `guardian` subagents. **A human
   merges.**
2. **Feature parent** — `/conveyor SHO-<parent>` (or `/ticket` on an issue
   with children / label `Feature`) runs the **parent orchestrator**
   (ADR-0029). It launches one background `implementer` per child in its own
   git worktree, launches independent reviews from **its** conversation,
   waits on `merge-gate`, and squash-merges when the gate is green. A human
   still closes the feature parent.

**Writer ≠ reviewer** is structural: the writer is the `implementer` (or the
`/ticket` session); reviewers are separate subagents with fresh context and
no edit tools. Unlike Cursor cloud children, subagents are launched from the
parent, so there is no nested-review gap (ADR-0029's SHO-197 limitation no
longer applies).

```
PLANNER → [parent orchestrator, optional] → EXECUTOR → VERIFIER → GUARDIAN
/feature   (/conveyor on a feature parent)  implementer  reviewer   guardian
                                            (worktree)   (+ CI gate)
```

Constitution stays: blueprint §2–§6, accepted ADRs (including ADR-0033),
`.claude/rules/`, `docs/scope.md`, `docs/module-ownership.md`. Do not open
`docs/archive/`. The executable contract of a feature is `*.contract.ts`
plus the tests in the definition of done.

## Models and token economy

Working models on the Claude Max plan (ADR-0040). Quality anchors stay on
Opus; volume work runs on Sonnet; log reading runs on Haiku. **The writer is
never Opus.**

| Role | Model | Why |
| --- | --- | --- |
| Planner (`/feature`), orchestrator (`/conveyor`) | Opus (session model) | Product forks, sequencing, merge decisions — few turns, small context |
| `/ticket` session (any lane) | `opusplan` (Opus plans, Sonnet edits) or Sonnet | Same split as the implementer |
| `implementer` (every lane, incl. sensitive) | Sonnet, medium effort — no override | Pattern-following implementation; quality is gated by the Opus reviewer |
| `reviewer`, `guardian` | Opus, high effort, no MCP | Independent gate; a different model than the writer |
| `ci-triage` | Haiku, ≤ 15 turns | Reads failing logs so no one else has to |

What the first conveyor run (2026-09-12, $550, 13 h API) showed: 99% Opus,
the implementer 52% of usage, 84% of turns above 150k context, cache reads
103M tokens. Cost is **context length × number of turns**, not output. The
fixes below target exactly that.

1. **Small tickets.** ≤ 400 changed lines, ≤ ~12 files (`/feature`). The
   run's children were 2–3k lines; every read, verify, review, and fix
   round scaled with that. An implementer that sees the ticket growing past
   the cap reports STOPPED with a split instead of finishing.
2. **Sonnet writes, Opus reviews.** No per-lane model override for the
   implementer. Two STOPPED/FAILED reports on one ticket are a question for
   the human, not a reason to switch models.
3. **Read narrowly.** Grep first; `Read` with offset/limit; no whole files
   over ~300 lines; test files by `describe` block; never re-read after an
   edit; one verify run at the end (`--only` for retries). This is in
   `CLAUDE.md` so every session and subagent carries it.
4. **No prose.** Code has no comments (hook-enforced). Commits are a
   subject and ≤ 3 bullets; PR bodies are the 6-line template; reports are
   fixed formats ≤ 15 lines; Linear comments are one line; the orchestrator
   sends status lines and PROBLEM/OPTIONS blocks only. Prose is written
   once and then re-read on every later turn by every agent that sees it.
5. **Fresh over resumed for real fixes.** Nits → resume the same
   implementer (few turns). Blockers/majors, conflicts, second rounds → a
   fresh `implementer` in `fix` mode (~20k context) instead of resuming a
   150k+ history.
6. **No MCP where it is not needed.** Reviewer, guardian, and ci-triage run
   with an explicit tool list (no Linear, no Magic Patterns); the parent
   passes the card and ticket text in the prompt. Subagents cannot spawn
   subagents (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1`).
7. **Capped tool output.** `BASH_MAX_OUTPUT_LENGTH=16000`; `verify.mjs`
   and `merge-gate.mjs` print summaries, logs stay on disk; noisy commands
   are redirected to `.agent-tmp/`.
8. **Right-sized review.** Mechanical: CI only. Routine: `reviewer` in
   `bugs` mode. UI: `reviewer` `full`. Sensitive: `reviewer` `full` +
   `guardian`. Nits-only fixes merge on green CI without a second review.
   A diff over ~800 lines is itself a finding.
9. **Lazy context.** Only the constitution, `AGENTS.md`, and `CLAUDE.md`
   load at start; area rules by path; package `AGENTS.md` via nested
   `CLAUDE.md`; skills on invocation. Keep `AGENTS.md` short — every line
   is paid for on every turn of every agent.
10. **Worktrees are cleaned after every merge** (`git worktree remove
    --force`, then `prune`); each carries a `node_modules`.
11. **Fresh sessions per unit of work.** One session per `/feature`, per
    `/ticket`, per `/conveyor` run; `/clear` between unrelated tasks.
    Check `/usage` after a run and record the cost per merged PR.

## Role reference

### 1. PLANNER — `/feature <capability>`

| | |
| --- | --- |
| Agent | The session (plan mode, Opus) with Explore subagents for research |
| Input | Constitution, ADRs, ownership map, golden files for the layer, v1 reference only if needed |
| Output | A Linear **feature card**, a ticket graph with **Lane** and **Touches** per ticket, and a 5–15 file context pack. Contested APIs also get a contract-first ticket (`*.contract.ts` only) |
| Done when | You approve the card and tickets exist in Linear with `blocked by` relations |

The agent proposes; you challenge product behavior. Expect a short
iteration, not a novel. Never invent a new principal, table, or invariant
silently — those stop and ask, or need an ADR.

A **feature** is one closed capability (e.g. "staff creates a product with
variants"). An epic is a Linear milestone. A ticket is one branch = one PR
(~300 diff lines is comfort, not a cap). Product screens wait on the
Experience Foundation UX gate; backend tickets do not.

### 2. PARENT ORCHESTRATOR — `/conveyor SHO-<parent>` (optional)

| | |
| --- | --- |
| Agent | One parent session. Children are background `implementer` subagents, each in its own git worktree |
| Input | Approved Linear feature card and ticket graph |
| Output | Each child squash-merged on the merge gate. Parent stays In Progress |
| Done when | Named children and review follow-ups are on `main`. A human closes the parent |
| Isolation | **Default sequential.** Linear `blocked by` empty is not enough (SHO-184/186/185). Parallel only for disjoint **Touches** without migrations; at most two implementers at once |
| Merge gate | `merge-gate.mjs` GREEN on seven Actions jobs (`checks`, `secret-scan`, `dependency-audit`, `contract-check`, `migration-drift`, `bundle-probe`, `e2e-smoke`; `checks` is the fail-closed aggregator, SHO-334) on the head being merged + `reviewer` APPROVE when the lane requires it (nits do not hold it — they become tickets under the feature's slice-nits parent) + `guardian` without medium+ findings when required. No launched review still running. Third-party GitHub bot checks are not gates |

Findings (review blockers/majors, guardian medium+, CI regressions,
conflicts) are same-branch fixes by the **same implementer**, resumed with
the findings. Re-launch `reviewer` after blocker/major fixes. Reviewer nits
and guardian lows are not fixed on the branch: each becomes its own Backlog
ticket under a `<feature>: slice nits` parent (ADR-0029, amended
2026-09-12). **At most two fix rounds per child**; after the second, ask the
human. A late post-merge major becomes a new Linear child (fallback only);
never reopen Done. Playbook: `.claude/skills/conveyor/SKILL.md`.

### 3. EXECUTOR — `implementer` subagent, or the `/ticket` session

| | |
| --- | --- |
| Agent | One executor per ticket, parallel only where the dependency graph **and** path isolation allow |
| Input | The Linear card + ticket, the context pack, the golden files for this layer (`showzy-backend` / `showzy-web` / `showzy-mobile`) |
| Output | A **draft** PR with the required tests; Linear **In Review**; a compact report (`PR_OPEN` / `FIXED` / `STOPPED` / `FAILED`) |
| Done when | PR opened with `verify.mjs` PASS. Description names the feature card, the tests, and any deviations (there should be none — deviations mean stop). The executor does **not** merge |
| Escalation | 2 failed verify/review rounds → ask the human; 3 → design review or a new ADR |

Lanes:

| Lane | When | Run |
| --- | --- | --- |
| **mechanical** | tooling, seed, rename, docs-only, no new action protocol | blockers → implement → verify. No review subagents |
| **routine** | new/changed module action, not `sensitive` | short analyze → implement → verify → `reviewer` (`bugs`) |
| **ui** | `apps/web` / `apps/mobile` product code (never mechanical) | analyze + canvas read → implement → verify → `reviewer` (`full`) |
| **sensitive** | `sensitive` label, first golden backend/UI slice, or first new principal / composition edge | full analyze → implement → verify → `reviewer` (`full`) + `guardian` |

A new layer without an approved reference still needs a first-slice review
before its pattern is copied.

### 4. VERIFIER — CI always; `reviewer` by lane

| | |
| --- | --- |
| Agent | `reviewer` subagent (read-only, own worktree), or `/review-pr <pr>` manually |
| Input | The PR diff + the feature card + golden files + `.claude/rules/` + ADRs |
| Output | `VERDICT: APPROVE` or `REQUEST_CHANGES` with blocker/major/nit findings referencing constitution / ADR / golden / DoD — not an archived spec section |
| Done when | Required reviewers for the lane have run. Leaf `/ticket`: **a human merges**. Parent conveyor: parent squash-merges on the merge gate (ADR-0029) |

### 5. GUARDIAN — `guardian` subagent / `/guard <pr>` (optional)

Safety, security, and irreversibility, not style. Replaces Cursor's separate
security-review agent. Skip on mechanical and ordinary routine work.

| When | What |
| --- | --- |
| `sensitive` label | Auth, payments, QES, webhooks, files, tenant/runtime protocols (money, confirmation) |
| First golden backend or UI slice | Architecture pass vs ADRs and the intended copy template |
| First use of a new principal or composition edge | Same |
| Any ADR deviation | `STOP_ADR_REQUIRED`. Do not land. Draft a new ADR instead |

Done when guardian findings are addressed on the same branch and verify is
green again.

## Golden slices

A golden is a designation, not a special package. Later executors copy those
files. They do not invent a new folder shape. The `showzy-backend` skill is
the map.

**Backend.** The merged order slice and its pricing/chat collaborators
establish the action, transaction, event, and test protocols (ADR-0026).
For new staff list inputs use
[`orders.list`](../packages/modules/orders/src/actions/list.contract.ts);
for reference-aware writes use
[`orders.create`](../packages/modules/orders/src/actions/create.contract.ts)
and its [implementation](../packages/modules/orders/src/actions/create.ts).
ADR-0033 supersedes the early UUID-only / screen-page input shapes.
Select the relevant action, owned schema, exports, suite coverage, and
tests in the feature card's context pack; do not copy the whole module.

**Mobile.** Product feature placement follows
[`catalog/products`](../apps/mobile/src/features/catalog/products/AGENTS.md)
and the [`showzy-mobile` router](../.claude/skills/showzy-mobile/SKILL.md).
Each product screen still needs the recorded
[UX gate](design/process.md#ux-gate) and canvas coverage.

**Web.** Copy the companies onboarding/query patterns named in
[`apps/web/AGENTS.md`](../apps/web/AGENTS.md) and follow the
[web canvas port rule](design/mapping/mp-to-web.md).

Core test fixtures in `packages/core/src/testing/` stay core-internal.

## Linear workflow

Linear (team **Showzy-v2**, via the Linear MCP server) is the work ledger.

- **Project = roadmap phase** (`Phase 0 — Foundation` … `Phase 9 — AI
  Experience`, then `V2 Production Launch`, then `Phase 10 — Web` …) plus
  the parallel `Experience Foundation` project. Milestones inside a project
  = features / vertical slices. **V2 Production Launch is its own project**,
  never a phase milestone.
- **Issue = one ticket** from `/feature` (one branch = one PR).
  Dependencies = `blocked by`; parallel tickets have none. Descriptions carry
  **Lane** and **Touches**.
- **Labels**: the existing child label `<name>` under the `module` group
  (for example `orders`), plus `sensitive` when flagged. Do not invent a
  `spec` or `scaffold` label.
- **Statuses**: Backlog (blocked) → Todo (ready) → In Progress (executor
  running) → **In Review** (draft PR open) → Done (merged). Canceled is for
  dropped tasks. The executor moves the ticket to In Review when the PR
  exists. Linear GitHub sync may flip a ticket to In Progress when a PR is
  marked ready; after squash-merge, set Done again if needed.

Day-to-day loop:

1. New session, plan mode: `/feature <capability>`. Approve the card and
   tickets.
2. **Either** `/conveyor SHO-<parent>` and let it run the graph (check back
   when notified), **or** one worktree session per leaf:
   `claude -w sho-<n>` then `/ticket SHO-<n>` (you merge).
3. Gaps that are product forks (new capability, new principal, new table,
   invariant change, "should this exist") stop the ticket: it returns to Todo
   with a comment. Mechanical contract detail (timeout / rate-limit defaults,
   a Zod refine a test proved, a CHECK/column the card implied, a metadata
   field `defineActionContract` requires) patches in the same PR and is named
   in the description.

## Special roles (outside the main flow)

| Role | When |
| --- | --- |
| Debugging hard bugs | Escalation when an executor can't find the root cause in 1–2 iterations — an Opus session with the failing summary, then a human |
| ADR drafting | When any role hits a decision the blueprint doesn't cover, or wants to deviate from an accepted ADR |
| Leftover foundation | `/scaffold`. Phases 0–1 only; allowlisted packages. New domain work uses `/feature` |

## Rules that keep the pipeline honest

1. **Writer ≠ reviewer** when `reviewer` or `guardian` runs. Reviews are
   separate subagents without edit tools. Do not merge while a launched
   review is still running. Mechanical PRs do not need a review subagent.
2. **The contract is TypeScript.** `*.contract.ts` plus DoD tests. Do not
   write `docs/specs/<module>.md` or open `docs/archive/`. Protocol manuals
   for frozen packages may be patched in the same PR when a test proves them
   wrong; otherwise they change via ADR.
3. **Escalate, don't grind.** 2 failed review or debug iterations → human.
4. **CI is the gate, not a slot machine.** Never rerun a red job to get green,
   never push an empty commit, never add retries (`docs/operations/ci-flakes.md`).
5. **UX gate blocks product screens in `apps/mobile`.** It does not block
   backend features. Mobile UI follows `docs/design/mapping/mp-to-mobile.md`
   and references the Magic Patterns canvas screen, the running Expo SYSTEM,
   and `docs/design/process.md` (ADR-0024). **Web** product screens
   (`apps/web`) must MCP-read the web canvas (`mp-to-web.md`) before writing
   JSX; if MCP fails, stop. Figma is not a gate artifact. Expo shell, auth,
   and deep-link infrastructure are not gated.
6. **Copy the golden protocol. Do not invent layers.** Flag new abstractions,
   extra folders, or generic "clean architecture" that the golden does not
   use.

## Agent skills policy

Skills (`.claude/skills/`, SKILL.md format) distribute **code patterns** and
**workflow playbooks**, not constitution. Constitution lives in the
blueprint, ADRs, and `.claude/rules/`. Vendored skills are pinned in
`skills-lock.json`; after updating one from its source, copy it into
`.claude/skills/<name>` and keep the hand-written `showzy-*` routers.

### Ground rules

1. **Skills are advisory.** On any conflict, `.claude/rules/`, ADRs, the
   golden files, and this pipeline win. A skill never justifies violating a
   prohibition (e.g. raw SQL from a Postgres skill's examples).
2. **Vetted like dependencies.** Every third-party skill or plugin is
   reviewed by a human before it lands in `.claude/` or is enabled for the
   team.
3. **No generic backend-stack skills** (Drizzle, Hono, oRPC, better-auth,
   raw Postgres). Those leak conflicting patterns.
4. **Showzy backend skills are extracted from merged golden code**, never
   written from memory. `showzy-backend` is the golden-file map; deeper
   `showzy-action` / `showzy-schema` / `showzy-module-tests` /
   `showzy-events` skills may be extracted when repeated review findings
   show the map is not enough.

### Phased skill set

| Phase | Install | Notes |
| --- | --- | --- |
| Now | `showzy-backend` map; official `expo/skills` (selective: `expo-overview`, `expo-router`, `expo-native-ui`, `expo-design-system`, `expo-animation`, `expo-dev-client`) + **one** RN skill (`vercel-react-native-skills`) + hand-written `showzy-mobile` and `showzy-web` routers | Skip `expo-tailwind-setup`, `expo-ui`, `expo-data-fetching`, `expo-project-structure` — Unistyles, existing layout, Cookie/`@showzy/contract` transport |
| 3 Delivery | Hand-written **Nova Poshta API** skill | No public equivalent; extract from v1 + official docs |
| Pre-MVP | `eas-app-stores` from `expo/skills` | TestFlight / store submission |
| 6 Web | Vercel `react-best-practices` + `composition-patterns` | Not earlier |
| 7 Acquiring | Port v1 `mono-aquiring` as-is (SKILL.md + API reference; keep only the Node example) | Stack-agnostic Monobank knowledge |
| 8 Banking | Hand-written Monobank statements API skill | Same pattern as acquiring |

Everything else from v1 (`.cursor/skills` in `E:\showzy`) stays dropped:
NestJS/Supabase-RLS skills contradict this architecture, Postgres skills
push raw SQL, and process-skill packs duplicate this pipeline.

## Health metrics (blueprint §7.4)

Track per feature: % PRs merged without human edits (target >80% after the
golden backend slice stabilizes), review iterations per PR (≤2), feature-card
→ green-CI time, regressions reaching main (~0). Add: Claude usage per merged
PR (`/usage` or `/cost` at the end of a `/conveyor` run) to spot lanes that
need a different model or a narrower context pack.
