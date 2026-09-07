# ADR-0034: Model trace is prompt state, not a projection

- **Status**: Accepted
- **Date**: 2026-09-07
- **Deciders**: Ivan Kurbatov (+ proposing agent: Shozik audit,
  Linear [SHO-504](https://linear.app/showzy-v2/issue/SHO-504) /
  [SHO-510](https://linear.app/showzy-v2/issue/SHO-510))

## Context

ADR-0011 and `docs/module-ownership.md` say the `assistant` module "stores
action/tool IDs and results; never duplicates domain state". Today
`assistant_tool_runs` keeps `result_ids` and an outcome, and the model's
conversation history is **text only** (`packages/ai/src/messages.ts`,
eight-message window). After «покажи останні 3 замовлення» the model does
not remember the three orders it just listed; «а яке з них найдорожче?»
needs a second list call or fails.

The compact, clipped façade output the model saw inside the turn
(`clipToolExecutes`, ≤ `STAFF_ASSISTANT_CLIP_JSON_MAX` = 22 000 chars) is
exactly the context a follow-up needs. It is not rendered by any client;
cards are built from `result_ids` through the owning module's reads.
Storing it raises a real question against ADR-0011: is it a second copy of
domain state?

Forces: server-owned history ([SHO-506](https://linear.app/showzy-v2/issue/SHO-506))
moves model-context assembly to the server, so the server needs a source
for tool results; every turn in the window pays input tokens for whatever
is stored; Anthropic prompt caching can make a *stable* prefix cheap to
re-send, but only when the cached prefix bytes match exactly.

## Decision

`assistant_tool_runs` gains a nullable `model_trace jsonb` column holding
the **post-clip façade output** of a successful tool run — the bytes the
model already received in that turn. It is **prompt state**: a cache of a
model input, never a projection of domain state.

Rules that make it prompt state rather than a projection:

1. **Never rendered.** No client action exposes it; `assistant.getConversation`
   does not return it. A dedicated internal read
   (`assistant.getModelHistory`, `transport: "internal"`,
   `aiExposure: "internal"`) is the only reader, and its only caller is the
   model-history builder in `apps/api`.
2. **Never authoritative.** No domain rule, card, or event reads it. Cards
   keep resolving `result_ids` through the owning module. If trace and
   domain disagree, the domain is right and the trace is stale by design.
3. **Bounded.** ≤ 22 000 chars per run (CHECK), and a read-time token
   budget: full trace only for the most recent tool-bearing turn, a
   deterministic ≤ 300-char identity digest for older turns in the window,
   ≤ 8 000 chars across the whole window, oldest digests dropped first.
   One ordering rule keeps that from misfiring: a tier-1 trace that alone
   exceeds the cap is shrunk and then digested **before** the window is
   spent, because deleting ≤ 300-char digests to make room for a
   20 000-char trace loses the window for nothing. Tier 1 is *reduced*
   (shrink → digest) rather than dropped outright, and its digests are the
   newest, so they are the last to go — but the cap is hard and comes
   first. A single turn is allowed up to 50 tool runs, and 50 digests do
   not fit in 8 000 chars; that turn keeps as many of its newest runs as
   the cap allows and loses the rest. Guaranteeing every run of such a turn
   would mean a per-run budget, which is not worth the machinery.
4. **Only successful outcomes.** No trace for `confirmation_required`,
   `needs_choice`, or error runs; presenter text already records those.
5. **Same lifecycle as the conversation.** It lives and dies with
   `assistant_tool_runs`; no separate retention, export, or backfill.

ADR-0011 is amended in wording only: "never duplicates domain state" reads
"never duplicates domain state **as a projection or source of truth**;
bounded model-prompt caches that no client renders are prompt state (ADR-0034)".

## Alternatives considered

- **Keep text-only history; the model re-queries on follow-ups** —
  rejected: every follow-up costs a full extra model step (~1–2 ¢, 2–4 s)
  and the model answers about data it cannot see, which is where hallucinated
  numbers come from.
- **Rebuild a tool message from `result_ids` on each turn** (replay through
  `orders.get` / `customers.getCustomer`) — rejected: one read per remembered
  entity per turn, does not work for aggregates (`orders_list_counts`), and
  reproduces today's clip logic a second time.
- **Client-supplied tool results in the chat body** — rejected: the client
  becomes the authority over what the model remembers; contradicts
  server-owned history (SHO-506) and the tenant-isolation invariant.
- **Unbounded trace for the whole window** — rejected: four tool turns ×
  22 000 chars ≈ 25k input tokens per turn regardless of need.

## Consequences

- Positive: follow-ups about just-fetched data are answered from context;
  server-owned history has one source for tool results; payload size is
  bounded (≤ 8 000 trace characters across the window, ~2.5k tokens as a
  character-to-token estimate) and visible in `logTurnUsage` as
  `traceChars`. Token counts and cached vs fresh billing depend on the
  actual prompt and must be measured.
- Negative: input tokens rise for every turn in the window whether or not
  the follow-up needs the trace; the budget in rule 3 is the mitigation.
  Full-trace → digest conversion, the sliding eight-message window, and
  the uncached turn-context addendum (including the clock) change prompt
  prefixes. Anthropic caching matches prefixes, so these changes can miss
  the cache even within the TTL. A breakpoint is not a cache-hit
  guarantee. The harness ([SHO-412](https://linear.app/showzy-v2/issue/SHO-412))
  must report the measured delta in the T4 PR; if cache savings do not
  appear, say so — bounded context may still justify the change.
- Guard tests: `model_trace` never appears in the client conversation view;
  `getModelHistory` is not on oRPC and not an AI tool; oversized trace is
  rejected by the CHECK.
- `docs/module-ownership.md` gets a one-line amendment for `assistant` in
  the T4 PR. No other module may add a prompt-state column without its own
  ADR; this decision is scoped to `assistant_tool_runs`.
