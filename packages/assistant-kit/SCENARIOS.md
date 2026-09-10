# assistant-kit conformance scenarios

The acceptance suite for the protocol.

Nothing below names a kind this package knows about: `pick` and `confirm` come
from `fixture.ts`, and the route level uses the consumer's own registry. If a
scenario here can only be written with one product's vocabulary, it belongs in
that product's suite.
Every scenario below is
**deterministic**: a stub model, a `Map`-backed `PauseStore`, an in-memory
`DocumentStore`, a fixed `Clock` and a counter `Ids`. No scenario calls a real
provider — there is no budget for live-model runs, and none of these check
generation quality. Model behaviour stays a hand-test.

Levels:

- **K** — kit only. No HTTP, no database, no model. Runs in milliseconds.
- **L** — loop. Kit wired into a real `streamText` on a `MockLanguageModelV4`
  (`host.integration.test.ts`). Still no HTTP, no database, no live model.
- **R** — route. Needs the HTTP handler, a session and a tenant. Lives in the
  consumer's suite — for the first one, `apps/api/src/http/assistant-kit-choice.test.ts`.
  Still no database and no live model: auth, both stores and the provider are
  injected, so it runs in under two seconds.

Each scenario names the defect it exists to prevent, so a deletion has to
argue with history rather than with taste.

## Pause store

| #   | Level | Given / When / Then                                                                                                                                                                                                                    | Prevents                                                                                         |
| --- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 1   | K     | A tool returns `needs_choice`. → `open` stores a record whose `continuation.pausedToolCall.id` is a `ProviderToolCallId`. An illegal raw id cannot reach the store: `providerToolCallId` returns `illegal` and `open` is never called. | Host-minted `choice:` / `phase-a:` ids → provider 400 → swallowed as success speech (`6fa77cfc`) |
| 2   | K     | An open pause exists. → a second `open` on the same conversation returns `already_open` with the current pause, and does not overwrite.                                                                                                | One-open-pending protocol (ADR-0035)                                                             |
| 3   | K     | An open pause. → `claim` with the right revision returns `claimed` once; every further `claim` returns `gone`. Two concurrent claims: exactly one `claimed`.                                                                           | Double-tap creating two writes                                                                   |
| 4   | K     | Revision was raised while the card was on screen. → `claim` with the old revision returns `stale` carrying the current pause, and does **not** apply the answer.                                                                       | An answer applied to a draft the human did not see                                               |
| 5   | K     | A body the kind's own `answer` schema rejects → `invalid_answer`, and the claim is **not** consumed. Per kind, never one wide union.                                                                                                   | An answer meant for a different kind of question                                                 |
| 6   | K     | Clock advanced past `expiresAt`. → `claim` returns `expired`; the record is not resumable and no write happens.                                                                                                                        | Stale approval replayed against a new challenge                                                  |
| 7   | K     | Any pause. → `publicPauseSchema.parse(publicPause)` succeeds and the parsed object has no `resolvedInput`, no `optionMap`, and no `entityId` on any option.                                                                            | Canonical input on the wire                                                                      |
| 8   | K     | The kind's `resolve` runs server-side and hands back a value, not the raw answer. An answer it cannot make sense of → `unresolvable`, decided **before** the claim is spent.                                                           | Client-supplied ids; a meaningless answer burning the one claim                                  |
| 9   | K     | The subject of the decision changes mid-pause. → `revise` raises the revision, replaces options, and invalidates the previous answer.                                                                                                  | `pending_replace` losing a confirmation (SHO-542)                                                |
| 10  | K     | An answer arrives for a conversation whose pause is not stored yet. → `claim` returns `gone` and the caller retries; nothing is silently dropped and no write runs.                                                                    | Answer racing the pause write                                                                    |

## Resume

| #   | Level | Given / When / Then                                                                                                                                                                                                                                                                                                                                                                                       | Prevents                                                                            |
| --- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 11  | K     | A claimed pause. → `resume` returns `messages` **byte-identical** to the stored continuation. No id is rewritten, no tool result is merged in from history, no message is re-derived.                                                                                                                                                                                                                     | Re-deriving model history on resume (SHO-539)                                       |
| 12  | K     | `resume` output. → it carries exactly one tool result, addressed to `pausedToolCall.id`, so the paused call is finished rather than reissued.                                                                                                                                                                                                                                                             | Resume leaving the tool-run `started` (SHO-543)                                     |
| 13  | L     | Picker answered. → the resumed turn's document holds one entity card and one follow-up list card, no duplicate entity. Covered, plus the stronger check the defect really needed: the pausing tool executes **once** — the host resolves it, never re-enters it.                                                                                                                                          | Two `#…` cards from a fabricated `resume-surface:*` tool part (SHO-544)             |
| 14  | K + R | The action refuses after the pause was claimed. → `release` puts the answer back: the pause is open at the same revision, the document is untouched, and a retry can claim it.                                                                                                                                                                                                                            | Pause disappearing when Phase A errors (SHO-545)                                    |
| 15  | R + K | **Both paths.** A write committed, then the turn does not finish. → the surface part stays in the document and the text part is `status: "error"`. On resume the card is stored **before** `streamText` via `commitFirst`; on the ordinary path a card earned inside the turn is written by the failure path itself. Asserted for a provider failure mid-loop and for an abort inside the tool (SHO-546). | A provider failure presenting itself as a finished reply, or a write nobody can see |
| 15b | K     | A turn ends early. → `interrupted` is set, whether the stream errored or the signal aborted. Measured: an abort inside a tool rejects every promise on the result, one a moment later rejects none, and a mid-loop provider error is swallowed by `consumeStream` — so one dropped connection must not write two different-looking documents. A finished turn is **not** marked, asserted separately.     | A broken turn that is silent on both sides of the wire                              |
| 13b | L     | The model emits a write and a read in one step. → the write pauses and the read never runs.                                                                                                                                                                                                                                                                                                               | A write overtaking an unanswered question                                           |

## Document

| #   | Level | Given / When / Then                                                                                                                                                                                                    | Prevents                                  |
| --- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| 16  | K + L | A turn's parts are appended live. → `document.read` afterwards returns the **same parts in the same order**. Live and reload are the same bytes, not two derivations. Also asserted against a real turn's own `parts`. | Live and reload composing different cards |
| 17  | K     | `replace_card` with the same `cardId` and a higher revision. → the document holds one surface part for that id, updated — not two.                                                                                     | A second card per pagination step         |
| 18  | K     | A `text` part streams then settles. → `status` moves `streaming` → `complete`; a partial text left by a crash reads `error` and is never presented as final.                                                           | Partial generation shown as the answer    |

## Boundary

| #   | Level | Given / When / Then                                                                                                                                                                        | Prevents                                                             |
| --- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| 19  | K     | `src/**` contains no domain word (`no-domain.test.ts`).                                                                                                                                    | A generic pause growing a hardcoded action name and entity-kind enum |
| 20  | K + R | A pause opened for one owner. → a claim under another `bind` answers exactly as an absent pause does (410), the owner's card stays open, and nothing lands in the other tenant's document. | Cross-tenant resume; late results after a switch (SHO-540)           |
| 21  | R     | The request is already gone when the answer arrives. → no write runs at all (the resolver is not called), the answer is released, and the card is answerable again.                        | Acting for a client that has left; wasted generation on disconnect   |
| 22  | R     | The chosen `optionId` is not one this pause offered. → 409, nothing runs, the card survives.                                                                                               | A client-supplied id reaching a write                                |

## What this suite deliberately does not check

Tool choice, argument quality, phrasing, whether the assistant understood
"this customer" — all model behaviour. It is verified by hand, and its
regressions are prompt changes, not protocol changes.

## What it does not check, and should

Listed because the absence is otherwise invisible. An audit found three of these
after the rewrite shipped; the suite did not, and the reason was not the number
of tests but which failures were imagined. SHO-546 has since been closed and
moved into row 15.

- **A reply is lost after the write committed.** Retrying mints a new
  `commandId` and writes again; retrying an answer gets `gone` and no document
  (SHO-547).
- **Two turns on one conversation at once.** The document is read-modify-write
  with no compare-and-set and nothing serialises turns (SHO-548).

A row here that names a class must say which member it tests. Row 15 said "a
write committed, then generation fails" and tested one of the two ways that
happens, which is why nobody went looking for the other. It now names both, and
row 15b names the third thing that turned out to be hiding behind the same
sentence: the turn that ends early without anything throwing at all.

## What each level established that the one below could not

The loop level found two contract defects by running the real `streamText`
rather than reading its types:

1. `streamText` accumulates a tool-result for the pausing call — the tool
   returned, so the SDK recorded its output. Resume therefore **replaces** that
   one output. The first contract appended a second result for the same
   `toolCallId`, which is history no provider accepts.
2. A `MockLanguageModelV4` needs structured `finishReason` and `usage`. A
   malformed finish chunk silently produced `finishReason: "other"` and the
   tool never executed — a probe that looked like a passing test while proving
   nothing. Fixtures here are measured against the SDK, not assumed.

The route level then found the two the loop could not see, because neither is
visible without a second caller:

3. `claim` had **no owner check at all**. Any session could answer any
   conversation's pause. `PauseRecord.bind` is now an opaque owner token the
   caller supplies (identity plus tenant), and a mismatch is reported as
   `gone` — the same answer as a miss, so probing another tenant teaches
   nothing.
4. A claim is consumed exactly once, which is right for a write but wrong when
   the action it authorised **refused**. Without a way back, one validation
   error made the card vanish. `release` returns a claimed pause to open at the
   same revision; the caller asserts the absence of effect, since the kit
   cannot know it.

## What being parametric changed

The first shape enumerated two kinds and four answer forms, capped a picker at
twenty, and had a field that existed only because of that cap. None of that is
a protocol concern, and a third kind meant editing the package.

Three checks became possible only after the vocabulary moved out:

| #   | Level | Given / When / Then                                                                                                                                      |
| --- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 23  | K     | Opening on a kind the registry does not have → `unknown_kind`; a payload the kind's `prompt` schema rejects → `invalid_prompt`. Neither stores anything. |
| 24  | K     | Two kinds with different ttls expire at different times, with no ttl configured on the deployment.                                                       |
| 25  | K     | A pause whose kind is no longer registered → `unknown_kind` on claim. A pause can outlive the deploy that removed its kind; a caller treats it as gone.  |
| 26  | L     | A tool asking to pause on an unregistered kind → the turn is `pause_rejected` and no pause is stored.                                                    |

## The route level, completed

Three routes now, one factory, all on injected auth / stores / history /
provider. No database, no live model.

| #   | Given / When / Then                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 27  | `POST chat` runs a turn, stores the person's words **before** the model runs, and saves the provider history it produced. A failed generation still shows what was asked. |
| 28  | `POST chat` with an extra `messages` key is a 400. A client never supplies the model transcript.                                                                          |
| 29  | `POST chat` while a question is unanswered → 409 `interaction_open` with the current pause. A visible limitation instead of a draft that silently disappears.             |
| 30  | `POST chat` for a conversation owned by someone else → 410, indistinguishable from one that does not exist.                                                               |
| 31  | `GET messages` returns exactly the parts the live turn returned, byte for byte, plus the open pause from the pause store.                                                 |
| 32  | `GET messages` for another tenant returns an **empty document**, equal to what a conversation that does not exist returns.                                                |
| 33  | Full trip over HTTP: chat pauses → choice resolves → reload shows the interaction part and exactly one card, with no open pause left.                                     |

## A hole the route level found in the package

`document.read` scoped only the _pause_ by owner; the messages came back to
anyone who knew the conversation id — and an id is not a secret. A document now
carries the `bind` it was created under: a read by anyone else returns an empty
document, and a write by anyone else is refused as `wrong_owner` rather than
appended. `document.write` takes a scope, like the read.
