# @showzy/ai — Agent Instructions

Server-only AI SDK 7 staff loop (ADR-0032, ADR-0033). Owns no domain
state, does not mount HTTP, and never calls `/rpc`. The HTTP mount in
`apps/api` injects `executeAction`.

## One handler, mapped tools

UI and the staff assistant share the same `executeAction` registry name.
They do **not** need the same JSON Schema.

- Named tool façades live only in this package (`src/tool-facades/`).
- A façade always `execute("module.verb", canonicalInput, { toolCallId })`.
  Audit, permissions, timeout, and idempotency stay on the registry name.
- Do **not** add `*ForAssistant` `implementAction` twins, AI-only module
  Zod in `*.contract.ts`, SQL/GraphQL tools, or an MCP/Drizzle path here.
- Do **not** flatten a channel-neutral `*.contract.ts` (discriminated
  `kind`, EntityRef unions) to appease Anthropic. Map a narrower object
  schema in the adapter instead.
- `aiExposure: "exposed"` is a product choice. Composition-only reads
  stay `internal`. Adding an action to the assistant means setting
  `aiExposure: "exposed"` and appending its name to the literal staff
  allowlist in `apps/api/src/composition.contract-check.test.ts`.

Golden façade: `orders.list` → `orders_list_page` + `orders_list_counts`
(SHO-355 input map, SHO-360 output map before clip: compact rows,
cursor-safe paging, explicit `bucketsOmitted`; SHO-403 named `limit`
1–50 default 20 and clip JSON budget 22_000 so a completed page is not
silently row-dropped). Second copy:
`catalog.listProducts` → `catalog_list_products` (SHO-357, compact rows:
id, name, basePriceMinor, currency, status, variantCount). Third copy:
`pricing.listPriceLists` → `pricing_list_price_lists` (SHO-358, compact
rows: id, name, isDefault, isActive, entryCount). Fourth copy:
`customers.listCustomers` → `customers_list_customers` (SHO-381, compact
rows: id, name, phone, email, status, groupId, priceListId; named
assistant `limit` from SHO-360). Fifth copy, deferred:
`customers.listGroups` → `customers_list_groups` (SHO-382, compact
rows: id, name, memberCount, priceListId; not hot). Do not copy kinds.
Do not copy this list façade repo-wide in the same PR. Copy **input map
and output map** for later lists; do not copy T5 input-only façades.
Write copy:
`orders.create` → `orders_create` (SHO-359, named object over EntityRef /
quantity unions). Do not copy this write façade to every write in the
same PR. Do not flatten `create.contract.ts`.

`toProviderToolName("orders.list")` (`orders_list`) is the 1:1 mapping,
not the advertised ToolSet key. Hot names are the façade keys. The 1:1
`catalog_listProducts`, `pricing_listPriceLists`,
`customers_listCustomers`, and `customers_listGroups` keys must not
remain advertised once those façades exist.
`STAFF_ASSISTANT_FACADE_TOOL_NAMES` is those keys for the SHO-471
contract-check (not a second façade set).
`toProviderToolName("orders.create")` is already
`orders_create` — that key stays advertised, with the named object
schema, not the EntityRef union.

## Provider (SHO-508)

Anthropic specifics live in `src/provider/anthropic.ts`. The rest of
`packages/ai` consumes `StaffProviderAdapter`. Adding a provider is
**one file in `provider/`** plus passing that instance from `apps/api`
composition — no other change, no DI container, no adapter registry, and
no new `@ai-sdk/*` package without owner approval.

`apps/api` constructs the adapter once from validated config
(`createStaffAssistantProvider`) and passes it into the HTTP mount.

Zod 4 discriminated unions omit top-level `type`. Anthropic requires
`input_schema.type`. `provider.toolInputSchema` (Anthropic:
`ensureAnthropicToolInputSchemaType`) patches remaining 1:1 union tools.
Object façades already emit `type: "object"` and must not rely on that
patch.

## Speech (ADR-0036)

A turn is three parts: **speech** (`text-*` and
`assistant_messages.body`), **surface** (generic card from the registry),
and **pending** (HITL envelope). Speech never duplicates a surface.

The model streams **plain text**. Do not add `Output.object`,
`experimental_output`, or a `{ spoken }` envelope. Do not parse model
JSON to extract `spoken`, invent a delimiter protocol, or make a second
model call to clean the reply.

`commitTurnSpeech` is the only writer of the visible/persisted line. It
returns `{ source: "model" | "protocol" | "fallback", text }`. `source`
is in-memory (`StaffAssistantTurnResult.speech`); it is not a database
column. `StaffAssistantTurnResult.text` is `speech.text` so persist and
`onTurn` stay one string. Live emit and persist use that string.

Priority: HITL / typed domain-error protocol copy; else usable model
prose; else one locale-keyed generic fallback. A rule-based guardrail
rejects empty text, leftover `{ … }` JSON, and markdown dumps.

`streamStaffAssistantChat` holds candidate `text-*` until that commit
so a tripped guardrail is never briefly shown. Tool progress, result
surfaces, and HITL events keep streaming immediately.

Do not delete a **surface** (registry / cards). Do not add a second
model call to summarize the card. Do not re-introduce a JSON spoken
envelope, a presenter that serializes rows, or live≠persisted replies.

## Gate (SHO-513)

The gate classifies `{ mode: chitchat | capability | job, confidence }`
only. High-confidence chitchat attaches no tools; job, capability, and
fail-open (low confidence / error) attach the full permitted set plus
BM25. It does not force a tool. Call one terminal tool per job; do not
narrate instead of calling.

## Pending interaction (ADR-0035)

Confirmation and choice share one pending-interaction protocol. Pause
writes a discriminated Redis record (`kind: confirmation | choice`) with
server-authoritative canonical input. Resume is HTTP
(`POST /assistant/confirm` or `POST /assistant/choice`) — claim, execute
the stored action, persist, complete — with no model. Core still issues
and consumes the confirmation challenge (hash + bindings). Dismiss is
client-local. Canonical input and challenge ids are not logged at info.
`x-confirmation-challenge-id` on `POST /assistant/chat` is a temporary
adapter for old mobile builds.

## Tests

No live LLM in CI. Inject `MockLanguageModelV3`. Façade tests must prove
the mapped canonical input, compact output before clip, and that
`execute` is called with the registry name plus `toolCallId`. Composition
tests against the real `orders.list` contract live in `apps/api`.
