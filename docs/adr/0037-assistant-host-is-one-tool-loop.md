# ADR-0037: The staff assistant host is one tool loop

- **Status**: Accepted
- **Date**: 2026-09-08
- **Deciders**: Ivan Kurbatov (human) (+ proposing agent: Linear
  [SHO-519](https://linear.app/showzy-v2/issue/SHO-519) /
  [SHO-520](https://linear.app/showzy-v2/issue/SHO-520))

## Context

The staff Shozik tab must finish a job such as “створи замовлення на
макаронси і покажи замовлення цього клієнта” as **one** agent loop: the
model chooses tools and explains results; a picker or confirmation pauses
the write; after the human taps, the server runs the **stored** request
and the **same** loop continues the rest of the job.

Today’s live host (`streamStaffAssistantChat` + intent gate +
`commitTurnSpeech`) cannot be that loop:

- ADR-0035 stores one pending-interaction record, but treats resume as
  **zero model after execute** — protocol copy is the end of the job.
  A second list after a picker therefore needs a new user turn or a
  second conversation protocol.
- ADR-0036 speech priority is protocol-first (HITL / typed domain-error
  copy, then model prose). `presentOrderCreatedSpeech` and catalog
  domain-error copy win over usable model text. The guardrail also
  rejects markdown tables and `**`, so a table in model prose is
  rewritten to a generic fallback.
- Confirmation resume still asks the model to re-emit tool args
  (`x-confirmation-challenge-id` on `POST /assistant/chat`). Choice
  resume is a separate HTTP shape that does not continue the loop.
- Replace is not named: matching `actionName` is not a product
  decision. Chat text, including «Так», is not a confirmation.

SHO-516 (modelless confirmation as end of job) is cancelled. This ADR
replaces that host. The action graph, façades, surface registry, and
`packages/core` confirmation protocol stay.

Forces:

- **One `streamText` host** (ADR-0032). Not WorkflowAgent, LangGraph,
  or a second AI framework.
- **Stored canonical input** is server-authoritative (ADR-0035 store).
  Resume must not take action args from the client or from model output.
- **Speech is not a surface** (ADR-0036 three-part split). The bubble
  is model prose. Cards stay cards.
- **Live switch is T5.** History (T2), pending lifecycle (T3), slim
  prompt (T4), and markdown bubbles ([SHO-525](https://linear.app/showzy-v2/issue/SHO-525))
  land first. T1 accepts this ADR by merging its PR and ships a **new**
  runtime that tests invoke directly. Production `POST /assistant/chat`
  stays on the old stream until T5.

## Decision

The staff assistant host is **one AI SDK 7 `streamText` loop**. After
HITL the server executes stored canonical input, then continues that
loop from **persisted** messages. Speech is usable model prose. Live
`/assistant/chat` switches in T5.

### 1. One host

`packages/ai` owns a new runtime (`src/runtime/`) that tests invoke
directly. It is not a patch of `staff-assistant-stream.ts`. The old
stream and gate remain the live HTTP path until T5 deletes them.

Tools in one model step run **sequentially**. Before each domain
execute the host checks pending (T1: stub that always allows; T3: real
one-open-pending rule).

### 2. HITL pause and resume

After `needs_choice` / `confirmation_required` in a turn: no further
tool executes this turn; one narration step; the HITL card is shown.
The pause turn is **speech-only**. Model output is never a resolution
(no claim, `optionId`, `confirmationChallengeId`, `pendingId`, or
pending version from the model). «Так» is not confirmation, picker
resolution, replace, or abandon.

Resume (`POST /assistant/choice` and, in T3, `POST /assistant/confirm`):
claim stored canonical input (ids only on the wire) → `executeAction`
→ persist that run → continue the loop from persisted messages (no
duplicated user line / tool result). Both routes return the same resume
envelope. Generation failure after a committed write retries from the
last saved tool run, never a second domain write for that
`execution_id`.

This **keeps** the ADR-0035 store (one pending-interaction record,
discriminated `kind`, CAS, bind isolation). Core hash+GETDEL are still
both required for `approval.source: "core"`. Host confirmation uses
Redis claim + displayed expiry, only for unique `orders.create` after
`pending_replace` when `requiresConfirmation` is `false`. It **drops**
“zero model after execute” as the end of the job.

### 3. One pending; replace is not matching `actionName`

One open pending per conversation. New user chat text does not cancel
it. An independent write while `open` is refused — including another
`orders.create`. Matching `actionName` is not replace.

**Replace** is only an explicit version-CAS of **this** pending
(`pending_replace` host tool in T3): the host injects pending id and
version; the model does not supply them; re-validate; old confirmation
does not carry.

**Abandon** is a named HTTP (`POST /assistant/pending/abandon` in T3).
Card dismiss/cancel uses that. Client-local hide that leaves pending
`open` is not allowed.

Chat and resume share a conversation lock (T3). `claimed` execute wins
over concurrent chat; a stale tap after replace/abandon is `expired`.

### 4. Speech (inverts ADR-0036 priority)

Usable model prose is the bubble. Guardrail rejects leftover `{…}` JSON
only — not emphasis `**`, and **not** markdown tables. Tables are a
style/eval rule (prompt in T4; eval may warn), not a `speech.ts`
rewrite. Do not use `presentOrderCreatedSpeech` or catalog domain-error
copy as the winner over model text. `speech.source` stays in-memory
(`model` | `fallback`; protocol copy is not the bubble on the new
host). No `{ spoken }` JSON envelope. No presenter.

Priority on the new host: usable model prose; else one locale-keyed
generic fallback (including leftover JSON). The live path still uses
`commitTurnSpeech` protocol-first until T5.

### 5. Attempt identity (T2 / T3)

Before every domain execute, the host persists `execution_id` + enough
input to retry **that** call (`stageRun` via
`assistant.checkpointAssistantTurn`, T2). Crash after domain commit
and before `finishRun` recovers the id from storage and replays via
existing idempotency.

Identity rules (T2/T3 work, recorded here):

- **Confirm** = same attempt (`execution_id`).
- **Replace** with new args = new attempt.
- **HTTP retry** = same attempt (do not mint a new `execution_id`).

ADR-0034 `model_trace` is extended in T2 to `error` /
`choice_required` / `confirmation_required` / `started`. Do not
overload `assistant.recordAssistantTurn` as checkpointing.

### 6. Compatibility

`x-confirmation-challenge-id` on `POST /assistant/chat` stays as an
adapter until T5. At T5 the adapter may call the **new** confirm
executor only; the model re-entry path is deleted with the old host.

Choice resume HTTP stays as today until T5. Do not stream production
HITL through the live chat mount in T1–T4.

## Alternatives considered

- **Patch `staff-assistant-stream.ts` in place** — rejected. The live
  path must keep working until history, resume, mobile cards, and
  markdown bubbles exist. A second file is the replace, not a flag.
- **Keep zero-model resume as end of job** (SHO-516 / ADR-0035 §4) —
  rejected. The owner job is one loop that continues after the write.
- **Infer replace from matching `actionName`** — rejected. Replace is
  an explicit version-CAS of this pending.
- **Chat text cancels pending / «Так» confirms** — rejected. An
  intent classifier for cancel is a stop-condition. Confirmation is a
  named HTTP with a session, not model or chat text.
- **Substitute speech because the model used a markdown table** —
  rejected. Tables are style; SHO-525 renders a closed markdown subset.
- **WorkflowAgent / LangGraph / a second AI framework** — rejected
  (ADR-0032).
- **Switch live `/assistant/chat` in T1** — rejected. Live switch is T5.

## Consequences

- Positive: one conversation protocol; model explains results; HITL
  is a pause, not a second product; speech matches what the model said.
- Negative: two hosts exist until T5 (old live, new test-only). Agents
  must not retarget production composition early.
- Migration: T1 this ADR + new loop (tests only). T2 durable history.
  T3 pending versioning, confirm/abandon, conversation lock. T4 slim
  prompt, drop the live gate on the new host. T5 live switch and delete
  the old stream/gate/speaker.
- Related: ADR-0032 (SDK 7 loop), ADR-0033 (same `executeAction`),
  ADR-0034 (trace as prompt state; T2 extension), ADR-0035 (store kept,
  zero-model-as-end superseded in part), ADR-0036 (three-part split
  kept; speech priority inverted on the new host).
- `packages/core` unchanged.
