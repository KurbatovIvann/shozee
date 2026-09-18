# ADR-0045: A context rewrite in front of the judgment, and reads taken without a shadow gate

- **Status**: Accepted
- **Date**: 2026-09-18
- **Deciders**: Ivan Kurbatov (human) (+ proposing agent)
- **Amends**: ADR-0044 (decisions 2, 3 and 8, and one rejected alternative)

## Context

ADR-0044 made the turn a cascade — a typed judgment plans the first step when
it is sure and the job is a read, otherwise the language model runs the turn —
and said two things this ADR changes: "there is no rewriting stage", and
"Phase B starts only after the owner reads the shadow numbers".

Both rested on what had been measured by then. Two things were not:

- **Follow-up turns.** The planner sees one message. "А за тиждень?", "для
  неї", "таке саме для Ігоря", "120" in answer to "яка ціна?" cannot be
  planned from one message, and in a chat they are a large share of turns.
- **Whether a shadow phase can produce numbers at all.** There is no
  production (owner, 2026-09-11). Shadow traffic would be the owner typing by
  hand — the same sentences that would exercise Phase B directly.

The owner proposed again that a language model prepare the message for Jev.
ADR-0044 rejected that on a probe of *hard single messages* (63% against 90%
for the same small model planning alone). That probe never tested the job the
owner meant: resolving a message against its conversation.

`docs/reference/typesafe-followup-probe-2026-09.md` measures it. 140 labelled
turns in two corpora; the second (90 turns) was written by an agent that saw
neither the specs nor any prompt. Three runs of every Jev path on each corpus,
history carrying real tool calls, `jev-1.13.0`, Haiku 4.5, Sonnet 4.6:

- **The planner alone is safe on follow-ups but useless for them**: it
  delegated 74 of 79; all 5 confident plans were wrong, all 5 were
  `orders_create` without a customer — writes it may not take.
- **A yes/no question "does this message depend on the earlier
  conversation?"**, asked of the message alone (its own request in the probe;
  questions in one request cannot see each other's answers, so it can ride in
  the planner's): 94–97% of follow-ups at 0.5. Asked with the assistant's previous reply as well: 100%
  in every run. Both give the same end result, because the follow-ups the
  first one misses are ones the planner declines anyway.
- **Haiku rewrites the message against the conversation, the unchanged
  planner plans from the rewrite**: on the unseen corpus 32–35 of 50
  follow-ups planned per run, at most one wrong; on the first corpus 23 of 29,
  none wrong. About 0.7 s and $0.0003 a rewrite.
- **A failure class of the rewrite, and it is a write.** Praise after a create
  ("клас, швидко ти") was rewritten into the previous request and planned as
  `customers_createCustomer` again. The needs-history answer does not stop it
  (0.47–0.57). The planner's own message kind, asked of the *original*
  message, does: every talk turn was `small_talk` or `capability_question` at
  ≥ 0.88 in all runs, while about 95% of follow-ups were `request`.
- **Run to run**, the planner's decision on an original message did not change
  on either corpus. What varies is Haiku's wording, which moves a plan between
  "planned" and "delegated"; once in six runs it moved one from right to wrong
  (a list became a count — a read).
- Checked offline on the saved runs: requiring every name and number in a plan
  made from a rewrite to occur in the conversation dropped no correct plan.
- **End to end** (judgment when confident, else Sonnet): 91–94% correct first
  calls with 57–70% of turns needing no tool-loop model, against 90–92% and
  13–24% without the rewrite. Of the reads the judgment would take, nine in
  ten are order counts and order lists, which already have result cards.
- **Escalation target**, measured in the real tool loop: Sonnet 6–8% wrong
  first calls, Haiku 9–16%. Haiku asks for fields no tool needs and declares
  actions impossible.

## Decision

**The cascade gains one stage: when the judgment says a request depends on
the conversation, a small language model rewrites it as a self-contained
request and the judgment plans from that. Code still decides everything; the
rewrite is text for the judgment, never a decision. Reads are taken without a
shadow phase first, behind a mode switch.**

1. **The first judgment request gains one question** — does the message
   depend on the earlier conversation — asked of the message alone. The
   assistant's previous reply is *not* sent to TypeSafe: it can carry a
   customer's phone, the accuracy gain is one plan in ninety, and ADR-0043's
   state minimisation stands.
2. **The rewrite runs only when all of this holds**: the conversation is not
   empty; the judgment's message kind for the original message is a request
   or out of scope, never small talk or a capability question; the
   needs-history answer is at or above its threshold. Otherwise the original
   plan stands as in ADR-0044.
3. **What the rewrite is.** One call to the provider's gate model (the
   existing `gateModel`, Haiku; no new configuration) with the text of the
   last three exchanges and the latest message, asking for one self-contained
   Ukrainian request, unchanged when the message already stands alone. Its
   output is planned by a second judgment request under ADR-0044's take rules
   unchanged, plus one guard: every name and number the plan takes from the
   rewrite must occur in the conversation, or the step delegates.
4. **The rewrite is invisible.** It is never shown, never stored as the
   person's message, and never given to the reply model: a delegated turn
   runs on the real history exactly as today. No model output is parsed for a
   decision — the only reader of the rewrite is the typed judgment.
5. **It lives inside the cascade model** in `packages/ai` (ADR-0044 decision
   1). The judgment stage — first request, rewrite, second request — has one
   deadline of three seconds; past it, or on any refusal or error, the step
   delegates. Inside a conversation the rewrite starts alongside the first
   request and is aborted when it is not needed; it costs less than the wait.
   (Amended the day it shipped: the first four live turns showed a single
   request at 0.65 s from a worker whose connections had gone cold, against
   0.36 s in the probes, so request → rewrite → request in sequence never fit
   two seconds and three of the four turns timed out.)
6. **Reads only stands** (ADR-0044 decision 6), and the replayed write above
   is now a second reason for it. So does the card requirement (decision 7):
   the first reads taken are `orders_list_counts` and `orders_list_page`.
7. **A mode switch replaces the shadow gate.** `ASSISTANT_JUDGMENT_MODE` =
   `off | shadow | take`, default `shadow`, through `@showzy/config`; without
   a TypeSafe key it is `off`. `take` is ADR-0044's Phase B with this ADR's
   rewrite. The shadow record stays on in `take` for every turn the judgment
   did not take, and records a taken turn as taken; it gains whether a rewrite
   was used, never the rewrite's text.
8. **Thresholds** are the measured ones — take 0.7, doubt 0.3, argument 0.7,
   needs-history 0.5 — tied to `jev-1.13.0` and to the gate model's version,
   in one place beside the specs. They are revisited with shadow data when
   there is traffic to produce it.
9. **The escalation target stays the reply model (Sonnet).** A cheaper tier
   for talk and capability questions is not decided here: the probe has ten
   such turns.
10. **ADR-0044 is amended:** decision 2 reads "at most two judgment requests
    per turn, on the first step only"; decision 3's "thresholds come from
    shadow data" becomes decision 8 above; decision 8's last sentence is
    replaced by decision 7 above; the rejected alternative "a language-model
    orchestrator that rewrites messages for Jev" is narrowed to "rewrites
    *every* message" — rewriting a hard single message stays rejected on the
    same numbers. `packages/ai/AGENTS.md` names the rewrite as the one
    language-model call allowed before the reply model, and why it is not a
    classifier: nothing reads its output but the judgment.

## Alternatives considered

- **Keep ADR-0044 as it is: follow-ups always go to the language model.**
  Safe and simple, and the judgment then serves about a fifth of turns. The
  rewrite triples that for $0.0003 and under a second. Rejected, but it is the
  fallback if the rewrite misbehaves: `shadow` mode is exactly this.
- **A language model first on every turn, deciding who handles it** (the
  orchestrator in full). Rejected: it puts a model call on the turns the
  judgment already plans alone in a third of a second; the one error the
  ungated rewrite made on the first corpus and two of three on the second
  came from rewriting messages that needed none; and a model that *decides*
  is a classifier whose output code must parse. Here Jev decides and the
  model only supplies text.
- **Give the judgment the conversation instead of rewriting.** Not measured.
  Jev selects among candidates code offers; carried-over values would need
  candidate spans from history and questions about which turn they belong to
  — a larger change to the planner than one rewrite call, with 64k context
  and PII in every request. Worth a probe if the rewrite's variance becomes a
  problem.
- **Send the previous reply with the needs-history question.** 100% against
  94–97%, identical end result, and it sends customer data to a second
  processor. Rejected.
- **Haiku as the escalation target.** Rejected on measurement for now.
- **Keep the shadow gate.** Rejected: no traffic exists to fill it, and the
  one thing only real use shows — whether a card with a fixed line is an
  acceptable answer — shadow cannot show.

## Consequences

- More than half of turns in a conversation can finish without the tool-loop
  model, once their reads have cards; today that is order counts and lists.
- A follow-up the judgment ends up delegating waits about a second longer
  before the reply model starts. Bounded by the two-second deadline.
- A third model is in the turn path (Haiku), on the existing Anthropic key.
  Its spend (about $0.0003 a turn in a conversation) is unmetered, like the
  TypeSafe spend: the turn keeps its flat budget hold only when the reply
  model ran. Charging a $0.10 hold for a $0.0005 turn would make every turn
  inside a conversation cost what a Sonnet turn costs.
- The conversation text already goes to Anthropic for every turn; the rewrite
  adds no new processor. TypeSafe now receives rewritten messages, which name
  the customer a pronoun stood for — the same kind of data an explicit
  message already carries.
- New bug class: a rewrite that carries over what was not meant. It is
  confined to reads, visible at once, and recorded (`rewrite used`) so it can
  be counted.
- The probe corpora become the regression set for any change to the rewrite
  prompt, the needs-history question, or either model version: hand-run,
  never in CI.

## Revisit when

- Any wrong taken read is traced to a rewrite more than rarely, or the
  rewrite's share of delegations grows: try the conversation-in-state
  alternative.
- The gate model or Jev changes version: re-run both corpora.
- Writes become eligible (the preview-and-confirm ADR): the replayed-write
  failure must be re-measured first, not assumed fixed by the talk guard.
- Real traffic exists: replace the probe thresholds with shadow numbers.
