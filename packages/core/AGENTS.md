# @showzy/core — Agent Instructions

Action runtime and module test kit. **Frozen for module implementation
tasks**: if core lacks a capability, stop and report; do not change it
or work around the protocol. Root instructions and
[prohibitions](../../.cursor/rules/prohibitions.mdc) apply.

The protocol authority is [docs/specs/core.md](../../docs/specs/core.md).
Read the relevant sections before a core change. This file is a work map,
not a second copy of the runtime specification.

## Public entry points

| Import                  | Purpose                                                 | Source                  |
| ----------------------- | ------------------------------------------------------- | ----------------------- |
| `@showzy/core/contract` | Client-safe `defineActionContract` and metadata types   | `src/contract/index.ts` |
| `@showzy/core/errors`   | Typed error vocabulary                                  | `src/errors/index.ts`   |
| `@showzy/core`          | Server runtime, registry, protocols, permission helpers | `src/index.ts`          |
| `@showzy/core/testing`  | Test kit and inherited suite registrars                 | `src/testing/index.ts`  |

Use public entry points; pipeline-internal context, emit, and call builders
are not module APIs. Export lists live in code and `package.json`.

## Protocol map

Section numbers refer to [core.md](../../docs/specs/core.md).

| Work area                                            | Read                        | Implementation                                                             |
| ---------------------------------------------------- | --------------------------- | -------------------------------------------------------------------------- |
| Descriptor metadata and conditional callbacks        | §2, ADR-0016                | `src/contract/`, `src/runtime/implement-action.ts`, `src/runtime/types.ts` |
| Principal scope and permission precedence            | §3, companies-foundation §2 | `src/runtime/context/`                                                     |
| Execution order, deadlines, transactions, hook slots | §4                          | `src/runtime/pipeline/`                                                    |
| Retry keys, leases, replay, confirmed retries        | §5                          | `src/runtime/idempotency/`                                                 |
| Events, ordering, delivery, dead-letter replay       | §6, db §7                   | `src/runtime/events/`                                                      |
| Confirmation and fail-closed consumption             | §7                          | `src/runtime/confirmation/`                                                |
| Audit, redaction, failure/read transactions          | §8                          | `src/runtime/audit/`                                                       |
| Read composition and atomic capabilities             | §9, ADR-0015/0021           | `src/runtime/pipeline/ctx-call.ts`, `ctx-call-atomic.ts`                   |
| Rate limits and store-failure behavior               | §10, security-operations    | `src/runtime/rate-limit/`                                                  |
| Typed errors and client-safe messages                | §11, contract §4            | `src/errors/`                                                              |
| Required isolation/protocol suites                   | §12                         | `src/testing/`                                                             |
| Define, registration, registry-wide CI rules         | §2/§12                      | `src/contract-check/`, `src/runtime/action-registry.ts`                    |

Companion manuals: [DB](../../docs/specs/db.md),
[contract](../../docs/specs/contract.md),
[security/operations](../../docs/specs/security-operations.md),
[RBAC](../../docs/specs/companies-foundation.md).

## Guardrails

- Handler `ctx` is `ActionCtxFor<contract.principal>` (SHO-416), not
  the seven-mode union. A staff handler does not need a principal guard
  just to access `companyId`. Inner `public` target/global and `system`
  tenant/global discriminants remain unions. Runtime factory selection
  and authorization are unchanged.
- The current handler method shape preserves assignability to the
  registry/pipeline's three-argument `ImplementedAction`; `NoInfer` on
  `ctx` prevents explicit annotations from widening `TPrincipal`. These
  are deliberate typing constraints, not decoration; read the source
  comment before changing them. SHO-453 tracks replacing both with a
  function property and an explicit erased shape; do not treat that
  follow-up as already implemented.
- `executeAction` is the invocation path. Context factories verify scope;
  never assemble an `ActionCtx` by hand or use a selector as authority.
- Check staff permissions through `staffHasPermission`; reading
  `membership.permissions` cannot represent owner-all. Use
  `resolveEffectivePermissions` for the effective permission projection.
- The pipeline owns execution transactions and the step order in §4.
  Reads have both a database read-only transaction and a `ReadTx` facade.
  Output validation happens before commit. Declared protocols must fail
  closed when their hooks are missing; optional hook types support tests,
  not production omissions.
- Cross-module reads run through `ctx.call`; same-transaction writes need
  mutually declared `ctx.callAtomic` edges. Runtime and registry checks
  share `src/contract-check/call-rules.ts`; do not fork the rules.
- Throw the typed core errors in domain code. Only `clientMessage` may
  reach the wire; internal diagnostics and `Error.message` are log-facing.
  Error codes are pinned to the contract wire table by tests.
- Idempotency keys and confirmation challenges are transport metadata,
  never domain input. Preserve replay-before-confirmation and the
  persisted-grant rules in §5/§7.
- Buffer events through `ctx.emit` and flush with the handler transaction.
  Delivery effects and processed status commit atomically. Preserve
  consumer-scoped ordering, claims, retries, and replay from §6.
- Audit success for mutations shares their transaction; audited reads use
  the separate best-effort post-commit path. Failure hooks do not mask
  the original outcome. Follow §8 for snapshots and redaction.
- Apps bind Redis, telemetry, and worker loops. Core exposes libraries,
  not process boot or scheduled jobs. Store-failure policies differ by
  protocol/action class; use §7/§10 rather than a blanket retry policy.
- Raw SQL is limited to explicitly approved foundation primitives with
  an approval reference. See core §4/§6 and db §7; this is not permission
  for domain SQL or extra transactions.

## Registration belongs to composition roots

Module tasks register actions, events, call edges, schema ownership,
`@showzy/<module>/suite-coverage`, and assistant-surface binding refs
(SHO-471) in `apps/api/src/composition.ts`.
Subscriptions are registered once in `apps/api/src/subscriptions.ts`;
the worker re-exports that array. Do not modify core to register a module.

`ActionRegistry.assertPaired()` is the boot gate. Define-time validation,
implementation callback checks, and `runContractCheck` cover different
layers; do not duplicate registry-wide checks inside a descriptor factory.

- Every contract declares `errors`: the domain codes `VALIDATION`,
  `NOT_FOUND`, and/or `CONFLICT`, or an explicit empty array. Callers must
  include their `ctx.call` / `ctx.callAtomic` callees' declared codes.
  See core §2 and contract §5; do not declare pipeline codes or `INTERNAL`.
- AI-exposed create actions require provenance columns and the channel
  CHECK on the derived entity table. `src/contract-check/record-provenance.ts`
  owns the derivation, physical-table aliases, and named `companies` /
  `files` exclusions (SHO-467/488/491); do not hardcode another table list.
- Assistant surface `actionNames` / `toolNames` must resolve against
  AI-exposed contracts and registered façade names. Keep the binding
  check in `src/contract-check/assistant-surfaces.ts` (SHO-471), not a
  second client/tool registry.

## Testing and client safety

- Instantiate the required suites from `@showzy/core/testing` and declare
  coverage. Missing required coverage fails the contract check.
  `createTestKit` / `buildTestContext` use real context factories.
  Internal fixture actions are not public goldens.
- `*.test.ts` runs in the Docker-free unit project;
  `*.db.test.ts` uses the shared `@showzy/db/testing` harness. Do not
  construct per-module containers or use a hand-rolled context fixture.
- Check the affected protocol tests, core typecheck (including
  `tsconfig.contract.json`), and API `contract:check` when changing core.
  Follow the root DoD and CI gate; for docs-only edits validate links,
  referenced symbols, and guardrail preservation, and report which
  runtime checks were not run.
- The `contract` graph may reach Zod and approved shared validation, never
  core runtime, DB, Node builtins, logging, Redis, or workers. Its
  `types: []` typecheck and CI bundle probe guard this boundary.
