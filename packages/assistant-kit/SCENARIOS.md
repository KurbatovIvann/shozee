# assistant-kit conformance scenarios

The acceptance suite for the protocol. Every scenario below is
**deterministic**: a stub model, a `Map`-backed `PauseStore`, an in-memory
`DocumentStore`, a fixed `Clock` and a counter `Ids`. No scenario calls a real
provider — there is no budget for live-model runs, and none of these check
generation quality. Model behaviour stays a hand-test.

Levels:

- **K** — kit only. No HTTP, no database, no model. Runs in milliseconds.
- **I** — integration. Kit wired into the host turn and the route.

Each scenario names the defect it exists to prevent, so a deletion has to
argue with history rather than with taste.

## Pause store

| # | Level | Given / When / Then | Prevents |
| --- | --- | --- | --- |
| 1 | K | A tool returns `needs_choice`. → `open` stores a record whose `continuation.pausedToolCall.id` is a `ProviderToolCallId`. An illegal raw id cannot reach the store: `providerToolCallId` returns `illegal` and `open` is never called. | Host-minted `choice:` / `phase-a:` ids → provider 400 → swallowed as success speech (`6fa77cfc`) |
| 2 | K | An open pause exists. → a second `open` on the same conversation returns `already_open` with the current pause, and does not overwrite. | One-open-pending protocol (ADR-0035) |
| 3 | K | An open pause. → `claim` with the right revision returns `claimed` once; every further `claim` returns `gone`. Two concurrent claims: exactly one `claimed`. | Double-tap creating two writes |
| 4 | K | Revision was raised while the card was on screen. → `claim` with the old revision returns `stale` carrying the current pause, and does **not** apply the answer. | An answer applied to a draft the human did not see |
| 5 | K | A `confirmation` pause. → `claim` with `{ kind: "select" }` returns `wrong_answer_kind`, listing what is accepted. | A picker answer approving a confirmation |
| 6 | K | Clock advanced past `expiresAt`. → `claim` returns `expired`; the record is not resumable and no write happens. | Stale approval replayed against a new challenge |
| 7 | K | Any pause. → `publicPauseSchema.parse(publicPause)` succeeds and the parsed object has no `resolvedInput`, no `optionMap`, and no `entityId` on any option. | Canonical input on the wire |
| 8 | K | `entityIdFor(record, optionId)` resolves server-side. An `optionId` absent from `optionMap` returns `undefined` and the caller refuses. | Client-supplied entity ids |
| 9 | K | The subject of the decision changes mid-pause. → `revise` raises the revision, replaces options, and invalidates the previous answer. | `pending_replace` losing a confirmation (SHO-542) |
| 10 | K | An answer arrives for a conversation whose pause is not stored yet. → `claim` returns `gone` and the caller retries; nothing is silently dropped and no write runs. | Answer racing the pause write |

## Resume

| # | Level | Given / When / Then | Prevents |
| --- | --- | --- | --- |
| 11 | K | A claimed pause. → `resume` returns `messages` **byte-identical** to the stored continuation. No id is rewritten, no tool result is merged in from history, no message is re-derived. | Re-deriving model history on resume (SHO-539) |
| 12 | K | `resume` output. → it carries exactly one tool result, addressed to `pausedToolCall.id`, so the paused call is finished rather than reissued. | Resume leaving the tool-run `started` (SHO-543) |
| 13 | I | Picker answered. → the resumed turn's document contains the entity card from the write **and** any follow-up list card, in one assistant message, with no duplicate entity. | Two `#…` cards from a fabricated `resume-surface:*` tool part (SHO-544) |
| 14 | I | The tool returns `domain_error` after the pause was claimed. → the pause stays visible with its status, no success text appears, and no write is recorded. | Pause disappearing when Phase A errors (SHO-545) |
| 15 | I | A write committed, then generation fails. → the surface part stays in the document, the text part is `status: "error"`, and no completion phrase is emitted. | A provider failure presenting itself as a finished reply |

## Document

| # | Level | Given / When / Then | Prevents |
| --- | --- | --- | --- |
| 16 | K | A turn's parts are appended live. → `document.read` afterwards returns the **same parts in the same order**. Live and reload are the same bytes, not two derivations. | Live and reload composing different cards |
| 17 | K | `replace_card` with the same `cardId` and a higher revision. → the document holds one surface part for that id, updated — not two. | A second card per pagination step |
| 18 | K | A `text` part streams then settles. → `status` moves `streaming` → `complete`; a partial text left by a crash reads `error` and is never presented as final. | Partial generation shown as the answer |

## Boundary

| # | Level | Given / When / Then | Prevents |
| --- | --- | --- | --- |
| 19 | K | `src/**` contains no domain word (`no-domain.test.ts`). | A generic pause growing a hardcoded action name and entity-kind enum |
| 20 | I | A pause opened for one company. → a claim carrying another company's session returns `gone`, and a late result from the previous selection is not appended. | Cross-tenant resume; late results after a switch (SHO-540) |
| 21 | I | The request is aborted mid-turn. → the model call aborts, any budget hold is released, and the document keeps whatever was already settled. | Wasted generation and held budget on disconnect |

## What this suite deliberately does not check

Tool choice, argument quality, phrasing, whether the assistant understood
"this customer" — all model behaviour. It is verified by hand, and its
regressions are prompt changes, not protocol changes.
