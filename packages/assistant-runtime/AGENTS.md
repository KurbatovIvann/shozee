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
- `assistant-budget-guard.ts`, `stores/budget.ts`, `stores/budget-redis.ts` —
  the pure spend guard, the budget store port with its in-memory reference
  store, and the Redis store both processes mount (SHO-561). A counter never
  goes below zero in either store.
- `stores/assistant-kit-stores.ts` — Redis pause store and command receipts
  (the receipts and the kit's turn lease are replaced by `assistant_turns` at
  the switch, SHO-563).
- `stores/assistant-kit-postgres-stores.ts` — Postgres message log and history,
  through `executeAction` as the caller. `stores/caller.ts` is how every
  Postgres store acts as the caller; internal.
- `stores/assistant-turn-store.ts` — accept, start and finish a turn as the
  caller, and the reconciler's global read (SHO-560). Owns the ids of a turn's
  messages (derived from the command), the placeholder's shape and the budget
  hold's micro-USD form; the module stores them as given. Finishing a turn
  returns the hold it took off the row, once (SHO-561).
- `stores/assistant-turn-for-job.ts` — the global system read of the turn a job
  names, and the only producer of `VerifiedAssistantCaller` (the row's
  `user_id`, `company_id` and `request_id`; no client IP), for a queued turn
  only. A job payload is never a caller. The session is not read (ADR-0039,
  amended SHO-561).
  - The brand is produced only in this file.
  - ESLint (`no-restricted-syntax`) catches only a direct type assertion to
    the name `VerifiedAssistantCaller`. A renamed import, a type alias, an
    indexed type (`AssistantTurnForJob["caller"]`), a user-defined type guard
    or a generic cast helper gets past it.
  - Any other way of producing a `VerifiedAssistantCaller` is a review
    blocker.
- `queue.ts` — the assistant queue contract: name, BullMQ prefix, job payload
  schema, `jobId` derivation. Pure constants and a schema. The payload is the
  turn's identity only (kind, conversation id, command id, lowercased);
  Postgres is the source of everything else, and the reconciler rebuilds a
  job from the turn row.
- `events.ts` — the event channel contract (SHO-562): the per-conversation
  channel and presence key (company then conversation, lowercased), the stream
  slot key, the heartbeat, presence ttl, per-person stream limit and idle
  close, and the versioned envelope a published event travels in. The payload
  schemas themselves are client-safe and live in
  `@showzy/validation/assistant-events`, because a phone parses them.
- `stores/assistant-events-redis.ts` — the Redis half: the publisher (the
  worker's), presence and stream slots (sorted sets whose deadlines come from
  the Redis server's clock inside Lua), and the subscriber hub — one duplicated
  connection per process, no automatic resubscribe, `onLost` when it drops. On
  the shared, non-persistent Redis. No replay log: every stream starts from a
  snapshot.

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
