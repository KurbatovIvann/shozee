# ADR-0036: Assistant speech is not a surface

- **Status**: Accepted
- **Date**: 2026-09-08
- **Deciders**: Ivan Kurbatov (human) (+ proposing agent)

## Context

After SHO-507 (plain-text reply) and SHO-511 (model speaks above the card),
two leftover modules still competed to write `assistant_messages.body`:

- `presenter.ts` serialized generic collection / aggregate / entity cards
  into a second sentence (“Latest orders: #12 (New), …”).
- `spoken-reply.ts` was a second decision tree (HITL, markdown dump,
  locale fallbacks).

The client already renders generative UI from tool / `data-*` parts
(`data-presentation`, `data-confirmation`, `data-choice`) using shared
collection / aggregate / entity blocks. Duplicating those rows as speech
fought AI SDK 7 `UIMessage.parts`, Claude’s chat-vs-artifact split, and
OpenAI Agents’ single `tool_use_behavior`.

SHO-511’s `packages/ai/AGENTS.md` said “do not delete the presenter.”
That stop-condition is lifted by this ADR.

## Decision

A staff-assistant turn is three parts: **speech** (`text-*` and
`assistant_messages.body`), **surface** (generic card from the surface
registry), and **pending** (HITL envelope). Speech never duplicates a
surface.

`commitTurnSpeech` is the only writer of the visible/persisted line. It
returns `{ source: "model" | "protocol" | "fallback", text }`. `source`
is in-memory (`StaffAssistantTurnResult.speech`) for tests and logs; it
is not a database column.

Priority: HITL / typed domain-error protocol copy; else usable model
prose; else one locale-keyed generic fallback. A rule-based output
guardrail rejects empty text, leftover `{ … }` JSON, and markdown dumps.
No JSON spoken envelope, no extracting `spoken` from model JSON, no
second model call to summarize a card.

`presenter.ts` and `spoken-reply.ts` are removed. Protocol copy lives on
the protocol modules (`choice.ts`, `confirmation.ts`, domain-error copy).

## Alternatives considered

- **Keep a thin presenter for silence** — rejected: it reintroduces a
  second UI and grows with every surface.
- **Empty `body` when a card is present** — rejected:
  `messageBodySchema` is `min(1)`; changing it is a product fork.
- **Persist `source` on `assistant_messages`** — rejected: not named by
  the feature card; telemetry/tests are enough.

## Consequences

- SHO-516 (modelless confirmation resume) must call `commitTurnSpeech` /
  protocol copy, not `presentCompletedStaffAssistantTurn`.
- ADR-0034 rule 4 and ADR-0035 “presenter text” wording mean committed
  speech, not surface-to-text.
- New surfaces add a card descriptor, not a speech template.
