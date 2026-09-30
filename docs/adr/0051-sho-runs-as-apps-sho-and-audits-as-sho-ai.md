# ADR-0051: Шо runs as `apps/sho`, and its audit channel is `sho-ai`

- **Status**: Proposed
- **Date**: 2026-09-30
- **Deciders**: Ivan Kurbatov (human) (+ proposing agent)

## Context

ADR-0049 puts Шо in front of every staff assistant message. This ADR says
where it runs and what it is given.

- `packages/sho` vendors the runtime and model with an md5-verified loader
  (SHO-731 f5d089a6: 478/478 v3 vectors, p50 9.5 / p95 22.9 ms; SHO-739
  ec9478b8: `system-one-uk` b1e2b4d D88–D92, model v3.3, 490/490 + 46/46,
  p50 8.2 ms). The runtime is ONNX on CPU; a parse is milliseconds, a context
  compile is not, and it blocks whatever thread it runs on.
- SHO-732 (spike PR #534, Testcontainers, 10k products × 4 variants, 5k
  customers): a full context read is **117 ms client / 8.7 ms server** — the
  ≤ 150 ms target met — for **6.06 MB** of JSON, of which `product_variants`
  is 5.0 MB and 81% of the read time. A `count(*) + max(updated_at)`
  fingerprint is **15.7 ms** over 6 round trips; `product_variants` alone is
  **11.1 ms** server against a ≤ 5 ms per-list target — **missed** — while the
  other five lists are ≤ 1.5 ms. Every plan is a Seq Scan; the
  `(company_id, updated_at, id)` index exists only on `company_customers` and
  `counterparties` and is never chosen. The fingerprint is O(tenant rows), not
  O(1). All 26 write kinds are visible through the shared `set_updated_at`
  trigger; the blind spots are an update in the same millisecond as the
  recorded max, and a delete+insert with a non-newer `updated_at`.
- At ~6 MB for 10k × 4 with UUID ids, the runtime's 8 MB context limit is
  reached near ~13k products × 4 variants.
- The audit/event channel is `"ui" | "ai" | "system" | "webhook"` in
  `packages/core/src/runtime/events/envelope.ts:78`,
  `packages/core/src/runtime/context/types.ts:21`, and the CHECKs in
  `packages/db/src/schema/foundation.ts:82,264` and
  `packages/db/src/schema/tenant-columns.ts`.
- SHO-733 finding 7: `packages/sho` is not type-importable from other
  packages (`.ts` specifiers).
- `onnxruntime-node` is approved. `@google-cloud/speech` (Chirp 3) is not.

## Decision

**Шо runs as its own Node service, `apps/sho`. It parses; it never decides.
`apps/api` keeps the database, the user, the threshold and the action.**

- **Process.** `apps/sho` holds a `worker_threads` pool; a worker owns the
  model and an LRU-by-bytes cache of compiled contexts. `apps/api` picks a
  replica by rendezvous hash of `companyId` over `SHO_URLS`; the service picks
  a worker by `hash(companyId) mod N`. The queue is bounded, and a task whose
  `deadlineMs` has passed is dropped. `packages/sho` is imported by `apps/sho`
  alone; a new `@showzy/sho-protocol` package holds the Zod schemas both sides
  share and closes SHO-733 finding 7.
- **Protocol.** Internal HTTP + JSON, `Authorization: Bearer
  ${SHO_SERVICE_TOKEN}`, no external port.

| endpoint | request | responses |
| --- | --- | --- |
| `GET /v1/model` | — | `{model:{id,md5,catalogue,labelsMd5,runtime}, actions, workers}`; the API checks `labelsMd5` against its own mapping table |
| `PUT /v1/contexts/{contextKey}` | `{fingerprint, context}`, gzip, ≤ 8 MB | 204 · 413 `context_limit` · 503 `busy` |
| `POST /v1/parse` | `{requestId, companyId, contextKey, fingerprint, text, now, previous?, deadlineMs, debug}` | 200 `{model, contextRevision, result, ms}` · 409 `context_required` · 400 `input` · 503 `busy` · 504 `deadline` |
| `GET /v1/contexts/{contextKey}/phrases?limit=1000` | — | customer, product and variant names, for speech hints |
| `GET /v1/health`, `GET /v1/ready` | — | `ready` only once the model is loaded and the workers are warm |

  - `contextKey = companyId:scopeHash`, where `scopeHash` is the set of lists
    the staff member may see. On 409 the API builds the context, `PUT`s it,
    and retries the parse **once**. A stale context is never parsed against.
  - `text` is raw, ≤ 400 characters. `now` is the company's local time.
    `previous` is held by the API in the conversation; the client never sends
    it.
  - An unknown action, need kind or reason never breaks the API's parse of the
    response — it falls through to the LLM — so the two deploy in any order.
    Every response carries `model.md5`.
  - Logs carry no command text. The headline metric is the share of turns
    without the LLM.
  - API tests run against a `FixtureShoEngine` over recorded responses; no
    model in CI.
- **Context.** `apps/api` builds the context from bulk id+name reads and sends
  it gzipped. Freshness is a `count(*) + max(updated_at)` fingerprint per list
  behind a short TTL — **not** recomputed per parse: SHO-732 measured it at
  O(tenant rows), 11.1 ms for `product_variants` against a 5 ms target, and a
  per-turn cost that grows with the tenant is the wrong shape at the front of
  every turn. The durable answer is an **O(1) per-company collection
  revision**, which is ADR-0042 extended to collections. This ADR does not
  build it; the TTL stands in until it is ticketed.
  - Above a variants cap the list is sent `partial` and the parse is
    best-effort; the 8 MB limit is reached near ~13k products × 4 variants.
  - The fingerprint's two blind spots are accepted: a stale name costs a
    fall-through or a card the person declines, never a wrong write
    (ADR-0050).
  - Two name matchers now exist — Шо's and `@showzy/module-kit`'s (SHO-529,
    SHO-530). An id from Шо is used only on a card showing the name a person
    approves; an unconfirmed reference goes to the server matcher as
    `{ by: "query" }` (ADR-0033).
- **Audit.** An action Шо closed carries channel `sho-ai`, distinct from `ai`,
  so "what did the small model do" is answerable without parsing a trace. That
  is a fifth value in the core channel enum and in the db CHECKs named in
  Context. **This is a `packages/core` and `packages/db` change: proposed
  here, not built.**
- **Dependencies.** `onnxruntime-node` is approved. `@google-cloud/speech`
  (Chirp 3) and a WebSocket adapter for Hono are **proposed** and need the
  owner's approval before a ticket adds them.

## Amendments to earlier ADRs

**ADR-0042, Decision §3, "Live resources".** "**Collections** ("a new order
arrived", transaction feeds) are out of scope and get their own ADR." — the
Шо context is the first concrete caller for a collection revision. This ADR
does not write that ADR; it records the requirement, ships a fingerprint TTL
in its place, and puts the numbers that make a per-tenant fingerprint the
wrong long-term shape in Context.

Nothing else is amended. ADR-0032's import boundary is untouched: `apps/sho`
mounts no model loop of the AI SDK and reaches no database.

## Alternatives considered

- **A worker pool inside `apps/api`.** Rejected: compiling a large context
  blocks the thread that does it, and inside the API that thread serves
  requests for other tenants. Every API replica would also carry the model's
  memory, and `packages/sho`'s vendored tree and md5 loader would enter the
  API's import graph.
- **On the device (React Native / Hermes).** Rejected: the context is the
  company's catalogue, and the phone would have to hold and refresh 6 MB of
  it. The runtime is portable, so this reopens if an offline requirement
  appears.
- **A per-parse fingerprint with no TTL.** Rejected on SHO-732: 15.7 ms over 6
  round trips, 11.1 ms for `product_variants` against a 5 ms target, every
  plan a Seq Scan, and the cost growing with the tenant.
- **Reuse channel `ai` for Шо.** Rejected: invariant 4 wants the invocation
  channel to say who acted. Merging them turns "how many writes did the small
  model make" into a trace-parsing question. The cost is one enum value, two
  CHECKs and a migration, paid once while no production database exists.
- **Jev / TypeSafe as the parser.** Rejected in ADR-0049: 82.9% top-1 on 31
  one-line options, and every phrase leaves the server.

## Consequences

- A new deployable. `apps/api` gains `SHO_URLS` and `SHO_SERVICE_TOKEN`
  through `packages/config`, and a turn now depends on a second process being
  ready — every failure of which is a fall-through to the LLM.
- A fifth audit channel is a core + db change with a migration. Readers of
  `channel` — audit, the event envelope, the `created_via` CHECK, and
  `packages/core/src/contract-check/record-provenance.ts` — all see it.
- `@showzy/sho-protocol` is a new package on both graphs.
- The collection-revision follow-up (ADR-0042) is now owed a ticket.
- Recorded, not built: replica count and capacity, deploy ordering between
  `apps/api` and `apps/sho`, model rollout and rollback, warm-up on deploy,
  and the cost ceiling of cloud speech recognition.

## Revisit when

- A collection revision lands and the fingerprint TTL can go.
- A real tenant reaches the 8 MB context limit.
- An offline requirement appears — the runtime is portable, so the device
  option reopens.
- Chirp 3 is integrated and a second recognizer can be compared on the same
  traffic.

## Open questions

1. Does `sho-ai` count in `countedCreatedVia` (today `ui` and `system`)?
2. Do we keep staff command text and audio to train Шо, and on what consent
   basis?
3. `@google-cloud/speech` and a Hono WebSocket adapter: approve now, or defer
   speech to a later feature?
4. Is the fingerprint TTL acceptable as the stand-in, and for how long before
   the collection revision is ticketed?
