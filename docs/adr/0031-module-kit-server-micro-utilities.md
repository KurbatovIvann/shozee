# ADR-0031: Server module micro-utilities live in `@showzy/module-kit`

- **Status**: Accepted
- **Date**: 2026-08-31
- **Amended**: 2026-09-15 — `./revision` dependency exception: ADR-0042, SHO-622
- **Deciders**: Ivan Kurbatov (human) (+ proposing agent)

## Context

SHO-285 (parent SHO-277) consolidates byte-near-identical server helpers
copied across domain modules: the Postgres unique-violation cause-chain
walker, the writable-transaction cast, canonical money encoding, id-holder
audit-target builders, `parseDbEnum` guards, byte SHA-256, order-preserving
`uniqueIds`, Zod literal-gate `requireOrValidationError`, and
optional-nullable UUID normalization.

`packages/core` is frozen for module work. `@showzy/db` owns schema and
migrations (ADR-0014) and is not a utilities bag. `@showzy/validation` is
the client-safe Zod layer (ADR-0016, contract.md §2) and ships in mobile
and web bundles. These helpers walk `cause` chains, inspect SQLSTATE,
hash bytes with `node:crypto`, and throw `CoreInvariantError` /
`ValidationError` — they must not enter `*.contract.ts` or client apps.

A new workspace package is a new dependency edge and needed an explicit
home. On 2026-08-31 Ivan Kurbatov named that home `@showzy/module-kit`
(`packages/module-kit`).

## Decision

Server-only module micro-utilities live in **`@showzy/module-kit`**
(`packages/module-kit`). Domain modules import kit **subpaths**. The
package is a **platform** element (same class as `@showzy/validation`):
modules may import it; `*.contract.ts` may not; client apps may not.

The kit owns no actions, no tables, and no client Zod schemas. Pagination
and money **wire** schemas remain `@showzy/validation` (SHO-284).

## Alternatives considered

- **`@showzy/db` utils subpath** — rejected: ADR-0014 limits `packages/db`
  to schema, migrations, and the client/harness. A walker used by action
  handlers is not a schema concern.
- **`packages/core`** — rejected: core is frozen; module tasks must not
  edit it. These helpers are not runtime protocol.
- **`@showzy/validation`** — rejected: client-safe Zod only. These helpers
  import `@showzy/core/errors` and Node builtins and must stay off the
  client allowlist.

## Consequences

- SHO-285 migrates existing copies onto kit imports in the same PR as this
  ADR. Named mechanical fix: catalog variant audit type unifies to
  `variant` (not `product_variant`).
- ESLint `PLATFORM_PACKAGES` and `boundaryElements` register `module-kit`.
  No client-app exception. No domain-module → domain-module service holes.
- Allowed kit dependencies: `@showzy/core`, `@showzy/core/errors`, `zod`,
  `node:crypto`. No new third-party npm.
  Exception (2026-09-15, ADR-0042, SHO-622): the `./revision` subpath also
  depends on `drizzle-orm` and on `@showzy/db` (peer + dev dependency). The
  rest of the kit stays within the list above.
- Follow-up consolidations of other server copies use this package; they
  do not reopen the home decision.
