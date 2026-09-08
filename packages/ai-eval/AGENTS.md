# `@showzy/ai-eval` — staff assistant eval harness (SHO-412)

Dev-only leaf. Proof / plain-reply / gate corpora drive
`streamStaffAssistantChat` against a real Anthropic model (hand-run) or
`MockLanguageModelV3` (CI self-tests). `MODEL_SPEAKS` drives the T1
`runStaffAssistantHostTurn` so markdown tables keep `speechSource: "model"`
(ADR-0037). Do not retarget production `POST /assistant/chat`. Tool
execution is `executeAction` over the existing Testcontainers Postgres kit.

## Commands

- `pnpm --filter @showzy/ai-eval test:unit` — matcher, pass-rate, secret
  hygiene. No live model. No Postgres.
- `pnpm --filter @showzy/ai-eval run eval` — live proof scenarios. Needs
  a valid process env (`loadServerConfig`) including `ANTHROPIC_API_KEY`.
  Optional `--runs=N` / `--runs N` (default 3; `eval-cli.mjs` strips the
  flag because Vitest rejects unknown CLI options). Not on the PR path.

## Do not

- Depend on this package from `@showzy/ai` or any app.
- Wire `eval` into `test:unit`, `test:db`, or CI.
- Add Vitest `retry`. A 2/3 pass rate is a flake, not green.
- Read `process.env.ANTHROPIC_API_KEY` in this package. Pass `config.ai`
  from `loadServerConfig()` at the live entry.
- Log the system prompt, API key, or raw request bodies.
- Change a contract, façade, handler, or `system-prompt.ts` to make a
  scenario pass.

## Layout

- `src/` harness (safe to import from unit tests except `sandbox.ts`).
- `src/eval/live.eval.ts` boots the DB kit and live models. Unit tests
  must not import it or `sandbox.ts`.
