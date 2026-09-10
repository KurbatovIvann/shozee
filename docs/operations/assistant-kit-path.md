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
          "POST /assistant/kit/abandon","GET /assistant/kit/messages"]}
```

`enabled:true, mounted:false` means the flag is on but no language model was
configured.

## What the phone does now

The sheet resolves its conversation through the existing
`assistant.createConversation` / `listConversations` pair — one row per person per
company, found again by listing — and then does nothing but read this path's
document and post answers to it. It mints no parts of its own and holds no memory
of which questions it has already dealt with; a source test
(`sheet/use-assistant-sheet.seam.test.ts`) fails if an import from the previous
client sneaks back in.

Nothing of the previous client remains on disk.

## The four routes

| Method | Path | Body / query |
| --- | --- | --- |
| POST | `/assistant/kit/chat` | `{ commandId, conversationId, text }` |
| POST | `/assistant/kit/answer` | `{ commandId, conversationId, interactionId, revision, answer }` |
| POST | `/assistant/kit/abandon` | `{ conversationId, interactionId }` |
| GET | `/assistant/kit/messages` | `?conversationId=` |

Same auth as the live assistant: staff session cookie plus `x-company-id`.
`commandId` and `conversationId` are uuids the client makes up.

One answer route for every kind of question, not one per kind: `answer` is
opaque, and the stored pause says which kind it belongs to. `abandon` is how a
question is dropped — including saying no to a confirmation, which is not an
answer to it but a decision to stop.

**Every route answers with the whole document**, never with just the parts one
request produced:

```json
{ "status": "ok", "document": { "conversationId": "...", "bind": "...",
  "messages": [...], "openPause": null } }
```

A refusal carries it too — `409 stale`, `409 unresolvable`, `409 action_failed`
and `409 interaction_open` all come back with the current `document`, so a client
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
`document.openPause` in the previous response, and `optionId` from
`document.openPause.prompt.options`):

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

## The scenario worth running

1. **A read.** `chat` with "покажи замовлення цього клієнта". Expect one list or
   aggregate card in the last message, not one card per row.
2. **A write that needs a choice.** `chat` with "створи замовлення для <an
   ambiguous name>". Expect `document.openPause` with the options, and an
   `interaction` part in the last message.
3. **Answer it.** `answer` with `{ optionId }` from that pause. In the last
   message expect the record's card **first**, then the explanation, and
   `document.openPause: null`.
4. **Reload.** `messages`. Expect a document byte-identical to the one the turn
   returned.
5. **The second question.** Try a request where both the customer and the product
   are ambiguous. Expect a pause, then after answering it, **another** pause
   rather than an error.
6. **Drop one.** Ask something ambiguous, then `abandon` it. Expect the next
   `chat` to be accepted rather than refused with `interaction_open`.

What to watch for, because these are the failures the old path had:

- two cards for one order, or none after a picker
- a confident "Готово." when nothing was written
- the card disappearing when the action refuses
- a reload showing a different set of cards than the live turn did

## The spend ceiling

`POST /assistant/kit/chat` and `/answer` run under the same guard the previous
assistant used, on the same Redis keys and the same per-user bucket: a Kyiv-day
USD ceiling per company and globally, plus 20 turns/minute/user. The other two
routes call no model and are unguarded.

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

- **Confirmations.** The kind is registered, the server can store one and the
  sheet can render and answer it, but nothing on the server *opens* one yet — only
  `choice` occurs in practice, from a catalog picker conflict.
- **Streaming.** Responses are whole JSON, so the sheet shows a wait row rather
  than text appearing as it is generated.

## Reading the state directly

The open question is Redis; the conversation is Postgres.

```
kit:pause:<conversationId>      the open interaction, if any
```

```sql
select document, history, updated_at
from assistant_chat_state
where conversation_id = '<conversationId>';
```

Two blobs in one row: the chat document a person reads, and the provider
messages the next turn is built from. Both are replaced whole — there is no
append, so a row is always a complete document rather than a fold over deltas,
and that is what makes a reload byte-identical to the live turn.

Read and written through `assistant.readChatState` / `assistant.writeChatState`
as the caller, so the tenant scope and the author rule are the same ones every
other read of that conversation goes through. A conversation that is not yours,
and one that does not exist, both answer `410` — the store cannot tell them
apart and must not.

The document also carries the kit's own `bind` (`<userId>:<companyId>`), checked
inside the package. Two independent answers to the same question, which is
deliberate: the table scope is enforced by the database, the `bind` by the
protocol.

## What the audit says

What the assistant *did* is in `audit_log`, not here — every tool call runs
through `executeAction` with `channel: "ai"` and the request id as `ai_trace_id`:

```sql
select action, outcome, duration_ms, created_at
from audit_log
where channel = 'ai' and ai_trace_id = '<requestId>'
order by created_at;
```
