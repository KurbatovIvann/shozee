# TypeSafe (Jev) on follow-up turns, and Haiku vs Sonnet in the tool loop — 2026-09-18

Fourth probe. The earlier ones measured single messages; the ADR-0044
planner also sees only the last message, so "А за тиждень?" was the failure
class nobody had measured. Harness: `apps/api/src/typesafe-probe/followup/`
(`run.ts --raw <file>`, `--rescore <file>` re-renders without a live call).
Owner-authorised hand-runs, two runs, about $5 of Anthropic spend and under
$0.01 of TypeSafe. One run per number: Jev is not stable near a boundary, so
read differences of one or two cases as noise.

## Setup

50 labelled turns: 29 **follow-ups** that cannot be acted on without the
conversation (a changed period or status, "for her", "the same for …", an
answer to the assistant's question, a correction) and 21 **controls** that
state the whole request (14 after an unrelated exchange, 6 opening a
conversation, 1 self-contained message that starts with "А"). Each label is
the first staff tool call and the arguments the judgment specs cover.

The history carries real tool calls and results. The first run used text-only
history and both models started imitating it — answering "Додав товар" with
no call — so its language-model numbers were discarded.

Paths measured on every turn:

- **Jev, last message only** — `planStaffTurn` as the shadow runs it today.
- **Needs-history Noul** — one extra question, asked of the message alone and
  of the message plus the assistant's previous reply.
- **Haiku rewrite → Jev** — Haiku reads the conversation and rewrites the
  latest message as one self-contained request; the unchanged planner plans
  from that.
- **Language model in the real tool loop** — the production system prompt,
  tool set (hot and deferred, BM25 tool search) and provider options, a fake
  `execute`; scored on the first staff tool call. "Read before the write" is a
  lookup the model chose to make before a create: a slower path, not an error.

## Results

| Needs-history Noul | Threshold | Follow-ups flagged | Controls flagged |
| --- | --- | --- | --- |
| message only | 0.5 | 97% | 14% |
| message + previous reply | 0.5 | 100% | 10% |
| message + previous reply | 0.7 | 97% | 5% |

| Jev path | Follow-ups: planned / correct / wrong | Controls: planned / correct / wrong |
| --- | --- | --- |
| Last message only | 2 / 0 / 2 | 13 / 13 / 0 |
| + Noul ≥ 0.5 delegates | 0 / 0 / 0 | 11 / 11 / 0 |
| Haiku rewrite → Jev | 23 / 23 / 0 | 14 / 13 / 1 |
| Noul ≥ 0.5 → rewrite → Jev, else Jev | 23 / 23 / 0 | 13 / 13 / 0 |

Reads only, which is all ADR-0044 lets the judgment take: last message only
takes 8 of 50 turns (8 correct); Noul-then-rewrite takes 21 of 50 (21
correct).

| Model in the tool loop | Follow-ups correct | Controls correct | Read before the write | Wrong | First call p50 / p95 ms | First step cost |
| --- | --- | --- | --- | --- | --- | --- |
| Haiku 4.5 | 72% | 86% | 6% | 16% | 1178 / 3115 | $0.0115 |
| Sonnet 4.6 | 93% | 81% | 4% | 8% | 2093 / 5026 | $0.0367 |

| Cascade (Jev plan when confident, else the model) | Fallback | Correct, all turns | Turns with no tool-loop model |
| --- | --- | --- | --- |
| Last message only + Noul delegates | Sonnet | 90–92% | 22% |
| Noul ≥ 0.5 → rewrite → Jev, else Jev | Sonnet | 94% | 72% |
| Noul ≥ 0.5 → rewrite → Jev, else Jev | Haiku | 86% | 72% |

Haiku rewrite: p50 703 ms, p95 3280 ms, $0.0003 a turn. Jev plan: p50 366 ms.

## What it says

- **The planner already fails safe on follow-ups.** Alone it delegated 27 of
  29; its two wrong plans were both `orders_create` without a customer —
  writes, which it may not take. The Noul removes those too at no extra
  request (it rides in the same one).
- **Rewriting with history works, unlike rewriting a hard single message**
  (63% in the executor probe). Resolving "for her" and "the same, but this
  week" from a transcript is a narrow job Haiku does well: 23 plans, none
  wrong. Its one error came from rewriting a message that needed no rewrite
  ("Дякую!" became the previous question), and once it carried a customer into
  a request that named none. Gating the rewrite on the Noul removes the first
  and leaves the second as the known risk.
- **Haiku is not a drop-in fallback.** On follow-ups it asks for fields the
  tool does not need (an email, product variants) and answers "there is no
  such group" from a truncated list. Sonnet's misses are milder: counts where
  a list was asked, global search instead of the deferred groups tool.
- Two labels are disputable and were left as scored: both models declined to
  re-list three customers a card already showed (`f30`), and both asked
  "to which order?" for "Додай товар Макаронс за 55 гривень" after an orders
  list (`c05`) — where the planner, blind to history, was right.
- The probe found one production defect: the shadow comparison read only
  `quantityDecimal`, and both models send `quantityMilli`, so every order
  would have been recorded as `argsAgree: false`. Fixed with a test.

## What it does not say

Synthetic turns written by the person who wrote the specs; one exchange of
history in most cases; one run. It does not measure the reply a person sees,
the second step of a tool loop, or talk and capability questions beyond three
controls. A rewrite hop in front of the judgment is an LLM call before the
reply model, which `packages/ai/AGENTS.md` forbids today: wiring it needs an
ADR.
