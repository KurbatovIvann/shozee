---
name: showzy-backend
description: Golden-file map for Showzy server work — module actions (contract + implementation), events and subscriptions, owned Drizzle schema and migrations, suite coverage, composition registration, and the DB/unit test pattern. Load before adding or changing anything in packages/modules, packages/db/src/schema, apps/api composition, or module tests.
---

# Showzy backend golden-file map

A router, not a second spec. Open the golden file for the piece you are
building, copy its **protocol** (tenant scope, errors, metadata, pagination
helpers, folders, test suites), and adapt names. Constitution, ADRs, and
`packages/core/AGENTS.md` win over this map. The merged order slice and its
pricing/chat collaborators are the backend golden (ADR-0026, ADR-0033).

## Where each piece lives

| Building | Golden to copy | Notes |
| --- | --- | --- |
| Staff list action (bounded query) | `packages/modules/orders/src/actions/list.contract.ts`, `list.ts`, `services/order-list/` | ADR-0033 `kind` + `filter` + caps. Not pre-SHO-350 `catalog.listProducts` input |
| Reference-aware write | `packages/modules/orders/src/actions/create.contract.ts`, `create.ts`, `services/create-order.ts` | ids or unique `query`; resolve in the owning module via `ctx.call` |
| Status transition write | `orders/src/actions/confirm.contract.ts` + `confirm.ts` | idempotent, audit, emits `orders.confirmed` (ADR-0026) |
| Single read | `orders/src/actions/get.contract.ts` + `get.ts` | |
| Internal match/resolve read for `ctx.call` | `orders/src/actions/search-matches.*` | `aiExposure: "internal"` |
| Event definition | `orders/src/events/confirmed.ts` | name `<module>.<pastVerb>`; version in envelope |
| Event subscriber → idempotent system action | `packages/modules/chat/src/events/order-card-updater.ts`, `chat/src/actions/upsert-order-card.*` | projection stores ids, never order state (ADR-0011) |
| Module barrels | `orders/src/index.ts` (actions + events only), `orders/src/index.contract.ts` (descriptors only) | |
| Suite coverage manifest | `orders/src/suite-coverage.ts` | missing required coverage fails `contract:check` |
| Owned schema | `packages/db/src/schema/orders.ts` | db.md §3; tenant composite keys (ADR-0025); money `_minor` + `currency` |
| Migration | `pnpm --filter @showzy/db db:generate` | never hand-edit generated SQL; review lock risk and FK indexes |
| Registration | `apps/api/src/composition.ts` (actions, events, call edges, schema ownership, suite coverage, assistant bindings); `apps/api/src/subscriptions.ts` | never register in `packages/core` |
| AI tool façade (only when the card names it) | `packages/ai/src/tool-facades/orders-list.ts` | read `packages/ai/AGENTS.md` first |
| Server micro-utilities | `packages/module-kit/src` | ADR-0031; do not copy helpers into modules |

## Tests (definition of done)

| Test | Golden | Runs in |
| --- | --- | --- |
| Contract metadata pinning | `orders/src/actions/confirm.test.ts` | unit (`*.test.ts`, no Docker) |
| Pure services | `orders/src/services/line-money.test.ts` | unit |
| Behavior + inherited suites | `orders/src/actions/orders.db.test.ts` — `createTestKit`, `crossTenantSuite`, `idempotencySuite`, `eventSuite` from `@showzy/core/testing` | DB (`*.db.test.ts`, shared Testcontainers harness) |
| List behavior | `orders/src/actions/list.db.test.ts` | DB |

Cover for every new/changed action: happy path, mode-appropriate authorization
denial, validation failure, cross-tenant isolation, and the
idempotency/confirmation/event cases the metadata declares. Use the shared
`@showzy/db/testing` harness; never per-module containers or hand-built
contexts.

## Read on demand (sections, not whole files)

- `docs/specs/core.md` — §2 metadata, §3 principals, §5 idempotency, §6
  events, §7 confirmation, §8 audit, §9 composition, §12 suites (map in
  `packages/core/AGENTS.md`).
- `docs/specs/db.md` — §3 schema conventions, §7 raw-SQL exceptions.
- `docs/module-ownership.md` — who owns a table or capability.
- `docs/specs/money.md` — money types and snapshots.

## Checks

`node .claude/scripts/verify.mjs` selects `contract-check`,
`migration-drift`, `bundle-probe`, and the DB suite automatically when these
paths change.
