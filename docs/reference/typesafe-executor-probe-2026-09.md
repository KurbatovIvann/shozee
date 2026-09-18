# TypeSafe (Jev) as an executor — what it can do in Showzy's scope, 2026-09-18

Follow-up to [the first probe](typesafe-probe-2026-09.md). Question from the
owner: can Jev carry the staff assistant's actions, with Sonnet left for
summaries and conversation? Four hand-runs, owner authorised, about $0.03 in
total, `jev-1.13.0`. Nothing was executed and nothing touched a database:
every probe compares Jev's typed answers with labelled expectations. Harness:
`apps/api/src/typesafe-probe/executor/`.

## The shape that was measured

Jev cannot write an argument, so code offers candidates and Jev selects
(TypeSafe's "select instead of generate"). One request per message carries,
speculatively and in parallel:

- one Noul per staff job (16 jobs) — a message may ask for several;
- one Choice per text argument over the message's own 1–3 word spans
  (customer, group, product, price-list name);
- one Choice per number argument over the numbers in the message, including
  Ukrainian number words (phone, order number, price, quantities);
- closed-set Choices (document type, period, order status, invite kind);
- three ordered item positions (product, quantity) for an order's lines.

Code then keeps the jobs above 0.5, reads only the arguments those jobs
consume, drops repeated item picks, and would order the steps by fixed
dependencies (group → customer → assignment → order → confirm → document).
Jev never plans the order of steps.

## Results

| Probe | Cases | Whole result correct | Notes |
| --- | --- | --- | --- |
| Plan, first wording (tuning set) | 42 | 60% | every miss was an extra job or a repeated item; **arguments 100%** |
| Plan, tightened wording (tuning set) | 42 | 98% | chains 91%; at min-confidence ≥ 0.5: 86% coverage, 100% correct |
| **Plan, held-out set, no tuning after** | 32 | **91%** | single job 95%, chains (2–4 jobs) 86%, no-job 80%; **arguments 100% (45/45)** |
| Reference resolution + conversation context | 32 | 88% | products 100%, groups 100%, **context 100%**, customers 67%; every miss ≤ 0.29 confidence |

Held-out cases that passed include negation ("не підтверджуй … краще
скасуй"), self-correction ("2 лате, ні, краще 3"), prices as distractors
next to quantities, a surzhyk three-job chain, a verbless order, mixed
English/Ukrainian, and three jobs the list does not have (correctly: no job).

## What Jev can carry

- **Which jobs a message asks for**, including 2–4 job chains, in Ukrainian,
  surzhyk and mixed language — once each job question says what it is *not*.
- **Every argument that is present in the message or the conversation** —
  names, phones, order numbers, prices, quantities, closed-set options.
  No argument was wrong in 114 scored slots across both plan sets.
- **Inflected references to stored records** ("олени петренко" → Олена
  Петренко, "круасанів" → Круасан, "віп" → VIP), when code supplies the
  candidate records. This removes the main objection to a model that cannot
  lemmatise.
- **References to earlier turns** ("підтверди його", "скасуй друге",
  "зроби для неї"), when code supplies the candidates from history.
- **Knowing when it does not know.** Confidence separates right from wrong
  in every probe; all resolution misses sat at ≤ 0.29.

## What it cannot carry

- **Anything that must be written**: the reply, a summary, a clarifying
  question, a nominative name for a *new* record ("Заведи клієнта Ігоря
  Шевчука" selects "ігоря шевчука"; 19 of 74 plan cases select an inflected
  span). New-record names need a morphology step or the reply model.
- **Values that are not candidates**: "півтора кіло" — confidently wrong
  (0.84) because 1.5 was never offered. Candidate coverage is code's job and
  its failures are silent.
- **Several values for one argument** ("Підтверди 1042 та 1043"): one
  Choice returns one value. Needs a per-candidate Noul design.
- **Capability questions read as requests** ("Ти можеш виписувати
  рахунки?" → issue_document at 0.78). The first probe's gate separates
  these at 100%, so the two must run together.
- **Ambiguity between two real records** is not reliably flagged
  ("петренка" with two Petrenkos chose one, at 0.24). Low confidence
  catches it; the `ambiguous` option alone does not.
- Counting, date arithmetic and multi-hop reasoning (documented by
  TypeSafe; not re-measured here).

## Reading for the architecture

A Jev-first turn is plausible for the closed set of staff jobs: about 0.3 s
and $0.0002 a request against a Sonnet tool loop, with confirmation cards
(ADR-0038) still between every write and the database. The measured design
is: gate + plan in one request → code resolves references through the
owning module's list actions and a second Jev request over the candidates →
low confidence, no job, or an unsupported shape falls through to the
existing Sonnet loop unchanged. On the held-out set that would have sent
roughly one turn in five to Sonnet at a 0.5 threshold and the rest through
Jev at 92% whole-plan accuracy.

This reverses ADR-0043 decision 2 ("a judgment never authorises a write …
never resolves an ambiguous human reference") and changes what a turn is
(ADR-0038, ADR-0039). It needs its own ADR and feature card; nothing here
is wired into the assistant.

## Does a rewriting orchestrator help? (hard set, four modes)

Owner's hypothesis: an LLM "head" rewrites the user's message so that Jev,
the "hands", makes fewer mistakes. Measured on 30 deliberately hard messages
(`executor/hard.ts`: dictated run-ons, numbers and phones in words,
fractions, verbless fragments, corrections, capability questions, an
unsupported request), one live run, `executor/compare-run.ts`. The LLM
planners got the same job list and submitted one forced tool call.

| Mode | Whole plan correct | Latency p50 | Cost per turn |
| --- | --- | --- | --- |
| Jev on the raw message | 53% | 0.3 s | $0.0002 |
| Haiku rewrites, then Jev | 63% | 1.1 s | $0.0005 |
| Sonnet 4.6 plans alone | 83% | 3.9 s | $0.0102 |
| Haiku 4.5 plans alone | 90% | 1.9 s | $0.0034 |

- **The rewrite is not worth its place.** It bought ten points and
  introduced its own failures: it invented digits in a phone number
  (`067123456789`), turned a request into a statement so the order was
  missed ("Олена Петренко замовила…"), and twice answered the user instead
  of rewriting. Once an LLM has read the message, letting it finish the
  plan is both more accurate and simpler than handing a paraphrase to Jev.
- **Most of Jev's hard-set misses are candidate coverage**, not
  understanding: eight of fourteen involve a number written in words, which
  code never offered. The rest are extra jobs on terse or verbless fragments.
- **Confidence still routes correctly.** At min-confidence ≥ 0.7 Jev keeps
  12 of 30 and gets 10 right; the two confident misses are a fraction that
  was never a candidate and the capability question — one detectable in
  code (a number word with no digit), the other by the first probe's gate.
  With those two guards the cascade takes a third of even this set at 0.3 s
  and sends the rest to an LLM.
- **Haiku planned better than Sonnet here** (90% against 83%, a third of
  the cost, half the latency). Thirty cases and single-shot planning, not
  the real tool loop — a reason to measure Haiku as the fallback model, not
  a conclusion.

**Reading:** the measured shape is a cascade with code as the orchestrator,
not an agent network: Jev first; an LLM only when Jev is unsure, the gate
says it is not a request, or code sees a value it could not offer. "Head"
and "hands" are then an escalation order, not two stages of every turn.

### Run output — hard set

30 hard cases. Normaliser mean latency 871 ms.

| Mode | Jobs exact | Slots all correct | Items correct | Whole plan correct | Latency p50 / p95 ms | Cost per turn |
| --- | --- | --- | --- | --- | --- | --- |
| Jev raw (jev-1.13.0) | 80% | 70% | 93% | 53% | 295 / 952 | $0.00019 |
| Haiku normaliser → Jev | 70% | 83% | 100% | 63% | 1104 / 1858 | $0.00049 |
| Sonnet plans alone (claude-sonnet-4-6) | 90% | 97% | 97% | 83% | 3871 / 4733 | $0.01015 |
| Haiku plans alone (claude-haiku-4-5) | 97% | 90% | 100% | 90% | 1932 / 2412 | $0.00338 |

| Mode | Case | Missing jobs | Extra jobs | Wrong slots | Items |
| --- | --- | --- | --- | --- | --- |
| Jev raw (jev-1.13.0) | x-order-number-in-words |  |  | orderNumber: none |  |
| Jev raw (jev-1.13.0) | x-fractional-quantity |  |  |  | none×кави в зернах |
| Jev raw (jev-1.13.0) | x-phone-in-words |  |  | customerPhone: none |  |
| Jev raw (jev-1.13.0) | x-big-number-words |  |  |  | none×еклерів, none×макаронів |
| Jev raw (jev-1.13.0) | x-capability-question |  | issue_document |  |  |
| Jev raw (jev-1.13.0) | x-assign-then-order |  |  | groupName: клієнтка |  |
| Jev raw (jev-1.13.0) | x-price-in-words |  |  | price: none |  |
| Jev raw (jev-1.13.0) | x-reprice-in-words |  | create_order | price: none |  |
| Jev raw (jev-1.13.0) | x-negated-then-number-words |  |  | orderNumber: none |  |
| Jev raw (jev-1.13.0) | x-rename-correction | create_group | assign_customer_to_group |  |  |
| Jev raw (jev-1.13.0) | x-three-jobs-dictated |  |  | customerName: мельник |  |
| Jev raw (jev-1.13.0) | x-complete-number-words |  | cancel_order | orderNumber: none |  |
| Jev raw (jev-1.13.0) | x-new-customer-implicit |  | create_product |  |  |
| Jev raw (jev-1.13.0) | x-assign-verbless |  | start_order | groupName: сашу білого |  |
| Haiku normaliser → Jev | x-dictated-order | create_order |  |  |  |
| Haiku normaliser → Jev | x-phone-in-words |  |  | customerPhone: 067123456789 |  |
| Haiku normaliser → Jev | x-capability-question |  | issue_document |  |  |
| Haiku normaliser → Jev | x-reprice-in-words | change_product_price | create_order | price: none |  |
| Haiku normaliser → Jev | x-rename-correction | create_group |  |  |  |
| Haiku normaliser → Jev | x-three-jobs-dictated |  |  | customerName: мельник |  |
| Haiku normaliser → Jev | x-complete-number-words |  | cancel_order |  |  |
| Haiku normaliser → Jev | x-new-customer-implicit |  | create_product | customerName: сашу білого |  |
| Haiku normaliser → Jev | x-assign-verbless | assign_customer_to_group |  | groupName: none |  |
| Haiku normaliser → Jev | x-name-left-to-assistant | create_price_list |  |  |  |
| Haiku normaliser → Jev | x-start-with-reason |  | change_product_price, issue_document |  |  |
| Sonnet plans alone (claude-sonnet-4-6) | x-price-in-words |  | change_product_price |  |  |
| Sonnet plans alone (claude-sonnet-4-6) | x-note-by-customer |  | find_customer |  |  |
| Sonnet plans alone (claude-sonnet-4-6) | x-terse-three-jobs |  |  |  | 2×рафа, 1×еспресо, 3×круасан |
| Sonnet plans alone (claude-sonnet-4-6) | x-name-left-to-assistant |  |  | priceListName: знижковий прайс |  |
| Sonnet plans alone (claude-sonnet-4-6) | x-unsupported-add-to-order |  | create_order |  |  |
| Haiku plans alone (claude-haiku-4-5) | x-reprice-in-words | change_product_price | create_order | productName: none; price: none |  |
| Haiku plans alone (claude-haiku-4-5) | x-yesterday-slang |  |  | period: none |  |
| Haiku plans alone (claude-haiku-4-5) | x-name-left-to-assistant |  |  | priceListName: знижковий прайс |  |


## Limits of this evidence

74 plan cases and 32 resolution cases, all written by the proposing agent;
no production traffic exists. The job questions were tuned on the first
set; the held-out number (91%) is the one to quote. Candidate records in
the resolution probe were synthetic lists of 2–4, not a real company's
customer base — larger candidate sets will be harder. One model version.

## Run outputs

### Plan — held-out set

Model `jev-1.13.0`, 32 requests, 140374 input tokens, $0.0059; mean 4387 tokens a request; latency p50 331 ms, p95 752 ms. Refused: 0.

| Cases | n | Jobs exact | Slots all correct | Items correct | Whole plan correct |
| --- | --- | --- | --- | --- | --- |
| all | 32 | 94% | 100% | 97% | 91% |
| single job | 20 | 100% | 100% | 95% | 95% |
| chains (2–4 jobs) | 7 | 86% | 100% | 100% | 86% |
| no job expected | 5 | 80% | 100% | 100% | 80% |

| Plan min confidence ≥ | Coverage | Whole plan correct |
| --- | --- | --- |
| 0.5 | 81% | 92% |
| 0.7 | 56% | 89% |
| 0.9 | 13% | 100% |

| Slot | Asked | Correct |
| --- | --- | --- |
| customerName | 13 | 100% |
| customerPhone | 3 | 100% |
| groupName | 4 | 100% |
| orderNumber | 9 | 100% |
| period | 5 | 100% |
| statusFilter | 5 | 100% |
| productName | 2 | 100% |
| price | 2 | 100% |
| documentType | 2 | 100% |
| inviteKind | 1 | 100% |
| priceListName | 2 | 100% |

Cases whose selected span is an inflected form that code cannot use as a stored name or an exact lookup: 8 of 32.

Wrong plans:

| Case | Min conf | Missing jobs | Extra jobs | Wrong slots | Items |
| --- | --- | --- | --- | --- | --- |
| h-chain-close-note-list | 0.34 | list_orders | cancel_order |  |  |
| h-quantity-not-a-candidate | 0.84 |  |  |  | none×кави |
| h-capability-not-request | 0.78 |  | issue_document |  |  |

### Plan — tuning set, tightened wording

Model `jev-1.13.0`, 42 requests, 180418 input tokens, $0.0076; mean 4296 tokens a request; latency p50 317 ms, p95 763 ms. Refused: 0.

| Cases | n | Jobs exact | Slots all correct | Items correct | Whole plan correct |
| --- | --- | --- | --- | --- | --- |
| all | 42 | 98% | 100% | 100% | 98% |
| single job | 26 | 100% | 100% | 100% | 100% |
| chains (2–4 jobs) | 11 | 91% | 100% | 100% | 91% |
| no job expected | 5 | 100% | 100% | 100% | 100% |

| Plan min confidence ≥ | Coverage | Whole plan correct |
| --- | --- | --- |
| 0.5 | 86% | 100% |
| 0.7 | 67% | 100% |
| 0.9 | 29% | 100% |

| Slot | Asked | Correct |
| --- | --- | --- |
| customerName | 15 | 100% |
| customerPhone | 6 | 100% |
| groupName | 5 | 100% |
| orderNumber | 11 | 100% |
| productName | 4 | 100% |
| price | 4 | 100% |
| documentType | 6 | 100% |
| inviteKind | 2 | 100% |
| priceListName | 2 | 100% |
| period | 7 | 100% |
| statusFilter | 7 | 100% |

Cases whose selected span is an inflected form that code cannot use as a stored name or an exact lookup: 11 of 42.

Wrong plans:

| Case | Min conf | Missing jobs | Extra jobs | Wrong slots | Items |
| --- | --- | --- | --- | --- | --- |
| c-complete-note | 0.38 |  | cancel_order |  |  |

### Plan — tuning set, first wording

Model `jev-1.13.0`, 42 requests, 136864 input tokens, $0.0057; mean 3259 tokens a request; latency p50 306 ms, p95 940 ms. Refused: 0.

| Cases | n | Jobs exact | Slots all correct | Items correct | Whole plan correct |
| --- | --- | --- | --- | --- | --- |
| all | 42 | 60% | 100% | 88% | 60% |
| single job | 26 | 73% | 100% | 92% | 73% |
| chains (2–4 jobs) | 11 | 18% | 100% | 73% | 18% |
| no job expected | 5 | 80% | 100% | 100% | 80% |

| Plan min confidence ≥ | Coverage | Whole plan correct |
| --- | --- | --- |
| 0.5 | 64% | 78% |
| 0.7 | 43% | 89% |
| 0.9 | 14% | 100% |

| Slot | Asked | Correct |
| --- | --- | --- |
| customerName | 15 | 100% |
| customerPhone | 6 | 100% |
| groupName | 5 | 100% |
| orderNumber | 11 | 100% |
| productName | 4 | 100% |
| price | 4 | 100% |
| documentType | 6 | 100% |
| inviteKind | 2 | 100% |
| priceListName | 2 | 100% |
| period | 7 | 100% |
| statusFilter | 7 | 100% |

Cases whose selected span is an inflected form that code cannot use as a stored name or an exact lookup: 11 of 42.

Wrong plans:

| Case | Min conf | Missing jobs | Extra jobs | Wrong slots | Items |
| --- | --- | --- | --- | --- | --- |
| s-assign | 0.18 |  | create_customer |  |  |
| s-order | 0.64 |  | start_order |  | 2×капучино, none×круасан, none×круасан |
| s-order-words | 0.08 |  | start_order, complete_order |  | 3×лате, 2×еспресо, none×еспресо |
| s-order-company | 0.12 |  | start_order |  |  |
| s-confirm | 0.00 |  | start_order, complete_order |  |  |
| s-product | 0.48 |  | start_order |  |  |
| s-delivery-note | 0.04 |  | start_order |  |  |
| c-customer-group-order | 0.70 |  | start_order |  |  |
| c-order-confirm | 0.72 |  | start_order, complete_order |  |  |
| c-order-invoice | 0.16 |  | start_order |  |  |
| c-confirm-note | 0.64 |  | start_order, complete_order |  |  |
| c-product-order | 0.00 |  | start_order, complete_order |  | 2×раф |
| c-customer-order | 0.45 |  | start_order |  | none×американо, 2×круасани, none×круасани |
| c-complete-note | 0.52 |  | cancel_order |  |  |
| c-cancel-count | 0.10 |  | complete_order |  |  |
| c-four-steps | 0.09 |  | start_order, complete_order |  | 3×чізкейки, none×чізкейки |
| n-attack | 0.52 |  | cancel_order |  |  |

### Reference resolution and context

Model `jev-1.13.0`, 32 requests, 13658 input tokens.

| Group | n | Correct | Confidence ok / wrong |
| --- | --- | --- | --- |
| all | 32 | 88% | 0.83 / 0.25 |
| customer | 12 | 67% | 0.76 / 0.25 |
| product | 10 | 100% | 0.74 / n/a |
| customer group | 3 | 100% | 0.99 / n/a |
| context | 7 | 100% | 0.97 / n/a |

Misses:

| Case | Expected | Got | Confidence |
| --- | --- | --- | --- |
| diminutive | Ольга Бондар | ambiguous | 0.29 |
| transliterated | Анна Лисенко | ambiguous | 0.29 |
| surname-shared | ambiguous | Олена Петренко | 0.24 |
| near-surname | Віктор Гриценко | Віктор Грищенко | 0.18 |
