# ADR-0049: Шо parses every staff assistant message first

- **Status**: Proposed
- **Date**: 2026-09-30
- **Deciders**: Ivan Kurbatov (human) (+ proposing agent)

## Context

The staff assistant is one Haiku tool loop (ADR-0032, ADR-0037), accepted by
the API and executed by the worker (ADR-0039). Every turn costs tokens and
seconds, including «покажи замовлення за сьогодні».

SHO-728 measured the alternative. Шо (`system-one-uk` b1e2b4d, model v3.3) is
vendored in `packages/sho` (SHO-731 f5d089a6, SHO-739 ec9478b8): 490/490
action vectors, 46/46 focus vectors, p50 8.2 ms in process, and p50 64 /
p95 81 ms over warm HTTP in the SHO-733 spike.

Measured on 554 never-trained owner utterances offline and a stratified
100-phrase subset live (SHO-740, draft PR #539; spend $1.16 Anthropic,
$0.012 Jev):

| arm | first-tool accuracy | closed without the LLM | $/turn |
| --- | --- | --- | --- |
| A — Haiku alone | 50.0% | 0% | $0.00402 |
| B — Haiku + Шо's parse as a hint | 41.4% | 0% | $0.00423 |
| C — Шо first, cards | 98.6% of what it closes | 66.2% (367/554) | $0.00143 |
| D — Jev in front | 82.9% top-1 / 88.6% top-3 | 0% (a gate, not a closer) | $0.00005 + the LLM |

Four further facts the decision rests on:

- A synthetic `sho-<n>-<tool>` `tool_use` / `tool_result` pair, written by the
  server for a tool no model called, was **accepted by Anthropic in all three
  live arms**, and Haiku cited the result correctly. SHO-733 finding 4 is
  refuted.
- `previous` together with focus raises follow-up closure from 39.3% to 56.4%
  at 86.1% accuracy and zero wrong writes (D78, D88–D90).
- On 14 bare answers to the assistant's own question («65 гривень»,
  «Постійні»), Шо fires **0** confident commands and answers `ui.pick` (10),
  `ui.refine` (3) or `ui.confirm` (1) — none of which maps to a tool, so all
  14 go to Haiku today. A chat send while an interaction is open is refused as
  `interaction_open` and the draft bounces back into the composer (SHO-550).
- `withAssistantKitBudget` reserves and rate-limits **before** the route
  handler (SHO-733 finding 1).

## Decision

**Шо parses every staff assistant message inside the accept request. A
confident command in a Shozee domain is closed there; everything else becomes
an ordinary LLM turn, and Шо's parse is discarded.**

- The accept calls `POST /v1/parse` (ADR-0051) after the existing
  repeated-command, budget and open-question checks, before anything is
  enqueued. The whole Шо path has a ~1 s time budget.
- A command is taken when confidence **≥ 0.95**, the action is on the
  whitelist, and the only blocking need is an ambiguous reference. Reads
  answer at once; writes open the preview card (ADR-0050); an ambiguous
  reference opens a choice card.
- The floor is calibrated, not a round number: on the SHO-734 ticket
  whitelist, action accuracy is **99.0% at ≥ 0.95** against **98.0% at
  ≥ 0.90**, and the bar is ≥ 97%. It does not reach the wrong-write class —
  that is ADR-0050's job — and raising it further buys 0.3 points at the cost
  of turns Шо would have closed correctly.
- Talk, non-commands, unsupported actions, several commands in one message and
  anything depending on the conversation go to Haiku with today's tool loop.
  **Шо's parse is not attached to the prompt** — arm B cost 8.6 points of
  first-tool accuracy and 15 points on the clarification stratum.
- A Шо-closed turn is stored as a synthetic `sho-<seq>-<tool>`
  `tool_use` / `tool_result` pair in the same provider history the LLM reads.
- `focus` and `previous` are derived on the server from the stored log; the
  client never sends them.
- **An answer typed or dictated while an interaction is open answers that
  interaction.** A `ui.pick` / `ui.confirm` / `ui.refine` from Шо while a pause
  is open is routed to that pause; with no pause open it falls through to the
  LLM. This reverses the `interaction_open` refusal (SHO-550).
- Budget: `withAssistantKitBudget` keeps the per-minute turn limit and holds
  **$0** for the Шо path. A fall-through turn reserves as it does today.
- Any Шо error, timeout, or unusable parse is an ordinary LLM turn.
- **Retraining data** (owner, 2026-09-30): the command transcript and Шо's
  result are stored for retraining in **dev and test companies only**, and no
  audio is stored anywhere. Whether real company commands may be kept is a
  production policy, decided before there is production.
- Шо closes a turn by calling the same `executeAction` handlers through the
  same façades (ADR-0033). It is not a second domain path.

## Amendments to earlier ADRs

**ADR-0039, Decision.** "A turn is accepted by the API, executed by the
worker, and delivered to the client as events." — a turn Шо closes is
accepted, executed and settled inside the accept request: nothing is enqueued
and no event delivers it. Every turn that reaches the LLM is unchanged.

**ADR-0039, Consequences.** "**Every accepted turn runs to the end and is
charged,** whether or not anyone is watching." — a Шо-closed turn makes no
provider call and is charged nothing.

**ADR-0038, Decision.** "A pause stores the **exact provider messages** of the
turn plus the tool call that stopped it." — those messages may now include a
`tool_use` / `tool_result` pair with a server-issued `sho-` id, for a tool no
model called. Replay stays exact: the history is written once and replayed
byte for byte, and nothing is reconstructed.

ADR-0038's "One open question per conversation, claimed exactly once by
compare-and-set" is unchanged; what changes is where a typed answer goes.
ADR-0037's rule that model output is never a resolution survives: Шо's
`ui.confirm` resolves a pause through the kit's claim, not by asserting one.

## Alternatives considered

- **Haiku alone (arm A)** — 50.0% first-tool accuracy, $0.00402/turn, p50
  1 638 ms. Rejected: two thirds of real owner traffic is a routing decision
  Шо makes in 10 ms for nothing.
- **Attach Шо's parse to the prompt (arm B)** — 41.4% first-tool, 25% → 10% on
  clarifications, no tool at all twice as often (18.6% vs 8.6%). Rejected on
  those numbers: the model over-weights the hint.
- **Jev in front as the router (arm D)** — 82.9% top-1, 285 ms, $0.00005.
  Rejected: it is a gate, never a closer; it was measured on 31 hand-written
  one-line options, not 60 real tools with schemas; and every phrase leaves the
  server. Шо's own top-3 shortlist recall on the same 554 is **99.3%**, so the
  shortlist Jev would supply is already in the parse.
- **A perfect gate in front of Шо (the arm D ceiling)** — removes both wrong
  writes on the gold set and 4 of 11 on the router corpus, closing three fewer
  turns. Rejected as the answer to wrong writes: a gate buys about a third of
  that class; the preview card (ADR-0050) buys all of it.
- **Run Шо in the worker, after the accept** — rejected: the value is a 200
  with a finished window in ~1 s; an enqueued Шо turn costs the same round trip
  as the LLM turn it replaces.

## Consequences

- Two thirds of measured owner traffic never reaches a provider: 0.338 × the
  token bill, 10 ms instead of 1 638 ms.
- The accept gains a synchronous dependency on `apps/sho` (ADR-0051). Every
  failure of it is a fall-through, so the worst case is today's behaviour.
- The stored provider history gains server-written tool calls. Readers of
  `assistant_chat_state` must tolerate a `tool_use` id no provider issued.
- The whitelist and the param planners are the ceiling, not the threshold:
  222 of the 367 closures have no param planner today (`no_param_plan`), so a
  first slice closes 145.
- `interaction_open` stops being a refusal of a chat send; the mobile banner
  for it (SHO-550) goes with it.
- Recorded, not built: replica count, deploy ordering between `apps/api` and
  `apps/sho`, and the latency tail at production catalogue sizes.

## Revisit when

- Шо's closed-turn accuracy on real traffic falls below 97%, the bar SHO-734
  set.
- A dialogue model becomes cheap and accurate enough that a 10 ms local parse
  no longer pays for the second code path.
- Шо's action catalogue and the Shozee action registry diverge far enough that
  the whitelist stops covering common jobs.

## Open questions

1. What does the host do with `ui.pick` / `ui.refine` / `ui.confirm` when no
   interaction is open? Falling through to the LLM is proposed; 10 of the 14
   measured answer cases produce them.
2. Which param planners next? 222 of 367 closures fall back today.
