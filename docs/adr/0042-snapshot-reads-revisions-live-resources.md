# ADR-0042: Snapshot reads, aggregate revisions, and live resources

- **Status**: Accepted
- **Date**: 2026-09-13
- **Deciders**: Ivan Kurbatov (human) (+ proposing agent)

## Context

- **No read spans one state.** Core opens every execution transaction with only
  an access mode (`execute-action.ts:671`), so Postgres runs READ COMMITTED.
  The assistant window is assembled from separate reads
  (`assistant-window.ts:19-22`, `create-kit.ts:414-424`): a message page in its
  own `executeAction`, then the pause from Redis, with the active turn in yet
  another.
- **No server state carries an order a client can use.**
  - Per-row counters exist only on `assistant_chat_messages` (a compare-and-set)
    and `order_cards` (bumped per event, returned by an action no client calls).
  - Catalog, customer and price-list writes overwrite: last write wins.
  - `domain_events.aggregate_sequence` orders events, not state.
- **The assistant client reconstructs the missing order, and every review finds
  a hole.** SHO-579, SHO-616 and PR #460 are fixes of one defect class. The
  client orders `turn` and `openPause` from signals that disagree:
  `finishedTurns`, message revisions, `closedPauses`, `windowsApplied`.
  - `AGENTS.md`: a second fix of one class means the decision is wrong.
  - The decision was "no window version, because the pause lives in Redis"
    (SHO-579). Its premise fails: the pause is a kit port with a Redis adapter.
- **Clients learn about change only by asking.**
  - Outside the assistant nothing is pushed.
  - The document form fetches PDF status once and gives up
    (`use-document-form-handover.ts:90-96`).
  - The assistant's event channel is the only push path, and it is
    assistant-shaped.
- **What Postgres and the stack give.**
  - A transactional NOTIFY is delivered at commit, in commit order, never on
    rollback.
  - READ ONLY REPEATABLE READ cannot fail with a serialisation error.
  - `ctx.call` runs on the caller's transaction (`ctx-call.ts:178-181`).
  - oRPC 1.15 streams event iterators over SSE.
- **Three review rounds** (PR #462) settled the design. This ADR states the
  decisions and their **invariants**. Mechanics (defaults, intervals, frame
  rules, per-consumer plans) go to `docs/specs/live.md`, written with the first
  implementing feature.

## Decision

1. **Snapshot reads.** A `risk: "read"` action may declare
   `consistency: "snapshot"`, and core then runs it `READ ONLY, ISOLATION LEVEL
   REPEATABLE READ`. The default is unchanged. State that must appear in a
   snapshot lives in Postgres.
2. **Aggregate revisions.** An aggregate a client orders or observes carries a
   `revision` on its root row. It is bumped through `@showzy/module-kit` and
   returned by every read of the aggregate. Optimistic concurrency
   (`expectedRevision` → `ConflictError`) is opt-in per write contract. A
   machine-readable stale reason is left to the first form that needs it.
3. **Live resources** (`@showzy/live`, platform package).
   - **Declaring.** A resource is a `(kind, key)` owned by one module and
     declared with:
     - its root table and key column;
     - a snapshot action;
     - an **absent-root policy**: `revisionZero` or `notFound`.
   - **Hints.** A trigger primitive, `notify_live`, publishes identity-only
     hints at commit. The API holds one `LISTEN` and forwards hints to
     authorised SSE streams, one per key.
   - **Content** is always read through ordinary actions: the snapshot action,
     or an optional **changes action** (`sinceRevision`).
   - **Ephemeral frames** (uncommitted output such as tokens or typing) are
     **reserved, not built**: best-effort, never state.
   - **Collections** ("a new order arrived", transaction feeds) are out of
     scope and get their own ADR.
4. **First consumers.**
   - **The assistant conversation.** The pause moves to an assistant-owned
     table, the kit reads the window through one snapshot port, and
     `assistant.readChatWindow` is the snapshot. The client's freshness
     heuristics are deleted.
   - **PDF generation status** (`document_generation_jobs`, owned by
     `doc-generation`), chosen because the whole state lives in one module.
     Order cards and documents were rejected: their state spans modules.

### Invariants

Each invariant names the test that proves it.

**Snapshots and revisions.**
- **L1 One snapshot.** Every statement of a snapshot action, including
  `ctx.call` reads, sees one committed state. Write actions cannot declare it.
  *Core test with a racing writer; contract check.*
- **L2 One bump per transaction, monotonic, commit-ordered.**
  - Every transaction that changes an observable aggregate raises its revision
    exactly once: the INSERT that creates the root counts as the bump.
  - Revisions never decrease, and keys are never reused.
  - A transaction bumps every root it will change before writing any of them,
    in a fixed order. When a root is discovered late, a deadlock abort and
    retry is the accepted fallback.
  *Per consumer: each write action, create path included, bumps once.*
- **L3 Granularity.** Bulk work bumps per chunk, never per row. Writers that are
  independent in the domain never share a root. *Per consumer: a load test of
  concurrent independent writers shows no serialisation on the root.*

**Hints.**
- **L4 Hints carry identity, never content.** The notify payload is
  `{kind, key, companyId, revision}`. The key is a uuid, and a live root has a
  non-null company. The wire hint is `{revision}`, `gone` or `resync`, and
  `companyId` never leaves the server. *Payload shape test per consumer.*
- **L5 No commit is missed.**
  - A stream registers for hints before reading its snapshot.
  - A stream forwards only revisions above the last forwarded, coalesced with
    a trailing flush of the latest.
  - While `LISTEN` is down, and when it reconnects, every registered stream
    receives `resync`.
  *Live package tests.*
- **L6 Tenant isolation.** A hint or frame reaches a subscriber only when its
  company equals the subscriber's verified scope. Channels and filters derive
  from the stream's verified company and key, never from subscribe input.
  *Inherited cross-tenant suite.*

**Authorisation.**
- **L7 Authorised at open and continuously.**
  - A stream opens by running the snapshot action.
  - Within a bounded interval, whose maximum `live.md` declares, the transport
    re-resolves the session, share token or customer target, and core re-runs
    the action's authorisation for the (kind, key) the stream opened with.
  - Any failure closes the stream.
  *Per consumer: a revoked session, membership or token closes the stream
  within the declared maximum.*
- **L8 The authorise-only path is not a general oracle.**
  - It lives on a core subpath that ESLint lets only `@showzy/live` import.
  - It accepts only registered live snapshot actions, for the key a stream
    opened with, and logs denials.
  *ESLint + core test.*
- **L9 An absent root never grants a subscription.**
  - `revisionZero` is allowed only when the snapshot's authorisation never
    reads the root row. `customer` and `share` resources must be `notFound`.
  - A stream at revision 0 queues hints behind a re-run of the snapshot action,
    takes the revision that re-run returns, and closes if it is denied.
  *Contract check for `customer`/`share` ⇒ `notFound`; review of the
  root-row criterion; per consumer: another author's absent conversation
  cannot be subscribed.*
- **L10 Principals and stream resources are bounded.**
  - Only `staff`, `customer` and `share` resources can be live; `public`,
    `consumer` and `account` cannot.
  - Streams are capped per user, and per share token and client IP. Opening a
    stream consumes the principal's rate tier.
  - Capability tokens never travel in a URL.
  *Contract check for principals; live package tests.*

**Clients and content.**
- **L11 One client rule.** The client:
  - takes a snapshot only if its revision is greater than the one held;
  - re-reads when a hint's revision is greater;
  - treats `gone`, a `NOT_FOUND` snapshot, or revision 0 while holding a
    positive revision as gone.
  No feature keeps freshness logic of its own. *`@showzy/live/client` tests.*
- **L12 Changes actions are complete.** A changes action is a snapshot read. It
  answers `full` whenever `sinceRevision` is below the retained history floor,
  so a purged deletion is never missed. *Per resource that adds one.*
- **L13 Frames never outrank state** (when built). Frames:
  - flow only on an authorised stream, on a channel derived as in L6, pass the
    same revision-0 gate, and stop when the stream closes;
  - are buffered only within a declared bound;
  - never change state, bump a revision or persist;
  - are discarded on `gone`, denial, or a newer snapshot.
  *Built with the first consumer.*
- **L14 Secrets stay server-side.** A pause's `secret` is stored apart from its
  public shape, is never selected into any action output, is cleared when the
  pause resolves or expires, and never outlives the confirmation challenge.
  Snapshot actions scope by verified company. *Assistant and doc-generation
  tests.*

## Alternatives considered

- **Keep per-field client heuristics.** Rejected: repeated fixes of one defect
  class, and each new transition needs a new signal.
- **A seqlock inside a module read.** Rejected: it approximates REPEATABLE READ
  with a retry loop that can run out.
- **One SQL statement per window.** Rejected: raw SQL per consumer, and it does
  not compose with `ctx.call`.
- **Hints published from code or an after-commit hook to Redis.** Rejected: a
  crash between commit and publish loses the hint silently, which was the
  SHO-616 review scenario.
- **Hints through the outbox.** Rejected: delivery rows and polling latency for
  what is a hint.
- **Deltas in the stream.** Rejected for committed state:
  - a lost delta corrupts a client, so the stream would need a replay log;
  - deltas cannot be coalesced;
  - each would need authorisation;
  - a returning mobile client would replay a backlog.
  Changes actions give the bandwidth saving; frames cover uncommitted output.
- **Socket.IO.** Rejected for one-way hints (ADR-0039). Two-way chat may add a
  socket under the same resource contract.
- **Sync engines (ElectricSQL, Zero, PowerSync).** Rejected: rows reach clients
  outside `executeAction` and code-level permissions.
- **Order cards or documents as the second consumer.** Rejected: their state
  spans modules. A revision on the `orders` root was deferred by the owner
  (2026-09-13).
- **Mechanics in this ADR.** Rejected after three review rounds: defaults,
  intervals and per-consumer plans belong in a spec that tests can prove wrong.

## Consequences

**Amended and superseded.**
- **ADR-0038:** the pause is stored in Postgres; the kit reads the window
  through one snapshot port; the dead `turn:` lease is deleted.
- **ADR-0039:** the assistant event channel becomes a live resource; presence
  and stream slots move to `@showzy/live`.
- **Blueprint:** the realtime row becomes "SSE live resources (ADR-0042)".
- **SHO-579:** "no window version" is superseded.
- **ADR-0041** is consistent: jobs add no notify load, and batches bump per
  chunk.

**Core** (approved by this ADR): `consistency` metadata and its transaction
option, the restricted authorise-only path, contract checks for L1 and L9, and
`core.md` §4 paragraphs.

**Database.**
- `notify_live` is approved raw SQL: `db.md` §5/§7, with
  `packages/db/AGENTS.md` naming it as the sanctioned second trigger pattern.
- `db.md` §5 states the revision convention.

**Spec.** `docs/specs/live.md` is written with the first implementing feature.
It holds:
- coalescing and heartbeat intervals, slot keys and limits;
- the stream protocol;
- the changes-action and history-floor shape;
- frame rules;
- each consumer's plan (for example, the PDF status action and where its
  not-found mapping moves from `documents.get`).

**Operations, recorded, not built** (`db.md` §6):
- LISTEN needs a session-mode or direct connection;
- a stalled listener fills the notify queue and fails notifying commits;
- a LISTEN reconnect causes a resync burst.

**Easier.** A new live screen is a snapshot action, bumps and a trigger.
Lost-update protection is one field.

**Harder.** A missed bump is a stale client. NOTIFY takes a commit-time lock.
Re-reads cost a snapshot per change until a changes action exists.

## Revisit when

- **Notify or heartbeat load** dominates after chunking and coalescing: a
  notify relay behind the same client rule.
- **Changes actions or frames prove insufficient** (ordered offline
  application): deltas with a replay log.
- **Live collections** are needed: a new ADR.
- **Two-way realtime** (customer chat): a socket under the resource contract.
- **Many keys per screen** exhaust slots: multiplex keys on one stream.
- **Snapshots must span services or replicas.**
- **Offline writes must merge across devices:** a sync-engine decision.
