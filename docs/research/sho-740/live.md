# SHO-740 — live Haiku 4.5

Model `claude-haiku-4-5`, called directly on `/v1/messages` so the usage
numbers are the provider's own. Tools: the real staff toolset built
from `contractModules` through `staffAssistantTools`; system: the real
`staffAssistantSystemPrompt` plus the turn-context addendum, with one
1.25x cache breakpoint on the system prefix and one on the last tool.
Nothing is executed: the reply's first `tool_use` is the routing answer.

Tools sent: 60.

## Arm A (LLM only) vs arm B (LLM + Шо's parse and shortlist)

| arm | calls | right tool | accuracy | input tok/turn | output tok/turn | $/turn | latency p50/p95 ms |
|---|---|---|---|---|---|---|---|
| A | 100 | 55 | 55.0% | 29863 | 126 | $0.00402 | 1638 / 3007 |
| B | 100 | 48 | 48.0% | 29971 | 145 | $0.00423 | 2007 / 3481 |

| stratum | arm A | arm B |
|---|---|---|
| read | 76.0% (25) | 68.0% (25) |
| write | 44.0% (25) | 40.0% (25) |
| clarify | 25.0% (20) | 10.0% (20) |
| talk | 73.3% (15) | 73.3% (15) |
| unsupported | 60.0% (15) | 53.3% (15) |

## Dialogues (4 turns: talk, command, answer to the assistant, talk)

| arm | turns | turns that cost an LLM call | $/dialogue | p50/p95 ms |
|---|---|---|---|---|
| A | 20 | 20 | $0.01623 | 1333 / 3483 |
| B | 20 | 20 | $0.01641 | 1420 / 3429 |
| C | 20 | 19 | $0.01572 | 1504 / 3422 |

### The turn after a Шо-closed turn (synthetic `sho-` tool_use / tool_result)

| arm | provider accepted the foreign tool_use | used the Шо result | reply |
|---|---|---|---|
| A | yes | yes | З трьох замовлень сьогодні — два підтверджені (№ 1041 та № 1040), одне ще нове (№ 1042). |
| B | yes | yes | З трьох замовлень сьогодні уже підтверджено два — №1041 та №1040. Одне замовлення №1042 ще в статусі «нове» і чекає підтвердження. |
| C | yes | yes | За сьогодні **2 замовлення підтверджено** (№ 1041 та № 1040 на суму 26 000 та 9 000 ₴), і **1 замовлення** (№ 1042 на 13 000 ₴) ще у статусі |

## Spend

Calls: 259. Input 140317, output 32925,
cache write 0, cache read 7617449.

**Claude spend: $1.0667 of a $4.00 cap.**
