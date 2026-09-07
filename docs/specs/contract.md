# Spec: packages/contract

> Status: Active. Approved by: owner, 2026-08-18.
> Active surface: entire file.
> Ledger catch-up: first merged `packages/contract` implementation (fnd-T23…T25).
> Written against blueprint §3, §4; ADR-0004, ADR-0008, ADR-0013, ADR-0016,
> ADR-0018, ADR-0020, ADR-0021, and ADR-0022.
> Foundation spec. Resolves the client-safety question: how one action
> definition feeds server, mobile, web, AI, and OpenAPI without leaking
> Node/DB dependencies into client bundles.

## 1. Purpose

`packages/contract` is the boundary between action definitions and every
consumer. It derives from the registry: the oRPC router (server), the typed
client (Expo/Next.js), the OpenAPI document, and the AI tool manifest
source. It owns no logic and no state.

## 2. Client safety — the two-layer split

The problem (foundation review P0-2): `defineAction` includes a handler
that imports Drizzle/Node; Expo must never bundle that.

The split:

- **Layer 1 — contract descriptors (client-safe).** Every module's
  `actions/<name>.ts` is split in two files by convention, enforced by
  ESLint boundaries:
  - `actions/<name>.contract.ts` —
    `defineActionContract({...})` imported from the explicitly client-safe
    `@showzy/core/contract` subpath: all §2 metadata from core.md **except**
    `handler`, `resolveTarget`, `confirmationSummary`, `auditTarget`,
    `auditSnapshot`, and other server callbacks. Imports allowed: Zod,
    `@showzy/core/contract`, shared
    validation schemas (`packages/validation`), nothing else. The
    `@showzy/core/contract` export graph contains no DB/Node/runtime imports.
  - `actions/<name>.ts` — `implementAction(contract, { resolveTarget?,
    confirmationSummary?, auditTarget?, auditSnapshot?, handler })`: binds
    the server-only parts. May
    import Drizzle, services, schema.
- **Layer 2 — composition.**
  - `packages/contract` imports **only** `*.contract.ts` files (via each
    module's `index.contract.ts` barrel). It retains all descriptors for
    pairing/CI, but builds the oRPC client contract, OpenAPI document, and
    typed client only from `transport: client` actions (this includes all
    `public`, `consumer`, `account`, and `share` actions, which must declare
    `transport: client`).
    `system` and other internal actions have no externally mountable route.
  - `apps/api` imports the full modules (contracts + implementations),
    registers them in the core registry, and mounts the oRPC router that
    pairs each contract procedure with its handler through the core
    execution pipeline (core.md §4). A contract without an implementation
    (or vice versa) fails at boot and in the contract check.
- AI manifests include only descriptors with both `transport: client` and
  `aiExposure: exposed`, then filter by current principal/permissions.
  `exposed` is a product choice, not the default for every client route
  (ADR-0033). A
  consumer session sees only `consumer`-principal exposed tools (no
  company-scoped tools appear without an active company context). An
  account session sees only `account`-principal exposed tools (no
  company-scoped tools appear without an active company context; account
  tools cover own-user operations like creating or listing companies).
  Share-principal actions are always `aiExposure: internal` (core.md) and
  never appear in any session's tool list — including a logged-in user on a
  share page. AI is not a bypass to an internal action or a share write.

Enforcement (CI):

- ESLint boundaries: `*.contract.ts` may import only Zod,
  `@showzy/core/contract`, and validation;
  `packages/contract` may import only `*.contract.ts`; client apps may
  import only `packages/contract` (+ validation/ui/copy) and
  `@showzy/document-signing` (native/web adapters; never `/node`)
  (SHO-251 / SHO-260 on-device QES; SHO-414 staff copy).
- A **bundle probe**: CI builds a minimal client entry that imports the full
  typed client with a bundler configured to fail on Node builtins /
  `packages/db` / `packages/core` server paths (the client-safe
  `@showzy/core/contract` subpath is allowed). Red = someone leaked a server
  import into the contract layer.

## 3. Transport and auth

- oRPC over HTTP mounted in Hono at `/rpc`; OpenAPI-shaped REST aliases are
  generated at `/api/v1` for external consumers (webhooks docs, future
  public API).
- Auth: better-auth session. Browser and Expo clients use cookies (Expo
  persists them in OS secure storage via `@better-auth/expo`). The contract
  client factory accepts a cookie provider and an optional bearer token
  provider for non-RN callers. `apps/api` resolves the session and hands it
  to the core principal factories (core.md §3). The contract layer itself
  never interprets permissions — that is core's job.
- Staff company selection: the active `companyId` travels as a dedicated
  header (`x-company-id`) that core verifies against membership — it is a
  *selector*, never an access grant (ADR-0013).
- Public routing (ADR-0020): no session or `x-company-id` is required.
  `publicScope: target` runs its server resolver; `publicScope:
  globalProjection` constructs an anonymous null-company context bound to the
  descriptor's `projectionGrant`. The typed procedure never accepts tenant
  scope as transport metadata. Trusted-proxy-normalized IP is passed only to
  core rate limiting/logging.
- Share routing (ADR-0022): no session or `x-company-id` is required or
  consumed. The capability token is **action input** (the typed
  `resolveTarget` hashes it). It is not transport meta: no `x-share-token`,
  and not `x-company-id`. `toPrincipalInvocation` maps share like public:
  `{ mode: "share" }` — neither session nor selector reaches the pipeline.
  A present session on a share invocation is ignored: it does not bind
  `actor` to that user (access log stays `anonymous`) and grants no extra
  access. Trusted-proxy-normalized IP is passed only to core rate
  limiting/logging (same path as public). Unlike public, share actions may
  be `risk: write`; they remain `transport: client` so the share page can
  call them. The client typed procedures for share actions do not accept a
  company parameter. Invalid, expired, revoked, or mismatched tokens
  surface as `NOT_FOUND` (404), never `UNAUTHENTICATED` (401). Share writes
  still require `idempotency-key` meta (core.md §5). Confirmation meta does
  not apply (`requiresConfirmation: false`). HTTP `channel` stays `"ui"`
  (security-operations §4).
- Consumer routing (ADR-0018): consumer actions require a valid better-auth
  session; the transport invokes the consumer context factory (core.md §3)
  directly — no `x-company-id` header is required or consumed. If a staff
  selector is present on a consumer action invocation it is ignored and
  grants no company scope. The client typed procedures for consumer actions
  do not accept a company parameter.
- Account routing (ADR-0013): account actions require a valid better-auth
  session; the transport invokes the account context factory (core.md §3)
  directly — no `x-company-id` header is required or consumed. If a staff
  selector is present on an account action invocation it is ignored and
  grants no company scope. The client typed procedures for account actions
  do not accept a company parameter. Unlike consumer actions, account
  actions may perform writes (e.g., creating a company) and may emit events.
- Idempotency keys travel as `idempotency-key` header / oRPC meta
  (core.md §5). The generated client exposes `createMutationAttempt()`,
  which mints one key. Callers pass `attempt.options` on every retry of
  that logical submit — `@showzy/contract` has no automatic HTTP retry
  layer. The server rejects a missing key for idempotent mutations.
  `requiresConfirmation` challenges return as a typed error and are supplied
  on re-invocation as transport meta, never added to action input (core.md
  §7, so the input hash stays stable).
- Money minor units cross the wire as canonical base-10 strings and are
  mapped explicitly to/from domain `bigint` at action/client boundaries;
  action Zod input/output remains JSON-safe and never transforms a wire value
  into `bigint` inside the transport contract (db.md §3).

## 4. Error mapping

Typed core errors (core.md §11) map to stable wire codes. Transport-level
authentication failure is in the same union so clients never string-match:

| Core error / transport | HTTP | Wire code |
| --- | --- | --- |
| ValidationError | 400 | `VALIDATION` (+ Zod issues) |
| *(no session where one is required)* | 401 | `UNAUTHENTICATED` |
| PermissionDeniedError | 403 | `PERMISSION_DENIED` |
| NotFoundError | 404 | `NOT_FOUND` |
| ConflictError / IdempotencyConflictError | 409 | `CONFLICT` / `IDEMPOTENCY_CONFLICT` |
| ConcurrentRetryError | 409 | `RETRY_IN_PROGRESS` (+ retryAfter) |
| ConfirmationRequiredError | 409 | `CONFIRMATION_REQUIRED` (+ challenge) |
| RateLimitError | 429 | `RATE_LIMITED` (+ retryAfter) |
| TimeoutError | 504 | `TIMEOUT` |
| CoreInvariantError / unknown | 500 | `INTERNAL` (no details on the wire) |

`UNAUTHENTICATED` (401) is issued by the HTTP session gate before
`executeAction` — it is not a core.md §11 class. Public and share
invocations are not "session required"; a missing session must not yield
401. `PERMISSION_DENIED` (403) remains the mapped core error for an
authenticated caller without access.

Clients get a discriminated union typed by wire code — no string matching.

## 5. OpenAPI

Generated from the contract layer in CI and committed as an artifact
(`packages/contract/openapi.json`); drift check like migrations. Action
`description` doubles as the OpenAPI summary — one more reason it is
written carefully (it also becomes the AI tool description). Per-operation
error responses come from `toContractProcedure`: pipeline-universal §4
codes union the action's declared `errors` (`VALIDATION`, `NOT_FOUND`,
`CONFLICT`). Shared HTTP statuses stay a oneOf — declaring `CONFLICT`
does not replace `CONFIRMATION_REQUIRED` or `IDEMPOTENCY_CONFLICT` on 409.

## 6. Versioning policy

MVP: single version, additive evolution only (new optional fields, new
actions). Breaking a shipped action's input/output requires a new action
name (`orders.createV2`) — cheap in the registry model — and a deprecation
note in the spec. Full URL versioning deferred until there are external
API consumers.

## 7. Acceptance criteria

- [ ] Expo test app imports the typed client; bundle probe passes; type
      errors surface at `tsc` when an action contract changes.
- [ ] Importing `@showzy/core/contract` from the bundle probe reaches no
      server/runtime/DB module.
- [ ] Contract/implementation pairing: missing handler or orphan
      implementation fails boot + contract check (tests).
- [ ] `transport: internal` and every system action are absent from client,
      OpenAPI, and AI artifacts and return no routable endpoint.
- [ ] Every `ctx.callAtomic` callee remains internal and absent from client,
      OpenAPI, and AI artifacts; undeclared caller/callee edges fail pairing.
      Enforcement (`buildContractRouter` / `buildServerRouter` reject
      `transport: internal`) exists today. When the first `ctx.callAtomic`
      edge is registered in composition, add a fixture proving that callee
      is absent from `contractRouter`, `openapi.json`, and AI tool sources
      — do not invent a fake module before then.
- [ ] Error mapping table covered by integration tests per error class.
- [ ] `x-company-id` for a company without membership → 403 (test).
- [ ] Public-target and public-global procedures work without a session;
      neither accepts `x-company-id` as authority.
- [ ] Public-global descriptor without a declared projection grant, with a
      resolver, or with mutation metadata fails the contract check.
- [ ] Public-global route is projection-only, returns only allowlisted fields,
      and rate-limits by rotating IP HMAC without exposing raw IP.
- [ ] Consumer action invoked with a valid session and no `x-company-id` →
      succeeds with consumer context (test).
- [ ] Consumer action invoked without a session → 401 (test).
- [ ] `x-company-id` present on a consumer action invocation is ignored and
      does not grant company scope (test).
- [ ] AI manifest for a consumer session includes only
      `consumer`-principal `aiExposure: exposed` tools (test).
- [ ] AI manifest for an account session includes only
      `account`-principal `aiExposure: exposed` tools (test).
- [ ] Account action invoked with a valid session and no `x-company-id` →
      succeeds with account context (test).
- [ ] Account action invoked without a session → 401 (test).
- [ ] `x-company-id` present on an account action invocation is ignored and
      does not grant company scope (test).
- [ ] Share read and write procedures work without a session; neither
      accepts `x-company-id` as authority; the capability token is action
      input only (no share-token header) (test).
- [ ] Share action invoked with a valid session still uses share context;
      the session is ignored (no user actor, no extra access) (test).
- [ ] Share action invoked without a session does not return 401 (test).
- [ ] Invalid, expired, revoked, or mismatched share token → 404
      `NOT_FOUND` (test).
- [ ] AI manifest for staff, customer, consumer, and account sessions
      includes no `share`-principal tools (test).
- [ ] Share writes missing idempotency meta → typed validation error
      (test).
- [ ] Share actions appear in the client router and OpenAPI
      (`transport: client`) and remain absent from AI artifacts (test).
- [ ] Missing idempotency meta on an idempotent mutation → typed validation
      error; retries of a logical submit must reuse `attempt.options` (no
      automatic retry helper in the client).
- [ ] Confirmation challenge meta is not part of action input and cannot
      change the canonical request hash.
- [ ] OpenAPI drift check red on uncommitted contract changes.
- [ ] `*.contract.ts` importing `packages/db` → ESLint error (test).

## Changelog

| Date | Change | Why | Reported by |
| --- | --- | --- | --- |
| 2026-09-06 | §5: per-operation errors are pipeline-universal ∪ `contract.errors` on `toContractProcedure`; 409 stays a oneOf | SHO-485: replacing OpenAPI responses by status dropped confirmation/idempotency 409 codes | SHO-485 |
| 2026-09-06 | Client apps may also import `@showzy/copy` (staff copy leaf) | Shared orders copy package (SHO-414) | SHO-414 |
| 2026-08-21 | Expo sessions use cookies (`@better-auth/expo`); bearer remains for non-RN callers | Align transport with the Expo integration; drop client-side bearer as the mobile path | owner |
| 2026-08-19 | Seventh principal `share` (ADR-0022): client/OpenAPI mount, no-session dispatch, token in action input only, AI never lists share | HTTP dispatch for unauthenticated capability-token writes; core.md already amended | owner via `/rework-spec contract.md` |
| 2026-08-19 | Status: Active; Active surface: entire file | Ledger catch-up: first merged packages/contract (fnd-T23…T25) | owner via spec-process-after-phase-0 |
| 2026-08-19 | §3/§7: key reuse is manual via `attempt.options` (no automatic retry layer); §7: composition fixture for the first `ctx.callAtomic` callee is owed when that edge lands | Align living spec with the client (fnd-G1 A12) | scaffold (fnd-G1 A12) |
| 2026-08-18 | Added transport-level `UNAUTHENTICATED` / 401 to the §4 wire-error union | Session-gate 401 was outside `isWireError()`, forcing clients to string-match | scaffold (fnd-G1 A8) |
| 2026-08-17 | Integrated `account` principal: transport exposure, AI manifest filtering, routing rules, and acceptance criteria | Align contract with ADR-0013 (amended) 6-mode principal model (`staff \| customer \| public \| system \| consumer \| account`) per spec-rework queue Step 1 | spec-rework agent |
| 2026-08-17 | Added consumer client exposure and session routing without company scope | Align transport composition with ADR-0018 and core consumer semantics | Human owner via spec-rework queue |
| 2026-08-17 | Defined the client-safe core subpath, retry-key ownership, confirmation transport, and bigint wire encoding | Foundation consistency review against core/db specs and ADR-0013 | GPT-5.6 Sol |
| 2026-08-17 | Initial draft | — | spec agent (Fable 5) |
