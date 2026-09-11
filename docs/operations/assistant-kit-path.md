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
  "messages": [...], "olderCursor": "12", "openPause": null } }
```

`messages` are the latest thirty, each exactly as stored. `olderCursor` is null
when nothing precedes them; otherwise `GET /assistant/kit/messages` with
`&before=<olderCursor>` returns the page before. A message is never changed once
its request ends, so a page a client already holds does not go stale.

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
- **Idle streams close** after 10 minutes without an event.
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

Reserve, run, settle or release. A refusal never spends a turn slot, and a turn
that produced nothing gives its reservation back. Answering an open question
skips the per-minute bucket — it is finishing work already admitted — but not
the money.

A refusal is `429` with `Retry-After` and `{ "error": { "code": "RATE_LIMITED" },
"retryAfterSec": n }`. The app shows it as the rate-limit banner, not as a fault.

Charged at the reservation (`AI_UNKNOWN_MODEL_TURN_USD`, default $0.10/turn)
whatever the turn actually used — the previous path settled the same way, so
this is the same coarseness, not a new one.

```
AI_CHAT_TURNS_PER_MINUTE_PER_USER=20
AI_DAILY_BUDGET_USD_PER_COMPANY=5
AI_DAILY_BUDGET_USD_GLOBAL=100
AI_UNKNOWN_MODEL_TURN_USD=0.1
```

## What is deliberately missing

- **Streaming.** Responses are whole JSON, so the sheet shows a wait row rather
  than text appearing as it is generated.

## Reading the state directly

The open question is Redis — the shared, non-persistent instance (`db.md` §6);
the conversation is Postgres. The assistant queue (ADR-0039, from SHO-561) will
live on the separate queue Redis and hold only pointers to turns.

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
