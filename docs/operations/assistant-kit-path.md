# The assistant-kit path

**This is the assistant** (ADR-0038). There is no other one: `/assistant/chat`,
the pending store and the host loop were removed once the app stopped calling
them. `AI_ASSISTANT_KIT` defaults to `1` and is a way to take the assistant
**down** — with it off the routes do not exist and the sheet cannot load a
conversation.

This document exists because the previous rewrite passed CI and still behaved
worse on a phone. A protocol with green tests and no minutes of real use is not
yet known to work — so exercising these routes by hand stays worth doing.

## Turning it off

```
AI_ASSISTANT_KIT=0
```

Boot mounts the routes only when a provider is also configured — there is nothing
to exercise without one.

Boot says which of those happened, so it is never a guess:

```
{"msg":"assistant-kit path","enabled":true,"mounted":true,
 "paths":["POST /assistant/kit/chat","POST /assistant/kit/answer",
          "POST /assistant/kit/abandon","GET /assistant/kit/messages",
          "GET /assistant/kit/events"]}
```

`enabled:true, mounted:false` means the flag is on but no language model was
configured.

## What the phone does now

The sheet resolves its conversation through the existing
`assistant.createConversation` / `listConversations` pair — one row per person per
company, found again by listing — and then does nothing but read this path's
windows and post answers to it. It mints no parts of its own and holds no memory
of which questions it has already dealt with; a source test
(`sheet/use-assistant-sheet.seam.test.ts`) fails if an import from the previous
client sneaks back in.

Nothing of the previous client remains on disk.

The thread is a window onto the conversation. It opens on the latest thirty
messages, and scrolling to the top asks for the page before them. Every answer
joins onto what is already loaded, by message id; if the conversation moved on
by more than a window meanwhile — another device, a long absence — the older
pages are dropped rather than shown with a gap. A page arriving at the top keeps
the person where they are reading; a reply brings the thread back to its end.

## The routes

| Method | Path | Body / query |
| --- | --- | --- |
| POST | `/assistant/kit/chat` | `{ commandId, conversationId, text }` |
| POST | `/assistant/kit/answer` | `{ commandId, conversationId, interactionId, revision, answer }` |
| POST | `/assistant/kit/abandon` | `{ conversationId, interactionId }` |
| POST | `/assistant/kit/continue` | `{ commandId, conversationId }` — Продовжити (SHO-574) |
| GET | `/assistant/kit/messages` | `?conversationId=` and, for an older page, `&before=` |
| GET | `/assistant/kit/events` | `?conversationId=` — server-sent events, see [The event stream](#the-event-stream) |

Same auth as the live assistant: staff session cookie plus `x-company-id`.
`commandId` and `conversationId` are uuids the client makes up.

One answer route for every kind of question, not one per kind: `answer` is
opaque, and the stored pause says which kind it belongs to. `abandon` is how a
question is dropped — including saying no to a confirmation, which is not an
answer to it but a decision to stop.

**Every route answers with the conversation's latest window**, never with just
the parts one request produced:

```json
{ "status": "ok", "window": { "conversationId": "...",
  "messages": [...], "olderCursor": "12", "openPause": null,
  "turn": { "id": "...", "status": "running" } } }
```

`messages` are the latest thirty, each exactly as stored. `olderCursor` is null
when nothing precedes them; otherwise `GET /assistant/kit/messages` with
`&before=<olderCursor>` returns the page before. A message is never changed once
its request ends, so a page a client already holds does not go stale.

`turn` is `assistant_turns`' own answer to whether one is running on this
conversation right now — `null` once it has ended, whoever ended it (SHO-574,
item 0). A client derives "busy" and "is this streaming placeholder still being
written" from this field alone, never from a message's own `streaming` text
part: that part is a projection, and a turn the sweep ended for a removed
author leaves it stored forever with nothing to end it a second time.

A refusal carries it too — `409 stale`, `409 unresolvable`, `409 action_failed`
and `409 interaction_open` all come back with the current `window`, so a client
never has to guess what the card should now say. That is deliberate: a response
carrying only the new fragment is what made a live turn and a reload disagree.

### Calling it

Take the session cookie from a logged-in browser (DevTools → Application →
Cookies) or from the app, and the company id from any `x-company-id` header the
app already sends.

```bash
export KIT=http://localhost:3000
export COOKIE='better-auth.session_token=PASTE_HERE'
export COMPANY='879e8662-6a94-4a4f-8cd9-43a1ce72c4ef'
export CONV=$(uuidgen)
```

A turn:

```bash
curl -sS "$KIT/assistant/kit/chat" -H "cookie: $COOKIE" -H "x-company-id: $COMPANY" -H 'content-type: application/json' -d "{\"commandId\":\"$(uuidgen)\",\"conversationId\":\"$CONV\",\"text\":\"покажи замовлення цього місяця\"}" | jq
```

Answering a question it asked (take `interactionId` and `revision` from
`window.openPause` in the previous response, and `optionId` from
`window.openPause.prompt.options`):

```bash
curl -sS "$KIT/assistant/kit/answer" -H "cookie: $COOKIE" -H "x-company-id: $COMPANY" -H 'content-type: application/json' -d "{\"commandId\":\"$(uuidgen)\",\"conversationId\":\"$CONV\",\"interactionId\":\"PASTE\",\"revision\":1,\"answer\":{\"optionId\":\"PASTE\"}}" | jq
```

Dropping the question instead:

```bash
curl -sS "$KIT/assistant/kit/abandon" -H "cookie: $COOKIE" -H "x-company-id: $COMPANY" -H 'content-type: application/json' -d "{\"conversationId\":\"$CONV\",\"interactionId\":\"PASTE\"}" | jq
```

Продовжити, on a conversation whose window reports `turn: null` and whose last
assistant message still shows `streaming` — the server resolves which turn to
continue from `assistant_turns` itself, never from a client-supplied id:

```bash
curl -sS "$KIT/assistant/kit/continue" -H "cookie: $COOKIE" -H "x-company-id: $COMPANY" -H 'content-type: application/json' -d "{\"commandId\":\"$(uuidgen)\",\"conversationId\":\"$CONV\"}" | jq
```

What a reload would render:

```bash
curl -sS "$KIT/assistant/kit/messages?conversationId=$CONV" -H "cookie: $COOKIE" -H "x-company-id: $COMPANY" | jq
```

The page before it (take `olderCursor` from the previous response):

```bash
curl -sS "$KIT/assistant/kit/messages?conversationId=$CONV&before=PASTE" -H "cookie: $COOKIE" -H "x-company-id: $COMPANY" | jq
```

## The event stream

`GET /assistant/kit/events?conversationId=` answers with server-sent events
(ADR-0039, SHO-562). Additive until the switch (SHO-563): no client listens yet,
and nothing publishes until the worker runs turns (SHO-561).

Authorization is the other routes': the session cookie, `x-company-id`, and a
read of the conversation as the caller. A conversation that is not yours and one
that does not exist both answer `410 {"status":"expired"}`, exactly as
`GET /assistant/kit/messages` does, before any stream opens.

| Event | Data |
| --- | --- |
| `snapshot` | `{ type, window }` — always first; the window `GET /assistant/kit/messages` returns |
| `turn.started` | `{ type, conversationId, kind, commandId }` |
| `message.updated` | `{ type, conversationId, message }` — the latest message, whole, with its `revision` |
| `turn.finished` | `{ type, kind, commandId, status, window }` — the window, because `openPause` is window-level |
| `text.delta` | reserved for streaming tokens; never sent |

Between events, a comment line `: heartbeat` every 15 s.

**Every message carries a `revision`** — in every window and every event. It is
1 when the message is stored and rises by one on each update. A client holding
two copies of one message keeps the higher, so a window and an event that
crossed cannot overwrite each other with the older copy.

**Nothing is replayed.** An event published while nobody listened is gone, and
that costs nothing: the next connection's snapshot already shows its effect. A
client that suspects it missed something reconnects; it never asks for history.

Limits, none of which touch the turn budget:

- **5 open streams per person**, counted across API processes. The sixth answers
  `429 {"error":{"code":"RATE_LIMITED"}}`. A closed stream frees its slot at once;
  one whose process died frees it within 45 s.
- **Sign-out ends a stream.** The session is re-checked on every heartbeat —
  without refreshing it and bypassing the cookie cache — so a sign-out or a
  revoked session ends the stream within 15 s, and watching never keeps a
  session alive.
- **Idle streams close** after 10 minutes without an event written to the
  client.
- **A client that stops reading is let go.** A stream holding more than 64
  frames it could not write is closed, releasing its subscription, presence and
  slot; the client's next connection starts from a snapshot. The heartbeat's
  session check and refreshes never wait behind those writes, so a stalled
  stream cannot let its slot lapse while it is still open.
- **A dropped Redis subscriber ends every stream on it**, so each client
  reconnects from a snapshot rather than carrying on past a gap.

```bash
curl -N "$KIT/assistant/kit/events?conversationId=$CONV" -H "cookie: $COOKIE" -H "x-company-id: $COMPANY"
```

### Where it lives

The channel and presence use the shared, non-persistent Redis (`REDIS_URL`):
neither needs to survive a restart. Each API process holds one more connection,
for subscribing, because a Redis connection in subscribe mode can run nothing
else. The worker publishes on its own existing connection.

```
assistant:events:<companyId>:<conversationId>     pub/sub channel, ids lowercased
assistant:presence:<companyId>:<conversationId>   live streams: stream id -> deadline
assistant:streams:<userId>                        one person's open streams, same shape
```

```
redis-cli PUBSUB NUMSUB assistant:events:<companyId>:<conversationId>
redis-cli ZRANGE assistant:presence:<companyId>:<conversationId> 0 -1 WITHSCORES
```

Deadlines are Redis server time in milliseconds, set inside Lua, so the API that
writes presence and the worker that reads it never compare their own clocks.

### Required before production

There is no production environment yet, so these are recorded, not built:

- The ingress or proxy in front of the API must not buffer `text/event-stream`
  responses (for nginx, `proxy_buffering off`), and its read timeout must be
  comfortably longer than the 15 s heartbeat.
- Idle timeouts at the load balancer and at the edge must also exceed the
  heartbeat, or streams are cut and clients reconnect for nothing.
- Connection limits per API instance must allow one long-lived connection per
  open stream — up to 5 per signed-in person.
- A deploy ends an instance's streams on SIGTERM before its HTTP server closes;
  clients reconnect to another instance and start from a snapshot.

## The scenario worth running

1. **A read.** `chat` with "покажи замовлення цього клієнта". Expect one list or
   aggregate card in the last message, not one card per row.
2. **A write that needs a choice.** `chat` with "створи замовлення для <an
   ambiguous name>". Expect `window.openPause` with the options, and an
   `interaction` part in the last message.
3. **Answer it.** `answer` with `{ optionId }` from that pause. In the last
   message expect the record's card **first**, then the explanation, and
   `window.openPause: null`.
4. **Reload.** `messages`. Expect the same window, byte for byte, as the one
   the turn returned.
5. **The second question.** Try a request where both the customer and the product
   are ambiguous. Expect a pause, then after answering it, **another** pause
   rather than an error.
6. **Drop one.** Ask something ambiguous, then `abandon` it. Expect the next
   `chat` to be accepted rather than refused with `interaction_open`.
7. **A confirmation.** Archive a customer, then `chat` with "видали клієнта
   <that name>". Expect `window.openPause.kind: "confirmation"` with a
   summary, and the customer still there. `answer` with `{ "approved": true }`
   and expect it gone; `abandon` instead and expect it untouched.
8. **Scroll back.** In a conversation longer than thirty messages, `messages`
   returns the latest thirty and an `olderCursor`, and `&before=<olderCursor>`
   returns the page before; the two meet with no message missing or repeated.
   On the phone, scrolling to the top loads that page without moving what is on
   screen, and the next reply brings the thread back to its end.

What to watch for, because these are the failures the old path had:

- two cards for one order, or none after a picker
- a confident "Готово." when nothing was written
- the card disappearing when the action refuses
- a reload showing a different set of cards than the live turn did
- a jump to the bottom while an older page loads, or a gap or a repeated
  message where two pages meet

## Confirmations

Five actions will not run without a person's say-so (`requiresConfirmation:
true`): deleting a customer, a group, a counterparty or a price list, and
requesting a signature. The assistant reaches them through core's challenge —
the same one every other channel uses — never around it.

1. The model calls the tool. Core refuses with a single-use challenge bound to
   the action, the hash of its input, the person, the company and the
   **idempotency key of the attempt**. Nothing is written.
2. The tool layer turns the refusal into a `confirmation` pause. Its prompt is
   core's redacted summary; the action, the input, the key and the challenge
   stay in the pause's secret, which no client sees.
3. `answer` with `{ "approved": true }` presents that stored attempt to
   `executeAction` again with the challenge. Core consumes it once and checks
   every binding before anything runs.

Saying no is `abandon`. A challenge core will not accept — expired, or presented
for anything it was not issued for — comes back as a new confirmation card, not
as an execution. A retry of an answer that already ran replays the stored
result.

The key is the part not to lose. The answer arrives with its own `commandId`,
and a resume that built its key from that would be a different attempt: core
would ask again every time, and nothing would ever run.

## The spend ceiling

`POST /assistant/kit/chat` and `/answer` run under the same guard the previous
assistant used, on the same Redis keys and the same per-user bucket: a Kyiv-day
USD ceiling per company and globally, plus 20 turns/minute/user. The other
routes call no model and are unguarded; the event stream has its own
per-person limit instead, and never takes from the turn budget.

Reserve, run, and give the reservation back if nothing ran. A refusal never
spends a turn slot, and a turn that produced nothing gives its reservation
back. Answering an open question
skips the per-minute bucket — it is finishing work already admitted — but not
the money.

A refusal is `429` with `Retry-After` and `{ "error": { "code": "RATE_LIMITED" },
"retryAfterSec": n }`. The app shows it as the rate-limit banner, not as a fault.

Charged at the reservation (`AI_UNKNOWN_MODEL_TURN_USD`, default $0.10/turn)
whatever the turn actually used. The reservation **is** the charge: nothing
reconciles it against real provider spend afterwards, so the counter is an
admission threshold rather than a ledger (SHO-572).

```
AI_CHAT_TURNS_PER_MINUTE_PER_USER=20
AI_DAILY_BUDGET_USD_PER_COMPANY=5
AI_DAILY_BUDGET_USD_GLOBAL=100
AI_UNKNOWN_MODEL_TURN_USD=0.1
```

## What is deliberately missing

- **Streaming.** Responses are whole JSON, so the sheet shows a wait row rather
  than text appearing as it is generated.

## The worker turn path

A turn is accepted by the API into Postgres and executed by the worker from a
pg-boss job (ADR-0039, ADR-0041, SHO-651). `assistant.acceptTurn` sends the
`assistant.turn` job with `ctx.enqueue` **in the accepting transaction**: the
row and its job commit together or neither does, and a replayed or busy accept
sends nothing.

### Reading what a turn is doing

Three places, in this order. The row is the truth; the job and the events are
how it is being run and watched.

```sql
select command_id, kind, status, end_reason, created_at, started_at,
       deadline_at, finished_at,
       company_reserved_micro_usd, global_reserved_micro_usd
from assistant_turns
where conversation_id = '<conversationId>'
order by created_at desc;
```

- `queued`: accepted, not started. It holds the conversation; its job is in
  `pgboss`.
- `running` with `deadline_at` in the past: its worker is gone (a crash, an
  abandoned attempt, or a member removed mid-turn, which core refuses the
  finish of). The overdue sweep ends it.
- `done` / `failed` / `interrupted`: ended, hold zeroed, conversation free.
  `interrupted` is what **Продовжити** (`POST /assistant/kit/continue`,
  SHO-574) continues: a new turn from saved history with no new text, under a
  db `kind: "answer"` row so it needs no new `assistant_turns.kind` value —
  and `continues_command_id` set to the interrupted turn's own command (or, for
  a continuation of a continuation, that command's own root), so its tools'
  idempotency keys replay the interrupted turn's writes rather than repeating
  them (SHO-547).

The job for that turn is a row in the same database:

```sql
select id, name, state, retry_count, start_after, created_on
from pgboss.job
where name in ('assistant.turn', 'assistant.turn.exhausted')
order by created_on desc limit 20;
```

`end_reason` says how a turn that did not finish itself ended: `not_started`
for a turn whose job was exhausted before it ever ran (its hold is refunded),
`job_exhausted` for one abandoned while running, `timeout` for one the overdue
sweep found past its deadline. The last two keep the reservation as the charge.

### Failure, exhaustion and recovery

A turn's job has **zero retries** and an attempt timeout of 210 s (the 180 s
turn timeout plus room for its final writes). Anything that fails the attempt —
a thrown handler, a start core refused for a removed member, a queued turn past
its 15-minute start deadline, an abandoned attempt, a worker with no model —
fails it with a typed code and exhausts the job. pg-boss then runs
`assistant.interruptTurn` on the exhaustion queue, in the job's recorded
company: the turn becomes `interrupted`, its conversation is free, and the hold
the statement zeroed is handed back. A post-commit hook runs the shared
recovery helper on that output — release the hold for a turn that never
started, settle the placeholder's text as the turn's own author, publish
`turn.finished`. Nothing is swallowed and logged as a success.

```bash
grep "job attempt failed" worker.log | tail -20
grep "assistant turn job processed" worker.log | tail -20
```

### The overdue sweep

Every 60 s the global periodic job `assistant.sweepOverdueTurns` pages
`assistant.listOverdueTurns`, groups what it finds by company, ends each
group through the tenant `assistant.sweepOverdueTurns` action and hands every
ended turn to the same recovery helper. It exists for the turns no job
exhaustion will reach — a worker that died holding an attempt.

| What it finds | What it does |
| --- | --- |
| `queued`, accepted under 15 minutes ago | leaves it alone — its job is waiting its turn |
| `queued`, never started, older than **15 min** | interrupts it (`not_started`) and **gives its hold back** |
| `running` past its deadline | interrupts it (`timeout`) and **keeps the reservation as the charge** |

The same `overdue()` predicate refuses a start: `assistant.startTurn` will not
claim a queued turn at or after `created_at + 15 minutes`, so a late worker
cannot start a turn the sweep is about to end, and the sweep cannot end one a
worker has just started.

**A pass that dropped work is logged, not retried.** A turn this pass ended is
no longer overdue, so no later pass finds it again, and the job has zero
retries. A recovery that drops a step throws; the pass counts it in
`failedTurns` (`failedCompanies` for a group it could not end), logs it and
carries on with the siblings and the other companies. The dropped hold waits
for its Kyiv-day key to expire — a lost refund is the safe direction — and the
placeholder keeps its streaming part until the conversation is reloaded.

```bash
grep "assistant overdue turns swept" worker.log | tail -1
```

**Lag is expected.** After a worker crash the interruption becomes visible only
once the sweep passes the deadline — up to the turn timeout (180 s) plus one
interval (60 s). That is not a hang; nothing is lost, and what the turn stored
stands.

### Shutdown drains jobs

`SIGTERM` drains the one job runner first and waits for the attempts this
process is running, up to `JOB_DRAIN_TIMEOUT_MS` (210 s), before the outbox
loop stops and the database, Redis and the object store close. Past that the
runner abandons its attempts; those rows are then the sweep's, exactly as a
crashed worker's are.

**Required before production:** the platform's stop grace period must be at
least that bound, or a deploy kills turns the drain is waiting for. Recorded,
not configured — there is no production environment yet.

### Signing out does not cancel a turn

A turn accepted before its author signed out still runs to completion (owner
decision, ADR-0039 as amended). The worker reads no session: the actor is the
turn row's `user_id`, and core re-checks that person's membership on every
action the turn runs. So:

- **to stop what a turn can still do, remove the membership** — the next action
  it attempts is refused, its job is exhausted, and the turn ends with the hold
  charged;
- signing out ends that person's event streams within 15 s, but not the turn.

## pg-boss acceptance (SHO-715)

The worker path's device scenarios, carried over from the canceled SHO-565
without its Redis/BullMQ queue operations. A stub-model or database test below
is technical evidence; it is **not** device acceptance. Every device row is
**pending owner acceptance** until someone runs it on a phone and fills it in.
A real defect found here gets its own bounded ticket.

Checked commit `34aaf15c`. CI on `main` at that commit:
[run 35142355827](https://github.com/KurbatovIvann/shozee/actions/runs/35142355827),
all 13 jobs green. A push to `main` runs every Turbo task in full (no
`--affected`), and since SHO-708 the Turbo cache is write-only
(`--cache=local:w`): that run reports `0 cached` for `typecheck` (29 tasks),
`lint` (30) and `test-unit` (30), and `test-db` runs the whole DB suite in one
Vitest process. The one step skipped by selection is `dependency-audit`'s
`pnpm audit`, which runs only when a push changes a lockfile or manifest.

### Automated evidence

Paths are repository-relative; the quoted name is the `it(...)` title.

| Scenario | Tests | Not covered |
| --- | --- | --- |
| 1. Lock, background or force-close mid-turn, reopen | `apps/api/src/http/assistant-kit-events.db.test.ts`: "starts with a snapshot equal to GET /assistant/kit/messages", "shows the current state on a reconnect after an event it missed"; `apps/mobile/src/features/assistant/thread/assistant-thread-merge.test.ts`: "replaces stale state from the snapshot it opens with", "does not bring back a turn a reconnect snapshot showed ended, and reads the window"; `apps/mobile/src/features/assistant/api/assistant-events-client.test.ts`: "ends a connection that has heard nothing for several heartbeats" | No automated test drives the app lifecycle (lock, background, force-close) |
| 2. Airplane mode, reconnect, same-command retry | `apps/mobile/src/features/assistant/thread/use-assistant-conversation.test.ts`: "sends the same command token, so the server can replay it"; `apps/api/src/http/assistant-kit.test.ts`: "enqueues nothing for a replayed turn whose committed accept already sent its job, and writes nothing twice"; `apps/api/src/stores/assistant-turn-store.db.test.ts`: "replays a repeated command in another casing, names the same job, and writes nothing"; `packages/modules/assistant/src/actions/turns.db.test.ts`: "of the same command: one is accepted and the other replays it", "replays a command whose turn has already ended, rather than running it again"; `apps/api/src/http/assistant-kit-confirmation.db.test.ts`: "replays rather than running again when a confirmed answer is retried" | No automated test toggles the network |
| 3. Stop or kill a worker mid-turn | `packages/modules/assistant/src/actions/turns.db.test.ts`: "interrupts a running turn past its deadline once, audited in its company"; `packages/assistant-runtime/src/assistant-overdue-sweep.test.ts`: "drains page after page, keyed on the last identity, and sweeps each company once"; `apps/api/src/assistant-turn-processor.db.test.ts`: "stores \`interrupted\` when its deadline fires, and keeps the card committed before it", "replays a write the interrupted turn committed when its continuation repeats it: one customer, not two", "stores nothing after the end, so the continuation's history stands" | No test kills a worker process; the tests start the rows a dead worker leaves |
| 4. Queued chat and answer turns past the start deadline | `packages/modules/assistant/src/actions/turns.db.test.ts`: "refuses to start a queued turn past its start deadline and ends it as never started", "never ends a turn that already ended, whichever of the two came first"; `packages/modules/assistant/src/actions/sweep-overdue-turns.db.test.ts`: "stores not_started on an answer turn and a snapshot read returns it with the continuation's command", "are distinct: a queued turn is overdue fifteen minutes after its accept, a running one only past its own deadline"; `apps/api/src/stores/assistant-turn-store.db.test.ts`: "names the interrupted turn's own placeholder, not the conversation's latest message"; `apps/api/src/assistant-turn-processor.db.test.ts`: "runs nothing for a job whose turn has already started"; `apps/mobile/src/features/assistant/thread/use-assistant-conversation.test.ts`: "shows the stored reason for a turn that never started, and again after a reconnect" | — |
| 5. Worker with no model; author membership removed | `apps/worker/src/jobs.db.test.ts`: "boots with no model, closes a leftover queued turn as not_started through its exhaustion, settles its placeholder and gives its hold back"; `apps/api/src/assistant-turn-processor.db.test.ts`: "runs and writes nothing for an author who lost membership: the refused start fails the job and the turn stays queued", "is refused at the next action: nothing is created, nothing reads as done, and the turn is left for exhaustion to close"; `apps/mobile/src/features/assistant/thread/assistant-thread-merge.test.ts`: "reports none for a turn ended for a removed author, even with a streaming placeholder still stored" | — |
| 6. Failed post-terminal recovery | `packages/assistant-runtime/src/assistant-turn-recovery.db.test.ts`: "says the hold was dropped when the budget store fails, and leaves the turn ended with its reservation standing", "still ends the turn's budget and publishes its status when the author write fails, and says the text was dropped"; `packages/assistant-runtime/src/assistant-overdue-sweep.test.ts`: "counts a turn whose own recovery fails, recovers its siblings and the other companies, and still returns the pass"; `packages/assistant-runtime/src/assistant-budget-guard.test.ts`: "says the release failed when the store is down, leaving the reservation to its ttl"; `packages/assistant-runtime/src/stores/budget.test.ts`: "forgets a hold once its ttl passes, so a new day reserves again" | — |
| 7. Failed boot with a running job (SHO-714) | `apps/worker/src/jobs.db.test.ts`: "keeps a running job's database, Redis and object store open until its drain settles when only the listener fails to start"; `apps/worker/src/boot.test.ts`: "keeps the boot error, still attempts every release and logs each cleanup failure" | Not a device scenario |

Scenario 6 is best effort by decision: a dropped refund is logged, never
retried, and the reservation stands until its Kyiv-day key expires; a dropped
placeholder text keeps its streaming part until the conversation is reloaded
(see [The overdue sweep](#the-overdue-sweep)).

### Device checklist

Run against a local API and worker. Record each run as a row.

1. **Lock, background, force-close.** Send a chat that calls tools; mid-turn
   lock the phone, then background the app, then force-close it; reopen.
   Expect every committed message and card still shown and the window matching
   `messages` for that conversation.
2. **Airplane mode.** Send a chat, enable airplane mode before the reply,
   disable it and let the app retry. Expect one `assistant_turns` row for the
   command and one business write.
3. **Kill the worker.** Start a write-heavy turn, stop the worker process after
   the first card. Expect the turn `interrupted` (`timeout`) within 180 s + 60 s
   once a worker runs again, the conversation free, the card kept, and
   **Продовжити** not repeating the committed write.
4. **Start deadline.** With the worker stopped, send a chat and, in another
   conversation, answer an open question; wait past 15 minutes; start the
   worker. Expect both `interrupted` + `not_started` on their own placeholders,
   **Продовжити** offered on the answer turn, and no work from the late jobs.
5. **No model, removed member.** Start the worker with no model and send a
   chat; separately remove the author's membership mid-turn. Expect no
   unauthorized write and each turn ended by exhaustion or the sweep.

| # | Device / build | Commit | Expected | Actual | Result |
| --- | --- | --- | --- | --- | --- |
| 1 | | | as above | | pending owner acceptance |
| 2 | | | as above | | pending owner acceptance |
| 3 | | | as above | | pending owner acceptance |
| 4 | | | as above | | pending owner acceptance |
| 5 | | | as above | | pending owner acceptance |

## Reading the state directly

The open question is Redis — the shared, non-persistent instance (`db.md` §6);
the conversation is Postgres. The turn's job is a pg-boss row in Postgres too
(ADR-0041, SHO-651), carrying only the turn's identity.

```
kit:pause:<conversationId>      the open interaction, if any
```

```sql
select seq, message_id, message
from assistant_chat_messages
where conversation_id = '<conversationId>'
order by seq;
```

```sql
select history, updated_at
from assistant_chat_state
where conversation_id = '<conversationId>';
```

The transcript is a log, one row per message, ordered by `seq`. A message is
written by the request that produced it and not touched after, so nothing
rewrites the conversation, and a message the running build cannot parse is
skipped — logged as `assistant message could not be read and was skipped` —
instead of emptying it (SHO-555). The provider messages the next turn is built
from are one value in `assistant_chat_state`, replaced whole.

That value is written by the accept, in the accept's own transaction
(SHO-575): a chat accept appends the person's message to it, an answer accept
replaces it with the resumed transcript, and **Продовжити** writes nothing and
runs from what is stored. So a turn row and the history that turn runs from
exist together or not at all — no route can accept a turn and leave its
history behind. After the accept, only the worker writes it: once per finished
step, and once more for a step that paused.

There is one way to find a `queued` turn whose `history` does not end in the
person's question, and it is worth recognising before you go looking for a
route that produced it. A turn the sweep ended past its deadline may
still have a live worker; that worker's next per-step save writes the whole
value and can land after the accept that took the conversation next. Look for
an `interrupted` turn finished shortly before this one was accepted, and for
worker log lines under its command after that time.

Read and written through `assistant.readChatMessages` /
`assistant.insertChatMessage` / `assistant.updateChatMessage` and
`assistant.readChatState` / `assistant.writeChatState` as the caller, so the
tenant scope and the author rule are the same ones every other read of that
conversation goes through. A conversation that is not yours, and one that does
not exist, both answer `410` — the store cannot tell them apart and must not.

Each message also carries the kit's own `bind` (`<userId>:<companyId>`), checked
inside the package and never sent to a client. Two independent answers to the
same question, which is deliberate: the table scope is enforced by the database,
the `bind` by the protocol.

## How much conversation the model sees

The last **six requests**, cut on request boundaries — never inside a turn,
because a provider refuses a history where a tool call has no result.

Counted in requests rather than messages: one request that calls a tool is three
or four messages, so "ten messages" would be two and a half requests. Six covers
create, amend, check, act on what was just shown, with room for a detour.

The row keeps what the last turn ran with; the window is applied on the way out.
A turn appends to the window it was given, so the stored value never holds more
than one request beyond it.

Nothing is summarised. A précis of an operations log is not context for the next
action and costs a model call to produce. Old turns simply fall out — which is
also how a habit picked up from earlier turns stops being demonstrated.

```sql
select jsonb_array_length(history) as messages,
       (select count(*) from assistant_chat_messages m
        where m.conversation_id = s.conversation_id) as visible
from assistant_chat_state s where conversation_id = '<conversationId>';
```

`ASSISTANT_HISTORY_TURNS` and `ASSISTANT_HISTORY_MESSAGES_MAX` (a backstop for a
turn that called many tools) live in
`packages/assistant-runtime/src/assistant-kit-history-window.ts`.

## What the audit says

What the assistant *did* is in `audit_log`, not here — every tool call runs
through `executeAction` with `channel: "ai"` and the request id as `ai_trace_id`:

```sql
select action, outcome, duration_ms, created_at
from audit_log
where channel = 'ai' and ai_trace_id = '<requestId>'
order by created_at;
```
