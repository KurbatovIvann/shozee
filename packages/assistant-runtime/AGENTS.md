# @showzy/assistant-runtime — Agent Instructions

The server half of the staff assistant (ADR-0038, ADR-0039). A turn runs in
two server processes — `apps/api` accepts it and runs an answer's synchronous
half, `apps/worker` runs it off the request (SHO-557) — and the worker may
import only the approved `@showzy/api/subscriptions` and `@showzy/api/registry`
subpaths, never the API's runtime internals, so what both need lives here. The
registry is injected into `createAssistantRuntime`; this package never imports
`@showzy/api`.

## Layout (`src/`)

- `assistant-runtime.ts` — `createAssistantRuntime`: tools per caller, the
  resolved-answer runner, the system prompt, and the per-caller kit and history
  stores. `assistantKitIdempotencyKey` derives a tool's key from the command.
  `createAssistantCallerKits` is the per-caller kit, history and turn stores on
  their own, built without a provider or a language model, so recovery work can
  act as a turn's author with no model mounted (SHO-698).
- `runtime-types.ts` — `AssistantRuntime` and the ports a turn uses
  (`AssistantToolContext`, `AssistantHistoryPort`, `ResolveAnswer`,
  `AssistantTurnPrompt`), and `ASSISTANT_CHAT_WINDOW_MESSAGES`.
- `assistant-interactions.ts`, `assistant-kit-confirmation.ts`,
  `assistant-kit-resolve.ts`, `assistant-kit-tools.ts` — the interaction
  types, the confirmation pause, answer resolution, and the façade-to-outcome
  adaptation.
- `assistant-kit-history-window.ts` — what the model reads of a conversation.
- `assistant-model.ts` — which language model, or none; the provider from
  config (`createStaffAssistantProvider`), and the one mount rule and log line
  both processes use (`staffAssistantMount`, `logStaffAssistantMount`,
  SHO-569).
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
  caller (SHO-560). Owns the ids of a turn's
  messages (derived from the command), the placeholder's shape and the budget
  hold's micro-USD form; the module stores them as given. Finishing a turn
  returns the hold it took off the row, once (SHO-561).
- `stores/assistant-turn-for-job.ts` — the **company-scoped** system read of
  the turn a job names, and the only producer of `VerifiedAssistantCaller` (the row's
  `user_id`, `company_id` and `request_id`; no client IP), for a queued turn
  only. A job payload is never a caller. The session is not read (ADR-0039,
  amended SHO-561). The same file also produces the caller that settles an
  **already interrupted** turn's placeholder (SHO-570) — a message is domain
  content, so it is written as the turn's author and core re-checks that
  membership; nothing running can be written to through it.
  - The brand is produced only in this file.
  - ESLint (`no-restricted-syntax`) catches only a direct type assertion to
    the name `VerifiedAssistantCaller`. A renamed import, a type alias, an
    indexed type (`AssistantTurnForJob["caller"]`), a user-defined type guard
    or a generic cast helper gets past it.
  - Any other way of producing a `VerifiedAssistantCaller` is a review
    blocker.
- `assistant-jobs.ts` — the one re-export of the assistant module's job
  declarations (`assistant.turn`, `assistant.sweepOverdueTurns`), its turn
  timeouts and `interruptAssistantTurn`, so `apps/worker` binds the declared
  definitions without depending on `@showzy/assistant` directly. The payload
  is the turn's identity only (kind, conversation id, command id); Postgres is
  the source of everything else. There is no queue contract and no producer
  here: `assistant.acceptTurn` sends the job with `ctx.enqueue` in its own
  transaction (SHO-651).
- `assistant-turn-processor.ts` — `createAssistantTurnProcessor`: what the
  worker does with one `assistant.turn` attempt (SHO-651). Takes the recorded
  company, the turn identity, the recorded actor, the job's request id and the
  attempt's `AbortSignal`; reads the turn through the company-scoped
  `assistant.readTurnForJob`, refuses before the start unless that actor is the
  turn's author, starts it as its author, runs the host from
  history with the turn deadline **and** the attempt signal as the aborts,
  ends the placeholder's text, finishes the turn, releases the returned hold
  only when the model was never reached, and publishes each event after its
  write. A turn that is not queued is a no-op. A refused or expired start
  throws, so the attempt fails, the job is exhausted and
  `assistant.interruptTurn` closes the turn.
- `assistant-turn-recovery.ts` — `createAssistantTurnRecovery`: the work that
  follows a turn's terminal transition, wherever that transition was made
  (SHO-698). Releases exactly the hold the winning statement handed back, and
  only for a turn that never started; settles that turn's own placeholder as
  its author; publishes the ended status after the commit. At-most-once through
  the store's `dropHold`, not exactly-once: a crash between the two stores
  leaves the reservation until its Kyiv-day TTL. A missing membership costs the
  message write and nothing else. No model, no Redis or model I/O inside a
  domain transaction.
- `assistant-overdue-sweep.ts` — `sweepOverdueAssistantTurns`: one bounded pass
  over `assistant.listOverdueTurns`, grouped by company, each group ended
  through the tenant `assistant.sweepOverdueTurns` on the job attempt's own
  `run`, each ended turn handed to the recovery helper. Pages are drained while
  the attempt is live, keyed on the last identity of a full page; a company
  whose page or turn fails is logged and the rest go on.
  **`assertAssistantSweepRecovered` decides the attempt**: a pass with
  `failedCompanies` or `failedTurns` above zero fails the job. A turn this pass
  already ended is no longer overdue, so no later pass would find it; without
  that failure its hold and its placeholder would never be retried. The job is
  `assistant.sweepOverdueTurns`, global periodic, every 60 seconds.
- `stores/assistant-turn-placeholder.ts` — the one answer to "which message is
  this turn's, and under which owner token", used by both the processor and the
  recovery helper.
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
- No queue client of any kind here. Jobs are declared by the assistant module
  and bound by `apps/worker` through `@showzy/jobs`; this package contributes
  the processor, the recovery helper and the sweep pass, each taking the job
  attempt structurally (SHO-651). Turn timeouts change only with ADR-0039 or
  ADR-0041 and a proving test.
- Tests that need the API's action registry (`createActionRegistry`) stay in
  `apps/api`; unit and Redis tests of this package's own code live here.
