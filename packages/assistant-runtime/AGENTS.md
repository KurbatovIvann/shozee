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
  stores. `assistantKitIdempotencyKey` derives a tool's key from the command and the
  action: one write of a kind per command, and an untouched retry replays it.
  The one exception: after the handler itself refused the write (`VALIDATION`,
  `NOT_FOUND`, `CONFLICT`, `PERMISSION_DENIED` — nothing was written), the next
  call to that action in the same turn gets a new key, so a corrected call is
  not an `IDEMPOTENCY_CONFLICT` with the refused one. Never after `INTERNAL`,
  `TIMEOUT` or an idempotency refusal, where a write may stand.
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
- `assistant-invocation.ts` — the assistant path name and the two invocation
  channels: `ai` for a turn the dialogue model runs, `sho-ai` for one Шо closed
  in the accept (SHO-760). A tool context carries the channel; omitting it
  means `ai`.
- `sho-turn.ts`, `sho-engine.ts` — the Шо-first turn (ADR-0049, SHO-768).
  `runShoTurn` asks the engine for one `ShoPlan`, runs that plan through the
  same staff tool façade, and comes back `settled` (the card, the reply and a
  synthetic `sho-<seq>-<tool>-<command>` tool call), `ask` (a pause with that
  call as its continuation) or `fallback`. Every error, timeout and refusal is
  a fallback: the caller then runs today's LLM accept unchanged.
  - It returns the exchange as `appended`, never a whole history. A settled
    accept appends, as every chat accept does, because a settled turn takes no
    active-turn slot: two of them read the same snapshot, and a replace would
    drop one exchange (`assistant.acceptTurn` concatenates the append in one
    statement).
  - `createShoEngine` is the production engine over the `@showzy/sho-protocol`
    client and the context source. It takes a `ShoVerifiedMember`, built only
    from the company the staff context verified — which is why a
    `PERMISSION_DENIED` from the three name-index reads is the `unreadable`
    fallback here (a member holding none of those permissions) and not a
    refusal. The `ShoPlanner` that turns a `ShoResult` into a plan is injected
    (SHO-769), and `mountShoEngine` is the one place that reads `config.sho`
    and decides whether `apps/api` runs Шо first at all: no replica, no token
    or an empty whitelist mounts nothing, so a turn costs no parse.
- `sho-plan.ts` — that planner (SHO-769). One gate over the parse result, then
  one registered action planner. The gate sends a turn to the dialogue model
  when Шо read more than one command, `none`, a `ui` answer, a `how_to` or
  `language` need, a `reference` / `check_reference` need (until SHO-770),
  `unsupported` on the action, a refinement or a reference to an earlier
  command, action confidence below the calibrated `0.95`, or a blocking need
  no card can settle. `shoLocatorFor` is the other half of that rule: an
  ambiguous or unknown name with candidates, and an unchecked phone or email,
  become a `by: "query"` locator, so the domain resolver raises the picker and
  the person taps a card (the SHO-747 rule) instead of the model guessing.
  Action planners are registered per action in `SHO_ACTION_PLANNERS` and
  enabled per deployment by `SHO_ACTIONS`, empty by default — an empty list
  means every turn goes to the LLM, as it did before. A planner declares
  `writes`, and a command Шо parsed as a write (or that it wants confirmed)
  reaches only a planner that declares it, so a mis-parse cannot be planned
  through a read tool; every AI write still pauses on the preview card
  (SHO-749), which is what the SHO-740 wrong-write recordings pin.
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
  - The store, not each caller, gives back a reservation no row holds:
    `releaseUnusedHold` is called at most once, only for a replay, a busy
    conversation, a wrong owner or a core refusal other than `INTERNAL`
    (`acceptProvedRollback`) — never after `accepted`, where the row holds it
    until the worker's processor or the recovery helper releases it, and
    never after an unknown error,
    which may have followed COMMIT. It must not throw.
- `stores/assistant-turn-for-job.ts` — the **company-scoped** system read of
  the turn a job names, and the only producer of `VerifiedAssistantCaller` (the row's
  `user_id`, `company_id` and `request_id`; no client IP — it is transport-only,
  `security-operations.md` §3, and core does not need it for a staff action),
  for a queued turn only. A job payload is never a caller. The accepting
  session is recorded on the row and never read (ADR-0039, amended SHO-561). The same file also produces the caller that settles an
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
  `assistant.interruptTurn` closes the turn — including a turn whose author
  lost membership, which is how that turn ends (SHO-569 closed; pinned by
  `apps/api/src/assistant-turn-processor.db.test.ts`).
  - A started turn is never run again: anything that throws after the start
    ends it `interrupted`, with what it stored standing.
  - Its tools derive idempotency keys from the continuation root's command, so
    Продовжити replays a write the dead turn committed (SHO-547).
  - Ending the placeholder's text and the check that there is something to end
    are one write (SHO-570): the message has a second writer, so a read
    followed by an append could store a second text part beside the one it was
    beaten to.
  - Every event is published after the write it reports, read back as the
    turn's author, so `message.updated` carries the stored revision. A lost
    event costs nothing — every stream starts from a snapshot — so a publish
    never fails the turn.
- `assistant-turn-recovery.ts` — `createAssistantTurnRecovery`: the work that
  follows a turn's terminal transition, wherever that transition was made
  (SHO-698). Releases exactly the hold the winning statement handed back, and
  only for a turn that never started; settles that turn's own placeholder as
  its author; publishes the ended status after the commit. That `turn.finished`
  carries **no** window: the helper acts for no person and a conversation is
  read as the person whose conversation it is, so a client that receives one
  without a window re-reads the conversation itself. At-most-once through
  the store's `dropHold`, not exactly-once: a crash between the two stores
  leaves the reservation until its Kyiv-day TTL. A missing membership costs the
  message write and nothing else. Every step runs whatever the others did, and
  the call then throws naming the ones it dropped — that throw is the only
  report there is, since nothing runs the recovery of an ended turn again. No
  model, no Redis or model I/O inside a domain transaction.
- `assistant-overdue-sweep.ts` — `sweepOverdueAssistantTurns`: one bounded pass
  over `assistant.listOverdueTurns`, grouped by company, each group ended
  through the tenant `assistant.sweepOverdueTurns` on the job attempt's own
  `run`, each ended turn handed to the recovery helper. Pages are drained while
  the attempt is live, keyed on the last identity of a full page; a company
  whose page or turn fails is logged and the rest go on.
  **Nothing retries what a pass dropped**: a turn this pass already ended is no
  longer overdue, so no later tick selects it, and the job has zero retries. A
  recovery that throws is counted in `failedTurns` (a group that would not end,
  in `failedCompanies`) and logged, and the pass still returns its summary. The
  job is `assistant.sweepOverdueTurns`, global periodic, every 60 seconds.
- `stores/assistant-turn-placeholder.ts` — the one answer to "which message is
  this turn's, and under which owner token", used by both the processor and the
  recovery helper; two readings of it would be two answers waiting to disagree.
  A turn writes under the token the accept stored rather than deriving one
  again, and the placeholder must still be the conversation's latest message —
  only the latest message can be written to.
- `sho-context.ts`, `sho-context-source.ts` — the Шо parse context (ADR-0051,
  SHO-767): the three `listNameIndex` reads as the staff member, clipped to
  `@showzy/sho-protocol`'s `CONTEXT_LIMITS` and the 8 MB upload budget so an
  oversized company is `partial` rather than contextless; ids and names only
  (brand, unit and variant values stay unsent until the catalog owns them);
  the scope hash of the lists that staff member may see; one build cached 30 s
  per company and scope, so a name created inside the window costs a
  fall-through, never a wrong write; and `parseWithShoContext`, which on a 409
  `context_required` PUTs that build and retries the parse once.
  - A denial of one list is an absent scope; a caller denied **all three**
    never gets a build, a PUT or a parse, which is how a company the caller
    is not a member of is refused (core gives both the same denial).
  - `parseWithShoContext` rethrows that denial and turns any other read
    failure into the `unreadable` fallback, so an outage falls through to the
    LLM and an unauthorized caller does not.
  - A caller is served a shared build only while **its own** last verified
    read is inside the window; another caller keeping that build warm does
    not extend it, so a revoked or narrowed member re-reads within 30 s.
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
