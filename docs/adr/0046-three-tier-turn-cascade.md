# ADR-0046: Three tiers for a turn — judgment, gate model, reply model — and the judgment creates orders

- **Status**: Accepted
- **Date**: 2026-09-18
- **Deciders**: Ivan Kurbatov (human) (+ proposing agent)
- **Amends**: ADR-0044 (decisions 6 and 7), ADR-0045 (decisions 6 and 9)

## Context

ADR-0045 shipped the same day. Live, in `take` mode, a chain of four
follow-ups ("А за тиждень", "А за місяць", "Тільки підтверджені", "Скільки
їх?") was answered by the judgment with the right arguments in about two
seconds a turn, against five to twelve through the reply model. The owner's
decision after seeing it: run the whole assistant as a cascade — Jev, then
Haiku, then Sonnet — live, now, and decide about preview-and-confirm for
writes afterwards, from what live use shows. There is no production (owner,
2026-09-11); the only data at risk is a development database.

What the probes say about who should take what
(`docs/reference/typesafe-followup-probe-2026-09.md`, both corpora, first call
in the real tool loop):

| Turn | Haiku 4.5 | Sonnet 4.6 |
| --- | --- | --- |
| read (71) | 65 correct, 6 wrong | 65 correct, 6 wrong |
| talk, capability question (10) | 10 | 10 |
| write (59) | 39 correct, 10 detours, 10 wrong | 51 correct, 5 detours, 3 wrong |

Haiku equals Sonnet on reads and talk at a third of the price and half the
latency. On writes it asks for fields no tool needs and declares actions
impossible. The judgment's own write plans, made from a rewrite when the
message depends on the conversation, were right in every run for
`orders_create`; its known failures are an order without a customer when it
plans a follow-up alone (now behind the needs-history gate) and a create
replayed from praise (behind the talk guard).

One thing the judgment cannot do for a write: it selects spans of the message
and never generates. "Додай клієнта Андрія Коваля" would store the name in the
genitive. `orders_create` does not have that problem — it passes human
references that the owning module resolves, inflection included — and its
result has a card.

## Decision

**A chat turn is routed once, on its first step, by code, from the judgment's
answers: the judgment takes it, or the gate model runs it, or the reply model
runs it. The judgment may now take `orders_create`. This is a live trial in
development; preview-and-confirm is decided after it.**

1. **Tier one, the judgment**, takes a step when ADR-0044 decision 3 and
   ADR-0045 hold and the spec is marked takeable: the reads that have a result
   card, and `orders_create`. A write is takeable only when its arguments are
   references a module resolves or closed values — never a new record's name,
   which would be stored as typed. So `customers_createCustomer`,
   `customers_createGroup`, `catalog_createProduct` and
   `pricing_createPriceList` are planned, recorded, and not taken.
2. **Extra guards for a taken write**, each of which only delegates: every
   argument the tool's input schema requires is present; no fourth order line
   (the planner asks for three and one sentinel); no number in the message the
   plan did not consume; the judgment says the message asks nothing of the
   order beyond customer, products and quantities (a date, a delivery, a
   comment, a price or a discount goes to a model that can write it down).
3. **Tier two, the gate model (Haiku)**, runs the turn when the judgment did
   not take it and the message is talk or a capability question, or is a
   request whose one confident job is a read. **Tier three, the reply model
   (Sonnet)**, runs everything else: any write the judgment did not take,
   several jobs, a job with no spec, out of scope, and every refusal, timeout
   or error of the judgment stage. A turn stays on its tier for all its steps.
   There is no self-escalation from Haiku to Sonnet: a model's opinion of its
   own answer was not measured and is not trusted.
4. **Same turn, different model.** Tiers two and three get the same system
   prompt, tools, history and provider options; only the model differs. A
   paused turn continues on the reply model, as today.
5. **The reply to a taken step** is the result card plus the spec's fixed
   line (ADR-0044 decision 7 as amended). A failed or paused tool result is
   never narrated by the judgment: a failure goes to the reply model, a pause
   (the picker for an ambiguous customer or product) is the kit's.
6. **Recorded per turn**: the tier that ran it, beside the existing judgment
   record. The budget hold is kept when tier two or three ran.
7. **`ASSISTANT_JUDGMENT_MODE=take` now means this cascade.** `shadow` and
   `off` are unchanged, and `shadow` is the way back.

## Alternatives considered

- **Preview-and-confirm first** (the proposing agent's recommendation).
  Declined by the owner for now: live behaviour first, on data that does not
  matter, then decide with evidence.
- **The judgment takes every create.** Rejected: a genitive name stored as the
  customer's name is silent data damage that no later step catches.
- **Haiku for everything the judgment declines.** Rejected on the table
  above: ten wrong writes in fifty-nine.
- **Haiku escalates to Sonnet itself** (an `escalate` tool). Not measured; the
  routing here costs nothing because the judgment already answered.

## Consequences

- A wrong `orders_create` plan is a wrong order with nothing in front of it.
  Accepted for the trial; the record on the turn is how it gets counted.
- Most turns stop reaching Sonnet: reads and talk go to Haiku at the worst.
  Expect Haiku's known habit on reads — answering from a truncated list.
- The routing depends on the judgment's message kind and job answers being
  right even when it does not take the turn; a read misrouted as a write costs
  money, a write misrouted as a read goes to the weaker model for writes.
  Both are visible in the record (tier against the model's first call).
- Before production: preview-and-confirm or `requiresConfirmation` for
  judgment-taken writes is a precondition, not an option (record, do not
  build).

## Revisit when

- The live trial has a few dozen taken orders: count wrong ones, then decide
  preview-and-confirm.
- Haiku's wrong reads show up live more than the probes' 8%.
- A create gains a module-side name normaliser — then it can be takeable.
