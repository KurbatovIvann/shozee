# SHO-740 — Jev in front (arm D)

Model `jev-latest` on `https://api.typesafe.ai/v1/systemone`, two choice
questions a turn: the gate (command / talk / mixed / unsupported) and
one tool out of 31 options. The follow-ups send the whole exchange as
state, so this is the only arm that reads history without a parser.

### Stratified subset (the same phrases arms A and B saw) (100 messages)

| metric | value |
|---|---|
| gate exactly right (4 classes) | 72/100 = 72.0% |
| gate right on command / not-command | 78/100 = 78.0% |
| top-1 tool on commands | 58/70 = 82.9% |
| top-3 tool on commands | 62/70 = 88.6% |
| top-5 tool on commands | 63/70 = 90.0% |
| said `none` when nothing was asked for | 22/30 = 73.3% |
| latency p50 / p95 | 285 / 369 ms |

### Router follow-ups (140 messages)

| metric | value |
|---|---|
| gate exactly right (4 classes) | 121/140 = 86.4% |
| gate right on command / not-command | 121/140 = 86.4% |
| top-1 tool on commands | 124/130 = 95.4% |
| top-3 tool on commands | 130/130 = 100.0% |
| top-5 tool on commands | 130/130 = 100.0% |
| said `none` when nothing was asked for | 4/10 = 40.0% |
| latency p50 / p95 | 281 / 351 ms |

## Spend

Calls: 240 (0 failed). Input tokens 282667.

**Jev spend: $0.01187 of a $1.80 cap.**
