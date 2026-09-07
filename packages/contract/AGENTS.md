# @showzy/contract — Agent Instructions

The boundary between action definitions and every consumer (contract.md,
ADR-0004, ADR-0016). Derives the oRPC contract router, the typed client,
the wire-error table, money wire helpers, and the AI tool-manifest source
from client-safe action descriptors; the `./server` subpath pairs those
procedures with registered implementations through the core execution
pipeline. **Owns no domain logic and no state.**

## Public exports

Two export subpaths:

- `@showzy/contract` (root, client-safe) — `buildContractRouter` /
  `contractRouter` from the exposure record, `createContractClient` /
  `createMutationAttempt`, the contract.md §4 `wireErrorStatus` /
  `wireErrorDefinitions` / `isWireError` table, `moneyToWire` /
  `moneyFromWire`, transport-meta header names, and
  `deriveAiToolSources` / `aiToolSourcesForPrincipal`.
- `@showzy/contract/server` — `buildServerRouter` (every procedure is
  `executeAction`), `toPipelineRequestMeta` / `toPrincipalInvocation`,
  `toWireError` + `wireErrorInterceptors`. Reaches the core runtime; the
  CI bundle probe rejects this subpath from client entries.

The `bundle-probe` CI job compiles `probe/entry.ts` (the full typed client)
with esbuild and fails on Node builtins, `packages/db`, and core server
paths (`@showzy/core/contract` is allowed). OpenAPI is generated from
`contractRouter` into the committed `openapi.json`; `openapi:check` diffs
it like migrations.

`src/client/modules.ts` is the populated client exposure record. Module
tasks add their `index.contract.ts` descriptors there and regenerate the
OpenAPI artifact; preserve the existing entries.

## Client-safe root (`src/client/`)

- Import graph may reach **Zod**, `@orpc/client`, `@orpc/contract`,
  `@showzy/validation` (canonical money wire schema), and
  `@showzy/core/contract` (plus a type-only pin to `@showzy/core/errors`
  so the wire table cannot drift from the §11 vocabulary). No core
  runtime, `packages/db`, Node builtins, logging, Redis, or workers.
- `tsconfig.client.json` re-checks `src/client` (and `probe/entry.ts`) with
  `"types": []` and DOM lib (Fetch / Web Crypto) in the same `typecheck`
  script — an accidental `process`/`Buffer` reference is a compile error.
- Only `transport: "client"` descriptors are routable.
  `buildContractRouter` / `buildServerRouter` **fail loudly** on an
  internal/system entry rather than filtering it out — silent omission
  would hide a composition bug.
- Record keys must mirror `<module>.<verb>` exactly: the RPC path is the
  nested object shape, so a mismatch would serve one action under
  another's name.
- `toContractProcedure` attaches `.errors(pipeline-universal ∪ contract.errors)`.
  OpenAPI is that map; do not overwrite 400/404/409 after generation.
- Apps call `createContractClient({ baseUrl, getCookie })` (Expo) or
  `getAccessToken` (bearer). Then `setActiveCompany` for the staff
  selector. `/rpc` fetch uses `credentials: "omit"` so a manual `Cookie`
  header is not overwritten. The omit wrapper rebuilds from URL + init
  and must not `new Request(existingRequest)` (Expo mutations lose Cookie
  and/or body on that clone). Rebuilt bodies are JSON **strings**
  (`request.text()`), not `ArrayBuffer` — RN XHR drops a buffer from
  another realm, which makes empty-input reads succeed and writes never
  hit `executeAction`. `isWireError` matches §4 `code` + `status`,
  not `instanceof ORPCError`. `createMutationAttempt()` mints the
  idempotency key via Web Crypto method calls (`randomUUID`, then
  `getRandomValues`); Expo may pass
  `createMutationAttempt(() => expoCrypto.randomUUID())` when Hermes
  Web Crypto throws. Callers must pass `attempt.options` on retry (no
  automatic HTTP retry layer). Confirmation re-invokes with
  `attempt.withChallenge(id)`. Money minor units use `moneyToWire` /
  `moneyFromWire`. Narrow errors with `isWireError` and `error.code` —
  never by matching `message` text.

## Server subpath (`src/server/`)

- `apps/api` (fnd-T26) resolves the session, trusted-proxy IP, and meta
  headers into `TransportInvocationContext`. This package maps that onto
  pipeline shapes; it never treats a selector as authority (ADR-0013).
- `toPrincipalInvocation` is the one place each mode is allowed to see
  transport meta: staff gets the raw selector (core verifies membership);
  customer/consumer/account get only the session; public and share get
  nothing (share capability token is action input, never a header; a
  present session is ignored); system is unreachable (composition error).
  Share HTTP tests live here and in `apps/api` (session-gate skip).
- Every procedure runs `executeAction`. There is no second data path.
  Pairing problems (orphans, descriptor drift, a registered client action
  missing from the exposure record) fail boot.
- `toWireError` maps the ten §11 classes onto the §4 table (`clientMessage`
  only; `INTERNAL` carries no details). `wireErrorInterceptors` remaps
  oRPC's own `BAD_REQUEST` / output-validation failures onto the same
  vocabulary — mount them as `clientInterceptors` on `RPCHandler`.

## Adding a module's client actions

1. Export descriptors from the module's `index.contract.ts`.
2. Add them to `src/client/modules.ts` under `{ [module]: { [verb]: contract } }`
   with keys that match `contract.name`.
3. Register both barrels in `apps/api/src/composition.ts` (implementations
   and the module's `./suite-coverage` export). Do not edit `packages/core`.
   The server router builder proves the exposure record and the registry
   agree.

Do not hand-write oRPC procedures, wire codes, or AI-tool lists — they
all derive from the descriptor.

## Testing

- `*.test.ts` — Docker-free: the §4 table, composition rules, AI coverage,
  wire mapping, principal dispatch of transport meta, mutation-attempt
  key reuse, money int64 round-trip, client header injection, bundle-probe
  leak fixtures, OpenAPI generation vs the committed artifact.
- `*.db.test.ts` — transport round-trip against the Testcontainers
  harness (`@showzy/core/testing`): every §4 error class over the wire,
  selector/session rules, idempotency and confirmation meta, orphan boot
  failure, typed-client missing-key / retry. Docker required.

CI also runs `bundle:probe` and `openapi:check` in the `bundle-probe` job.
