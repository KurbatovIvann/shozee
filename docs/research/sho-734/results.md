# SHO-734 — Шо v3.3 on Shozee dev data

Model v33 (f10ddb14); decision function
`planShoTurn` (`packages/assistant-runtime/src/sho-plan.ts`, SHO-733).
Context compiled from the seeded dev company's own catalogue rows
(no server path builds one yet — the SHO-733 spike compiles it in its
test). Every utterance enters the runtime as `run({ raw })`, so the
runtime normalises and finds punctuation breaks itself.

Two whitelists are scored. The SHO-733 spike whitelist is
`orders.list` + `orders.create`; the SHO-734 ticket whitelist adds
orders get/confirm/start/complete/cancel, customer and product
cards and lists, and price lists. Only the two spike actions have a
param planner, so on the ticket whitelist the decision gate (single
command, action whitelisted, confidence floor, no blocking need) is
what is scored and the rest falls back with `no_param_plan`.

## A. SHO-733 spike whitelist

### A1. Never-trained gold (554 utterances)

| metric | value |
|---|---|
| gold inside this whitelist | 154 (27.8%) |
| passed the decision gate | 68 (12.3%) |
| closed without the LLM (gate + a param plan) | 34 (6.1%) |
| — answered (read) | 21 |
| — paused for confirmation (write) | 13 |
| — choice | 0 |
| fallback to the LLM | 520 (93.9%) |
| action accuracy of gated decisions | 68/68 = 100.0% |
| wrong-confident | 0 |
| whitelisted gold the gate rejected | 86 |

Action accuracy by confidence floor (`confidence.action`):

| floor | gated | right | accuracy |
|---|---|---|---|
| 0.90 | 68 | 68 | 100.0% |
| 0.95 | 68 | 68 | 100.0% |
| 0.98 | 68 | 68 | 100.0% |
| 0.99 | 66 | 66 | 100.0% |

Misses by class (whitelisted gold the gate rejected, plus wrong-confident):

| class | rows |
|---|---|
| needs missing | 65 |
| asr error | 17 |
| model unsure | 3 |
| model wrong | 1 |

Fallback reasons over every utterance:

| reason | rows |
|---|---|
| not_whitelisted | 372 |
| blocking_need | 77 |
| unsupported_param | 34 |
| many_commands | 28 |
| low_confidence | 9 |

### A2. Not leak-guarded — report separately (95 utterances)

| metric | value |
|---|---|
| gold inside this whitelist | 37 (38.9%) |
| passed the decision gate | 18 (18.9%) |
| closed without the LLM (gate + a param plan) | 12 (12.6%) |
| — answered (read) | 10 |
| — paused for confirmation (write) | 2 |
| — choice | 0 |
| fallback to the LLM | 83 (87.4%) |
| action accuracy of gated decisions | 18/18 = 100.0% |
| wrong-confident | 0 |
| whitelisted gold the gate rejected | 19 |

Action accuracy by confidence floor (`confidence.action`):

| floor | gated | right | accuracy |
|---|---|---|---|
| 0.90 | 18 | 18 | 100.0% |
| 0.95 | 18 | 18 | 100.0% |
| 0.98 | 18 | 18 | 100.0% |
| 0.99 | 18 | 18 | 100.0% |

Misses by class (whitelisted gold the gate rejected, plus wrong-confident):

| class | rows |
|---|---|
| needs missing | 17 |
| model unsure | 1 |
| model wrong | 1 |

Fallback reasons over every utterance:

| reason | rows |
|---|---|
| not_whitelisted | 59 |
| blocking_need | 17 |
| unsupported_param | 6 |
| low_confidence | 1 |

## B. SHO-734 ticket whitelist

### B1. Never-trained gold (554 utterances)

| metric | value |
|---|---|
| gold inside this whitelist | 187 (33.8%) |
| passed the decision gate | 99 (17.9%) |
| closed without the LLM (gate + a param plan) | 34 (6.1%) |
| — answered (read) | 21 |
| — paused for confirmation (write) | 13 |
| — choice | 0 |
| fallback to the LLM | 520 (93.9%) |
| action accuracy of gated decisions | 97/99 = 98.0% |
| wrong-confident | 2 |
| whitelisted gold the gate rejected | 90 |

Action accuracy by confidence floor (`confidence.action`):

| floor | gated | right | accuracy |
|---|---|---|---|
| 0.90 | 99 | 97 | 98.0% |
| 0.95 | 98 | 97 | 99.0% |
| 0.98 | 98 | 97 | 99.0% |
| 0.99 | 96 | 95 | 99.0% |

Misses by class (whitelisted gold the gate rejected, plus wrong-confident):

| class | rows |
|---|---|
| needs missing | 69 |
| asr error | 18 |
| model unsure | 3 |
| model wrong | 2 |

Fallback reasons over every utterance:

| reason | rows |
|---|---|
| not_whitelisted | 335 |
| blocking_need | 82 |
| unsupported_param | 34 |
| no_param_plan | 31 |
| many_commands | 28 |
| low_confidence | 10 |

### Blocking needs on spike-whitelisted gold

| need | occurrences |
|---|---|
| items[i].product — unknown | 114 |
| items[i].variant — variant_required | 100 |
| customer — unknown | 31 |
| items[i].variant — ambiguous | 17 |
| order_number|customer|period|amount — missing | 1 |

### Wrong-confident decisions (ticket whitelist)

| row | said | gold | Шо decided |
|---|---|---|---|
| live_heldout_gold:lh-144 | які є варіанти в макаронс | search.query | catalog.getProduct (no_param_plan) |
| dictation_v5_gold:dv5-none-26 | Замовлення Оксани я вже підтвердила ще зранку, не хвилюйся. | none | orders.confirm (no_param_plan) |

Unlabelled held-out rows (ambiguous, excluded above): 23, of which Шо closed 1.
