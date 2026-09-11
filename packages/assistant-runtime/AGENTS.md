# @showzy/assistant-runtime — Agent Instructions

The server half of the staff assistant (ADR-0038, ADR-0039). A turn runs in
two server processes — `apps/api` accepts it and runs an answer's synchronous
half, `apps/worker` runs it off the request (SHO-557) — and the worker may
import only the approved `@showzy/api/subscriptions` subpath, never the API's
runtime internals, so what both need lives here.

## Layout (`src/`)

- `assistant-runtime.ts` — `createAssistantRuntime`: tools per caller, the
  resolved-answer runner, the system prompt, and the per-caller kit and history
  stores. `assistantKitIdempotencyKey` derives a tool's key from the command.
- `runtime-types.ts` — `AssistantRuntime` and the ports a turn uses
  (`AssistantToolContext`, `AssistantHistoryPort`, `ResolveAnswer`,
  `AssistantTurnPrompt`), and `ASSISTANT_CHAT_WINDOW_MESSAGES`.
- `assistant-interactions.ts`, `assistant-kit-confirmation.ts`,
  `assistant-kit-resolve.ts`, `assistant-kit-tools.ts` — the interaction
  types, the confirmation pause, answer resolution, and the façade-to-outcome
  adaptation.
- `assistant-kit-history-window.ts` — what the model reads of a conversation.
- `assistant-model.ts` — which language model, or none.
- `assistant-invocation.ts` — `channel: "ai"` and the assistant path name.
- `assistant-budget-guard.ts`, `stores/budget.ts` — the pure spend guard and
  the budget store port with its in-memory store. The Redis budget store is
  still `apps/api/src/stores/redis.ts`.
- `stores/assistant-kit-stores.ts` — Redis pause store and command receipts.
- `stores/assistant-kit-postgres-stores.ts` — Postgres message log and history,
  through `executeAction` as the caller.
- `queue.ts` — the assistant queue contract: name, BullMQ prefix, job payload
  schema, `jobId` derivation. Pure constants and a schema. The payload is the
  turn's identity only (kind, conversation id, command id, lowercased);
  Postgres is the source of everything else, and the reconciler rebuilds a
  job from the turn row.

## Rules

- Server-only. Client apps, domain modules and `packages/ai` may not import
  it (`showzy/import-boundaries`, `boundaries/dependencies`).
- No HTTP. No Hono, no request or response, no auth instance. Route handlers,
  `assistant-kit-http.ts` request plumbing, and the Hono budget wrapper stay in
  `apps/api`.
- Every domain call goes through `executeAction` as the staff member with
  `channel: "ai"`. No DB access, no module service imports.
- No `bullmq` dependency here until a slice produces or processes jobs. Queue
  contract values change only with ADR-0039 and a proving test.
- Tests that need the API's action registry (`createActionRegistry`) stay in
  `apps/api`; unit and Redis tests of this package's own code live here.
