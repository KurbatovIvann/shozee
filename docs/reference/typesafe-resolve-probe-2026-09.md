# TypeSafe resolve probe, September 2026

Can the judgment create an order whose customer, products and variants are
named the way staff type them — and what should happen when the module cannot
resolve a name on its own? Harness:
`apps/api/src/typesafe-probe/resolve/` (a db test over a Testcontainers
Postgres; the live part runs only with `TYPESAFE_LIVE_PROBE=1`, hand-run,
owner-authorised).

```
cd apps/api
TYPESAFE_LIVE_PROBE=1 TYPESAFE_PROBE_OUT=<file.md> node --env-file=../../.env \
  node_modules/vitest/vitest.mjs run --project db src/typesafe-probe/resolve
```

## What it measures

- **World**: the base probe's 300 customers and 134 products, plus four
  products sold only in variants (Макаронси ×6, Торт бісквітний ×3, Футболка з
  логотипом ×3, Чай листовий ×3), seeded through the real create actions.
- **Corpus**: 36 order messages, 72 references: exact, inflected and plural,
  partial names, a variant named in the line, a variant not named, a customer
  the words do not tell apart, one they do, a record that does not exist,
  typos, a diminutive, transliteration, several lines. Most have no verb
  ("Наталії Гук 2 тірамісу"), the way orders are dictated.
- **The production planner** asks Jev once a message; its spans go to the real
  `customers.resolveCustomerReference` and `catalog.resolveLineReferences`.
- **Three paths** for a reference: the module alone (today); the judgment
  answers the module's picker from the person's own message (a Choice among
  the picker's options plus `unclear` and `none`, acted on at 0.9); the same,
  and a product query the module cannot find is tried as "product words +
  variant words" through the same resolver.

## Findings, 2026-09-19

1. **The planner took 7 of 36 orders, though it had the arguments right in
   all but three.** The
   job answer for a verbless order is 0.75–0.83, under the 0.85 it took to
   act.
2. **Those three were confident wrong orders**: "2 великих капучино" →
   `капучино`, "лате на вівсяному молоці" → `лате`, "Кава Хаус на Подолі" →
   `кава хаус`; each shorter span is the exact name of another record, so the
   module resolved it. Guard, in code: every word of an order message must be
   a filler, a number, or inside a span the plan took
   (`unconsumedWords`) — else the step delegates. It removed all three.
3. **With that guard, `act` 0.75 for `orders_create`**: 22 of 36 orders taken
   instead of 7, none wrong on any path; on the calibration corpus +3 correct
   observations and no new wrong one, no trap and no other job taken. The
   references are verified by the module, which is why the job answer can be
   lower here than for a read. `argument` 0.3 adds four more and is not
   applied: no evidence it is needed.
4. **The judgment answering the picker**: of 9 references the module left to
   the person, 6 resolved correctly and none wrongly at 0.9 — a one-option
   picker for a plural ("булочок з корицею"), a typo, "Мельника з синами"
   among 15 customers, size M among three variants. It said `unclear` every
   time the words did not tell the records apart (Віктор among 20, Олена
   among 12, a variant not named). At 0.7 it made two wrong picks, both from
   typo candidates: "Петрашенко" → Олена Петренко (0.77), "макаронси малина" →
   the product Макарон малиновий (0.79–0.86). Hence 0.9.
5. **A variant named inside the product words** ("макаронси фісташка", "торт
   бісквітний полуничний") is `NOT_FOUND` today — the live defect of
   2026-09-18. Trying the words as product + variant through the same
   resolver fixed 3 of 5; adjective and plural variant forms ("лимонних
   макаронсів", "чаї листові зелені") stay unresolved and go to the reply
   model.
6. Whole orders at `act` 0.75: module alone 14 right, 3 unneeded pickers, 5 to
   the reply model; with the picker answered 16 / 1 / 5; with the split too
   18 / 1 / 3. No path created a wrong order.
7. Left alone: a typo in a customer's name (the module offers no
   candidates), a diminutive, transliteration. They end `NOT_FOUND` and the
   reply model takes the turn.

## What shipped from it

The unconsumed-words guard and `thresholds: { act: 0.75 }` on the
`orders_create` spec. Findings 4 and 5 change who resolves a reference and
what a catalog query means: ADR-0047.

## After the first live trial, same day

The order job's wording now names the terse form (calibration doc, series
5): 23 of 36 orders are taken at the default thresholds, 19 right with the
picker answered, 2 unneeded pickers, 2 to the reply model, none wrong. The
`act` 0.75 override is gone. Two guards came from the live logs: an item
whose words are the customer's ("Каті Самбуці 2 макаронси" planned a line
`каті самбуці`) delegates, and talk that depends on the conversation ("Так"
after a question) goes to the reply model — live, the gate model created an
order from it.

## After ADR-0047 was built, same day

The probe now calls the production `answerPickerFromMessage`, and the split
lives in `catalog.resolveLineReferences`, so "module alone" has it. One run:
references not found 7 → 4; at `act` 0.75, of 21 orders taken, 17 right, 2
unneeded pickers, 2 to the reply model, none wrong (15 / 4 / 2 with the module
alone). Jev's spans vary run to run: this run it took `лате холодне` from
"матча лате холодне", which is another product; the unconsumed-words guard
delegated it.
