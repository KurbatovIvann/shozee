# Spec: packages/core

> Status: Active. Approved by: owner, 2026-08-18.
> Active surface: entire file.
> Ledger catch-up: first merged `packages/core` implementation (fnd-T8…T28).
> Written against blueprint §2.1, §4, §7; ADR-0008, ADR-0009, ADR-0011,
> ADR-0012, ADR-0013, ADR-0014, ADR-0015, ADR-0016, ADR-0018, ADR-0020,
> ADR-0021, and ADR-0022.
> This is a foundation spec: it defines executable protocols, not a domain
> module. It owns no domain tables; the foundation tables it drives
> (`domain_events`, `event_aggregate_sequences`, `event_deliveries`,
> `idempotency_keys`, `audit_log`)
> are specified in `docs/specs/db.md` and are off-limits to module tasks.

## 1. Purpose

`packages/core` provides the client-safe `defineActionContract` leaf export
and the server-only `implementAction` runtime/registry (ADR-0016),
principal contexts, permission evaluation, the execution pipeline
(validation → authorization → idempotency → transaction → outbox → audit),
`ctx.call`, declared `ctx.callAtomic`, `ctx.emit`, the event bus with consumer registration, the
confirmation protocol for `requiresConfirmation` actions, typed errors, rate
limiting, and the module test kit every module inherits. It explicitly does
NOT own: HTTP transport (apps/api + packages/contract), queues for execution
jobs (BullMQ in apps/worker), any domain logic, any domain tables.

## 2. The action contract

One logical action is a client-safe descriptor paired with exactly one server
implementation. Serializable rows below belong to `defineActionContract`;
callback rows (`resolveTarget`, confirmation/audit callbacks, `handler`) are
bound by `implementAction`. All fields are required unless noted:

| Field | Type / values | Notes |
| --- | --- | --- |
| `name` | `<module>.<verb>` | Unique in the registry; CI fails on duplicates |
| `description` | string | Written as an instruction to an AI model |
| `principal` | `staff` \| `customer` \| `public` \| `system` \| `consumer` \| `account` \| `share` | ADR-0013, ADR-0018, ADR-0020, ADR-0022; exactly one; public and consumer actions are read-only; share may write |
| `transport` | `client` \| `internal` | Whether HTTP/client routers mount it; `system` must be internal; `consumer`, `account`, and `share` must be `client` |
| `input` / `output` | Zod v4 schemas | The single source for oRPC, forms, AI tools |
| `permissions` | `string[]` of `<module>:<verb>` | Non-empty for `staff`; must be `[]` for `customer`/`public`/`consumer`/`account`/`share` (authorization = ownership/visibility/published-read/own-user/valid token, §4); must be `[]` for `system` |
| `publicScope` | `target` \| `globalProjection`, **public only** | `target` is one published company/resource; `globalProjection` is an ADR-0020 published discovery projection. Share does not use this field |
| `projectionGrant` | grant ID, conditional | Required only for `publicScope: globalProjection`; must match a grant declared by the projection owner; forbids `resolveTarget` |
| `resolveTarget` | typed fn, **customer/public-target/share** | `<TTarget>(input, { tx, principal }) => Promise<{ companyId, resource: TTarget, tokenHash?: string }>` — customer args include authenticated `userId`; share and public-target have no `userId`; a nested `ctx.call` also supplies the already verified `inheritedCompanyId`. Loads the referenced resource and proves ownership/visibility/valid token; throws `NotFoundError` (never "forbidden" — no existence leaks). Missing, expired, revoked, or mismatched share tokens are `NotFoundError`. Share resolvers MUST return `tokenHash` (the stored hash from the token row, never the raw secret) — it is the idempotency principal key |
| `systemScope` | `tenant` \| `global`, **system only** | Tenant-scoped system actions require `ctx.companyId`; `global` is reserved for genuinely global jobs |
| `aiExposure` | `exposed` \| `internal` | `exposed` requires `transport: client`; `internal` never becomes an AI tool |
| `risk` | `read` \| `draft` \| `write` \| `high` | `read` handlers/resolvers receive a `ReadTx` capability; top-level reads also use a DB read-only transaction |
| `requiresConfirmation` | boolean | Required for human-invoked `risk: high` (staff, customer, account — not share); triggers the confirmation protocol (§7) |
| `confirmationSummary` | server fn, conditional | Required when `requiresConfirmation: true`; returns a redacted, human-readable summary from validated input + resolved target |
| `idempotent` | boolean | Write actions with `true` participate in the idempotency protocol (§5) |
| `emits` | `string[]` event names | Declared outbox events; `ctx.emit` of an undeclared event throws; CI checks declared events have a definition |
| `atomicCalls` / `atomicCallers` | action-name arrays | ADR-0021 allowlist edges; empty unless this action is a root caller/internal atomic callee |
| `audit` | boolean | §8. Mandatory `true` for `risk: write`/`high` |
| `auditTarget` | server fn, conditional | Required when `audit: true`; derives `{ type, id }` from validated input/output/context |
| `auditSnapshot` | optional server fn | Returns explicitly redacted safe JSON; hash-only is the default. **Required** on `share` writes (redacted certificate identity; never the raw token) |
| `timeout` | ms | Whole-pipeline deadline, shared with nested `ctx.call`s; DB statement timeout and abort signal enforce it |
| `rateLimit` | optional `{ limit, windowSec, scope }` | Defaults per principal (§10) |
| `handler` | `(input, ctx) => Promise<TOutput>` | Runs inside the transaction; `ctx` is the `ActionCtx` arm matching the contract's declared `principal` literal (`implementAction` threads it — a staff handler sees `companyId` without a principal guard). Output is Zod-validated before commit and must be JSON-safe |

The **contract check** (CI, phase-0 task) walks the registry and fails on:
missing/empty metadata, duplicate names, invalid transport/principal/AI
combinations, `customer`/`public`/`share` actions with permissions, customer,
public-target, or share actions without `resolveTarget`, public-global actions
with a resolver or missing/unknown `projectionGrant`, public-global actions
that do not satisfy the strict public metadata/access rules below, `consumer`
actions with `resolveTarget`, `consumer` actions not satisfying
(`risk: read`, `permissions: []`, `audit: false`, `idempotent: false`,
`requiresConfirmation: false`, `emits: []`, `transport: client`), `account`
actions with `resolveTarget`, `account` actions with non-empty `permissions`,
`account` actions with `transport` other than `client`, `share` actions not
satisfying the share subset below (`transport: client`, `aiExposure: internal`,
`permissions: []`, typed `resolveTarget`, `requiresConfirmation: false`,
`risk` not `draft`/`high`, writes with `idempotent: true` + `audit: true` +
`auditSnapshot`), invalid `systemScope`, invalid confirmation metadata
(`requiresConfirmation` implies human principal — staff, customer, account —
+ `risk: high` + `idempotent: true`), `emits` naming violations
(`<module>.<pastVerb>`), undeclared event definitions, `ctx.call` targets
that are not `risk: read` or do not accept the caller's principal, undeclared
or invalid `ctx.callAtomic` edges (ADR-0021),
event scope inconsistent with action/system scope, `risk: write|high` with
`audit: false`, `audit: true` without `auditTarget`, event subscriptions not
bound to a compatible internal idempotent system action. The same CI phase
validates the schema-ownership
manifest: every foreign schema import by `search`/`analytics` must match a
read-model grant declared in the owning spec (ADR-0015).

Public actions are a strict subset: `risk: read`, `permissions: []`,
`audit: false`, `idempotent: false`, `requiresConfirmation: false`,
`emits: []`, and `transport: client`. `publicScope: target` requires a typed
resolver. `publicScope: globalProjection` forbids a resolver and may query
only the named published projection grant; it cannot use `ctx.call`.
`actor.type: anonymous` exists only for access logs/traces; event and audit
schemas accept accountable user/system actors only.

Consumer actions are a strict subset: `risk: read`, `audit: false`,
`idempotent: false`, `requiresConfirmation: false`, `emits: []`,
`permissions: []`, `transport: client`, and no `resolveTarget`. Unlike public,
consumer requires authentication (`actor.type: user`) and rate-limits per user
rather than per IP.

Account actions: `permissions: []`, `transport: client`, and no
`resolveTarget`. Unlike consumer, account actions may have `risk: write` (or
`read`/`draft`), `audit: true`, `emits` (e.g. `companies.created`),
`idempotent: true`, and `requiresConfirmation: true` — subject to the same
metadata rules as staff writes. Authorization is own-user identity: the
handler may read/write only resources belonging to `ctx.userId` (no company
RBAC applies). Account requires authentication (`actor.type: user`).

Share actions (ADR-0022): no session; `permissions: []`; `transport: client`;
`aiExposure: internal`; typed `resolveTarget` always (there is no global
share form; `publicScope` is forbidden). `requiresConfirmation: false`.
`risk` is `read` or `write` only (`draft` and `high` are forbidden — legal
intent is on-device QES; staff/AI supplier signing remains `high` +
confirmation). Writes: `idempotent: true`, `audit: true`, `auditSnapshot`
required (redacted certificate identity: CN, org, tax id, role — never the
raw token), `emits` allowed. Reads follow ordinary read rules. Access logs
and traces use `actor.type: anonymous`. Durable audit rows and domain events
use `actorType: system` and `actorId: "share"` so they fit the
`user|system` CHECKs. The raw capability token never appears in logs, audit,
or events. Expired, revoked, or mismatched tokens are `NotFoundError`.

## 3. Principal contexts (ADR-0013, ADR-0018, ADR-0020, ADR-0022)

Discriminated union `ActionCtx`, common fields first. `implementAction`
threads the contract's `principal` literal into the handler
(`ActionCtxFor`), so a staff action receives `StaffCtx` and a customer
action receives `CustomerCtx`. The seven-arm union is the vocabulary the
factories construct, not what every handler must accept. Inner
discriminants the contract does not pin remain unions: `public` is
`target | globalProjection`, `system` is `tenant | global`. Runtime
construction is unchanged: exactly one factory per mode, and
`executeAction` still selects the factory from the invocation principal.

```ts
type BaseCtx<TDb extends ReadTx = Tx> = {
  db: TDb;                // ReadTx for read actions, Tx otherwise
  requestId: string;
  correlationId: string;  // propagated across ctx.call and events
  actor:
    | { type: "user"; id: string }
    | { type: "system"; id: string }
    | { type: "anonymous"; id: "anonymous" };
  channel: "ui" | "ai" | "system" | "webhook";
  clientIp?: string;       // trusted-proxy normalized; rate-limit use only
  aiTraceId?: string;
  toolCallId?: string;
  deadline: number;
  signal: AbortSignal;     // shared with nested calls/external clients
  log: Logger;            // pino child bound to request/actor/company/action
  emit: (event: DomainEvent) => void;   // outbox insert, same tx (§6)
  call: <A>(action: A, input: In<A>) => Promise<Out<A>>; // ADR-0015 (§9)
  callAtomic: TDb extends Tx
    ? <A extends AtomicTarget>(action: A, input: In<A>) => Promise<Out<A>>
    : never; // ADR-0021 (§9)
};

type StaffCtx<TDb extends ReadTx = Tx> = BaseCtx<TDb> & {
  principal: "staff"; userId: string; companyId: string;
  membership: { role: Role; permissions: string[] };
};
type CustomerCtx<TTarget, TDb extends ReadTx = Tx> = BaseCtx<TDb> & {
  principal: "customer"; userId: string;
  target: { companyId: string; resource: TTarget };
};
type PublicTargetCtx<TTarget> = BaseCtx<ReadTx> & {
  principal: "public"; scope: "target"; clientIp: string;
  target: { companyId: string; resource: TTarget };
};
type PublicGlobalCtx<TGrant extends string> =
  BaseCtx<ProjectionReadTx<TGrant>> & {
    principal: "public"; scope: "globalProjection"; clientIp: string;
    projectionGrant: TGrant; companyId?: never; target?: never;
  };
type PublicCtx<TTarget, TGrant extends string> =
  | PublicTargetCtx<TTarget>
  | PublicGlobalCtx<TGrant>;
type SystemCtx<TDb extends ReadTx = Tx> = BaseCtx<TDb> & {
  principal: "system"; serviceName: string;
} & (
  | { scope: "tenant"; companyId: string }
  | { scope: "global"; companyId?: never }
);
type ConsumerCtx = BaseCtx<ReadTx> & {
  principal: "consumer";
  userId: string;
  clientIp: string;
  companyId?: never;
  target?: never;
  membership?: never;
};
type AccountCtx<TDb extends ReadTx = Tx> = BaseCtx<TDb> & {
  principal: "account";
  userId: string;
  clientIp: string;
  companyId?: never;
  target?: never;
  membership?: never;
};
type ShareCtx<TTarget, TDb extends ReadTx = Tx> = BaseCtx<TDb> & {
  principal: "share";
  clientIp: string;
  target: { companyId: string; resource: TTarget };
  tokenHash: string; // stored hash from the resolved token row; never the raw secret
  userId?: never;
  membership?: never;
};
```

Construction — exactly one factory per mode, nothing ad-hoc:

- **staff**: better-auth session → `userId`; the transport supplies an active
  company selector (`x-company-id`, contract.md §3), and the factory loads a
  verified `company_members` row. The selector is never authority. Missing
  selector or membership → `PermissionDeniedError`. Phase-0 integration
  depends on the approved minimal companies/membership/RBAC schema slice in
  db.md; core does not own those tables.
- **customer**: better-auth session → `userId`; the action's typed
  `resolveTarget` runs in the execution transaction; the returned resource
  is the proof of ownership/visibility.
- **public**: no session required. `publicScope: target` runs the typed
  resolver proving one company/resource is published.
  `publicScope: globalProjection` skips target resolution and binds the
  context to its declared published projection grant. The API factory supplies
  a trusted-proxy-normalized `clientIp`; all public actions are read-only and
  unaudited.
- **system**: constructed only via `createSystemContext(serviceName, scope)`
  by workers/webhook handlers/outbox consumers. `actor_id` becomes
  `system:<serviceName>`. Scope is set explicitly by the enqueuing code —
  a system context is never "all companies" unless the job genuinely is
  (e.g. Nova Poshta dictionary sync).
- **consumer**: better-auth session → `userId`; the API factory supplies
  a trusted-proxy-normalized `clientIp` for per-user rate limiting. No
  company selector is read or expected; no membership or target resolver
  runs. `actor.type` is always `user`. Consumer actions receive a `ReadTx`
  and may access only declared global discovery projections and published
  facts; owning specs and inherited tests enforce this boundary.
- **account**: better-auth session → `userId`; the API factory supplies
  a trusted-proxy-normalized `clientIp` for per-user rate limiting. No
  company selector is read or expected; no membership or target resolver
  runs. `actor.type` is always `user`. Unlike consumer, account actions
  may receive a writable `Tx` (for `risk: write`/`draft`) or a `ReadTx`
  (for `risk: read`). The handler may read/write only own-user resources
  (e.g. own companies, personal profile); owning specs and inherited tests
  enforce this boundary.
- **share**: no session. The action's typed `resolveTarget` runs over the
  hashed capability token in the execution transaction (and in preflight when
  idempotency will store a row); the returned resource is the proof of
  access, and the returned `tokenHash` (stored hash, never the raw secret) is
  bound on `ShareCtx` as the idempotency principal key. The API factory
  supplies a trusted-proxy-normalized `clientIp`.
  Log `actor.type` is `anonymous`. Share writes receive a writable `Tx`;
  share reads receive a `ReadTx`. Raw tokens never enter log bindings.

Core exposes one `effectiveCompanyId(ctx)` helper used by logging, events,
audit, and operational metadata: staff/system-tenant use `ctx.companyId`;
customer/public-target/share use `ctx.target.companyId`; public-global,
consumer, account, and global system work return null.
Pre-authorization access logs may have no company, but the authorized action
span and every domain event/audit row carry this resolved scope (null for
public-global, consumer, and account; public/consumer never emit events or
write audit; account may do both with null company; share emits and audits
with the resolved company while the access-log actor stays `anonymous`). AI
calls keep the initiating user as `actor` and set `channel: "ai"` plus
trace/tool IDs.

## 4. Execution pipeline

Fixed order, no per-action variation:

1. **Validate input** (Zod). Fail → `ValidationError` (no side effects).
2. **Authenticate principal and read transport selectors** (session/service
   credentials; no authorization is inferred from a selector). Consumer and
   account actions require a valid session; public (both scopes), share,
   consumer, and account actions skip the company selector entirely. Public
   and share require no session.
3. **Rate limit** (§10). Fail → `RateLimitError`.
4. **Authorization preflight** in a short read-only transaction when the
   action needs confirmation or idempotency: verify staff membership or run
   the typed customer/public-target/share `resolveTarget`. Public-global and
   consumer actions skip this step (no company scope, resolver,
   confirmation, or idempotency). Account
   actions that declare confirmation or idempotency run a preflight that
   verifies only session validity (no membership/target to check); the
   own-user authorization boundary is enforced within the handler. Share
   writes are always idempotent, so they always run `resolveTarget` here —
   the stored token hash is known before the idempotency reservation. This
   prevents unauthorized challenges/idempotency rows but is never the only
   authorization check.
5. **Replay probe + confirmation gate** (`requiresConfirmation` actions,
   §7): a completed idempotency record replays before checking the
   single-use challenge; otherwise validate/consume the challenge.
6. **Idempotency reserve** (idempotent writes, §5) after confirmation.
7. **Open execution transaction** (read-only for `risk: read`); re-run
   membership/target authorization in this transaction to prevent TOCTOU
   (public-global, consumer, and account actions have no target; share
   re-runs `resolveTarget` like public-target). Bind a
   public-global handler to its declared projection-only DB capability, set
   the transaction-local DB statement timeout, then run the handler with the
   remaining deadline/abort signal.
8. **Validate output** with the declared Zod schema before any commit; a
   mismatch is `CoreInvariantError` (server bug), never a client validation
   error.
9. Inside the same transaction: outbox inserts from `ctx.emit`, successful
   audit record (§8), idempotency finalize (§5).
10. **Commit**. Failures roll back handler/outbox/audit/finalization, then
    record the failed audit outcome and mark the idempotency key `failed` in
    a separate short transaction.

The pipeline emits one structured **start** log line with `request_id`,
`action`, and `channel` (identity is unknown before authentication) and one
**finish** log line that adds `actor` (`actor_type` / `actor_id`),
`company_id` (null for public-global, consumer, account, and global
system), `outcome`, and `duration_ms`, plus an OTel span; errors go to
Sentry with the same correlation fields as the finish line.

`risk: draft` is still a mutation: it receives a writable transaction and
must declare idempotency/audit according to its spec. It is not callable
through cross-module `ctx.call`, which accepts `risk: read` only.

## 5. Idempotency protocol

Applies to actions declaring `idempotent: true` with `risk` ≠ `read`
(read actions are naturally idempotent — no key, no storage).

- **Key source**: callers supply `idempotencyKey` (oRPC meta/header from
  clients; the AI loop uses its tool-call id; workers use the job id;
  webhook handlers use the provider's delivery/event id). The client SDK
  helper generates one UUID per logical submit and retains it for retries.
  The server cannot infer a logical button press: a missing key on an
  idempotent mutation is a `ValidationError`, never silently generated.
- **Scope**: unique on
  `(principal key, scope key, action name, idempotency key)`, where
  principal key includes mode + accountable identity
  (`staff:<userId>`, `customer:<userId>`, `account:<userId>`,
  `system:<serviceName>`, or `share:<tokenHash>`). For share, `tokenHash` is
  the stored hash from the resolved token row, never the raw secret; reserve
  runs after preflight so the hash is known.
  Scope key is `company:<effectiveCompanyId>` for every tenant-scoped action
  (including share),
  `user:<userId>` for `account` actions (own-user scope), and `global` only
  for a declared global system action. Both actor and scope are required:
  omitting actor lets one staff member replay another's result; omitting
  scope lets a system service collide across companies or an account action
  collide across users.
- **Request hash**: SHA-256 over RFC 8785 canonical JSON of the JSON-safe
  validated input plus principal key and scope key.
- **States**: `in_progress` → `completed` | `failed`.
- **Flow**: (a) INSERT `in_progress` + request hash in its own short tx —
  unique violation means: existing `completed` + same hash → **replay the
  stored response** (no handler run); `completed` + different hash →
  `IdempotencyConflictError`; `in_progress` → `ConcurrentRetryError`
  (retry-after); `failed` or an expired in-progress lease → conditional
  takeover with a new `attemptId`, so only one caller wins. The takeover
  UPDATE re-checks status and lease/retention eligibility against the
  current row (still keyed on the observed `attemptId`); a lost race
  reloads and returns replay, conflict, or retry rather than flipping a
  completed attempt back to `in_progress`. The lease is the
  action timeout plus a bounded safety margin; long handlers renew it.
  (b) Handler tx
  runs; the key row is updated to `completed` with a response snapshot
  **inside the handler tx** — the Zod-validated, JSON-safe response snapshot
  and effects commit atomically. Idempotent action outputs must not contain
  expiring credentials or signed URLs. (c) On error: mark `failed` (separate
  tx).
- **Confirmed retries**: for `requiresConfirmation` actions, a read-only
  idempotency probe runs before challenge validation. `completed` replays the
  result and an active `in_progress` returns `ConcurrentRetryError`. When a
  challenge is consumed, its ID/confirmation time/expiry are persisted with
  the reservation. A failed/stale attempt may reuse that persisted grant only
  while it is unexpired and all request bindings match; otherwise it needs a
  new challenge. This survives a crash after reservation without making the
  raw challenge token reusable.
- **Retention**: keys expire after 48h (`expires_at`, cleaned by a worker
  job); replay after expiry re-executes — callers must not rely on replay
  beyond the retry window.

## 6. Domain events

Envelope (stored in `domain_events`, spec'd in db.md):

```ts
{ eventId: uuid,            // UUIDv7 (time-ordered), generated in ctx.emit
  name: "orders.confirmed", // <module>.<pastVerb> (conventions)
  version: 1,               // payload schema version; bump on breaking change
  occurredAt, companyId,     // UUID; null for declared global system events and account-principal events; share events carry the resolved target company
  aggregate: { type: "order", id, sequence }, // monotonic per aggregate
  actor: { type: "user" | "system", id,
           channel: "ui" | "ai" | "system" | "webhook" },
  requestId, correlationId,
  causationId,              // eventId or requestId that caused this event
  payload }                 // Zod-validated against the event definition
```

- **Definitions**:
  `defineEvent({ name, version, scope: "tenant"|"global", payload })` in
  the emitting module's `events/`. `ctx.emit` validates payload and inserts
  into the outbox in the action's transaction (ADR-0012: claim via
  `FOR UPDATE SKIP LOCKED`; `apps/worker` LISTENs on channel
  `domain_events` and polls as fallback). Share-emitted tenant events carry
  the resolved target `companyId` and envelope actor
  `{ type: "system", id: "share", channel }` (HTTP invocations use
  `channel: "ui"`).
- **Subscriptions**:
  `defineEventHandler({ event, consumer, action })` binds an event to a
  consuming module action; it does not accept arbitrary DB logic.
  `consumer` is stable (`chat.order-card-updater`). One consumer id may
  bind multiple events; the duplicate key is `(consumer, event)`. The
  target action must be
  transport-internal, AI-internal, system-principal, write/idempotent, and
  accept the event envelope as input. Core invokes it with a system context
  scoped to the event's `companyId`; a null company is allowed only for an
  explicitly global event/action or an account-principal event.
- **Delivery**: at-least-once. The dispatcher materializes one
  `event_deliveries` row per registered consumer and marks the outbox event
  dispatched in the same transaction. **Consumer dedup** is mandatory:
  `(consumer, eventId)` is unique (the delivery PK and claim key).
  `findClaimableDeliveries` returns the outbox event name so the worker
  executor selects the matching `EventSubscription` by
  `(consumer, eventName)` without querying foundation tables.
  Discovery returns a bounded batch of due **aggregate heads**: a due
  delivery is eligible only when that consumer has no earlier
  non-processed delivery for the same aggregate, including dead and
  not-yet-due predecessors. Claim re-validates ordering, due time, and
  leases. Blocked successors therefore cannot fill the batch and starve
  independent aggregates. The dispatcher runs the bound system
  action through the normal action pipeline in the delivery transaction
  (special core entrypoint, not `ctx.call`); transition to `processed`,
  action effects, audit, and emitted events commit together. A redelivery is
  a no-op. For this entrypoint the unique delivery row is the idempotency
  reservation (key = event ID), so no second `idempotency_keys` row is used.
- **Ordering**: `ctx.emit` increments a foundation sequence row in the same
  transaction, giving every event a monotonic per-aggregate sequence. A
  consumer handles only its earliest non-processed delivery for that
  aggregate and holds a transaction-scoped `(consumer, aggregate)` advisory
  lock while applying effects. Nothing is guaranteed across aggregates.
  Handlers must still tolerate replays.
- **Failure**: `event_deliveries` tracks
  `pending|processing|processed|dead`, attempts, next attempt, claim owner,
  and last error. A claim lease lasts for the bound action's declared timeout
  plus a 30-second commit/clock-skew margin; an expired `processing` claim may
  be taken over by another worker. Failed attempts retry after 1s, 2s, 4s,
  and 8s; the fifth failure parks the delivery for that consumer and emits an
  alert log. Replay changes dead deliveries back to immediately due pending,
  resets the five-attempt budget, and is idempotent. The phase-0 admin command
  requires a consumer ID and optionally narrows to one event ID; it cannot
  replay every consumer globally. Other consumers of the same event are not
  blocked.
- **Retention**: processed outbox rows are kept (they are the audit-grade
  event history) and partitioned/archived post-MVP if volume demands.

## 7. Confirmation protocol (`requiresConfirmation`)

Two-step, single-use, channel-agnostic (same for UI and AI — ADR-0008):

1. Invocation **without** a confirmation token completes authorization
   preflight and stops: core uses the required `confirmationSummary` callback,
   issues `{ challengeId, actionName, inputHash, principalKey, companyId
   (null for account), idempotencyKey, expiresAt (5 min) }` (Redis), and
   returns
   `ConfirmationRequiredError` carrying only the redacted summary. The AI
   surfaces this as a confirmation card; the classic UI as a dialog.
2. Re-invocation with `{ challengeId }` + identical input (hash-checked)
   executes. A challenge is consumed atomically (single use), bound to the
   same principal, company, and idempotency key, and expires. Any mismatch →
   new challenge required. Core stores the consumed grant on the idempotency
   reservation; a completed result may replay and a stale execution may
   safely resume under that unexpired grant without reusing the raw token
   (§5).
3. QES signing remains client-side regardless: `documents.sign`'s server
   part only records the client-produced signature; the confirmation
   protocol cannot substitute for key possession.

Redis unavailability fails closed for confirmation: high-risk execution does
not proceed, even if ordinary authenticated read rate limits are fail-open.

## 8. Audit

For every action with `audit: true` (mandatory for `write`/`high`), one row
in `audit_log` written in the handler transaction (mutations) or in a
separate transaction after the read-only handler transaction commits
(`risk: read`):

`{ id, requestId, correlationId, action, actorType: user|system,
actorId, channel: ui|ai|system|webhook, aiTraceId?, toolCallId?, companyId, targetType,
targetId, inputHash, inputSnapshot?, outcome: ok|<errorCode>, durationMs, createdAt }`

AI trace/tool-call IDs provide attribution without storing prompts or model
content in the audit row. `inputHash` is always a SHA-256 hex digest of the
RFC 8785 canonical JSON form of the validated input. `inputSnapshot` is null
by default (hash-only); it is populated only when the action binds an
`auditSnapshot` callback, which must return explicitly redacted safe JSON.

- **Share writes (ADR-0022):** `actorType: "system"`, `actorId: "share"`,
  `companyId` from the resolved target. `auditSnapshot` is mandatory and
  holds the redacted certificate identity, never the raw token. Access logs
  still use actor `anonymous`. The `audit_log.actor_type` CHECK stays
  `user|system` (no db.md change).
- **Permission denials** on `audit: true` actions are also recorded
  (outcome `PERMISSION_DENIED`, separate tx since no handler tx exists).
- **Failures before successful input validation** write no audit row:
  there is no Zod-validated input to hash, and a malformed request is not
  an accountable action outcome. The hook skips when `input` is undefined.
- **No raw input by default** — only the hash. An action may opt in to a
  redacted input snapshot via `auditSnapshot: (input) => SafeJson`; storing
  unredacted input is forbidden (prohibitions: no PII/secrets in logs).
- **Handler-derived snapshot data:** `auditSnapshot` receives only the
  validated input, but some snapshots need data the handler computed (e.g.
  a certificate identity resolved during signing). The sanctioned pattern
  is a module-private `WeakMap` keyed by the validated `input` object: the
  pipeline passes the same object to the handler and to `auditSnapshot`,
  so the handler stashes the derived value and the snapshot callback reads
  it back — request-scoped by construction, no process-global state, and
  concurrent executions cannot collide (first used by `doc-signing`
  `complete`). A typed core accessor may replace this if a third module
  needs it.
- **Audited reads** run in a database read-only transaction to preserve
  the `risk: read` write-prevention guarantee; the audit row is written in a
  separate short transaction after the read-only transaction commits. This is
  a best-effort record: if the post-commit write fails, the read result is
  already returned — audit failures are logged but never mask the response.
- Read access: no UI in MVP; queryable by operators via SQL. Retention:
  12 months online, then export/archive or delete according to the operations
  policy. Audit rows are not an event store.

## 9. Cross-module calls (ADR-0015, ADR-0021)

### `ctx.call`

- Callable targets: another module's `risk: "read"` actions only (runtime
  assert + CI check), and the callee must support the caller's principal
  mode. Same-module composition uses `services/`, not `call`.
- Consumer callers may only invoke other `consumer`-principal `risk: read`
  actions; company-scoped callees (`staff`, `customer`, `public`,
  system-tenant) are rejected at both CI and runtime because the consumer
  context carries no `companyId` to propagate.
- Account callers may invoke `consumer`-principal `risk: read` actions
  (global discovery reads) and other `account`-principal `risk: read`
  actions; company-scoped callees (`staff`, `customer`, `public`,
  system-tenant) are rejected at both CI and runtime because the account
  context carries no `companyId` to propagate.
- Public-global callers cannot use `ctx.call`; their read capability is
  limited to the action's own declared projection grant.
- Share callers may only invoke other `share`-principal `risk: read` actions;
  `staff` / `customer` / `public` / `consumer` / `account` / system-tenant
  callees are rejected at both CI and runtime. Cross-module document facts
  for a share page are a `share`-principal read on the owning module, not a
  call into `public`.
- The callee runs in the caller's transaction and principal context but sees
  only a `ReadTx` facade even when the caller's transaction is writable; the
  callee's own `permissions`/`resolveTarget` still execute (defense in
  depth). For customer/public-target/share calls, the resolver receives the
  caller's verified `inheritedCompanyId` and must return the same company; a
  mismatch is `CoreInvariantError`. Timeout budget is shared; audit gets a
  child entry only if the callee itself declares `audit: true` (rare for
  reads); logs/spans always nest via `correlationId`.
- Depth limit 3, cycle detection by action name — exceeding either is a
  `CoreInvariantError` (a bug, not a user error).

### `ctx.callAtomic`

- Available only to writable root actions with `idempotent: true`.
- Both descriptors must declare the edge: caller `atomicCalls` contains the
  callee name and callee `atomicCallers` contains the caller name.
- Callee must be `transport: internal`, `risk: write`,
  `requiresConfirmation: false`, and principal-compatible with the caller.
- Callee receives the root physical transaction and writable `Tx`; its own
  permissions/target resolver, validation, output validation, audit, events,
  and remaining timeout execute normally.
- The callee may access only its module-owned schema, may use read-only
  `ctx.call`, and may not invoke `ctx.callAtomic`, create/commit/roll back a
  transaction, or own an independent idempotency reservation.
- Only one atomic edge is allowed below the root. Undeclared edges, principal
  or tenant mismatch, nesting, cycles, and transaction escape are
  `CoreInvariantError`.

## 10. Rate limiting

Redis token bucket per `(action, rate-limit scope key)`. Defaults: `public`
and `share` 30/min per rotating HMAC of trusted-proxy-normalized IP;
`consumer` 60/min per user; `account` 90/min per user; `customer`/`staff`
120/min per user; `system` unlimited. Raw IP
remains transport-only and is never the Redis key or a domain log/audit
field. Per-action override via `rateLimit` (including on system actions).
AI tool invocations additionally consume a per-conversation budget (defined
in the phase-5 spec; core only exposes the hook). Exceeded →
`RateLimitError` with `retryAfterSec`. Redis failure is fail-closed for
public actions, **every share action** (reads and writes), and every
mutation (`draft`/`write`/`high`) and fail-open
with an error log for ordinary authenticated reads (`risk: read` on
staff/customer/consumer/account). System actions default to fail-open
(workers must not stall on Redis); an owning spec may declare a `rateLimit`
override for the bucket, but store-failure policy stays fail-open unless a
future spec rework adds a per-contract failure-mode flag.

## 11. Typed errors

`packages/core/errors` — the only error vocabulary for domain code:

`ValidationError` (Zod issues) · `PermissionDeniedError` · `NotFoundError` ·
`ConflictError` (domain state conflicts, e.g. status transition) ·
`IdempotencyConflictError` · `ConcurrentRetryError` ·
`ConfirmationRequiredError` (carries challenge) · `RateLimitError` ·
`TimeoutError` · `CoreInvariantError` (bugs: tenant leak, call cycle —
alerts, never shown to users).

Each has a stable `code` for the contract layer (HTTP/oRPC mapping in
contract.md) and a client-safe message; internal details stay in logs.

## 12. Module test kit

Exported from `packages/core/testing`, used by every module (this is how
"every module inherits the invariant tests" becomes real):

- `buildTestContext(mode, overrides)` — context factories for all seven
  principal modes against the Testcontainers DB (harness in db.md).
- `crossTenantSuite(actions)` — parameterized by each action's declared
  principal: staff of company A vs data of B; customer X vs resources of Y;
  public-target vs non-public resources; public-global/consumer vs
  unpublished or non-allowlisted fields; system tenant scoped to A
  touching B; system-global jobs succeed in the only scope they have
  (they do not deny a "foreign" tenant — isolation is that a locked row's
  derived keys do not mutate another company's objects, proven in the
  module tests); account user A vs user B's companies/personal data; or
  share token A vs document/resource of token B. Every module
  instantiates the relevant case for each action — omission fails the
  contract check.
- `publicProjectionSuite(actions)` — for `publicScope: globalProjection`:
  unpublished rows hidden, response field allowlist, no CRM/domain side
  effects, no resolver/cross-module call, anonymous logging, and IP-HMAC rate
  limit.
- `consumerIsolationSuite(actions)` — for `consumer`-principal actions:
  unpublished entities are hidden, no CRM side effects, no company-private
  data leakage.
- `accountIsolationSuite(actions)` — for `account`-principal actions: user A
  cannot see or modify user B's companies or personal data; no company-scoped
  resource access; `permissions` must be `[]`; `companyId` is null in context
  and events/audit.
- `shareIsolationSuite(actions)` — for `share`-principal actions: token A
  cannot read or write token B's resource; expired, revoked, and mismatched
  tokens are `NotFoundError`; co-sign (and any other share write) MUST NOT
  create CRM rows; raw token is absent from logs/audit/events.
- `idempotencySuite(action)` — replay, conflict, concurrent-retry cases.
- `eventSuite(module)` — declared events emitted transactionally (rollback
  removes them), consumer dedup respected.
- `atomicCallSuite(edge)` — declared edge succeeds in one transaction;
  rollback removes root/callee effects and events; undeclared, tenant/principal
  mismatch, and nested atomic calls fail.
- `runSocialDesiredStateCase(action)` — desired-state social writes
  (follow/like): retry and concurrent same-state writes do not duplicate
  counters; the opposite state reverses. Exported as a `run*` helper
  (modules copy the pattern); it is not a `suiteCoverage` registrar.

Composition supplies a `suiteCoverage` manifest to the contract check.
Every registered action must appear in `isolation` (and in
`publicProjection` / `consumerIsolation` / `accountIsolation` /
`shareIsolation` when those
suites apply). Every idempotent mutation that is not an event-consumer
binding must appear in `idempotency`. Every module that emits or
subscribes must appear in `events`. Every mutually declared atomic edge
must appear in `atomic`. Omission — or listing an action in a suite that
does not apply — fails the check.

## 13. Acceptance criteria

- [ ] Contract check fails on every §2 violation (test per rule), including
      both public-scope variants (resolver/grant mismatch, mutation metadata,
      projection escape), atomic-call graph violations,
      consumer-specific constraints (resolver present, non-read risk, audit,
      events, permissions, or non-client transport on a `consumer` action),
      account-specific constraints (resolver present, non-empty
      permissions, or non-client transport on an `account` action), and
      share-specific constraints (missing resolver, non-client transport,
      `aiExposure: exposed`, `risk: draft`/`high`, `requiresConfirmation`,
      write without `idempotent`/`audit`/`auditSnapshot`, or non-empty
      permissions on a `share` action).
- [ ] All seven context factories work; no other construction path exists.
- [ ] Pipeline order is §4 exactly; a failing handler rolls back outbox and
      audit rows written in the same tx.
- [ ] Output schema mismatch rolls back and maps to internal error.
- [ ] `risk: read` actions cannot compile against mutation methods and a
      top-level runtime write attempt fails in the DB read-only transaction.
- [ ] Idempotency: replay returns the stored response without re-running
      the handler; same-key/different-payload → conflict; concurrent
      double-submit runs the handler exactly once; a crashed/stale lease can
      be taken over by exactly one retry (race tests); a completed attempt
      cannot be reclaimed from a stale expired-lease snapshot.
- [ ] Events: emit is transactional; redelivery is a consumer no-op;
      per-aggregate ordering holds under concurrent dispatch; a dead event
      for consumer A does not block consumer B.
- [ ] Core exposes dispatcher/consumer libraries only; process loops,
      polling, retries, and shutdown run in `apps/worker`.
- [ ] Confirmation: challenge is single-use, principal-bound, hash-bound,
      company/idempotency-bound, expiring; execution without a valid
      challenge is impossible.
- [ ] Audit rows written for `audit: true` incl. permission denials after
      input validation; failures before a successful Zod parse write no
      row. AI calls retain the initiating user as actor and `channel: ai`.
- [ ] `ctx.call`: write target rejected; permissions of callee enforced;
      tx shared (callee sees caller's uncommitted writes); consumer caller
      invoking a company-scoped callee is rejected.
- [ ] `ctx.callAtomic`: only mutually declared principal-compatible internal
      write edges execute; root/callee writes, audit, and events commit or
      roll back together; nested atomic calls are rejected.
- [ ] Cross-tenant suite passes for the reference slices in all modes.
- [ ] Consumer isolation suite: unpublished entities hidden, no CRM record
      created, no company-private data returned, rate limit at 60/min per
      user.
- [ ] Public projection suite: no session required; unpublished and
      non-allowlisted fields hidden; no CRM/domain side effects; null company
      log scope; rate limit at 30/min per IP-HMAC key.
- [ ] Account isolation suite: user A cannot see/modify user B's companies
      or personal data; `companyId` is null in context, events, and audit;
      `permissions` enforced as `[]`; rate limit at 90/min per user.
- [ ] `ctx.call` from account: consumer reads accepted, company-scoped
      callees rejected.
- [ ] Share isolation suite: token A cannot read/write token B's resource;
      expired/revoked/mismatch → `NotFoundError`; no CRM row; rate limit at
      30/min per IP-HMAC key; fail-closed on Redis failure; audit actor
      `system`/`share` on writes.
- [ ] `ctx.call` from share: only `share`-principal reads accepted;
      public/staff/customer/consumer/account/system-tenant callees rejected.

## 14. Resolved decisions

1. Audit input policy — **hash-only by default**, per-action opt-in
   redacted snapshot via `auditSnapshot` (owner, 2026-08-17).
2. Idempotency retention window — **48h** (owner, 2026-08-17).
3. Rate-limit store failure for system actions — **fail-open** (phase-0
   default, fnd-G1 A12). An owning spec may set a `rateLimit` override for
   the bucket; a per-contract fail-closed flag is not in the protocol.
4. Audit on pre-validation failure — **no row** (phase-0 default,
   fnd-G1 A12). There is no validated input to hash; a malformed request is
   not an accountable action outcome. Permission denials after validation
   remain recorded.
5. Share principal (ADR-0022, owner 2026-08-19) — seventh mode for
   unauthenticated capability-token writes. Access-log actor is `anonymous`;
   audit/event actor is `system`/`share`. Default rate limit 30/min IP-HMAC,
   fail-closed. `ctx.call` is share→share reads only. `draft`/`high` and
   confirmation are forbidden on share.

## Changelog

| Date | Change | Why | Reported by |
| --- | --- | --- | --- |
| 2026-09-05 | §2/§3: a handler's `ctx` is the `ActionCtx` arm matching the contract's declared `principal` (`ActionCtxFor`), not the seven-mode union; runtime construction unchanged | SHO-416: 109 handlers opened with a principal guard the pipeline made unreachable — it existed only to narrow a type | SHO-416 |
| 2026-09-05 | §6: `findClaimableDeliveries` selects due aggregate heads before LIMIT | SHO-435: blocked successors filled the bounded batch and starved independent deliveries | SHO-435 |
| 2026-09-05 | §5: takeover CAS re-checks status/lease/retention; a lost race reloads for replay/conflict/retry | SHO-434: stale expired `in_progress` read could reopen a concurrently completed attempt | SHO-434 |
| 2026-08-22 | §12: `crossTenantSuite` treats `system` + `systemScope: global` like public-global — invoke succeeds; foreign deny is not the isolation property | SHO-115 scheduled GC cannot discover leftovers if the suite requires a per-id 404 | SHO-115 |
| 2026-08-21 | §6: one consumer id may bind multiple events; `findClaimableDeliveries` returns the outbox event name so the worker executor looks up `(consumer, eventName)` | SHO-95: `Map(consumer → subscription)` dropped the second binding of `chat.order-card-updater` | SHO-95 |
| 2026-08-19 | `ShareCtx.tokenHash` and share `resolveTarget` return the stored hash | fnd-T11B: `share:<tokenHash>` is not representable without the hash on the context; the idempotency-key test proved the gap | scaffold (fnd-T11B) |
| 2026-08-19 | Seventh principal `share` (ADR-0022): `ShareCtx`, contract-check subset, pipeline/idempotency keys, audit/event actor mapping, 30/min IP-HMAC fail-closed, `shareIsolationSuite` | Unauthenticated capability-token writes for owner-first dual-sign without weakening `public` | owner via `/rework-spec core.md` |
| 2026-08-19 | Status: Active; Active surface: entire file | Ledger catch-up: first merged packages/core (fnd-T8…T28), not a new freeze decision | owner via spec-process-after-phase-0 |
| 2026-08-19 | §4: start log has no actor/company (identity unknown pre-auth); §8: no audit row before successful input validation; §10: system rate-limit store failure is fail-open; §12: `runSocialDesiredStateCase` | Align living spec with phase-0 pipeline (fnd-G1 A12) | scaffold (fnd-G1 A12) |
| 2026-08-18 | §6: named the outbox wakeup channel `domain_events` (LISTEN + polling fallback in `apps/worker`) | fnd-T27 implementation pinned the channel the trigger notifies | scaffold (fnd-T27) |
| 2026-08-18 | §12: `suiteCoverage` manifest on the contract check; `idempotencySuite` / `eventSuite` / `atomicCallSuite` are instantiated by every module | fnd-T22 makes omitted inherited suites a CI failure | scaffold (fnd-T22) |
| 2026-08-18 | §6: pinned delivery retry delays (1/2/4/8s), fifth-failure parking, action-timeout + 30s claim leases, and consumer-scoped replay semantics | fnd-T18 implementation proved the operational timing and replay-scope gaps | scaffold (fnd-T18) |
| 2026-08-18 | §8: added `inputSnapshot` nullable column, audited-read post-commit semantics, and RFC 8785 hash specification | fnd-T13 implementation proved the storage and read-only tx gaps | scaffold (fnd-T13) |
| 2026-08-17 | Added public-global projection protocol and declared same-transaction atomic capabilities | Rebaseline foundation for ADR-0020/0021 mobile parity | Human owner via mobile parity rework |
| 2026-08-17 | Added account principal: `AccountCtx`, contract check rules, `ctx.call` rules, rate limit (90/min), idempotency scope (`user:<userId>`), `accountIsolationSuite`, and acceptance criteria | Complete the 6-principal model per ADR-0013 (amended) and ADR-0018 | Human owner via spec-rework queue Step 1 |
| 2026-08-17 | Added the consumer context, action constraints, logging, call rules, rate limit (60/min per user), and inherited isolation tests | Align the frozen foundation with ADR-0018 authenticated discovery | Human owner via spec-rework queue |
| 2026-08-17 | Tightened target resolution, idempotency scope, event delivery, confirmation, audit, and output validation | Foundation consistency review against blueprint and ADR-0013/0015 | GPT-5.6 Sol |
| 2026-08-17 | Initial draft | — | spec agent (Fable 5) |
