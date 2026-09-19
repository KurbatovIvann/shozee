# ADR-0047: The judgment answers a picker from the person's own words, and a product query may name its variant

- **Status**: Accepted
- **Date**: 2026-09-19
- **Deciders**: Ivan Kurbatov (human) (+ proposing agent)
- **Amends**: ADR-0043 (state minimisation), ADR-0044 (the judgment never
  resolves a human reference)

## Context

The owner wants the judgment to carry every action it can, and chose to start
with orders: resolve the customer, the products and the variants against real
records before the write. The live defect behind it (2026-09-18): "макаронси
лимон" went to `orders_create` as one product query and ended `NOT_FOUND`.

The first design — the cascade lists customers and products, the judgment
picks among the rows, the write carries ids — was not built, because the
module already does the lookup: `orders.create` resolves references through
`customers.resolveCustomerReference` and `catalog.resolveLineReferences`, and
what it cannot settle it returns as a structured `CONFLICT` with the
candidates — the picker a person taps. A second lookup in `packages/ai` would
be a second derivation of "which records match this name".

`docs/reference/typesafe-resolve-probe-2026-09.md` measured what is missing
on 36 order messages over a seeded base (300 customers, 138 products):

- Of 9 references the module left to the person, the person's message already
  said which option was meant in 6. Asked "which of these does the message
  mean?", Jev picked all 6 correctly at confidence ≥ 0.9 and said `unclear`
  wherever the words did not tell the records apart. At 0.7 it made two wrong
  picks, both among typo candidates.
- A variant named inside the product words is `NOT_FOUND`. Read as product
  words plus variant words by the same resolver, 3 of 5 resolve.

## Decision

1. **When a tool call ends in a picker, the judgment is asked first.** In
   `assistantKitTurnTools`, a picker `CONFLICT` goes to a picker-answer port
   before the pause: state is the person's message of this turn, the picker's
   subject and the option labels; one Choice among the labels plus `unclear`
   and `none`. At confidence ≥ 0.9 the same tool is called again with the
   chosen id through `withChosenId` — the path a tap takes, no second one.
   Otherwise the picker opens as today. At most four answers a tool call.
2. **It applies to every tier.** The reply model and the gate model get the
   same pickers for the same words.
3. **The module stays the resolver.** Which records are candidates, tenant
   scope, active-only, never-sell-the-parent are the module's. The judgment
   answers the question the module asked, from the person's words — the tap,
   not the search. ADR-0044's sentence becomes: "the judgment never looks a
   reference up; it may answer a picker the owning module opened."
4. **State sent to TypeSafe gains picker option labels** — customer, product
   and variant names, with the discriminator a customer label carries (the
   last four digits of a phone). ADR-0043's state minimisation names this
   field. Nothing else about a record is sent.
5. **`catalog.resolveLineReferences`: a product query may name its variant.**
   When a product query matches no product and carries no variant selection,
   the resolver tries its words as a product name followed or preceded by a
   variant name; it resolves only when exactly one split gives a unique
   product and a unique active variant of it. Domain behaviour in the owning
   module, so the panel and every tier get it.
6. **Recorded.** The turn's judgment record gains how many pickers the
   judgment answered (`pickersAnswered`). The stored history keeps the one
   tool call the model made, with its result; the repeated call is the same
   tool call continued, as it is after a tap.
7. Pickers are answered only in mode `take`. Without a TypeSafe key, in
   `off` and in `shadow`, nothing changes: shadow executes nothing.

## Alternatives considered

- **Pre-resolve with list reads in the cascade** (the first design). Rejected:
  a second matcher, two more steps a turn, and list search is token-AND, so
  "макаронси лимон" finds nothing there either.
- **Leave every picker to the person.** Safe, and today's behaviour. Rejected
  for the six in nine where the person already said it; a one-option picker
  for a plural is friction, not a question.
- **Act at 0.7.** Rejected on the two wrong picks.
- **Strip the phone digits from customer labels.** Two customers with one
  name then look the same and always go to the person — which is what the
  judgment says about them anyway. Open to the owner; the default keeps the
  label as the module wrote it.
- **A variant slot in the planner.** Jev cannot know whether "дубовий" is a
  variant or part of "Стіл дубовий"; the catalog can.

## Consequences

- Fewer pickers and fewer turns handed to the reply model for orders; about
  0.3 s and one more rolled-back transaction per answered picker (the debt
  `assistant-kit-tools.ts` already names).
- A wrong pick creates a wrong order with no confirmation in front of it
  (`orders.create` has none). The probe saw none at 0.9, in six picks acted on and eight
  left as `unclear`; a sample that small bounds nothing. The preview-and-
  confirm decision the owner deferred is the real guard.
- Customer names reach a second processor.
- Decision 5 changes what a catalog query resolves to: its contract
  description, its tests and the OpenAPI text change with it.

## Revisit when

- A wrong pick is seen live: raise the threshold or drop `unmatched_query`
  pickers from decision 1.
- Pickers exist for other tools than `orders_create`.
