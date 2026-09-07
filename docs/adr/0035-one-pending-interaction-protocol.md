# ADR-0035: One pending-interaction protocol; confirmation resumes without a model call

- **Status**: Accepted
- **Date**: 2026-09-07
- **Deciders**: Ivan Kurbatov (+ proposing agent: Shozik audit,
  Linear [SHO-430](https://linear.app/showzy-v2/issue/SHO-430) /
  [SHO-516](https://linear.app/showzy-v2/issue/SHO-516))

## Context

The staff assistant pauses a turn for a human in two situations: a
`requiresConfirmation` action (core.md §7) and an ambiguous reference in
`orders.create` that opens a picker (SHO-409/SHO-410 "choice"). Both mean
"a human must resolve something before the server continues", and today
they resume through two different mechanisms.

| | Confirmation (today) | Choice (today) |
| -- | -- | -- |
| Pause | `wrapExecute` catches `ConfirmationRequiredError`, records `{ actionName, toolCallId, challengeId }`, streams a `data-confirmation` card | `wrapExecute` maps an `orders.create` `CONFLICT` to a picker, writes a `ChoiceRecord` to Redis, streams a `needs_choice` card |
| Server-side record | Core challenge only: `{ challengeId, actionName, inputHash, principalKey, companyId, idempotencyKey, expiresAt }` — **no input** | `ChoiceRecord` in `apps/api` store: `status`, actor/company/conversation bind, **canonical `orders.create` input**, server-only target, option map, envelope |
| Resume entry | `POST /assistant/chat` + `x-confirmation-challenge-id` header + the client's echoed history | `POST /assistant/choice { conversationId, choiceId, optionId }` |
| Who re-emits the action input | **The model.** The gate is skipped, the main model runs again and must re-emit the identical tool call; core consumes the challenge (`GETDEL`) and checks the input hash and bindings | **The server.** Claim `open → claimed` (CAS), patch the stored canonical input with the mapped id, `executeAction("orders.create")`, mark `completed`; no model |
| Store semantics | Single-use `GETDEL` | `open → claimed → completed`, replay of the same option is idempotent, a different option is `conflict` |
| Reply text | Whatever the model says after the tool result | Presenter text (`presentCompletedStaffAssistantTurn`) |
| Cost | Two full model calls per confirmed write | Zero model calls on resume |

The confirmation resume has a structural problem, not a tuning problem: the
server already knows exactly which action and which input the human
approved, yet it asks a non-deterministic component to reproduce that input.
If the model emits different arguments the core hash check correctly fails
closed and a **new** challenge is issued — the user sees the same card twice.
SHO-401 guards this with prompt text; SHO-428 verifies it by hand. The
second model call also costs a full input pass over system prompt, tools,
and history for a step whose only acceptable output is a byte-identical
tool call.

Choice already demonstrates the right shape. It was built orders-specific
because SHO-409 needed it fast, and its record schema (`canonicalInput`
typed as the `orders.create` input, `optionMap`, `envelope`) reflects that.

Forces:

- **Core is not the missing piece.** core.md §7 accepts a re-invocation
  with `{ challengeId }` + hash-identical input from *any* caller; §5
  persists the consumed grant on the idempotency reservation so a crash
  after commit replays rather than re-executes. Nothing in `packages/core`
  needs to change for a server-driven resume.
- **The input is in hand at pause time.** `wrapExecute` receives the
  canonical input (façades map before calling `execute`) in the same frame
  where `ConfirmationRequiredError` is caught.
- **Two HITL protocols invite a third.** Every new pause reason (a price
  outside a band, a document needing a signer choice) would otherwise pick
  one of two patterns or invent its own.
- Post-SHO-504 the stream has no JSON envelope and no forced-job lifecycle
  ([SHO-507](https://linear.app/showzy-v2/issue/SHO-507),
  [SHO-513](https://linear.app/showzy-v2/issue/SHO-513)), so the resume
  path is simpler to converge after those land.
- ADR-0034 gives the next turn a `model_trace` of the confirmed run, so the
  model still "remembers" what happened even though it did not execute the
  resume.

## Decision

There is **one pending-interaction protocol**. A paused assistant turn is a
server-owned record that stores what the human is deciding about; resume is
a server-driven execution of that record with no model in the loop.
Confirmation becomes a second *producer* of the protocol that choice already
implements. `packages/core` is unchanged.

### 1. One record, discriminated by `kind`

`PendingInteractionRecord` (schema in `packages/ai`, store in
`apps/api/src/stores/pending-interaction.ts`, Redis with the existing Lua
CAS; keys `pending:{kind}:{id}`):

- common: `kind: "confirmation" | "choice"`, `id`, `status: "open" |
  "claimed" | "completed"`, bind `{ actorId, companyId, conversationId }`,
  `actionName`, `toolCallId`, `canonicalInput`, `locale`, `expiresAt`;
- `confirmation` variant: `id` **is the core `challengeId`**; `canonicalInput`
  is the exact object `executeAction` received (validated by the action's
  own Zod on resume, so the core hash matches); `resolution: "confirmed"`;
- `choice` variant: the current `ChoiceRecord` fields (`target`,
  `optionMap`, `envelope`, `claimedOptionId`) unchanged.

The orders-specific choice input schema stays inside the `choice` variant.
A generic record is not "the choice record with more optional fields".

### 2. One state machine

`open → claimed → completed`, compare-and-set on every transition, exactly
as `stores/choice.ts` does today. Replaying the **same** resolution on a
`claimed`/`completed` record returns the stored outcome; a **different**
resolution is `conflict`. `expired` and `forbidden` (bind mismatch) are
terminal and indistinguishable to the client ("this interaction has
expired"). `GETDEL` remains core's, never the api record's.

### 3. Pause writes the record; the model never sees the input again

`wrapExecute` gets one host callback `openPendingInteraction(record)`;
`apps/api` implements it with the store. For confirmation it is called in
the `ConfirmationRequiredError` branch with `{ challengeId, actionName,
toolCallId, canonicalInput }`; for choice it replaces the existing
`openChoice` hook. `packages/ai` does not import Redis. The streamed card
keeps its current shape (`data-confirmation`, `needs_choice`); clients keep
rendering ids and summaries, never input.

### 4. One resume route family, no model

`POST /assistant/confirm { conversationId, challengeId }` mirrors
`POST /assistant/choice`: session → resolve conversation → `claim`
(bind must match, else `expired`) → `executeAction(actionName,
canonicalInput, { confirmationChallengeId: challengeId, idempotencyKey:
attemptKey("tool", conversationId, toolCallId) })` → core consumes the
challenge and checks hash + bindings → persist the tool run
(`recordAssistantTurn`, outcome `success`, plus `model_trace` per
ADR-0034) → `complete` → one assistant turn with **presenter** text and the
entity card. Gate and reply model are not invoked.

Dismiss stays **client-local** (today's behaviour): nothing executes, the
record and the core challenge expire. A server-side "reject" outcome is not
part of this decision.

### 5. Two locks, both mandatory

The api record is *what to run*; the core challenge is *permission to run
it*. Resume succeeds only if the record claim passes **and** core's
`getAndDelete` + hash/binding check passes. Neither is trusted instead of
the other. A core mismatch (tampered record, expired challenge, idempotency
key drift) does not loop: the api marks the record failed, persists outcome
`error`, and the presenter says the confirmation expired — ask again.

### 6. Compatibility

`x-confirmation-challenge-id` on `POST /assistant/chat` stays as an
**adapter** for mobile builds shipped before the new route: the mount
resolves the record by header and runs the same modelless executor,
ignoring client text for that request, and logs a deprecation counter. The
model re-entry code path is deleted, not kept behind the header. The
adapter is removed when the supported mobile minimum passes the build that
calls `/assistant/confirm`.

### 7. Rule for future producers

A new pause reason adds a `kind` variant, a producer in `wrapExecute` (or
a handler-declared protocol), and a resolver for its resolution shape. It
does not add a store, a state machine, a route family, or a model call on
resume. Reviewers reject a third protocol the way they reject a second
`implementAction`.

## Security and compatibility conclusions

Required by SHO-430; each is a test in SHO-516 unless marked otherwise.

- **The model never approves its own action.** Resume is a human HTTP
  request with a session; no model output can produce a claim or a
  `confirmationChallengeId`. The pause branch only *stores* what core has
  already refused to run.
- **Canonical input is server-authoritative.** It is written by the server
  at pause time from the object the server itself validated and never read
  from the client. The resume body carries ids only. The client's echoed
  history (`data-confirmation` parts) is no longer consulted for the
  action or input; `resolvePausedToolAttempt` and
  `pausedToolAttemptForChallenge` go away with the model re-entry path.
- **Actor / company / conversation isolation.** The record bind is checked
  by the store on claim and complete (as `bindsMatch` does today), and core
  independently checks `principalKey` + `companyId` from the resumed
  request's verified context. A different staff user of the same company,
  or the same user in another company or conversation, gets `expired` and
  nothing executes; the core challenge is not consumed.
- **Single-use versus replay-safe.** The core challenge is single-use
  (`GETDEL`). The api record is replay-safe: a repeated `/assistant/confirm`
  after `completed` returns the same outcome without executing, because
  the record is `completed` and, one layer down, the idempotency
  reservation replays (core §5 "confirmed retries").
- **Tampering / hash mismatch.** If the stored input were altered, core's
  hash check fails closed and issues a fresh challenge that nobody
  consumes; the api treats this as terminal for the record (no retry loop,
  no second model call). The Redis record is internal; there is no client
  write path to it.
- **Crash after domain commit, before `completed`.** The idempotency
  reservation already holds the completed response and the persisted grant.
  The next `/assistant/confirm` claims as replay, `executeAction` replays
  the stored result, the turn is persisted (idempotent by `attemptKey`),
  and the record is marked `completed`. No double write.
- **TTLs.** Record TTL for `confirmation` = `CONFIRMATION_TTL_MS` (5 min)
  plus a short grace so the api can answer "expired" instead of "missing";
  core stays the authority on expiry. `choice` keeps `CHOICE_TTL_MS`
  (15 min). Both records live only in Redis, are never logged at info
  level, and hold the same class of data the choice record already holds
  (canonical action input, which may include a customer's name or phone);
  this ADR accepts that posture explicitly.
- **Old-mobile window.** The header adapter (Decision §6) covers it; the
  wire contract of the card and of `/assistant/choice` is unchanged.
- **Generic record outside the orders-specific choice schema.** Yes: a
  discriminated union. The `choice` variant keeps its typed
  `orders.create` input; the `confirmation` variant stores `unknown`
  validated by the target action's contract on resume.

## Alternatives considered

- **Keep confirmation distinct on purpose** (model re-emits the tool
  call) — rejected. The only argument for it is that the model can speak
  after the write; the presenter already does that for choice, and
  ADR-0034 puts the confirmed result into the next turn's context. The
  cost is a second full model call and a card that can reappear.
- **Move the canonical input into the core challenge record** (change
  `packages/core`) — rejected. Core would start storing arbitrary domain
  input in Redis for every human-invoked high-risk action (UI included),
  which core.md §7 deliberately avoids by storing only a hash. The
  assistant is the only channel that needs a stored input, so the record
  belongs to the assistant's host, `apps/api`.
- **Trust the api record alone and skip the core challenge on resume** —
  rejected. Core's single-use challenge is the protocol every channel
  shares; removing it from the AI path would make the AI path the weaker
  one.
- **Generalize by making choice a confirmation** (open a challenge for
  each picker option) — rejected. A picker is not a high-risk approval;
  forcing it through `requiresConfirmation` semantics would misuse the
  challenge and burn one per option.
- **A server-side `reject` route now** — deferred. Dismiss is local today
  and nothing executes; persisting a rejection is a product question, not
  a protocol requirement.

## Consequences

- Positive: zero model calls on any HITL resume; no "same card twice"
  loop; one store, one state machine, one set of tests for both kinds;
  a documented path for the next pause reason.
- Negative: the api holds canonical action input in Redis for ≤ 5–15
  minutes for one more kind (same posture as choice today); `apps/api`
  gains a route and the mobile confirmation card changes its call.
- Migration: [SHO-516](https://linear.app/showzy-v2/issue/SHO-516)
  implements this after [SHO-513](https://linear.app/showzy-v2/issue/SHO-513);
  the header adapter is removed in a follow-up ticket when the mobile
  minimum version passes. `stores/choice.ts` becomes the `choice` variant
  of `stores/pending-interaction.ts` with its tests kept.
- Documentation: `packages/ai/AGENTS.md`, the `assistant` module
  `AGENTS.md`, and `docs/specs/security-operations.md` gain one paragraph
  each pointing here (in SHO-516). core.md §7 is unchanged.
- Related ADRs: ADR-0008 (same actions for UI and AI) is preserved — both
  channels still consume the same core challenge; ADR-0034 supplies the
  model's memory of the confirmed result.
