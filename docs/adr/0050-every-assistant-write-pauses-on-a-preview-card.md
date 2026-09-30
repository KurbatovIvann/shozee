# ADR-0050: Every assistant write pauses on a preview card

- **Status**: Accepted
- **Date**: 2026-09-30
- **Deciders**: Ivan Kurbatov (human) (+ proposing agent)

## Context

Five contracts in the repo declare `requiresConfirmation: true`:
`customers.deleteCounterparty`, `customers.deleteCustomer`,
`customers.deleteGroup`, `documents.requestSign`,
`pricing.deletePriceList`. Every other write an assistant can reach —
`orders.create` included — executes on the model's or Шо's say-so.

Core's confirmation protocol (`core.md` §7) is two-step, single-use and
channel-agnostic: a first invocation returns `ConfirmationRequiredError` with
a redacted summary, and a challenge bound to principal, company, input hash
and idempotency key is consumed by the second. `runConfirmationGate` returns
`{ kind: "execute" }` immediately when the contract does not declare it
(`packages/core/src/runtime/pipeline/execute-action.ts:508`). The SHO-733
spike's Шо pause carried a `challengeId` core ignored: **the tap was a UI
gate, not authorization** (SHO-733 finding 2).

What makes the gate necessary:

- «Замовлення Оксани я вже підтвердила…» — a statement, not a command — parsed
  as `orders.confirm` at **0.9985**. No confidence floor catches it (SHO-734).
- Шо produced 2 wrong writes in 554 never-trained gold phrases (0.4%) and 11
  in 539 adversarial router phrases (2.0%), all at gate confidence. Raising
  the floor 0.90 → 0.99 moves accuracy 98.6% → 98.9% and removes **neither**
  of the two (SHO-740).
- Haiku never opened a wrong write as its first call in arms A and B — but
  only the first assistant step was taken, so that is not evidence about the
  loop's later steps.

## Decision

**Every assistant write pauses on a structured preview card before it
executes, on the Шо path and on the LLM path alike. Which actions pause is
read from `risk` on the action's existing contract — not from a new per-action
flag, and not from a rule inside `packages/ai`.**

- The card is structured: `title`, `lines`, `notes` from non-blocking needs,
  and `also` when the parse carries a second action. The client sends only
  `approve` or an option id; the pause is server-owned and its payload never
  reaches the wire (ADR-0038).
- **`also` is one card and one tap for two actions, and two attempts.** The
  card lists both; approving approves both; each then executes as its own
  attempt, with its own idempotency key and its own confirmation. A card is
  not a transaction: the second failing leaves the first committed, and the
  reply says so.
- Every AI-exposed action with `risk: "write"` or `risk: "high"` pauses.
  `risk: "draft"` does not — a draft is the thing a person then reviews, and a
  card in front of it asks the same question twice.
  **No new `preview` field.** "This action writes" already exists once, and a
  second derivation of one fact disagrees with the first sooner or later
  (`AGENTS.md`, How we work).
- The card's text comes from a server callback on the contract, shaped like
  today's `confirmationSummary` but returning structure instead of one
  redacted string, and required for every AI-exposed write. **That is a
  `packages/core` contract change: decided here, built by its own ticket.**
- Every closed card leaves a trace in the stored log — interaction id, action
  name, outcome — and a **declined card leaves one too, with outcome
  `rejected`**. "The assistant proposed this and the person said no" is the
  signal that tells a wrong parse from an unused feature. No input snapshot,
  no card body.
- **Relation to core confirmation.** For the five `requiresConfirmation`
  actions nothing changes: core issues the challenge, the preview card *is*
  the confirmation card and carries it, and the answer presents the same
  attempt with that challenge (ADR-0038 / SHO-553). For every other write the
  preview is a gate core does not verify, because `runConfirmationGate`
  returns `execute` at `execute-action.ts:508` and a `challengeId` on the
  attempt is ignored.
- **Core must change, and this is the change** (owner, 2026-09-30): core gains
  an **execution-time `requireConfirmation` option** that turns the §7 gate on
  for one attempt, whatever the contract declares. Core then issues and
  consumes an ordinary challenge — bound to principal, company, input hash and
  idempotency key, single use, 5-minute expiry, fail-closed — so the preview
  card carries a real challenge on every assistant write, not only on the
  five contracts that declare one. It reuses §7 whole: no second approval
  protocol, and no change to how the classic UI invokes anything.
  **Decided here, built by its own `packages/core` ticket, not by this ADR.**
- Until that ticket lands, the preview is a UI gate and is described as one —
  here, in the runbook, and in what the card's tests assert. It is not written
  down as authorization.

## Amendments to earlier ADRs

**ADR-0038, addendum "confirmations (SHO-553)".** "The previous host's named
exception, a host-side approval for a unique `orders.create`, went with that
host and is not carried over." — a host-side approval comes back, but as a
rule over every assistant write rather than a named exception for one action.

The same addendum's "**the assistant never skips core's challenge**" is
unchanged, and is now bounded: for an action core does not challenge, the
pause is not a challenge and does not claim to be one.

No `docs/specs/core.md` change lands with this ADR; §7 changes only when the
core option above is accepted and ticketed.

## Alternatives considered

- **A new `preview` / `previewSummary` contract field.** Rejected: `risk`
  already says the action writes. Two fields for one fact drift silently, and
  the first place they disagree is the defect class this repo has already
  paid for (SHO-486, derive on one side and hardcode on the other).
- **`requiresConfirmation: true` on every write contract.** Rejected: the
  field is a property of the *action*, and setting it puts a two-step dialog
  and a Redis round trip on every classic-UI save as well. ADR-0033's one data
  path is the handler, not the dialog. The execution-time option in the
  Decision gets the same gate for the caller that needs it.
- **A separate assistant-approval protocol beside core §7.** Rejected: a
  second copy of a protocol that already exists — the same single-use,
  principal-bound, hash-bound, fail-closed rules, written twice and diverging
  on the first fix applied to one of them.
- **A rule inside `packages/ai` (an assistant-channel rule).** Rejected:
  `packages/ai` is a façade layer (ADR-0033) and the Шо path does not pass
  through it, so the rule would be written twice and the server would own
  neither copy. ADR-0038 makes the pause server-owned.
- **Trust a higher confidence floor instead of a card.** Rejected on numbers:
  the worst wrong write scored 0.9985, and 0.90 → 0.99 removes neither of the
  two wrong writes on 554 phrases.
- **Preview only on the Шо path.** Rejected: arm A/B measured only the first
  assistant step, so "0 wrong first calls" is not evidence about the loop; and
  one write protocol beats two.

## Consequences

- Every AI-exposed write action gains a required structured-summary callback.
  That is a core contract change plus a migration across the AI-exposed write
  set — proposed here, sized elsewhere.
- Шо's measured wrong-write rate (0.4% gold, 2.0% adversarial) becomes a rate
  of wrong *cards* a person declines, not of wrong writes.
- Assistant writes gain one round trip. SHO-740's arm C numbers already count
  138 of its 367 closures as confirmation cards.
- The five `requiresConfirmation` actions show one card, not two.
- Until the core change lands, an assistant write executes on a tap core does
  not verify. That is today's state, not new exposure — but it must not be
  recorded as authorization.
- Recorded, not built: how long closed-card traces are retained.

## Revisit when

- Core gains a verified per-attempt approval — the "UI gate" wording here is
  then wrong and comes out.
- A model or Шо version reaches a wrong-write rate low enough that a card on
  every write costs more than it saves.
- A write appears that cannot be previewed in a card a person can read in one
  glance.

## Open questions

None.
