# Claude Code setup (ADR-0040)

One-time workstation setup for running the agent pipeline
(`docs/pipeline.md`) locally on Windows. Everything repository-level is
already committed in `.claude/`; this page covers what each person installs
and authorizes.

## 1. Tools

| Tool | Why | Check |
| --- | --- | --- |
| Claude Code (CLI or desktop Code tab), logged in with the Claude Max account | Harness | `claude --version`, `/status` |
| Git for Windows (Git Bash) | Claude Code's shell on Windows; worktrees | `git --version` |
| Node 22+ and pnpm via Corepack (`packageManager` pin) | Scripts, `verify.mjs` | `node -v`, `pnpm -v` |
| GitHub CLI, authenticated for `KurbatovIvann/showzy-v2` | PRs, checks, merge | `gh auth status` |
| Docker Desktop, running | Testcontainers DB suite, dev stack | `docker info` |

## 2. Connectors (MCP)

The pipeline uses two MCP servers. Connectors added on claude.ai appear in
Claude Code automatically when you log in with the same account; confirm with
`/mcp` inside a session.

- **Linear** (team Showzy-v2). If it is not listed, add it for your user:
  `claude mcp add --transport http --scope user linear https://mcp.linear.app/mcp`
  and authenticate from `/mcp`. Use either the claude.ai connector or this
  server, not both (duplicate tools waste context).
- **Magic Patterns** (web and mobile canvas reads). Connect it on claude.ai
  (Settings → Connectors) and confirm it in `/mcp`.

`.claude/settings.json` pre-approves the read/write Linear tools the conveyor
needs and the read-only Magic Patterns tools, for both the claude.ai
connector (`mcp__claude_ai_*`) and a user-added `linear` server.

## 3. Recommended plugin

TypeScript code intelligence (go-to-definition and diagnostics instead of
grep-and-read):

```
npm install -g typescript-language-server typescript
```

then inside Claude Code: `/plugin install typescript-lsp@claude-plugins-official`.

Other plugins are not needed: review, security, and CI triage are the
project's own subagents. Vet any plugin like a dependency
(`docs/pipeline.md` → Agent skills policy).

## 4. Models

- Planning and `/conveyor` sessions: `/model opus`.
- `/ticket` sessions (any lane): `/model opusplan` (Opus while in plan mode,
  Sonnet while implementing) or `/model sonnet`.
- Subagent models are fixed in `.claude/agents/*.md`: the implementer is
  always Sonnet; reviewer and guardian are Opus. Do not pass model
  overrides when launching agents.
- Do not widen `pnpm install` in `.claude/settings.local.json`
  (`Bash(pnpm install *)` also allows `--fix-lockfile`, which rewrote the
  Expo tree in SHO-563); the team allow list already covers
  `pnpm install --frozen-lockfile*`.

Use `/context` to see what is loaded and `/usage` (or `/cost`) after a run.

## 5. First run

1. `node .claude/scripts/verify.mjs --dry-run` on a feature branch — prints
   the plan without running anything.
2. `/verify` — full affected run; confirms pnpm, Docker, and turbo work.
3. A small mechanical ticket with `claude -w sho-<n>` then `/ticket SHO-<n>`.
4. Then a real feature: `/feature …`, approve, `/conveyor SHO-<parent>`.

## Personal overrides

Put personal permissions, a default model, or notification preferences in
`.claude/settings.local.json` (gitignored). Personal notes for Claude go in
`CLAUDE.local.md` (gitignored). Do not weaken the team `deny` list there.

## Known caveats

- Worktrees live in `.claude/worktrees/`. If Metro (`expo start`) or another
  whole-repo watcher picks them up while a conveyor runs, stop the watcher or
  remove finished worktrees (`git worktree list`, `git worktree remove`).
- Each worktree runs `pnpm install --frozen-lockfile --prefer-offline`
  (hard links from the pnpm store; fast after the first install).
- Background subagents cannot answer permission prompts on their own; a
  command outside the allow list shows up as "needs input". Add recurring,
  safe commands to the team allow list in a PR rather than approving them
  one by one.
