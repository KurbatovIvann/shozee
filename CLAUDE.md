@AGENTS.md

# Claude Code

- Rules: `.claude/rules/` (always: `constitution.md`,
  `definition-of-done.md`; by path: actions/AI, web, mobile). Nested
  `CLAUDE.md` files pull the nearest `AGENTS.md` in when you read files
  there — do not re-read those manuals by hand.
- Workflow skills: `/feature`, `/ticket`, `/conveyor`, `/verify`,
  `/review-pr`, `/guard`, `/scaffold`. Roles: `.claude/agents/`
  (`implementer`, `reviewer`, `guardian`, `ci-triage`).
- Checks: run `node .claude/scripts/verify.mjs` instead of raw
  `pnpm turbo` / `vitest` commands. It prints a compact summary and keeps
  full logs in `.claude/.verify/`; read a log section only when the summary
  is not enough.
- Context economy: use the Explore subagent for broad searches; grep
  headings and read sections of long manuals (`docs/blueprint.md`,
  `docs/specs/*`, `docs/scope.md`) instead of whole files; never dump CI
  logs into the conversation — delegate to `ci-triage`.
- Tools: GitHub through `gh`; Linear through the Linear MCP server (team
  **Showzy-v2**); web/mobile canvas through the Magic Patterns MCP server.
- Shell: Git Bash on Windows. Use forward slashes and repo-relative paths.
