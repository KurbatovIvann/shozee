# SHO-734 — Шо v3.3 on Shozee dev data

Model v33 (f10ddb14); decision function
`planShoTurn` (`packages/assistant-runtime/src/sho-plan.ts`, SHO-733).
Context compiled from the seeded dev company's own catalogue rows
(no server path builds one yet — the SHO-733 spike compiles it in its test).

### Never-trained gold, text as recognised (554 utterances)

| metric | value |
|---|---|
| gold in the SHO-733 whitelist | 154 (27.8%) |
| closed without the LLM | 12 (2.2%) |
| — answered (read) | 11 |
| — paused for confirmation (write) | 1 |
| — choice | 0 |
| fallback to the LLM | 542 (97.8%) |
| action accuracy of confident decisions | 12/12 = 100.0% |
| wrong-confident | 0 |
| whitelisted gold Шо did not close | 142 |

Action accuracy by confidence floor (`confidence.action`):

| floor | confident | right | accuracy |
|---|---|---|---|
| 0.90 | 12 | 12 | 100.0% |
| 0.95 | 11 | 11 | 100.0% |
| 0.98 | 11 | 11 | 100.0% |
| 0.99 | 11 | 11 | 100.0% |

Misses by class (whitelisted gold not closed, plus wrong-confident):

| class | rows |
|---|---|
| needs missing | 94 |
| asr error | 19 |
| period mapping | 18 |
| unsupported param | 4 |
| model unsure | 4 |
| model wrong | 3 |

Fallback reasons over every utterance:

| reason | rows |
|---|---|
| not_whitelisted | 366 |
| blocking_need | 110 |
| many_commands | 32 |
| unsupported_param | 22 |
| low_confidence | 12 |

### Never-trained gold, text lowercased and depunctuated (554 utterances)

| metric | value |
|---|---|
| gold in the SHO-733 whitelist | 154 (27.8%) |
| closed without the LLM | 34 (6.1%) |
| — answered (read) | 21 |
| — paused for confirmation (write) | 13 |
| — choice | 0 |
| fallback to the LLM | 520 (93.9%) |
| action accuracy of confident decisions | 34/34 = 100.0% |
| wrong-confident | 0 |
| whitelisted gold Шо did not close | 120 |

Action accuracy by confidence floor (`confidence.action`):

| floor | confident | right | accuracy |
|---|---|---|---|
| 0.90 | 34 | 34 | 100.0% |
| 0.95 | 34 | 34 | 100.0% |
| 0.98 | 34 | 34 | 100.0% |
| 0.99 | 34 | 34 | 100.0% |

Misses by class (whitelisted gold not closed, plus wrong-confident):

| class | rows |
|---|---|
| needs missing | 66 |
| period mapping | 20 |
| asr error | 17 |
| unsupported param | 13 |
| model unsure | 3 |
| model wrong | 1 |

Fallback reasons over every utterance:

| reason | rows |
|---|---|
| not_whitelisted | 372 |
| blocking_need | 78 |
| unsupported_param | 33 |
| many_commands | 28 |
| low_confidence | 9 |

### Not leak-guarded — report separately (95 utterances)

| metric | value |
|---|---|
| gold in the SHO-733 whitelist | 37 (38.9%) |
| closed without the LLM | 12 (12.6%) |
| — answered (read) | 10 |
| — paused for confirmation (write) | 2 |
| — choice | 0 |
| fallback to the LLM | 83 (87.4%) |
| action accuracy of confident decisions | 12/12 = 100.0% |
| wrong-confident | 0 |
| whitelisted gold Шо did not close | 25 |

Action accuracy by confidence floor (`confidence.action`):

| floor | confident | right | accuracy |
|---|---|---|---|
| 0.90 | 12 | 12 | 100.0% |
| 0.95 | 12 | 12 | 100.0% |
| 0.98 | 12 | 12 | 100.0% |
| 0.99 | 12 | 12 | 100.0% |

Misses by class (whitelisted gold not closed, plus wrong-confident):

| class | rows |
|---|---|
| needs missing | 17 |
| unsupported param | 5 |
| model unsure | 1 |
| period mapping | 1 |
| model wrong | 1 |

Fallback reasons over every utterance:

| reason | rows |
|---|---|
| not_whitelisted | 59 |
| blocking_need | 17 |
| unsupported_param | 6 |
| low_confidence | 1 |

### Blocking needs on whitelisted gold (raw text)

| need | occurrences |
|---|---|
| items[i].product — unknown | 119 |
| customer — unknown | 110 |
| items[i].variant — variant_required | 104 |
| items[i].variant — ambiguous | 15 |
| items[i].quantity — quantity_asks | 2 |
| order_number|customer|period|amount — missing | 1 |

### Wrong-confident decisions

| row | said | gold | Шо planned |
|---|---|---|---|
| live_heldout_ambiguous:undefined | покажи замовлення з третього | none | read orders_list_page |

Unlabelled held-out rows (ambiguous, excluded above): 23, of which Шо closed 1.
