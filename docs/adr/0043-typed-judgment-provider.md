# ADR-0043: A typed-judgment provider beside the reply model

- **Status**: Accepted
- **Date**: 2026-09-18
- **Deciders**: Ivan Kurbatov (human) (+ proposing agent)

## Context

- **TypeSafe's Jev is not a language model in the ADR-0032 sense.** One
  endpoint (`POST /v1/systemone`) takes `state` plus named questions and
  returns typed answers: Choice (one of a closed set, with a distribution and
  a confidence), Noul (probability of yes), Score (position on ordered
  levels). It does not generate text, does not fill free-text arguments
  (names, numbers, dates), counts and compares dates unreliably, and does not
  treat `state` as hostile (docs.typesafe.ai, `jev-1.13` jaggedness page).
- **It fits no existing seam.** `StaffProviderAdapter`
  (`packages/ai/src/provider/types.ts`) is `LanguageModel`/`ToolSet`-shaped,
  and `@showzy/assistant-kit` drives one `streamText` loop. ADR-0032 pins
  `ai@7` plus exactly one `@ai-sdk/<provider>`; `@typesafe-ai/sdk` is neither.
- **`packages/ai/AGENTS.md` forbids an intent classifier.** The rule was
  written against a second LLM prompt-and-parse hop in front of the reply
  model. A calibrated typed judgment at about $0.0001 a request is a
  different cost and failure shape, and the rule does not say which it means.
- **Quality on Ukrainian is unknown.** English is the primary training
  language; the docs do not mention Ukrainian. Every staff utterance is
  Ukrainian. No threshold and no consumer can be chosen from the docs.
- **Legal (docs, 2026-09-18):** no training on customer data; zero data
  retention is enterprise-only; region and sub-processors are not stated.

## Decision

Showzy adds a **judgment port** in `packages/ai` (`src/judgment/`), a sibling
of the reply-model provider and not a `LanguageModel`, with TypeSafe as its
first adapter. ADR-0032 stands for the reply loop and is amended only in that
a second AI vendor of this shape is allowed beside it.

1. **Advisory and fail-open.** A judgment result is either answers or a typed
   refusal (`timeout`, `rate_limited`, `overloaded`, `rejected`,
   `unavailable`). On a refusal or low confidence the existing path runs
   unchanged. No turn fails because a judgment failed.
2. **A judgment never decides what a human or the domain decides.** It never
   authorises a write, never stands in for a confirmation (ADR-0038), and
   never resolves an ambiguous human reference
   (`.claude/rules/actions-and-ai.md`: never guess).
3. **Where it runs.** Only from `packages/ai` or
   `@showzy/assistant-runtime`, in the worker's turn, outside any domain
   transaction. Never from a module handler: a handler is shared with the
   classic UI (ADR-0033) and must not depend on a model.
4. **One vendor file.** `src/judgment/typesafe.ts` is the only importer of
   `@typesafe-ai/sdk`, pinned by a test the way the Anthropic import is
   (`provider/anthropic.test.ts`). The port's own
   types cross the boundary; SDK types do not. Key and model come from
   `@showzy/config`; the SDK's own `TYPESAFE_*` env fallback is never relied
   on.
5. **The model id is pinned** (`TYPESAFE_MODEL`, default `jev-1.13.0`), never
   a moving alias. Thresholds belong to a version; a version bump re-runs the
   probe.
6. **State is minimised.** A request carries the utterance and the option or
   tool descriptions. Customer personal data enters `state` only when a
   consumer's own ticket names the field and why.
7. **A consumer needs numbers.** The first branch ships the port, the adapter
   and a hand-run Ukrainian probe, and changes no assistant behaviour. Each
   consumer is its own ticket, justified by probe results recorded in
   `docs/reference/`. The `packages/ai/AGENTS.md` sentence becomes: no second
   LLM prompt-and-parse hop; a judgment-port consumer needs probe numbers and
   a ticket.
8. **No automated live calls.** CI and `verify.mjs` use an injected `fetch`
   fake. The probe is run by hand, once per model version.

## Alternatives considered

- **A second `StaffProviderAdapter`** — rejected: every member of that
  interface (`createModel`, `decorateToolSet`, cache breakpoints) is
  meaningless for a model that returns no text and calls no tools.
- **Raw `fetch` without the SDK** — rejected: one endpoint is small, but the
  SDK already owns retry-after handling, typed errors and the injectable
  `fetch` the tests need; the owner approved the dependency.
- **Wrap Jev as an AI SDK `LanguageModel`** — rejected: it would serialise
  typed answers into text to be parsed again, which is the prompt-and-parse
  hop this provider exists to avoid.
- **Call it from module handlers** (for example inside
  `customers.resolveCustomerReference`) — rejected: it would put a
  probabilistic vendor call inside a domain transaction and make the classic
  UI's result depend on a model.
- **Ship a consumer with the port** — rejected: without Ukrainian numbers any
  threshold is a guess, and a wrong suggestion is measurably worse than none
  (TypeSafe's own skill-suggestion cookbook).

## Consequences

- The assistant has two AI vendors with different failure modes; the port's
  result type makes the fail-open branch unavoidable for a consumer.
- A port exists before its first consumer. That is accepted only because the
  same branch carries the probe that chooses the consumer; if the probe
  rejects all candidates, the port is removed rather than kept.
- The unused `"gate"` model kind and `AI_GATE_MODEL` are decided after the
  probe, not here.
- Judgment spend is not metered: roughly $0.0001 a request against a flat
  per-turn reservation. Recorded in `docs/operations/assistant-budget.md`.
- Before production (record, do not build): a signed DPA, the processing
  region, and whether zero data retention is required for staff utterances.

## Revisit when

- The probe shows Ukrainian accuracy or confidence separation too weak for
  every candidate consumer.
- A consumer needs customer personal data in `state`.
- TypeSafe changes pricing, retention terms, or retires the pinned version.
- A second judgment vendor appears, or Jev gains text generation and the
  ADR-0032 question reopens.
