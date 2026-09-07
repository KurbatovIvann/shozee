# Module ownership and composition map

> Status: Approved by owner, 2026-08-17.
> Normative companion to blueprint §5, scope §6, ADR-0011, ADR-0014,
> ADR-0015, ADR-0020, ADR-0023, and ADR-0028. Feature cards refine this
> map but may not move ownership silently.

## Rules

- Every table has one owner in `packages/db/src/schema/<module>.ts`.
- Only the owning module queries its tables. Synchronous cross-module reads
  use principal-compatible `risk: read` actions through `ctx.call`.
- Cross-module effects use domain events. Rare all-or-nothing writes use only
  declared `ctx.callAtomic` capabilities (ADR-0021). `search` and `analytics`
  may receive explicit read-model grants declared by the owning module; no
  other direct reads.
- Auth and foundation tables are platform-owned, not domain-owned.

## Foundation ownership

| Owner | Tables/capabilities | Boundary |
| --- | --- | --- |
| `packages/db` / better-auth | users, sessions, accounts, verification/OTP tables | Identity only; company authorization belongs to `companies` |
| `packages/core` protocol (physical schema in `db/foundation.ts`) | domain events/deliveries, idempotency keys, audit log | No domain state; module tasks may not change these tables |

## V2 launch domain ownership

| Module | Owns | Main composition |
| --- | --- | --- |
| `companies` | companies, memberships, RBAC roles/overrides, legal requisites, public profile/showcase settings, taxonomy, publication state, company follows/counter | Resolves company targets; exposes public/consumer profile reads and private account follow collections; emits follow/profile events |
| `customers` | company CRM customer records, customer groups/membership, company counterparties, customer legal profiles | Calls `companies` reads where needed; exposes pricing/order/document customer facts; invite accept creates or enriches CRM (ADR-0028) |
| `catalog` | products, variants, categories, media links, publication/active state, fixed-scale product/variant stock balances, product likes/counter, product comments/replies/counter | Resolves product targets; calls `files`; provides declared stock atomic capabilities to orders; exposes public/consumer product reads and private account like collections; emits engagement/catalog events |
| `pricing` | price lists and entries, personal and group price rules | Calls `catalog` and `customers` reads; exposes resolved immutable price facts to `orders` |
| `orders` | carts/items, orders/items, order log, fixed `company_statuses` | Calls catalog/customer/pricing reads; emits order lifecycle events; consumes payment/delivery status events |
| `payments` | payment records, order/document links, provider references, payment status machine | Consumes order/document events; emits payment lifecycle events; future `acquiring` integrates through events |
| `chat` | conversations, participants, messages/reactions, order-card link (`orderId` only) | Consumes order/document events; never owns or copies authoritative order/payment/document status |
| `documents` | documents/items, immutable totals/requisite snapshots, numbering sequences | Calls order/customer/company reads; emits document lifecycle events |
| `doc-generation` | generation jobs and generated-artifact links | Consumes document generation requests; uses `files` for artifacts |
| `doc-signing` | signing requests, signatures, ASiC-E artifacts, verification results | Consumes document events; QES keys never leave the client |
| `delivery` | shipment records and Nova Poshta dictionaries/sync state | Consumes order requests; emits shipment/tracking status |
| `reference-data` | global KVED/CPV classifiers and import metadata | Read-only actions for companies/customers/documents |
| `notifications` | notification intents/deliveries/preferences/device registrations | Consumes domain events; launch families are chat/order/document-signing; followed-company product updates are later opt-in |
| `invites` | invite tokens, redemption/expiry state (customer-entry only; not staff/team) | Calls companies/customer writes on accept so CRM is created or enriched with the token’s group and price list (ADR-0028); emits invite lifecycle events |
| `files` | attachment metadata, ownership links, upload/finalization state | Object bytes live in S3 (Garage locally, R2 in prod); exposes signed-upload/finalize actions |
| `feature-flags` | flag definitions and company overrides | Exposes reads; future subscriptions update it through events |
| `search` | Global FTS/trigram discovery projections for published companies/products and public counters | Consumes events or declared read-model grants from `companies`/`catalog`/`orders`; owns no domain authority or pricing data; exposes declared public-global and consumer reads (ADR-0020) |
| `assistant` | AI conversation/tool-run persistence | Stores action/tool IDs and results; never duplicates domain state as a projection or source of truth. `assistant_tool_runs.model_trace` is ADR-0034 prompt state (bounded post-clip façade output; no client renders it) |

## Post-launch ownership

- `acquiring` owns provider onboarding, Mono webhook deliveries,
  fiscalization, and provider-specific records; it never becomes the payment
  source of truth.
- `banking` owns bank connections, statements, transactions, matching, and
  accounting ledger foundations.
- `subscriptions` owns plans/billing/subscription state and updates
  `feature-flags` through events.
- `analytics` owns dashboard projections only when a useful post-launch
  dashboard is approved; no launch placeholder is required.

## Ownership gate

A `/feature` card must name its tables, actions, emitted/consumed events,
`ctx.call` targets, and read-model grants against this map. A conflict
requires a human-approved ADR before the feature starts. Do not invent a
module spec to resolve the conflict.
