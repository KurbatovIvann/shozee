@AGENTS.md

# Claude Code

- Rules: `.claude/rules/` (always: `constitution.md`,
  `definition-of-done.md`; by path: actions/AI, web, mobile). Nested
  `CLAUDE.md` files pull the nearest `AGENTS.md` in when you read files
  there — do not re-read those manuals by hand.
- Workflow skills: `/feature`, `/ticket`, `/conveyor`, `/verify`,
  `/review-pr`, `/guard`, `/scaffold`. Roles: `.claude/agents/`
  (`implementer`, `reviewer`, `guardian`, `ci-triage`).
- Checks: `node .claude/scripts/verify.mjs`, never raw `pnpm turbo` /
  `vitest`. Read `.claude/.verify/<step>.log` only around a failure.
- Tools: GitHub through `gh`; Linear through the Linear MCP server (team
  **Showzy-v2**); web/mobile canvas through the Magic Patterns MCP server.
- Shell: Git Bash on Windows. Forward slashes, repo-relative paths.

## Output protocol (every session and subagent)

Tokens are the budget. Every message, commit, PR, Linear comment, and report
is a status, not an essay.

- **Prose budget.** Chat turn ≤ 8 lines unless the human asks for detail.
  Subagent final report ≤ 15 lines in its fixed format. Commit message:
  one subject line ≤ 72 chars, optional ≤ 3 bullets. PR body: the 6-line
  template in `.claude/agents/implementer.md`. Linear comment: one line.
  No preamble, no recap of what was read, no "why this matters" paragraphs.
- **Decisions and questions** use one shape only:
  ```
  PROBLEM: <one line>
  OPTIONS:
  1. <option> — recommended: <one-line reason>
  2. <option>
  ```
  Nothing else in that message.
- **Code has no comments** (constitution). Names and tests carry meaning.
- **Read narrowly.** Grep first; `Read` with offset/limit; never a whole
  file over ~300 lines; a test file by its `describe` block. Do not re-read
  a file you just edited. Batch independent tool calls in one message.
- **Never paste logs.** Verify and merge-gate summaries only; CI logs go to
  `ci-triage`. Redirect noisy commands (`pnpm install`, builds) to a file
  under `.agent-tmp/` and print the exit code.
- **Ticket size.** The budget is **400 changed source lines**. Tests,
  generated files and markdown do not count: the definition of done makes
  tests 1.5-4x the source, so a budget over all changed lines is unmeetable
  and therefore gets ignored. The gate is
  `node .claude/scripts/diff-hygiene.mjs` (a `verify.mjs` step; it also fails
  on comments in code). Over budget is a planning failure: report it, do not
  grow it, and never raise `--budget` yourself.
