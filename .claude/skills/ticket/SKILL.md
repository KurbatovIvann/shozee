---
name: ticket
description: Run one Showzy Linear leaf ticket end-to-end in this session — lane it, implement, verify, open a draft PR, get independent subagent review. Dispatches to /conveyor when the issue is a feature parent.
argument-hint: SHO-<n>
disable-model-invocation: true
---

# /ticket — one leaf, interactively

Ticket: **$ARGUMENTS**. One ticket = one branch = one PR. Keep Linear updated
via the Linear MCP server.

## 0. Dispatch

Fetch the issue with relations and labels. If it has children or the
`Feature` label, this is a feature parent: read
`.claude/skills/conveyor/SKILL.md` and follow it with this issue id as the
parent (its `$ARGUMENTS` placeholder means this id). Stop here.

## 1. Lane (`docs/pipeline.md`)

| Lane | When | Run |
| --- | --- | --- |
| mechanical | non-UI tooling, seed, rename, docs-only, no new action protocol | blockers → implement → verify. No review subagents |
| routine | new/changed module action, not `sensitive` | short analyze → implement → verify → `reviewer` (mode `bugs`) |
| UI | `apps/web` / `apps/mobile` product code (never mechanical) | analyze + canvas read → implement → verify → `reviewer` (mode `full`) |
| sensitive | `sensitive` label, first golden slice, or first new principal / composition edge | full analyze → implement → verify → `reviewer` (mode `full`) + `guardian` |

Session model: `opusplan` (Opus plans, Sonnet edits) or `sonnet` for every
lane; Opus is for the independent `reviewer` / `guardian`, not the writer.
Output protocol (`CLAUDE.md`) applies: status lines, PROBLEM/OPTIONS for
questions, the implementer's commit/PR templates, no comments in code.

Refuse if a `blocked by` issue is not Done. Move the ticket to **In Progress**.

## 2. Workspace

Work on the Linear `gitBranchName` (fallback `feat/sho-<n>-<slug>`) from a
fresh `origin/main`. If the current checkout has uncommitted work or another
ticket is in progress, stop and tell the human to start a separate worktree
session (`claude -w sho-<n>`) rather than stashing their work. In a new
worktree run `pnpm install --frozen-lockfile --prefer-offline` first.

## 3. Analyze (skip for mechanical)

Read the feature card and the ticket's context pack only; load the layer
skill (`showzy-backend`, `showzy-web`, `showzy-mobile`). Mobile product
screens need the recorded UX gate. Web product screens:
read the web canvas via Magic Patterns MCP first — if MCP is unavailable,
stop. Use Explore for wide searches. Post a 3–5 line "understood, starting"
summary (scope + required tests) in the conversation and continue unless a
stop-condition applies (new capability, principal, table, invariant, ADR
conflict). Never invent product decisions.

## 4. Implement → verify

Follow the constitution and DoD. Hard boundaries: no `packages/core`, no
foreign module unless the card names that action, no raw SQL, no `any`.
Run `node .claude/scripts/verify.mjs` (Bash timeout up to 3600000 ms) until
PASS. Two failed rounds on the same failure → stop and ask the human. If you
cannot finish within the ticket scope, report the blocker instead of
expanding scope.

## 5. Publish

Commit (subject `SHO-<n> <title>`, ≤ 3 bullets), `git push -u origin
<branch>`, `gh pr create --draft` titled `SHO-<n> <title>` with the 6-line
PR body from `.claude/agents/implementer.md`. Do not mark the PR ready.
One-line Linear comment with the PR URL; move the ticket to **In Review**.

## 6. Independent review (writer ≠ reviewer)

In **one message**, launch what the lane requires — `reviewer` (with PR,
ticket, parent, lane, mode) and, for sensitive, `guardian` — plus a
background shell `node .claude/scripts/merge-gate.mjs <pr> --wait`. They run
in the background; do not poll. Comment verdicts on Linear.
`GUARD REQUIRED` from the reviewer → launch `guardian` too.

- Findings: you are the writer here — fix blockers/majors on the same branch,
  re-verify, push, comment the PR. Nits and guardian lows are **not** fixed
  here: file each as its own Backlog ticket under a `<feature>: slice nits`
  parent (created the first time this feature produces one) and say so on the
  ticket.
- After blocker/major fixes, re-launch `reviewer`; after guardian medium+
  fixes, re-launch `guardian`. **At most two fix rounds**; after the second,
  ask the human.
- CI RED → launch `ci-triage` instead of reading logs yourself.

## 7. Handoff

Linear comment: PR link, what was implemented, test summary, review verdicts,
open questions. The ticket stays **In Review**. **Do not merge** — a human
merges a leaf that is not under a conveyor. If you stopped, move the ticket
back to **Todo** with a comment explaining why.
