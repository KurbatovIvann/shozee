---
name: guard
description: Launch the guardian subagent (safety, security, ADR consistency) on a sensitive Showzy PR and relay its verdict.
argument-hint: <pr-number>
disable-model-invocation: true
---

# /guard

Run only when the lane requires it: `sensitive` tickets, the first golden
backend or UI slice, or the first use of a new principal / composition edge.

1. `gh pr view $ARGUMENTS --json number,title,headRefName,url`.
2. Launch the `guardian` subagent with the PR number, branch, ticket, and why
   the pass is required.
3. Relay the verdict verbatim. `STOP_ADR_REQUIRED` means: do not land; the
   human drafts a new ADR (`docs/adr/template.md`). Do not implement fixes
   here — the executor owns the branch.
