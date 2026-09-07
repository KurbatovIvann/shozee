# Agent Pipeline — Operations Manual

How the feature loop from `docs/blueprint.md` §7 and ADR-0023 actually
runs in Cursor. The blueprint defines *what* the roles are; this file is
the day-to-day checklist: which agent, which command, what goes in, what
comes out, and when a role is done.

**Two ways to run the loop.** The files in `.cursor/commands/` are the
role instructions.

1. **Leaf** — you (or an agent) run `/ticket SHO-<n>` on one child. The
   executor opens a draft PR and does **not** merge. You merge.
2. **Feature parent** — `/implement SHO-<parent>` (or `/ticket` on an
   issue with children / label `Feature`) runs the **parent orchestrator**
   (`.cursor/commands/conveyor.md`, ADR-0029). The parent does not
   implement. It launches one cloud `/ticket` executor per child, attaches
   independent Bugbot / `/review` / security-review from **its**
   conversation, and squash-merges when the conveyor merge gate is green.
   A human still closes the feature parent.

Cloud child executors cannot launch nested Task Bugbot, isolated
`/review`, or `security-review` (SHO-197). That is expected. They
self-check `review.md` / `guard.md`. **Writer ≠ reviewer** is the parent’s
independent Task tools, not the child.

Working model: **Grok 4.6** for every role. Do not stop a ticket because
Claude or GPT names in older notes are unavailable. Independent review on
the parent-conveyor path is green GitHub Actions, parent Task Bugbot on
routine+, parent Task security-review on `sensitive`, and isolated
`/review` when launched (wait for that verdict before merge).

```
PLANNER → [parent orchestrator, optional] → EXECUTOR → VERIFIER → GUARDIAN
(human+agent)   (/implement on feature parent)   (one cloud /ticket per child)
```

Constitution stays: blueprint §2–§6, accepted ADRs (including ADR-0033), `.cursor/rules/`, `docs/scope.md`,
`docs/module-ownership.md`. Do not open `docs/archive/`. The executable
contract of a feature is `*.contract.ts` plus the tests in the definition
of done.

## Role reference

### 1. PLANNER — `/feature <name>`

| | |
| --- | --- |
| Agent | One chat agent in **Plan mode**, working with you interactively |
| Command | `/feature` with a user-visible capability |
| Input | Constitution, ADRs, ownership map, golden slice files for the layer, v1 reference only if needed |
| Output | A Linear **feature card**, a ticket graph, and a 5–15 file context pack. Contested APIs also get a contract-first ticket (`*.contract.ts` only) |
| Done when | You approve the card and tickets exist in Linear with `blocked by` relations |

The agent proposes; you challenge product behavior. Expect a short
iteration, not a novel. Never invent a new principal, table, or invariant
silently — those stop and ask, or need an ADR.

A **feature** is one closed capability (e.g. “staff creates a product with
variants”). An epic is a Linear milestone. A ticket is one branch = one
PR (~300 diff lines is comfort, not a cap). Product screens wait on the
Experience Foundation UX gate; backend tickets do not.

### 2. PARENT ORCHESTRATOR — `/implement SHO-<parent>` (optional)

| | |
| --- | --- |
| Agent | One parent conversation. Children are isolated cloud Tasks |
| Command | `/implement` or `/ticket` on a feature parent (children or `Feature` label). Playbook: `.cursor/commands/conveyor.md` |
| Input | Approved Linear feature card and ticket graph |
| Output | Each child squash-merged on green Actions + parent Task reviews. Parent stays In Progress |
| Done when | Named children and review follow-ups are on `main`. A human closes the parent |
| Isolation | **Default sequential.** Linear `blocked by` empty is not enough (SHO-184/186/185). Parallel only if path sets are disjoint |
| Merge gate | Seven GitHub Actions jobs (`checks`, `secret-scan`, `dependency-audit`, `contract-check`, `migration-drift`, `bundle-probe`, `e2e-smoke`). `checks` is the fail-closed aggregator (SHO-334); format/typecheck/lint/test/build-smoke run as independent workers. Parent Task Bugbot on routine+. Parent Task security-review on `sensitive`. Isolated `/review` **when launched** (`sensitive`, first-slice, UI, or a prior REQUEST CHANGES). GitHub-hosted Cursor Bugbot / Security Reviewer checks are **not** gates (usage limits, `neutral`, late) |

If `/review` is launched, wait for **APPROVE with no open nits** before
squash-merge. REQUEST CHANGES with blockers/majors **or any nits** →
same-branch fix. Re-launch `/review` after majors; after a nits-only
apply, merge on green CI (no extra `/review`). A late post-merge verdict
(hung agent) → new Linear child as **fallback** (majors and nits); do
not reopen Done.

### 3. EXECUTOR — `/ticket SHO-<n>` on a **leaf** (wraps `/implement`)

| | |
| --- | --- |
| Agent | **One agent per ticket**, parallel where the dependency graph **and** file isolation allow |
| Command | `/ticket` with the Linear ticket id — it lanes the ticket, gates on blockers, implements, and runs the verify loop |
| Input | The Linear card + ticket, the context pack, the golden files for this layer |
| Output | A **draft** PR with the required tests. Linear **In Review**. Nested Task Bugbot / `/review` / `security-review` often unavailable — self-check only (ADR-0029) |
| Done when | PR opened with green local checks. Description names the feature card, the tests, and any deviations (there should be none — deviations mean stop). The executor does **not** merge |
| Escalation | 2 failed verify/review rounds → ask the human; 3 → design review or a new ADR |

Use the merged reference files listed below. A new layer without an
approved reference still needs a first-slice review before its pattern
is copied.

### 4. VERIFIER — CI always; `/review` by lane

| Lane | Review |
| --- | --- |
| **mechanical** | CI + human skim. No Bugbot/`/review` |
| **routine** | **Bugbot** + human. `/review` only if contested or a prior review failed |
| **sensitive / first-slice** | Bugbot + `/review` + `/guard` when `sensitive` or this is the first backend/UI golden + full human review |

| | |
| --- | --- |
| Agent | `/review` when the lane requires it |
| Input | The PR diff + the feature card + golden files + `.cursor/rules/` + ADRs |
| Output | Verdict: approve, or change requests referencing constitution / ADR / golden / DoD — not an archived spec section |
| Done when | Required reviewers for the lane have run. Leaf `/ticket`: **a human merges**. Parent conveyor: parent squash-merges on the merge gate (ADR-0029) |

On the parent-conveyor path, launch Bugbot / `/review` / security-review
from the **parent** conversation after the child PR exists. Do not expect
the cloud executor to nest those Task tools.

### 5. GUARDIAN — `/guard` (optional)

Safety and irreversibility, not style. Skip on mechanical and ordinary
routine work.

| When | What |
| --- | --- |
| `sensitive` | Security-review agent + `/guard` (auth, payments, QES, webhooks, files, tenant/runtime protocols) |
| First golden backend or UI slice | Architecture pass vs ADRs and the intended copy template |
| First use of a new principal or composition edge | Same |
| Any ADR deviation | Stop. Do not land. Draft a new ADR instead |

Done when Guardian findings are addressed on the same branch and VERIFY
is green again.

## Golden slices

A golden is a designation, not a special package. Later Executors copy
those files. They do not invent a new folder shape.

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
and the [`showzy-mobile` router](../.cursor/skills/showzy-mobile/SKILL.md).
Each product screen still needs the recorded
[UX gate](design/process.md#ux-gate) and canvas coverage.

**Web.** Copy the companies onboarding/query patterns named in
[`apps/web/AGENTS.md`](../apps/web/AGENTS.md) and follow the
[web canvas port rule](design/mapping/mp-to-web.md).

Core test fixtures in `packages/core/src/testing/` stay core-internal.

## Linear workflow

Linear (team **Showzy-v2**, via MCP) is the work ledger. Mapping:

- **Project = roadmap phase** (`Phase 0 — Foundation` … `Phase 9 — AI
  Experience`, then `V2 Production Launch`, then `Phase 10 — Web` …)
  plus the parallel `Experience Foundation` project.
  Milestones inside a project = features / vertical slices.
  **V2 Production Launch is its own project**, never a phase milestone.
- **Issue = one ticket** from `/feature` (one branch = one PR).
  Dependencies = `blocked by`; parallel tickets have none.
- **Labels**: the existing child label `<name>` under the `module` group
  (for example `orders`), plus `sensitive` when flagged. Do not invent
  a `spec` or `scaffold` label for new work.
- **Statuses**: Backlog (blocked) → Todo (ready) → In Progress (executor
  running) → **In Review** (draft PR open) → Done (merged). Canceled is
  for dropped tasks. The leaf executor must move the ticket to In Review
  when the PR exists (not leave it In Progress). Linear GitHub sync may
  flip a ticket to In Progress when a PR is marked ready; after
  squash-merge, set Done again if needed.

Day-to-day loop:

1. You open a thread in Plan mode and type `/feature <capability>`.
   Approve the card and tickets.
2. **Either** open a fresh thread per leaf and type `/ticket SHO-<n>`
   (you merge), **or** type `/implement SHO-<parent>` and let the parent
   orchestrator run the graph (ADR-0029).
3. The leaf executor implements, runs VERIFY, opens a draft PR, and
   self-checks `review.md` / `guard.md` when nested Task tools are missing.
4. Parent conveyor: independent reviews from the parent, then squash-merge
   on green Actions **and** the launched `/review` verdict. Leaf
   `/ticket` without a parent: **you merge.**
   Linear's GitHub integration links `SHO-n` in the branch/PR. Do not
   rely on it to mark Done — the conveyor sets Done after merge.

Gaps that are product forks (new capability, new principal, new table,
invariant change, “should this exist”) stop the ticket: it returns to
Todo with a comment. Mechanical contract detail (timeout / rate-limit
defaults, a Zod refine a test proved, a CHECK/column the card implied,
a metadata field `defineActionContract` requires) patches in the same PR
and is named in the description.

## Special roles (outside the main flow)

| Role | When |
| --- | --- |
| Debugging hard bugs | Escalation when the working model can't find the root cause in 1–2 iterations — then a human |
| ADR drafting | When any role hits a decision the blueprint doesn't cover, or wants to deviate from an accepted ADR |
| Leftover foundation | `/scaffold`. Phases 0–1 only; allowlisted packages. New domain work uses `/feature`, not `/scaffold` |

## Rules that keep the pipeline honest

1. **Writer ≠ reviewer** when `/review` or `/guard` runs. Do not
   rubber-stamp your own PR. On the parent conveyor, independent review is
   green GitHub Actions plus parent-launched Task Bugbot / security-review
   / `/review` when launched (ADR-0029). Do not merge while a launched
   `/review` is still running. A child’s in-process `review.md` is a
   self-check, not independent review. Mechanical PRs do not need
   `/review`.
2. **The contract is TypeScript.** `*.contract.ts` plus DoD tests. Do not
   write `docs/specs/<module>.md` or open `docs/archive/`. Protocol
   manuals for frozen packages may be patched in the same PR when a test
   proves them wrong; otherwise they change via ADR.
3. **Escalate, don't grind.** 2 failed review or debug iterations →
   human. Do not wait for another model family.
4. **Working model is Grok 4.6** until another family is on the Cursor
   plan. Do not keep a per-role model matrix in the meantime.
5. **UX gate blocks product screens in `apps/mobile`.** It does not block
   backend features. Mobile UI work must follow
   `docs/design/mapping/mp-to-mobile.md` and reference the Magic
   Patterns canvas screen, the running Expo SYSTEM, and
   `docs/design/process.md` (ADR-0024). **Web** product screens
   (`apps/web`) must MCP-read the web canvas (`mp-to-web.md`) before
   writing JSX; if MCP fails, stop. That is a mandatory canvas read,
   not the mobile UX gate. Figma is not a gate artifact.
   Expo shell, auth, and deep-link infrastructure are not gated.
6. **Copy the golden protocol. Do not invent layers.** Flag new
   abstractions, extra folders, or generic “clean architecture” that the
   golden does not use. Copy pagination helpers, tenant, errors, and
   folders — not a screen-shaped list/write input that ADR-0033 retires.

## Agent skills policy

Skills (`.cursor/skills/` and the skills-CLI copy in `.agents/skills/`,
SKILL.md format) distribute **code patterns**, not process and not
constitution. Process lives in this file and the commands. Constitution
lives in the blueprint, ADRs, and `.cursor/rules/`. Vendored skills are
pinned in `skills-lock.json`. After `npx skills update`, recopy
`.agents/skills/<name>` into `.cursor/skills/<name>` and keep the
hand-written `showzy-mobile` router.

### Ground rules

1. **Skills are advisory.** On any conflict, `.cursor/rules/`, ADRs, the
   golden files, and this pipeline win. A skill never justifies violating
   a prohibition (e.g. raw SQL from a Postgres skill's examples).
2. **Vetted like dependencies.** Every third-party skill is reviewed by a
   human before it lands in `.cursor/skills/` / `.agents/skills/`.
3. **No generic backend-stack skills** (Drizzle, Hono, oRPC, better-auth,
   raw Postgres). Those leak conflicting patterns.
4. **No Showzy backend skills until the golden backend slice has
   merged.** Then extract hand-written skills from that code:
   `showzy-action`, `showzy-schema`, `showzy-module-tests`,
   `showzy-events`. A `showzy-panel-screen` skill waits on the golden
   UI slice.

### Phased skill set

| Phase | Install | Notes |
| --- | --- | --- |
| Until golden backend merges | **Nothing backend** | Foundation and the first slice run under Guardian |
| After golden backend | Hand-written Showzy skills listed above | Extracted from the golden files, not from memory |
| 2–3 Mobile screens | Official `expo/skills` (selective: `expo-overview`, `expo-router`, `expo-native-ui`, `expo-design-system`, `expo-animation`, `expo-dev-client`) + **one** RN skill (`vercel-react-native-skills`, not Callstack) + hand-written `showzy-mobile` router | Skip `expo-tailwind-setup`, `expo-ui`, `expo-data-fetching`, and `expo-project-structure` — Unistyles, existing layout, Cookie/`@showzy/contract` transport. After the golden UI slice, add `showzy-panel-screen` |
| 3 Delivery | Hand-written **Nova Poshta API** skill | No public equivalent; extract from v1 + official docs |
| Pre-MVP | `eas-app-stores` from `expo/skills` | TestFlight / store submission |
| 6 Web | Vercel `react-best-practices` + `composition-patterns` | Not earlier |
| 7 Acquiring | Port v1 `mono-aquiring` as-is (SKILL.md + API reference; keep only the Node example) | Stack-agnostic Monobank knowledge |
| 8 Banking | Hand-written Monobank statements API skill | Same pattern as acquiring |

Everything else from v1 (`.cursor/skills` in `E:\showzy`) stays dropped:
NestJS/Supabase-RLS skills contradict this architecture, Postgres skills
push raw SQL, and process-skill packs duplicate this pipeline.

## Health metrics (blueprint §7.4)

Track per feature: % PRs merged without human edits (target >80% after
the golden backend slice stabilizes), review iterations per PR (≤2),
feature-card → green-CI time, regressions reaching main (~0).
