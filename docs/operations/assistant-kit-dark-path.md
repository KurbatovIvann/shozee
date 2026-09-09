# Running the assistant-kit path by hand

The `assistant-kit` routes sit beside the live assistant. They are off unless
`AI_ASSISTANT_KIT=1`, use their own Redis key prefix (`kit:`), and share nothing
with the pending store the live assistant uses. Turning them on changes nothing
about `/assistant/chat`.

This exists because the previous rewrite passed CI and still behaved worse on a
phone. A protocol with 78 green tests and no minutes of real use is not yet
known to work.

## Turning it on

```
AI_ASSISTANT_KIT=1
```

Boot mounts it only when a provider is also configured — there is nothing to
exercise without one. With the flag off, `createApp` never sees the option and
the routes do not exist.

Boot says which of those happened, so it is never a guess:

```
{"msg":"assistant-kit path","enabled":true,"mounted":true,
 "paths":["POST /assistant/kit/chat","POST /assistant/kit/choice","GET /assistant/kit/messages"]}
```

`enabled:true, mounted:false` means the flag is on but no language model was
configured.

## Nothing calls these routes on its own

The mobile app still talks to `/assistant/chat`. Turning the flag on does not
change what the phone does, and it never will until the client is pointed here.
Until then the only way this path runs is if you call it.

That is the point of the flag: the two runtimes sit side by side on the same
data, and the old one keeps serving.

## The three routes

| Method | Path | Body / query |
| --- | --- | --- |
| POST | `/assistant/kit/chat` | `{ commandId, conversationId, text }` |
| POST | `/assistant/kit/choice` | `{ commandId, conversationId, interactionId, revision, answer }` |
| GET | `/assistant/kit/messages` | `?conversationId=` |

Same auth as the live assistant: staff session cookie plus `x-company-id`.
`commandId` and `conversationId` are uuids the client makes up.

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

Answering a question it asked (take `interactionId` and `revision` from the
`pause` in the previous response, and `optionId` from `pause.prompt.options`):

```bash
curl -sS "$KIT/assistant/kit/choice" -H "cookie: $COOKIE" -H "x-company-id: $COMPANY" -H 'content-type: application/json' -d "{\"commandId\":\"$(uuidgen)\",\"conversationId\":\"$CONV\",\"interactionId\":\"PASTE\",\"revision\":1,\"answer\":{\"optionId\":\"PASTE\"}}" | jq
```

What a reload would render:

```bash
curl -sS "$KIT/assistant/kit/messages?conversationId=$CONV" -H "cookie: $COOKIE" -H "x-company-id: $COMPANY" | jq
```

## The scenario worth running

1. **A read.** `chat` with "покажи замовлення цього клієнта". Expect one list or
   aggregate card in `parts`, not one card per row.
2. **A write that needs a choice.** `chat` with "створи замовлення для <an
   ambiguous name>". Expect `pause` with the options, and `parts` containing an
   `interaction` part.
3. **Answer it.** `choice` with `{ optionId }` from that pause. Expect the
   record's card **first** in `parts`, then the explanation, and `pause: null`.
4. **Reload.** `messages`. Expect exactly the parts the two turns returned, and
   no open pause.
5. **The second question.** Try a request where both the customer and the product
   are ambiguous. Expect a pause, then after answering it, **another** pause
   rather than an error.

What to watch for, because these are the failures the old path had:

- two cards for one order, or none after a picker
- a confident "Готово." when nothing was written
- the card disappearing when the action refuses
- a reload showing a different set of cards than the live turn did

## What is deliberately missing

- **Budget and rate limits.** Not wired. Do not leave this on unattended with a
  real key.
- **Durable model history.** It lives in Redis with a ttl, so a conversation that
  sits long enough starts over. One port to replace; not a protocol question.
- **The mobile client.** Untouched — it still talks to the live assistant. Use an
  HTTP client for now.
- **Streaming.** Responses are whole JSON.

## Reading the state directly

```
kit:pause:<conversationId>      the open interaction, if any
kit:doc:<conversationId>        the chat document
kit:history:<bind>:<conversationId>   provider messages for the next turn
```

`bind` is `<userId>:<companyId>`. A document carries the `bind` it was created
under; reading it as anyone else returns an empty document on purpose.
