# SHO-740 — routing between Шо and the dialogue LLM

Research spike for SHO-728 check 7. Draft PR, never merged.

Base: the SHO-734 branch (SHO-733 fast path, `planShoTurn`, `run({ raw })`,
the dev bakery seed) with `origin/main` merged in, so the Шо runtime is the
re-vendored b1e2b4d (D88–D92) with model v33 (`f10ddb14`). The merge was
clean — no conflicts.

Everything below is reproducible from this branch:

| what | how |
|---|---|
| offline replay | `SHO_740=1 vitest run src/http/assistant-kit-sho-routing.db.test.ts` |
| live Haiku | `SHO_740_LIVE=1 node --env-file-if-exists=.env … assistant-kit-sho-live.db.test.ts` |
| rescoring the recorded calls (free) | `SHO_740_LIVE=estimate …` |
| Jev | `SHO_740_JEV=1 … assistant-kit-sho-jev.db.test.ts` |

Nothing live runs in CI: each live file is skipped unless its own env flag
is set, and each was run once by hand. Raw rows:
`offline.jsonl`, `live-calls.jsonl`, `live-dialogues.jsonl`,
`jev-calls.jsonl`; corpora copied from `feat/typesafe-judgment-port`:
`router-single.jsonl` (539), `router-followup.jsonl` (140). Detail per
stage: `offline.md`, `live.md`, `live-scored.md`, `jev.md`.

## Live spend

| provider | cap | spent | calls |
|---|---|---|---|
| Anthropic (`claude-haiku-4-5`) | $4.00 | **$1.1597** | 274 (15 smoke + 259) |
| TypeSafe (`jev-latest`) | $1.80 | **$0.01187** | 240 |

Both computed from the provider's own returned usage after every call, at
$1/$5 per MTok with a 1.25× cache write and a 0.1× cache read for Haiku and
$0.042 per input MTok for Jev. The ledger refuses a call that could cross
the cap.

## The arms, side by side

`share without the LLM` and `wrong-write rate` come from the offline replay
over the 554 never-trained gold phrases; tokens, $ and LLM latency come from
the live run over the 100-phrase stratified subset. Шо's own latency is
measured in-process on this box.

| | A — LLM only | B — LLM + Шо's parse | C — Шо first, cards | D — Jev in front |
|---|---|---|---|---|
| first-tool accuracy, stratified 100 | 50.0% (70 commands) | 41.4% | — (Шо decides, see below) | **82.9%** |
| same-module accuracy | 68.6% | 62.9% | — | — |
| no tool when none was asked for | 66.7% (30) | 63.3% | — | 73.3% |
| wrong write as the first call | 0/100 | 0/100 | 2/554 offline | 0 (never calls) |
| routing accuracy of what the router closes | — | — | **98.6%** (367 of 554) | 82.9% top-1 / 88.6% top-3 |
| share of turns without the LLM | 0% | 0% | **66.2%** | 0% (a gate, not a closer) |
| LLM tokens / turn (in / out) | 29 863 / 126 | 29 971 / 145 | same as B on the 33.8% that fall through | 662 in, no LLM |
| $ / turn | $0.00402 | $0.00423 | **$0.00143** (0.338 × B) | $0.00005 + whatever follows |
| latency p50 / p95 | 1 638 / 3 007 ms | 2 007 / 3 481 ms | Шо 10 / 29 ms, then B on the rest | 285 / 369 ms |

Arm C's `$ / turn` is arithmetic, not a separate billed run: the turns Шо
closes cost nothing, and the ones that fall through are arm B calls.

## What the offline replay says

Full tables in `offline.md`.

- **Arm C on the 554 gold phrases:** closes 367 (66.2%) — 108 reads, 138
  confirmation cards, 121 clarification cards — at **98.6%** action
  accuracy with **2** wrong writes. Raising the floor from 0.90 to 0.99
  moves accuracy 98.6% → 98.9% and does not remove either wrong write.
  The SHO-734 figure of 6.1% was the two actions that have a param planner;
  66.2% is the routing decision, which is what this ticket asks about.
- **Arm C on the 539 router single messages:** 67.0% closed but only 78.9%
  accurate, with 11 wrong writes (2.0% of turns). Those corpora are
  adversarial on purpose and reach into domains Shozee has no tool for.
- **Arm D ceiling (a perfect gate in front of Шо):** on the gold set it
  removes both wrong writes and lifts accuracy to 99.5% while closing three
  fewer turns; on the router singles it removes 4 of 11 wrong writes. A gate
  in front is worth about a third of the wrong-write class, no more.
- **Top-k tool shortlist** (arm B's payload) from `debug.actionProbabilities`
  mapped to showzy-v2 tool names: gold 554 → 99.3% at k=3 (k=5 and k=8 add
  nothing); router singles → 77.9 / 79.6 / 81.5%; follow-ups → 50.8% on the
  bare message, **63.1%** once the previous command is passed (D78).
- **`previous` is worth more than focus alone on follow-ups:** closed rises
  39.3% → 56.4% (reads 19 → 42), accuracy 85.5% → 86.1%, wrong writes 0.

## The check that mattered most: answers to the assistant's own question

14 follow-ups whose last assistant turn ends in a question and whose message
is the bare answer («65 гривень», «Постійні», «Петренко», «другій»).

**Шо fired a confident command on 0 of 14**, with focus alone and with focus
plus the previous command. It answers `ui.pick` (10), `ui.refine` (3) or
`ui.confirm` (1) — none of which maps to a showzy-v2 tool, so arm C routes
all 14 to the LLM today.

That is the wrong destination under the owner's decision that typing an
answer answers the open question. `ui.pick` is Шо saying *this text is an
answer to an open interaction*; the host should hand it to the open
interaction, not to Haiku. This is a routing rule the assistant host is
missing, not a model weakness.

## The check that settles SHO-733 finding 4

A turn was replayed after a Шо-closed turn stored as a synthetic
`sho-<n>-<tool>` `tool_use` / `tool_result` pair for a tool Haiku never
called. **Anthropic accepted it in all three arms with no error**, and Haiku
used the result correctly each time, e.g. «З трьох замовлень сьогодні — два
підтверджені (№ 1041 та № 1040), одне ще нове (№ 1042).»

SHO-733 finding 4 is refuted: a Шо-closed turn can be stored as ordinary
tool history and the next LLM turn reads it.

## Attaching Шо's parse to Haiku (arm B) made it worse

48% → 41.4% first-tool accuracy, and 25% → 10% on the clarification stratum.
Arm B also answered in text with no tool twice as often (18.6% vs 8.6%).
Reading the rows, the cause is the hint itself: when the block says
`Шо's own routing: sho_clarify_card`, Haiku asks a question instead of
calling the lookup it would otherwise have called. The parse is a hint the
model over-weights.

Caveat on all arm A/B numbers: only the first assistant step was taken, so a
legitimate lookup before a write (`catalog_list_products` before
`catalog_createVariant`) scores as a miss. The same-module column bounds
that: 68.6% vs 50.0% for arm A. Neither arm ever opened a wrong write as its
first call.

## Recommendation

**Arm C for the Шо-supported jobs, arm A for everything else, and Jev only
if a shortlist is needed later.** Concretely:

1. Route every turn through Шо first. Close reads, confirmation cards and
   clarification cards when the gate passes; two thirds of real owner
   traffic never reaches Haiku, at 10 ms and no tokens, with 98.6% accuracy.
2. Send `previous` and `focus` on every run. Focus alone leaves half the
   follow-up value on the table.
3. **Add the missing host rule before anything else:** a `ui.pick` /
   `ui.confirm` / `ui.refine` from Шо while an interaction is open is the
   answer to that interaction, not an LLM turn. Шо already gets this right
   14 times out of 14; the host throws the signal away.
4. Do not ship arm B. Attaching the parse to the prompt cost accuracy on
   every stratum and bought nothing.
5. Keep the confirmation card on every write regardless of arm. Шо's two
   wrong writes on 554 gold phrases (0.4%) and eleven on the adversarial
   router corpus (2.0%) are survivable only because a human taps first.
6. Jev is the strongest first-tool router measured here (82.9% vs Haiku's
   50.0% on the same phrases; 95.4% on follow-ups) at 285 ms and $0.00005 a
   turn — but on an easier task: 31 hand-written one-line options versus 60
   real tools with full schemas and arguments to fill. It is a candidate for
   the *shortlist* Haiku receives, not for the call itself, and adopting it
   needs ADR-0043 revisited plus the `@typesafe-ai/sdk` dependency.

## Open questions

1. What does the host do with `ui.pick` / `ui.refine` / `ui.confirm` when no
   interaction is open? Today Шо produces them on 10 of the 14 answer cases;
   with no open pause they are meaningless and must fall through.
2. Arm C's 367 closed turns are a routing decision, not a shipped one: only
   `orders.list` and `orders.create` have a param planner, so 145 of the 367
   (and 77 of the 121 clarification cards) can be built today and the other
   222 would fall back with `no_param_plan`. Which planners to write next is
   a sizing question, not a routing question.
3. The router corpora were replayed against the bakery context, so entity
   resolution is wrong for them by construction; only the action head and
   the gate are measured there. A second corpus with its own catalogue would
   sharpen the 78.9% number.
4. The 11 wrong writes on the router corpus cluster on «перевір, чи
   створено…» («check whether X exists») being read as a create. That looks
   like a training-data gap in Шо, not a routing parameter.
5. Arm B was tested with one hint format. A terser hint (the shortlist only,
   no routing verdict) may not carry the same damage, but there is no reason
   to spend on it before arm C ships.

## Deviations from the ticket

- The Jev arm runs over plain HTTP (`POST /v1/systemone`) instead of
  `@typesafe-ai/sdk`, which is a new dependency and therefore not this PR's
  to add. The shape is the one the shelved provider on
  `feat/typesafe-judgment-port` sends.
- Live Haiku calls go straight to `/v1/messages` rather than through the AI
  SDK, because `ai` is not a dependency of `apps/api` and because the raw
  endpoint returns the exact cache-write and cache-read token counts the
  budget ledger needs. The system prompt, the tool set and the cache
  breakpoints are the real ones, built from `contractModules` through
  `staffAssistantTools`.
- `packages/sho/src/index.ts` now re-exports `parseFocus` and `FocusEntry`
  from the vendored runtime. The vendored `runtime/` tree is untouched.
