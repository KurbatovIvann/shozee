# @showzy/core — Agent Instructions

The action runtime (core.md). **Frozen for module tasks** (prohibitions.mdc):
module implementation tasks may not change anything here — if core is missing
something, stop and report.

## Current state (fnd-T22)

Four export subpaths exist:

- `@showzy/core/contract` — the client-safe leaf (fnd-T8, below).
- `@showzy/core/errors` — the ten core.md §11 error classes.
- `@showzy/core` (root, server-only) — `implementAction` + `ActionRegistry`
  (fnd-T9), the registry-walking contract check (fnd-T10) including the
  `suiteCoverage` manifest (fnd-T22), the seven principal context factories
  plus `effectiveCompanyId` / `staffHasPermission` /
  `resolveEffectivePermissions` (fnd-T11 / fnd-T11B; SHO-438 re-export),
  the execution
  pipeline `executeAction` (fnd-T12), the audit protocol `createAuditHook`
  and `canonicalJson`/`canonicalJsonSha256` (fnd-T13), rate limiting
  `createRateLimitHook` + `createInMemoryRateLimitStore` (fnd-T14), the
  idempotency protocol `createIdempotencyHook` +
  `cleanupExpiredIdempotencyKeys` (fnd-T15), domain events
  `defineEvent` + the pipeline-internal `ctx.emit` buffer (fnd-T16),
  and event delivery — `defineEventHandler` + `eventEnvelopeSchema`,
  the dispatcher library `dispatchOutboxBatch`, and the delivery
  entrypoint `executeDelivery` (fnd-T17), plus claim leases, exponential
  retry, dead-letter parking, and consumer-scoped admin replay (fnd-T18),
  cross-module reads — the pipeline-internal `ctx.call` (fnd-T19),
  declared same-transaction writes — `ctx.callAtomic` (fnd-T19A), and
  the confirmation protocol `createConfirmationHook` +
  `createInMemoryConfirmationStore` (fnd-T20).
- `@showzy/core/testing` — the module test kit (fnd-T21/T22):
  `createTestKit` / `buildTestContext` against the db harness, plus
  `crossTenantSuite`, `publicProjectionSuite`, `consumerIsolationSuite`,
  `accountIsolationSuite`, `shareIsolationSuite`, `idempotencySuite`,
  `eventSuite`, and `atomicCallSuite`. Module tasks instantiate the
  registrars; omitting a
  required suite fails the contract check. The next package is
  `packages/contract` (fnd-T23).

## Typed errors (`src/errors/`, core.md §11)

- Ten classes on the `CoreError` base; the only error vocabulary for
  domain code. Never `throw new Error("...")` in handlers/services.
- `code` values are pinned to the contract.md §4 wire table by a test —
  renaming one is a breaking client API change and goes through spec
  rework.
- `clientMessage` is the only free-text string the contract layer may
  serialize; `Error#message` is log-facing and carries `internalMessage`
  diagnostics (IDs, tenant scope) that must never reach a client.
  `CoreInvariantError` takes an internal description only — its client
  message is a fixed generic string.

## Runtime (`src/runtime/`, ADR-0016)

- `implement-action.ts` — `implementAction(contract, callbacks)` validates
  at implement time that exactly the callbacks the metadata implies are
  bound (`resolveTarget` iff customer/public-target/share, `confirmationSummary`
  iff `requiresConfirmation`, `auditTarget` iff `audit: true`, required
  `auditSnapshot` on share writes), throws `ActionImplementationError` listing all problems,
  freezes and brands the pair. The handler's `ctx` is
  `ActionCtxFor<contract.principal>` (SHO-416). The handler is a method so
  a narrowed implementation stays assignable to the pipeline/registry's
  three-argument `ImplementedAction` (full union), and its `ctx` is wrapped
  in `NoInfer` so an explicit annotation cannot widen `TPrincipal` back to a
  union — neither is decoration, see the comment there. SHO-453 replaces
  both with a property plus an explicit erased shape.
- `action-registry.ts` — `ActionRegistry` with duplicate detection on both
  contracts and implementations; `assertPaired()` is the boot gate: orphan
  descriptors, orphan implementations, and same-name-different-object
  drift (a redefined descriptor) all fail before anything serves traffic.
- `types.ts` — callback shapes. Return types are spec commitments;
  `ActionHandler` is keyed on the contract `principal` literal (SHO-416);
  `ActionExecutionCtx` (= `ActionCtx`) and `TargetResolutionEnv`
  (`{ tx: ReadTx, principal, inheritedCompanyId? }`) were narrowed by
  fnd-T11; `AuditTargetEnv` was narrowed by fnd-T13 to
  `{ input, output?, ctx? }`; `ConfirmationSummaryEnv` was narrowed by
  fnd-T20 to `{ companyId, target? }`.

## Principal contexts (`src/runtime/context/`, core.md §3)

- `types.ts` — the seven-mode `ActionCtx` discriminated union, plus
  `ActionCtxFor<principal>` for the handler-facing arm. The DB slot
  is the capability the action's `risk` allows (`Tx`, `ReadTx`, or a
  grant-bound `ProjectionReadTx`); `emit` is the typed buffered emitter
  (fnd-T16, below); `call` is the typed cross-module read invoker
  (fnd-T19, below); `callAtomic` is the typed same-transaction write
  invoker (fnd-T19A);
  `deadline`/`signal`/`emit`/`call` values are supplied by the pipeline
  (fnd-T12) through `ContextRuntime`.
- `factories.ts` — exactly one factory per mode, the only construction
  path (never assemble a context by hand): staff verifies the
  `x-company-id` selector against a `company_members` row (the selector is
  never authority; missing/foreign/nonexistent all deny with one message);
  customer/public-target/share run the typed resolver over a read-only facade
  and adopt its resolved company (share also binds `tokenHash` from the
  resolver); public-global binds the declared
  projection grant; system takes an explicit tenant/global scope from the
  enqueuing code; consumer/account require a session and carry no company
  scope at all. Factories bind the pino child logger
  (request/actor/company/action, snake_case — security-operations §6) and
  `effectiveCompanyId(ctx)` is the one resolved-scope helper.
- `permissions.ts` — precedence in one place: owner-all, deny wins,
  grant, role default (companies-foundation.md §2). Check permissions only
  through `staffHasPermission`; never read `membership.permissions`
  directly (it cannot represent owner-all).
- Integration tests live in `*.db.test.ts` files — the vitest `db` project
  boots the shared Testcontainers harness (`@showzy/db/testing`); plain
  `*.test.ts` files stay in the Docker-free `unit` project that the CI
  contract-check stage runs.

## The execution pipeline (`src/runtime/pipeline/`, core.md §4)

- `execute-action.ts` — `executeAction(deps, invocation)`, the one path
  every action runs through. The §4 step order is fixed and encoded once:
  validate input → authenticate/read selectors → rate limit →
  authorization preflight (short read-only tx, only when confirmation or
  idempotency will store something) → replay probe + confirmation gate
  (fnd-T20) → idempotency reserve → execution transaction (transaction-local statement timeout,
  TOCTOU re-authorization via the context factories, handler under the
  deadline/abort signal) → output validation before commit
  (`CoreInvariantError` on mismatch) → same-tx outbox flush (fnd-T16) +
  audit/finalize slots → commit. Failures roll back and record the
  outcome via separate-tx hooks.
  `risk: read` runs in a database read-only transaction **and** hands the
  handler the `ReadTx` facade — two independent walls.
- `types.ts` — the protocol hook slots (`PipelineHooks`) filled by
  fnd-T13 (audit), fnd-T14 (rate limit), fnd-T15 (idempotency), fnd-T20
  (confirmation), plus `ActionTelemetry`, the OTel/Sentry seam bound by
  the apps (fnd-T26/T28). Core stays dependency-free; the hooks receive
  every correlation field the log lines carry. Slots stay optional on the
  type so tests can compose subsets; execution fails closed with
  `CoreInvariantError` when a declared protocol has no hook. Apps
  compose the full set at boot.
- The pipeline is the only caller of the context factories and the only
  place transactions are opened (db.md §3). It emits one structured start
  log line (`request_id`, `action`, `channel`) and one finish line that
  adds actor, `company_id` (null for the null-company modes), `outcome`,
  and `duration_ms`. Identity is unknown at start (pre-authentication).
- Everything leaving the pipeline is a typed core error; a throw outside
  the §11 vocabulary is wrapped as `CoreInvariantError` (server bug).
- The `SET LOCAL statement_timeout` statement is the one approved raw-SQL
  primitive here (core.md §4; SET LOCAL takes no bind parameters).
- `ctx-call.ts` — `createCtxCall` (fnd-T19, core.md §9): synchronous
  cross-module reads. A handler passes another module's implemented
  `risk: "read"` action (from its `index.ts`) plus input; the callee runs
  in the caller's execution transaction behind a fresh `ReadTx` facade,
  under the caller's principal re-authorized through the normal context
  factories (staff permissions re-checked; customer/public-target
  resolvers re-run with the caller's verified `inheritedCompanyId` — a
  company mismatch is a `CoreInvariantError`; system tenant scope
  propagates), with callee input/output validated like a transport
  invocation. The target rules are asserted from the same list the
  contract check proves in CI (`contract-check/call-rules.ts`) — runtime
  and CI cannot drift. Depth limit 3, cycle detection by action name,
  shared deadline/abort budget, correlation-nested log lines
  (`nested call started/finished` with `caller_action`) and one child
  span per nested call. An audited read callee gets its child audit entry
  via the §8 audited-read rule (separate short tx, best-effort). The
  pipeline boxes the execution transaction/context, so a context escaping
  its handler carries a `call` that refuses to run.

## Audit protocol (`src/runtime/audit/`, core.md §8)

- `canonical-json.ts` — RFC 8785 canonical JSON serialization and SHA-256
  hashing. Deterministic key ordering, ES `Number.toString` formatting,
  rejection of non-JSON values. Exported for reuse by fnd-T15 (idempotency
  `requestHash`).
- `create-audit-hook.ts` — `createAuditHook({ db, logger })` returns the
  `AuditHook` the pipeline consumes. `recordSuccess` inserts the audit row
  using the transaction it receives (handler tx for mutations, a post-commit
  tx for audited reads). `recordFailure` opens its own short transaction;
  a failing `auditTarget` callback there is logged at error level and the
  row falls back to a synthetic target.
  `inputHash` is always the canonical-JSON SHA-256 of the validated input;
  `inputSnapshot` is populated only when the action binds `auditSnapshot`.
  Failures before successful input validation write no row (`input` is
  undefined).
- **Audited reads**: the handler transaction is database read-only, so the
  pipeline writes the success audit row in a separate post-commit
  transaction. Best-effort: a post-commit write failure is logged but never
  masks the read result (core.md §8).
- The `AuditTargetEnv` type (narrowed from the fnd-T9 opaque alias) gives
  `auditTarget` callbacks `{ input, output?, ctx? }` — output/ctx are absent
  on failure/denial paths.

## Rate limiting (`src/runtime/rate-limit/`, core.md §10)

- `token-bucket.ts` — the `RateLimitStore` seam (atomic `consume` of one
  token per `(action, scope key)` bucket) and the in-memory reference
  token bucket. The production store is Redis, mounted by the apps in
  fnd-T26; the bucket math must run atomically there (Lua), and the
  in-memory implementation is the behavioral contract it must match.
- `create-rate-limit-hook.ts` — `createRateLimitHook({ store,
ipHmacSecret, logger, now? })` fills the pipeline's `rateLimit` slot.
  Principal defaults live in the exported `rateLimitDefaults` constant
  (public 30/min per rotating IP HMAC, consumer 60, account 90,
  customer/staff 120 per user; system unlimited); values change only via
  spec rework. Per-action `rateLimit` overrides are honored, including on
  system actions.
- Scope-key rules: `user` needs an authenticated mode; `ipHmac` needs the
  transport's trusted-proxy `clientIp`; `company` is enforceable this
  early only from a system invocation's tenant scope — the only company
  identifier that is _trusted_ at the rate-limit step. A staff selector is
  unverified here (keying buckets off it would let a caller mint fresh
  buckets by rotating selectors), so `scope: "company"` on any non-system
  mode is a metadata bug (`CoreInvariantError`); staff company budgets
  need post-authorization enforcement, added when an action first needs
  it.
- The raw IP is never a bucket key or log field: public keys use an
  HMAC-SHA256 whose input includes a rotation-window index
  (`IP_HMAC_ROTATION_MS`, 24 h), so keys rotate and are not linkable to an
  address.
- Store failure splits by action class: fail-open + error log for
  ordinary authenticated reads (`risk: read`, staff/customer/consumer/
  account) and for system actions (hardcoded; an owning spec may set a
  `rateLimit` override for the bucket, but store-failure stays fail-open);
  fail-closed (`RateLimitError`, retry after the window) for public
  actions and every mutation.

## Idempotency protocol (`src/runtime/idempotency/`, core.md §5)

- `create-idempotency-hook.ts` — `createIdempotencyHook({ db, now? })`
  fills the pipeline's `idempotency` slot. Rows are unique on
  `(principal key, scope key, action, key)`; the request hash covers the
  validated input **plus** principal and scope keys, so a hash match always
  implies the same accountable identity.
- `reserve` runs in its own short transaction (single statements): fresh
  INSERT `in_progress` → execute; `completed` + same hash → replay the
  stored snapshot; any different hash → `IdempotencyConflictError` (§5
  names `completed`, but a divergent payload on a live/failed row is the
  same caller bug and taking it over would corrupt the record); live lease
  → `ConcurrentRetryError` (+ retry-after); `failed`/expired lease/passed
  retention → conditional takeover CAS'd on the observed `attempt_id`
  **and** current status/lease/retention eligibility, so concurrent
  retries produce exactly one winner and a stale snapshot cannot reopen a
  completed row. A lost CAS reloads and returns replay, conflict, or
  `ConcurrentRetryError`.
- The lease is `contract.timeout + IDEMPOTENCY_LEASE_MARGIN_MS`. The
  pipeline deadline bounds every handler, so no mid-flight renewal exists;
  if `finalize` finds its attempt superseded it throws to roll the whole
  handler transaction back (never double-execute).
- `finalize` (inside the handler tx) stores the Zod-validated response
  snapshot with `completed`; `markFailed` flips to `failed` in its own
  statement after rollback. A missing key is a `ValidationError` — the key
  is transport meta (`PipelineHookRequestMeta`), never action input and
  never generated server-side.
- `cleanupExpiredIdempotencyKeys(db)` deletes rows past the 48-h retention
  (`IDEMPOTENCY_RETENTION_MS`); the worker loop schedules it (fnd-T27).
  Replay after expiry re-executes by design.
- Confirmation-grant columns (`confirmation_*`) are written by
  `reserve` when the pipeline hands over a consumed/resumed grant
  (fnd-T20). `probe` is required on `IdempotencyHook` and is the
  read-only lookup the confirmation gate uses:
  `completed` replays, a live lease is `ConcurrentRetryError`, and a
  failed/stale row with an unexpired grant resumes. Takeover preserves
  an existing grant except when reusing a row whose retention passed,
  which resets the slot entirely (then applies a newly consumed grant
  if one was supplied).

## Confirmation protocol (`src/runtime/confirmation/`, core.md §7)

- `store.ts` — the `ConfirmationStore` seam (`set` + atomic
  `getAndDelete`) and the in-memory reference store. The production store
  is Redis, mounted by the apps in fnd-T26; it must implement `GETDEL`.
  A store that cannot decide throws — the hook fails closed.
- `create-confirmation-hook.ts` — `createConfirmationHook({ store, now? })`
  fills the pipeline's `confirmation` slot. First invocation (no
  `confirmationChallengeId` meta) calls `confirmationSummary`, stores a
  5-minute challenge (`CONFIRMATION_TTL_MS`) bound to action / input hash /
  principal / company (null for account) / idempotency key, and throws
  `ConfirmationRequiredError` carrying only the redacted summary. The
  challenge id is transport meta (contract.md §3), never action input.
- Re-invocation consumes the challenge atomically. Bindings are checked
  after consume so a mismatched token is burned. Any mismatch or expiry
  issues a fresh challenge. The consumed grant is returned so
  `idempotency.reserve` can persist it.
- The pipeline probes idempotency **before** the gate (core.md §5
  "Confirmed retries"): a completed row replays without touching the
  token; a failed/stale row with an unexpired persisted grant resumes
  without making the raw token reusable. A missing confirmation hook on
  a `requiresConfirmation` action is a composition bug
  (`CoreInvariantError`) — high-risk execution cannot proceed.
- Store failure fails closed (`CoreInvariantError`, 500 + alert):
  high-risk work does not execute when Redis is down, even though
  ordinary authenticated read rate limits are fail-open.

## Domain events (`src/runtime/events/`, core.md §6)

- `define-event.ts` — `defineEvent({ name, version, scope, payload })`
  validates the declaration (`<module>.<pastVerb>` name, positive-integer
  version, `tenant`/`global` scope, Zod payload), throws
  `EventDefinitionError` listing all problems, freezes and brands the
  result. Modules declare events in `events/` files with this factory;
  the branded `EventDefinition` is what `ctx.emit` accepts.
- `emit.ts` — `createEmitBuffer` (pipeline-internal, not exported from
  the package root). `ctx.emit(definition, { aggregate, payload })` is
  **synchronous**: it validates at the call (event declared in the
  contract's `emits`, payload against the event schema, aggregate id is
  a UUID, action is not `risk: read`) and buffers the emission with its
  UUIDv7 `eventId` and `occurredAt`. The pipeline flushes the buffer in
  §4 step 9 inside the execution transaction: per-aggregate sequence
  upsert (row-lock serialized, strictly monotonic) + one outbox row per
  emission, so events commit or roll back atomically with the handler's
  effects. Every violation is a `CoreInvariantError` — the emitting
  module owns both definition and handler, so a bad emission is a server
  bug, never client input.
- Envelope scope: tenant events carry the verified `effectiveCompanyId`
  (flush throws without one); global events carry null by definition.
  `causationId` comes from `PipelineRequestMeta` (defaults to
  `requestId` at the edge; the fnd-T17 delivery entrypoint sets the
  delivered event's id).
- `uuidv7.ts` — RFC 9562 UUIDv7 (48-bit timestamp + random tail),
  implemented locally because Node's `randomUUID()` is v4-only and new
  dependencies need approval. Time-ordered across milliseconds; strict
  ordering is the per-aggregate sequence's job, not the ID's.
- `envelope.ts` — the JSON-safe `EventEnvelope` delivered as consumer
  input (`occurredAt` ISO string, `aggregate.sequence` decimal string —
  the audit protocol canonical-JSON-hashes the validated input, so
  `Date`/`bigint` are structurally excluded) and `eventEnvelopeSchema`,
  the builder every consumer action uses as its input schema.
- `define-event-handler.ts` — `defineEventHandler({ event, consumer,
action })` binds one event to one consuming action under a stable
  `<module>.<kebab-name>` consumer id; define-time validation (system
  principal, transport/AI internal, write + idempotent, `systemScope`
  matching the event scope) throws `EventHandlerDefinitionError` listing
  all problems. `eventSubscriptionRefs` maps subscriptions to the
  structural refs the contract check walks.
- `delivery.ts` — the fnd-T17/T18 delivery core. `dispatchOutboxBatch`
  claims undispatched outbox rows (`FOR UPDATE SKIP LOCKED`, expressed
  natively by Drizzle), fans out one `event_deliveries` row per
  registered consumer (`ON CONFLICT DO NOTHING` on the
  `(consumer, eventId)` PK) and marks the rows dispatched in the same
  tx; consumer-less events are still marked dispatched. `executeDelivery`
  takes a short owner claim, rejects not-yet-due/live-claimed/dead rows,
  reclaims claims older than the action timeout + 30 seconds, and enforces
  per-aggregate ordering (earliest
  non-processed delivery + the transaction-scoped `(consumer, aggregate)`
  advisory lock — the one approved raw-SQL primitive here, db.md §7 /
  ADR-0012), builds the envelope, and runs the bound action through the
  normal pipeline **inside** the delivery transaction: the pipeline's
  execution tx nests as a savepoint (`ActionTransactionRunner` in
  `pipeline/types.ts` is the seam), and the idempotency slot is replaced
  by the delivery-row reservation — `processed` commits atomically with
  the consumer's effects. Failure rolls everything back, then records
  1/2/4/8-second retry due times; failure five parks only that consumer's
  row as `dead` and emits one alert log. A lost claim (another worker
  took the lease) returns `deferred` and never overwrites the new owner. Deliveries run
  with a system context scoped by the event's stored `companyId`;
  `causationId` is the delivered event's id and each attempt gets a
  fresh `requestId`. `findClaimableDeliveries` is the bounded discovery read of due
  aggregate heads (no earlier non-processed predecessor for that
  consumer+aggregate) used by the worker loop and includes the outbox
  event name so the executor can select among multiple events bound to
  one consumer id;
  ownership remains authoritative in
  `executeDelivery`, so concurrent workers may safely discover the same row.
- `replay-dead-deliveries.ts` resets matching dead rows to immediately due
  pending rows with a fresh five-attempt budget. The operation is
  idempotent and always consumer-scoped; `replay-dead-deliveries.cli.ts`
  parses the admin command (`--consumer` required, `--event-id` optional)
  without reading env or constructing process dependencies inside core.

## The contract check (`src/contract-check/`, core.md §2)

The CI gate is layered — all three layers run in the `contract-check` CI
stage (`pnpm --filter @showzy/api contract:check`):

1. **Define time** — `defineActionContract` throws on every single-descriptor
   rule when the stage imports a module barrel.
2. **Implement/registration time** — `implementAction` (conditional
   callbacks), `ActionRegistry` (duplicates, `assertPaired`).
3. **Registry-wide** — `runContractCheck(input)` aggregates every violation
   that needs the whole registry plus the manifests: unknown projection
   grants, event definition existence/duplicates, emitter/event scope
   consistency (account and global-system emitters declare `scope: "global"`
   events — their envelopes carry a null company), subscription binding
   rules (system/internal/AI-internal/write/idempotent + scope match),
   declared `ctx.call` edge rules (cross-module, `risk: read`,
   principal-compatible, no public-global on either side — the per-target
   list lives in `call-rules.ts` and is shared verbatim with the fnd-T19
   runtime assert), atomic-edge
   mutuality/compatibility (ADR-0021), the ADR-0015 schema-ownership
   manifest (foreign schema imports need an owner-declared read-model grant
   to `search`/`analytics`), and inherited-suite coverage (core.md §12:
   every registered action and declared atomic edge must appear in
   `suiteCoverage`).

The composition root is `apps/api/src/composition.ts`
(`createActionRegistry` and `buildContractCheckInput`). Module tasks
register actions, events, subscriptions, call edges, schema-ownership
rows, and `suiteCoverage` (`@showzy/<module>/suite-coverage`) there —
never in this package. `defineEvent` outputs satisfy `EventDefinitionRef`,
`eventSubscriptionRefs` (fnd-T17) produces `EventSubscriptionRef` entries.
The input shapes are structural on purpose so module barrels satisfy them
without core changes. `runContractCheck` stays here as a library.

## Module test kit (`src/testing/`, core.md §12)

- `@showzy/core/testing` is the only import path. `createTestKit` seeds the
  parity fixtures (db.md §8) plus matching `user` / `companies` /
  `company_members` rows so staff and system-tenant factories share ids
  with the discovery tables. `kit.buildTestContext(mode, overrides)` is
  the seven-mode factory wrapper — it still goes through the real context
  factories, never hand-rolled objects.
- Isolation suites (`crossTenantSuite`, `publicProjectionSuite`,
  `consumerIsolationSuite`, `accountIsolationSuite`, `shareIsolationSuite`)
  and protocol suites
  (`idempotencySuite`, `eventSuite`, `atomicCallSuite`) take `getKit` and
  register vitest tests. `crossTenantSuite` does not require a foreign deny
  for `system` + `systemScope: global` (the job has no other tenant).
  `run*Case` is the same assertion without
  registration, so a leaky fixture action can be proven to fail the
  suite. Module tasks instantiate the registrars; omitting a required
  suite fails the contract check (`suiteCoverage` on
  `ContractCheckInput`, fnd-T22). `runSocialDesiredStateCase` is a `run*`
  helper for desired-state social writes (core.md §12); it is not a
  `suiteCoverage` registrar.
- Self-tests live in `kit.db.test.ts` (isolation) and
  `protocol-suites.db.test.ts` (idempotency/events/atomic, social
  desired-state, audit fields, projection ownership) and use per-mode
  fixture actions that are **not** part of the public testing export.

## The `contract` subpath (ADR-0016)

- `src/contract/types.ts` — serializable metadata types (core.md §2):
  principal/transport/risk unions, `publicScope`, `projectionGrant`,
  `systemScope`, `atomicCalls`/`atomicCallers`, rate-limit override, and the
  `ActionContractDefinition`/`ActionContract` shapes. Server callbacks
  (`handler`, `resolveTarget`, `confirmationSummary`, `auditTarget`,
  `auditSnapshot`) are deliberately absent — `implementAction` (fnd-T9)
  binds them server-side.
- `src/contract/define-action-contract.ts` — `defineActionContract`:
  validates every rule checkable from one descriptor in isolation, throws
  `ActionContractDefinitionError` listing **all** violations, freezes and
  brands the result. Registry-wide rules (duplicate names, event
  definitions, mutual atomic edges, grant existence) belong to the contract
  check (fnd-T10) — do not duplicate them here.
- The input type is deliberately permissive about cross-field combinations;
  runtime define-time validation is the authority. This keeps rejection
  paths testable without `@ts-expect-error` and produces precise messages
  instead of opaque compile errors.

## Client-safety rules

- The `contract` export graph may import **only Zod** (and, later, shared
  validation schemas). No core runtime, `packages/db`, Node builtins,
  logging, Redis, or workers — the CI bundle probe (fnd-T25) fails on leaks.
- The package `tsconfig.json` carries `"types": ["node"]` for the
  server-only runtime; `tsconfig.contract.json` re-checks `src/contract`
  with `"types": []` in the same `typecheck` script, so an accidental
  `process`/`Buffer` reference in the leaf is still a compile error.
- Every better place for server-only concerns exists: put nothing in
  `contract` that a mobile bundle must not ship.
