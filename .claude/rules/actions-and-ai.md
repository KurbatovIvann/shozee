---
paths:
  - "packages/modules/**"
  - "packages/ai/**"
  - "packages/validation/**"
  - "packages/contract/**"
  - "packages/assistant-kit/**"
  - "apps/api/**"
---

# Channel-neutral actions and staff AI tools (ADR-0033)

**Goal:** the staff UI and the staff assistant finish the same jobs through
the same `executeAction` handlers. An action is a staff **job**, not a screen
widget. The assistant may see a narrower mapped schema.

- **Same handlers.** No `*ForAssistant` `implementAction`, no AI-only module
  Zod in `*.contract.ts`, no SQL/GraphQL DSL or MCP from `packages/ai`, no
  workflow mega-action that spans customers+pricing+orders in one write.
- **Façades live only in `packages/ai`.** Named tools always
  `execute("module.verb", canonicalInput)`; the registry name stays the
  audit/permissions/timeout identity. Read `packages/ai/AGENTS.md` before
  changing `packages/ai` or staff-exposed contract **input** schemas. Copy the
  `orders.list` → `orders_list_page` / `orders_list_counts` pattern (SHO-355
  input map **and** SHO-360 output map before clip) when a ticket names that
  list. Do not copy T5 input-only façades. Do not copy it repo-wide unasked.
- **Do not flatten** a channel-neutral list/write contract to appease
  Anthropic (missing JSON Schema `type` on Zod 4 `oneOf`). Map named object
  tools instead. Keep `ensureAnthropicToolInputSchemaType` for remaining 1:1
  union tools until those get façades.
- **List** = bounded domain query: discriminated `kind` (page vs aggregate vs
  bounded lines), extensible `filter`, named caps, explicit truncation. The
  screen is a client of that query. New staff lists copy `orders.list`
  (SHO-351) — not pre-SHO-350 `catalog.listProducts` or page-only input.
- **Write** = canonical ids or a unique human `query` reference. Resolve in
  the **owning** module via internal `ctx.call`. Never guess on ambiguous
  names. Do not put name resolution in `pricing.resolveProductPrices`.
- **Grow in place.** New statuses, payment, delivery = optional filter fields
  on the existing list, not a new public action. Do not encode `active` as a
  server status; document it as `new`+`confirmed` until fulfillment statuses
  exist (fixed CHECK, not v1 per-company workflows).
- **`aiExposure: "exposed"` is a product choice**, not the default for every
  `transport: "client"` route. Composition-only reads (`ctx.call` callees the
  UI never uses) are `internal`.
- **ADR-0015 unchanged:** no joins of another module's tables. Add a bounded
  internal read on the owner instead (`listMatchingIds`, `resolve*Reference`).
