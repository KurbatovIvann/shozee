---
name: feature
description: Plan one Showzy feature — decompose a user-visible capability into a Linear feature card and ticket graph (lanes, touched paths, context packs). Planner role; never implements.
argument-hint: <user-visible capability>
disable-model-invocation: true
---

# /feature — plan one feature

You are the **Planner** for Showzy 2.0 (ADR-0023). Capability: **$ARGUMENTS**

You decompose it into Linear tickets that `implementer` subagents can run
without re-planning. You do **not** write `docs/specs/<module>.md` or
`docs/plans/<module>.md`, and you do **not** start implementing. Best run in
plan mode with Opus.

## 1. Research (cheap, parallel)

Launch 2–3 **Explore** subagents in one message, each with a narrow brief and
an instruction to return paths + one-line notes, not file dumps:

- ownership and scope: `docs/module-ownership.md`, `docs/scope.md` (in-scope
  vs deferred), relevant ADRs by title from `docs/adr/README.md`;
- golden files for the layer(s): backend via the `showzy-backend` skill map,
  web `apps/web/src/features/companies/`, mobile `catalog/products`;
- existing surface: current actions/tables/screens this capability extends
  (grep `packages/modules/*/src/index.contract.ts`,
  `packages/db/src/schema/`).

Then read only what the card needs: blueprint §2.1, the 1–3 governing ADRs,
and `.claude/rules/actions-and-ai.md` when the feature adds staff lists,
writes, or AI exposure (planning touches no files, so it is not auto-loaded).
Do not open `docs/archive/`; v1 archaeology only via `docs/reference/`.

If no merged golden exists for a layer this feature needs, this feature
**is** that slice: mark it `sensitive` / first-slice and keep it thin.

Stops: contradicting an accepted ADR → propose a new ADR instead; an
ownership conflict is a question, not an implicit decision. Product screens
require the Experience Foundation UX gate; backend tickets do not wait.

## 2. Output 1 — feature card (present for approval)

A short card, not a novel:

- **Goal** — one sentence the user can see.
- **Owner module(s)** — from the ownership map.
- **Named surface** — action/event/table **names** only (full Zod only for a
  contract-first ticket).
- **Acceptance** — testable statements, incl. the DoD classes that apply.
- **Layer** — backend, UI, or both (two ticket tracks).
- **Sensitivity** — auth, payments, QES, webhooks, files, tenant/runtime
  protocols, or first golden slice.
- **Stop-conditions** — new capability beyond the card, new principal, new
  table the card did not name, invariant change, "should this exist".
- **Context pack** — 5–15 files. Include ADR-0033 for staff lists or
  reference-aware writes.

## 3. Output 2 — ticket graph

For each ticket: title `<module>-T<n>: <title>` or `ui-<screen>: <title>`,
and in its description:

- feature card link, scope, context pack (paths), test list, DoD checklist;
- **Lane:** `mechanical` | `routine` | `ui` | `sensitive` (sensitive = the
  card's sensitivity, first golden slice, or first new principal / composition
  edge; UI product tickets are `ui`, never mechanical);
- **Touches:** the expected path set (e.g. `packages/modules/pricing/**`,
  `packages/db/src/schema/pricing.ts`, `apps/mobile/src/features/pricing/**`,
  i18n namespace). The conveyor uses this to decide what may run in
  parallel — be precise.

Sequencing rules:

- Schema (`packages/db/src/schema/<module>.ts` + migration, ADR-0014) precedes
  every action using those tables.
- Actions before projections; emitters before subscribers; `ctx.call` targets
  (ADR-0015) before callers. Backend before UI for the same capability.
- **Size is a hard constraint, not comfort.** One ticket ≤ **800 changed
  source lines** and ≤ 18 source files. Tests, generated files and markdown
  do not count: the definition of done makes tests 1.5-4x the source, so a
  budget over all changed lines is unmeetable and gets ignored — which is how
  the assistant-async slice shipped 13 children averaging ~1,050 source lines
  each. Estimate source lines per child **in the graph**, before approval: a
  child whose size you cannot bound is not planned. Split
  by layer and by action (schema → one write action + tests → the next
  action → projection → UI). A ticket that cannot be described in five
  lines is two tickets.
- Contested API → contract-first ticket (`*.contract.ts` only). Obvious shape
  from the golden → one implementation ticket.
- No tickets that modify `packages/core`. A foreign module only when the card
  **names** a supporting action owned there.
- No ticket whose only output is markdown.

Present card + graph and **wait for human approval**.

## 4. After approval — create in Linear (team Showzy-v2)

- One issue per ticket, parented under the feature issue (label `Feature` on
  the parent).
- Labels: the existing child label under the `module` group, plus
  `sensitive` where flagged. Do not invent labels.
- Relations: `blocked by` per the graph; parallel tickets have none.
- Status: `Todo` for unblocked, `Backlog` for blocked.

Finish with one line: `Next: /conveyor SHO-<parent>` (or `/ticket SHO-<n>`
for a single leaf).

Output protocol applies (`CLAUDE.md`): the card and graph are tables and
bullets, not prose; a ticket description is ≤ 25 lines; questions to the
human use the PROBLEM/OPTIONS shape.
