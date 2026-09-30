# SHO-740 — offline replay

Model v33 (f10ddb14), runtime b1e2b4d (D88-D92).
Context: the seeded dev bakery. Gate floor for arms C and D:
action 0.95, margin 0.40, spans 0.60.
Arm D's gate is the gold label (talk / command / mixed / unsupported):
a ceiling for any classifier in front, Jev included.

### Gold 554 (never-trained live + dictation) (554 messages)

| metric | arm C (Шо-first) | arm D (oracle gate + Шо) |
|---|---|---|
| closed without the LLM | 367 (66.2%) | 364 (65.7%) |
| — answered (read) | 108 | 108 |
| — confirmation card (write) | 138 | 136 |
| — clarification card | 121 | 120 |
| routing accuracy of what Шо closed | 98.6% | 99.5% |
| wrong writes | 2 (0.4% of turns) | 0 (0.0% of turns) |
| fell through to the LLM | 33.8% | 34.3% |

Шо latency on this set: p50 10.1 ms, p95 32.5 ms.

### Router single messages (539 messages)

| metric | arm C (Шо-first) | arm D (oracle gate + Шо) |
|---|---|---|
| closed without the LLM | 361 (67.0%) | 340 (63.1%) |
| — answered (read) | 85 | 84 |
| — confirmation card (write) | 147 | 137 |
| — clarification card | 129 | 119 |
| routing accuracy of what Шо closed | 78.9% | 80.6% |
| wrong writes | 11 (2.0% of turns) | 7 (1.3% of turns) |
| fell through to the LLM | 33.0% | 36.9% |

Шо latency on this set: p50 9.7 ms, p95 25.2 ms.

### Router follow-ups, focus only (D88-D90) (140 messages)

| metric | arm C (Шо-first) | arm D (oracle gate + Шо) |
|---|---|---|
| closed without the LLM | 55 (39.3%) | 55 (39.3%) |
| — answered (read) | 19 | 19 |
| — confirmation card (write) | 15 | 15 |
| — clarification card | 21 | 21 |
| routing accuracy of what Шо closed | 85.5% | 85.5% |
| wrong writes | 0 (0.0% of turns) | 0 (0.0% of turns) |
| fell through to the LLM | 60.7% | 60.7% |

Шо latency on this set: p50 7.8 ms, p95 13.1 ms.

### Router follow-ups, focus + previous command (D78) (140 messages)

| metric | arm C (Шо-first) | arm D (oracle gate + Шо) |
|---|---|---|
| closed without the LLM | 79 (56.4%) | 79 (56.4%) |
| — answered (read) | 42 | 42 |
| — confirmation card (write) | 15 | 15 |
| — clarification card | 22 | 22 |
| routing accuracy of what Шо closed | 86.1% | 86.1% |
| wrong writes | 0 (0.0% of turns) | 0 (0.0% of turns) |
| fell through to the LLM | 43.6% | 43.6% |

Шо latency on this set: p50 7.8 ms, p95 13.7 ms.

## Top-k tool shortlist (arm B's payload)

### Gold 554

Rows whose gold maps onto a showzy-v2 tool: 417 of 554.

| k | gold tool in Шо's top-k shortlist |
|---|---|
| 3 | 414/417 = 99.3% |
| 5 | 414/417 = 99.3% |
| 8 | 415/417 = 99.5% |

### Router single messages

Rows whose gold maps onto a showzy-v2 tool: 471 of 539.

| k | gold tool in Шо's top-k shortlist |
|---|---|
| 3 | 367/471 = 77.9% |
| 5 | 375/471 = 79.6% |
| 8 | 384/471 = 81.5% |

### Router follow-ups, focus only

Rows whose gold maps onto a showzy-v2 tool: 130 of 140.

| k | gold tool in Шо's top-k shortlist |
|---|---|
| 3 | 66/130 = 50.8% |
| 5 | 70/130 = 53.8% |
| 8 | 74/130 = 56.9% |

### Router follow-ups, focus + previous

Rows whose gold maps onto a showzy-v2 tool: 130 of 140.

| k | gold tool in Шо's top-k shortlist |
|---|---|
| 3 | 82/130 = 63.1% |
| 5 | 84/130 = 64.6% |
| 8 | 85/130 = 65.4% |

## Confidence floor sweep (arm C, gold 554)

| floor | closed by Шо | right | accuracy | wrong writes |
|---|---|---|---|---|
| 0.90 | 367 | 362 | 98.6% | 2 |
| 0.95 | 367 | 362 | 98.6% | 2 |
| 0.98 | 365 | 361 | 98.9% | 2 |
| 0.99 | 358 | 354 | 98.9% | 2 |

## Answers to the assistant's own question

14 follow-ups whose last assistant turn ends in a question and
whose message is the bare answer. The ticket's bar is zero confident
commands unless the answer is itself a command.

### Focus only: Шо closed 0 of 14

| row | assistant asked | person answered | Шо route | action | confidence |
|---|---|---|---|---|---|
| followup:f12-answer-price | Яка ціна у товару Лате? | 65 гривень | llm | ui.pick | 0.997 |
| followup:f13-answer-group-name | Як назвати групу? | Постійні | llm | ui.pick | 0.997 |
| followup:f14-answer-price-list-name | Яка назва прайсу? | Зимовий | llm | ui.pick | 0.964 |
| followup:f15-answer-customer-details | Як звати клієнта і який у нього телефон? | Андрій Коваль, 0501112233 | llm | ui.refine | 0.812 |
| followup:f20-disambiguate-surname | Знайшов двох клієнтів: Олена Петренко і Олена Петрук. Для кого замовлення? | Петренко | llm | ui.pick | 0.997 |
| followup_holdout:h023-answer-price-digits | Яка ціна у товару Медовик? | 120 | llm | ui.pick | 0.997 |
| followup_holdout:h024-answer-price-words | Скільки коштує Штрудель яблучний? | дев'яносто п'ять гривень | llm | ui.pick | 0.997 |
| followup_holdout:h025-answer-group-name | Як її назвати? | Корпоративні | llm | ui.pick | 0.975 |
| followup_holdout:h026-answer-customer-details | Як його звати і який номер телефону? | Дмитро Остапчук 0667778899 | llm | ui.refine | 0.756 |
| followup_holdout:h027-answer-phone-only | Який у неї номер телефону? | 0987654321 | llm | ui.refine | 0.582 |
| followup_holdout:h028-answer-which-surname | Є два клієнти: Степан Гуменюк і Степан Гуменний. Для кого з них? | той що Гуменюк | llm | ui.pick | 0.998 |
| followup_holdout:h029-answer-which-second | Знайшов двох: перша — Леся Приходько, друга — Леся Присяжнюк. Котрій оформити? | другій | llm | ui.pick | 0.997 |
| followup_holdout:h030-answer-for-whom | Для якого клієнта оформити? | для Зоряни Білик | llm | ui.pick | 0.963 |
| followup_holdout:h059-trap-abandoned-question | Яка ціна у товару Наполеон? | Ладно, потім з цим. Покажи нові замовлення | llm | ui.confirm | 0.998 |

### Focus + previous command: Шо closed 0 of 14

| row | assistant asked | person answered | Шо route | action | confidence |
|---|---|---|---|---|---|
| followup:f12-answer-price | Яка ціна у товару Лате? | 65 гривень | llm | ui.pick | 0.997 |
| followup:f13-answer-group-name | Як назвати групу? | Постійні | llm | ui.pick | 0.997 |
| followup:f14-answer-price-list-name | Яка назва прайсу? | Зимовий | llm | ui.pick | 0.964 |
| followup:f15-answer-customer-details | Як звати клієнта і який у нього телефон? | Андрій Коваль, 0501112233 | llm | ui.refine | 0.812 |
| followup:f20-disambiguate-surname | Знайшов двох клієнтів: Олена Петренко і Олена Петрук. Для кого замовлення? | Петренко | llm | ui.pick | 0.997 |
| followup_holdout:h023-answer-price-digits | Яка ціна у товару Медовик? | 120 | llm | ui.pick | 0.997 |
| followup_holdout:h024-answer-price-words | Скільки коштує Штрудель яблучний? | дев'яносто п'ять гривень | llm | ui.pick | 0.997 |
| followup_holdout:h025-answer-group-name | Як її назвати? | Корпоративні | llm | ui.pick | 0.975 |
| followup_holdout:h026-answer-customer-details | Як його звати і який номер телефону? | Дмитро Остапчук 0667778899 | llm | ui.refine | 0.756 |
| followup_holdout:h027-answer-phone-only | Який у неї номер телефону? | 0987654321 | llm | ui.refine | 0.582 |
| followup_holdout:h028-answer-which-surname | Є два клієнти: Степан Гуменюк і Степан Гуменний. Для кого з них? | той що Гуменюк | llm | ui.pick | 0.998 |
| followup_holdout:h029-answer-which-second | Знайшов двох: перша — Леся Приходько, друга — Леся Присяжнюк. Котрій оформити? | другій | llm | ui.pick | 0.997 |
| followup_holdout:h030-answer-for-whom | Для якого клієнта оформити? | для Зоряни Білик | llm | ui.pick | 0.963 |
| followup_holdout:h059-trap-abandoned-question | Яка ціна у товару Наполеон? | Ладно, потім з цим. Покажи нові замовлення | llm | ui.confirm | 0.998 |

## Wrong writes (arm C would open a confirmation card for the wrong write)

| row | pass | said | gold | Шо would write | confidence |
|---|---|---|---|---|---|
| live_heldout_gold:lh-251 | gold_554 | Ручку, стрілочку наверху. Создай мне. | none | catalog_createProduct | 0.996 |
| dictation_v5_gold:dv5-none-26 | gold_554 | Замовлення Оксани я вже підтвердила ще зранку, не хвилюйся. | none | orders_confirm | 0.999 |
| probe:update-legal | router_probe | Онови реквізити ФОП, у нас новий IBAN | companies_updateLegal | customers_updateCounterparty | 0.992 |
| calibration:customers_list_groups-04 | router_calibration | Чи існує група клієнтів VIP? | customers_list_groups | customers_updateGroup | 0.980 |
| calibration:customers_createCustomer-21 | router_calibration | Додай клієнтці Одарці Гаврилюк новий номер телефону 0689990011. | customers_updateCustomer | customers_createCustomer | 0.998 |
| calibration:customers_createCustomer-23 | router_calibration | Додай нового працівника Кирила Бондаря, його номер 0507771234. | invites_create | customers_createCustomer | 0.996 |
| calibration:customers_createGroup-20 | router_calibration | Перевір, чи створена в нас група «Дилери». | customers_list_groups | customers_createGroup | 0.997 |
| calibration:customers_createGroup-21 | router_calibration | Створи групу товарів «Десерти». | none | customers_createGroup | 0.999 |
| calibration:customers_createGroup-23 | router_calibration | Створи груповий чат для наших працівників. | none | customers_createGroup | 0.998 |
| calibration:pricing_createPriceList-20 | router_calibration | Перевір, чи створено прайс-лист «Літній». | pricing_list_price_lists | pricing_createPriceList | 0.999 |
| calibration:other_jobs-36 | router_calibration | Зроби прайс «Інтернет-магазин» типовим для всіх нових замовлень. | pricing_setDefaultPriceList | pricing_createPriceList | 0.999 |
| executor_holdout:h-unsupported-archive | router_executor_holdout | Заархівуй товар Чізкейк | none | catalog_archiveProduct | 0.998 |
| executor_holdout:h-unsupported-legal | router_executor_holdout | Онови реквізити ФОП, у нас новий IBAN | none | customers_updateCounterparty | 0.992 |

## Шо action distribution on non-commands

| Шо action | rows |
|---|---|
| none | 58 |
| orders.create | 3 |
| ui.confirm | 2 |
| nav.analytics | 2 |
| customers.createGroup | 2 |
| bank.statement | 1 |
| ui.reject | 1 |
| delivery.estimate | 1 |
| customers.listGroups | 1 |
| catalog.listProducts | 1 |
| pricing.setDefaultPriceList | 1 |
| nav.customers_new | 1 |
| nav.products_new | 1 |
| pricing.getPriceList | 1 |
| ui.refine | 1 |
| fiscal.openShift | 1 |
| debts.list | 1 |
| nav.accounting | 1 |
| customers.listCustomers | 1 |
| catalog.archiveProduct | 1 |
| customers.deleteCustomer | 1 |
| customers.updateCounterparty | 1 |
| analytics.summary | 1 |
| orders.count | 1 |
| accounting.taxDeadlines | 1 |
| orders.update | 1 |
