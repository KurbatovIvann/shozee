# ADR-0033: Channel-neutral actions — task-complete lists and reference writes

- **Status**: Accepted
- **Amended**: 2026-09-19 — a staff update changes only the fields it names
  (SHO-725, see Amendment below)
- **Date**: 2026-09-02
- **Deciders**: Ivan Kurbatov

## Context

Blueprint §1 and ADR-0008 say the classic UI and the staff assistant perform
**the same actions**. Golden-slice lists and writes were shaped like **mobile
screens**: a cursor page of ~20 header rows, UUID-only create, `aiExposure:
"exposed"` on almost every `transport: "client"` action.

Phase 9 then connected the model to that graph. The assistant sees dozens of
tools on a five-tab panel, pages and clips results, and hunts UUIDs (including
ids from the working set that belong to a different entity). Live example
2026-09-01: creating a customer, personal −10% prices, and an order with all
products degenerated into cursor/`omitted` talk, `pricing.resolveProductPrices`
as a discount calculator, and an `orders.create` id used as a `productId`.

Agents also copy comments such as “copy `catalog.listProducts`, do not invent
a second list shape” and the executor rule “follow the golden slice, do not
invent patterns.” That freezes the **screen-shaped** input, which is the
drift — not ADR-0015’s ban on joining another module’s tables.

`docs/archive/specs/` still contains Living novels that contradict later
cards. They are marked “not authority” and still get grepped.

## Destination (the goal)

The product we are building:

1. **One registry, two channels.** UI and the assistant share the same
   `executeAction`. Named tool façades in `packages/ai` may map a narrower
   schema onto that handler. No `*ForAssistant` `implementAction`, no
   AI-only module Zod, no generic SQL/GraphQL.
2. **An action is a staff job, not a widget.** A list can answer a bounded
   question (a page **or** a server aggregate) without `get` per row and
   without JSON clipping as the source of truth. A write can name a customer
   or product by unique human reference or by id.
3. **Cross-module phrases stay several writes.** “New customer + personal
   prices + order” is `customers.create` then a pricing write then
   `orders.create`. Do not add workflow mega-actions. Grow capability by
   making each of those writes/lists task-complete.
4. **Lists grow in place.** New lifecycle statuses, payment, and delivery are
   additive optional filter fields on the same list action — not new public
   actions. “Active” is documentation (`new`+`confirmed` until fulfillment
   exists), never a frozen server alias.
5. **The AI catalog stays small.** Reads that exist only so another action
   can `ctx.call` them are `transport: "internal"` and `aiExposure:
   "internal"`. `aiExposure: "exposed"` is a product choice, not the default
   for every client route.
6. **ADR-0015 stays.** Orders does not join Customers/Catalog tables. Missing
   match/resolve capability is a new **internal** read on the owning module.

First application: Linear [SHO-350](https://linear.app/showzy-v2/issue/SHO-350)
(`orders.list` / `orders.create`). Later lists (documents, catalog, …) copy
**this** shape, not the pre-SHO-350 `catalog.listProducts` input bag.

## Decision

- Staff **list** actions that UI and AI share use a discriminated `kind`
  (page vs aggregate vs bounded lines) plus an extensible `filter` object,
  named caps, and explicit truncation flags. oRPC and mobile send `kind`.
- The staff assistant may see **named tool façades** in `packages/ai` that
  map onto the same handler (`execute("orders.list", canonicalInput)`).
  Façade Zod is adapter-only. A list façade owns **model-safe output**
  (compact rows, cursor-safe paging, explicit omitted) — not only a
  narrower input schema. Flattening `*.contract.ts` to appease
  Anthropic, `*ForAssistant` twins, and SQL-in-tools are forbidden.
- Staff **writes** that reference other records accept `{ by: "id" } | { by:
  "query" }` (or stay id-only until that module’s ticket). Query resolution
  is an internal `ctx.call` into the **owner** of the named entity. Fuzzy
  match never writes; unique exact match may; ambiguity is `CONFLICT` with a
  bounded client message (no new core error code in SHO-350).
- Executor/planner instructions copy **protocol** from goldens (tenant,
  pagination helpers, errors, permissions), not a screen-shaped input that
  this ADR retires. Copy **one handler, not one JSON Schema**.
- Agents do not read `docs/archive/` unless a human names a file.

## Alternatives considered

- **Keep copying `catalog.listProducts` as the only list shape** — rejected:
  that is the drift. Pagination helpers stay shared; the *input job* does not.
- **AI-only list/create twins** — rejected: v1’s disconnected assistant
  (blueprint §1 problem 4, ADR-0008). Named façades in `packages/ai` that
  still `execute` the registry name are the allowed adapter (SHO-355).
- **One mega-action per chat utterance** — rejected: unbounded public API;
  permissions, idempotency, and confirmation become fiction.
- **Relax ADR-0015 so orders JOINs customers** — rejected: tenant and
  `customers:view` would leak into the wrong owner. Add `listMatchingIds` /
  `resolve*Reference` instead.
- **Delete or rewrite ADR-0008 / ADR-0015 / ADR-0016** — rejected: they are
  the destination’s foundation. This ADR names the missing *shape* rule.

## Consequences

- `.cursor/rules/`, `AGENTS.md`, `/ticket` `/feature`, and blueprint §1/§4
  point here. “Copy the golden list” means SHO-351 `orders.list`
  (`kind` + extensible `filter`). Do not add another page-only staff list.
  Named assistant tools over that handler copy T7 catalog + SHO-360
  (`orders_list_page` / `orders_list_counts` in `packages/ai`): input map
  **and** output map before clip. Do not copy T5 input-only façades.
- `pricing.resolveProductPrices` and similar composition reads should not
  be AI tools (SHO-350 T2).
- Protocol manuals (`docs/specs/core.md`, `contract.md`) stay; they do not
  define domain list shapes.
- Archived novels stay in git for humans; they are out of agent context.

## Amendment, 2026-09-19 — an update changes only the fields it names

**What no longer holds.** Staff update actions copied the form: "same fields
as create plus `id`; omitted/null optional fields clear"
(`customers.updateCustomer`, `customers.updateCounterparty`,
`customers.updateGroup`, `catalog.updateVariant`, `companies.updateLegal`).
That is the screen-shaped input this ADR retires: only a client holding the
whole record can call it safely. The assistant holds a compact list row, so
"change the phone" wiped `notes` and `email` and answered "Готово!"
([SHO-725](https://linear.app/showzy-v2/issue/SHO-725)).

**What now holds.**

- On a staff update, an **omitted** optional field is unchanged and an
  explicit **`null`** clears it. Every optional update field is
  `.nullable().optional()`; a field with no clear form gains `null`.
- The handler merges the input with the current row under the row lock it
  already takes. A row invariant (a customer keeps at least one contact, a
  variant override is a price-and-currency pair) is checked on the **merged**
  row, not on the submitted payload.
- Required fields stay required. An upsert (`companies.updateLegal`) treats
  an omitted field as unchanged when the row exists and as null when it does
  not.
- New staff updates follow this rule. No read-merge-write façade in
  `packages/ai` and no "get before update" prompt rule: both reconstruct
  state a contract decision threw away.

**Consequences.** Any client may send a partial update. A form that sends
the whole record with explicit nulls behaves as before; a form that relied
on omission to clear must send `null`.
