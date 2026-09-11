---
name: review-pr
description: Launch an independent reviewer subagent on a Showzy PR (constitution, ADRs, golden files, feature card, DoD) and relay its verdict.
argument-hint: <pr-number> [bugs|full]
disable-model-invocation: true
---

# /review-pr

Arguments: **$ARGUMENTS** (PR number, optional mode; default `full`).

1. `gh pr view <pr> --json number,title,headRefName,url,body` — extract the
   `SHO-<n>` ticket from the title and the parent feature from Linear.
2. Launch the `reviewer` subagent with: PR number, branch, ticket, parent,
   lane (from the ticket labels), and mode.
3. Relay the verdict and findings verbatim. Do not fix code in this command;
   say which findings are blockers for merge.
4. If the verdict ends with `GUARD REQUIRED`, suggest `/guard <pr>`.
