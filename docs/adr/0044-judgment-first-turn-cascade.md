# ADR-0044: The assistant turn is a cascade — typed judgment first, language model on escalation

- **Status**: Accepted (amended by ADR-0045: decisions 2, 3 and 8, one alternative)
- **Date**: 2026-09-18
- **Deciders**: Ivan Kurbatov (human) (+ proposing agent)

## Context

ADR-0043 added a typed-judgment port (TypeSafe's Jev) beside the reply model
and required numbers before any consumer. The numbers now exist
(`docs/reference/typesafe-probe-2026-09.md`,
`typesafe-executor-probe-2026-09.md`, `typesafe-base-probe-2026-09.md`; all
hand-run, about $0.10 in total, `jev-1.13.0`, cases written by the proposing
agent):

- **Ukrainian is not a handicap.** Message kind (request / capability
  question / small talk / out of scope) and rule-override detection: 100% in
  Ukrainian and in English.
- **Plan from one request**, code offering candidates and Jev selecting
  ("select instead of generate"): held-out set **91%** whole plans (single
  job 95%, chains of 2–4 jobs 86%), **arguments 114 of 114**, about 0.3 s and
  $0.0002 a request. The same questions scored 60% before each job question
  said what the job is *not* — wording is the largest single factor.
- **Hard messages** (dictated run-ons, numbers in words, fragments): Jev 53%,
  a Haiku rewrite in front of Jev 63% at 1.1 s, Sonnet alone 83% at 3.9 s,
  Haiku alone 90% at 1.9 s. The rewrite invented phone digits, turned a
  request into a statement, and twice answered the user instead of
  rewriting. Jev's confidence still routes: at ≥ 0.7 it kept 12 of 30 and got
  10 right, and both misses belong to classes code or the gate detects.
- **Records.** When the module's search finds the record, Jev never picked
  wrong; over a whole list it is 100% on 134 products and 12 groups, but on
  300 similar person names it over-answers `ambiguous`, one Choice takes at
  most 256 options, and a non-existent "олена петрашенко" came back as Олена
  Петренко at 0.91 — and as `ambiguous` at 0.30 on the previous run. Answers
  near a boundary are not stable run to run.
- **What it cannot do:** write any text; pick a value code did not offer
  ("півтора" → confidently wrong); return several values for one argument;
  count, compare dates, reason in several hops.

Facts about the system the decision has to fit:

- A turn is `runHostTurn({ model, tools, messages })` in
  `@showzy/assistant-kit` — one `streamText` loop over a `LanguageModel`
  (ADR-0038). A pause stores the turn's exact provider messages; the worker
  runs the turn (ADR-0039). The kit knows nothing about this product.
- Staff tools are façades in `packages/ai` over `executeAction`
  (ADR-0033). Several take **human references** (`customerQuery`,
  `productQuery`) that the owning module resolves; since the one-name-matcher
  change those resolvers accept inflected names and answer anything
  uncertain with a picker.
- **Only five actions require confirmation** (three customer deletes,
  price-list delete, `documents.requestSign`). `orders.create`,
  `customers.createCustomer`, `catalog.createProduct`,
  `documents.createFromOrder` and the order transitions write at once. A
  wrong plan for a write is a wrong write; nothing downstream catches it.
- The owner's proposal was "Jev is the hands, Sonnet is the head", possibly
  as an agent network whose orchestrator rewrites messages for Jev.

## Decision

**A turn is a cascade with code as the orchestrator: a typed judgment plans
the first step when it is sure and the job is a read; in every other case
the language model runs the turn exactly as it does today.** There is no
agent network. (ADR-0045 adds one rewriting stage, for a request that
depends on the conversation.)

1. **The seam is the `LanguageModel`.** `packages/ai` gains a *cascade
   model*: an AI SDK `LanguageModel` composed of the judgment planner and the
   reply model. For a step it either emits tool-call parts built from a typed
   plan or delegates the whole step to the reply model. `@showzy/assistant-kit`,
   the stored document, pauses and events do not change (ADR-0038 and ADR-0039
   stand); `@showzy/assistant-runtime` changes in two named places only
   (decisions 7 and 8). No model output
   is parsed as text; this is not the "Jev as a LanguageModel" that ADR-0043
   rejected — the port stays typed, and only code turns a plan into a call.
2. **At most two judgment requests per turn** (ADR-0045: the second plans a
   context rewrite), on the first step only, the first carrying the
   message kind, one yes/no question per eligible job, and every argument of
   those jobs, asked speculatively. Deadline one second; any refusal,
   timeout or malformed answer delegates (ADR-0043: fail-open).
3. **The cascade takes the step only when all of this holds:** the message is
   a request; exactly one eligible job is above the take threshold and no
   other job is above the doubt threshold; every argument that job consumes
   is above its threshold; and code's coverage guards pass — no number
   written in words without a digit, no second value for one argument, no
   open interaction, first step of the turn. Otherwise it delegates.
   Thresholds are the measured ones (ADR-0045 decision 8), belong to a model
   version, and live in one place beside the specs.
4. **Eligibility is declared once, beside the façade.** Each staff tool in
   `packages/ai/src/tool-facades/` may carry a *judgment spec*: the job
   question with what it is and what it is not, and how each argument maps
   onto the façade's input (closed set, span of the message, number in the
   message). A test pins every spec to its façade's input schema. A tool
   without a spec is language-model-only. There is no second description of
   the actions anywhere else.
5. **Jev never resolves a record.** A name goes into the façade's human
   reference (`customerQuery`, `productQuery`, list `search`) and the owning
   module resolves it or opens its picker. Whole-list resolution by Jev is
   not built: 256-option cap, a confident wrong person, run-to-run
   instability.
6. **Reads only** (amended by ADR-0046: for a live trial the judgment also
   takes `orders_create`, whose arguments are references a module resolves).
   A judgment may propose a call to a `risk: "read"` action.
   It never proposes a write. Reason: most writes have no confirmation step,
   the measured whole-plan accuracy is 91%, and a wrong write is silent. A
   judgment-originated write needs a preview-and-confirm interaction that
   does not exist; that is a separate ADR, to be written with shadow data for
   writes in hand.
7. **The reply to a judgment-planned read** is the tool's result card
   (`@showzy/validation/assistant-surfaces`; orders list and orders aggregate
   have one today) plus a fixed line declared on the judgment spec beside the
   façade (`reply`, Ukrainian or English by the script of the message; not
   `@showzy/copy`, which is client copy that `packages/ai` may not import);
   no language model is called. A read whose result has no card needs words, so it is not
   eligible until it has one. The
   turn processor keeps the flat budget hold as soon as the host turn starts
   (`reachedModel` is set before `runHostTurn`); it will instead ask the
   cascade model whether the reply model was called, so a judgment-only turn
   releases its hold like a turn that never reached a model.
8. **Phase A — shadow — is the first consumer and changes no behaviour.** The
   worker computes the plan beside the real turn, executes nothing from it,
   and records on the turn what it would have done and what the language
   model did first (tool name and the arguments the spec covers, no free
   text). Storage: one nullable `jsonb` column `judgment_shadow` on
   `assistant_turns`, written at finish, owned by the assistant module. Phase
   B — reads — is switched on by `ASSISTANT_JUDGMENT_MODE=take` (ADR-0045
   decision 7), not gated on shadow numbers.
9. **Who decided is recorded.** A step planned by the judgment carries
   `decidedBy: "judgment"` and the model version in the step's provider
   metadata, which the pause and the history already store, and in the turn's
   log line.
10. **ADR-0043 is amended:** decision 2 reads "a judgment may propose a call
    to a read action; it never proposes a write, never stands in for a
    confirmation, and never resolves a human reference"; decision 3 gains "or
    inside the cascade model in `packages/ai`". Decisions 1 and 4–8 stand.

## Alternatives considered

- **An agent network with a language-model orchestrator that rewrites
  every message for Jev** (narrowed by ADR-0045, which rewrites only a
  request that depends on its conversation) — rejected on measurement: +10 points over raw Jev, 27
  points below letting the same small model plan alone, 0.8 s slower, and it
  introduced failures of its own (invented digits, a request turned into a
  statement). Once a language model has read the message, letting it finish
  is more accurate and simpler. ADR-0032 already rejected a harness.
- **Jev executes writes too, relying on confirmation** — rejected: the
  premise is false; five actions require confirmation.
- **A second loop in `assistant-runtime` beside the kit** — rejected: two
  derivations of what a turn is. ADR-0034–0037 were superseded for exactly
  that.
- **Jev resolves records over whole lists** — rejected for now: see
  decision 5. The modules' own search was the bottleneck and has been fixed
  at the cause.
- **Gate only** (skip the model for small talk and capability questions) —
  subsumed: the same request answers it, and the cascade may use it, but it
  is not the main saving.
- **Chains of jobs in the first version** — rejected: 86% against 95% for a
  single job, and a plan that outlives a step needs state the turn does not
  carry today.

## Consequences

- Read turns — counts, lists, lookups — answer in about a third of a second
  with no language-model spend, once Phase B is on; everything else behaves
  as it does now, because it *is* what runs now.
- A new kind of bug: a confidently wrong read. It is visible to the person
  at once and changes nothing; that is why reads go first.
- The judgment specs are a second thing to keep true about each eligible
  tool. The pinning test and "no spec means language model only" bound the
  cost; a façade change that breaks a spec fails CI.
- One schema change (`assistant_turns.judgment_shadow`), named here so it is
  not a silent fork.
- Shadow mode spends about $0.0002 a turn and sends the staff member's
  message to TypeSafe. Before production (record, do not build): DPA, region,
  retention — as ADR-0043 already requires.
- Which model is the escalation target (Haiku planned better than Sonnet on
  thirty hard messages) is a separate measurement in the real tool loop, not
  decided here.

## Revisit when

- Shadow data disagrees with the probes: take-rate below a fifth of turns,
  or any confidently wrong plan above the take threshold.
- A preview-and-confirm interaction exists, or more writes gain
  `requiresConfirmation` — then judgment-proposed writes can be decided.
- TypeSafe ships a model that returns several values per question or
  accepts more than 256 options, or changes version: re-run the probes,
  re-set thresholds.
- A third tier of turn appears (voice, batch) whose latency budget differs.
