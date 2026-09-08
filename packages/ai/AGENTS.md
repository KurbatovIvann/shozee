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

## Speech (ADR-0036 / ADR-0037)

A turn is three parts: **speech** (`text-*` and
`assistant_messages.body`), **surface** (generic card from the registry),
and **pending** (HITL envelope). Speech never duplicates a surface.

The model streams **plain text**. Do not add `Output.object`,
`experimental_output`, or a `{ spoken }` envelope. Do not parse model
JSON to extract `spoken`, invent a delimiter protocol, or make a second
model call to clean the reply.

Until T5 there are two hosts:

- **Live** `streamStaffAssistantChat` — `commitTurnSpeech` is the writer.
  Priority: HITL / typed domain-error protocol copy; else usable model
  prose; else locale-keyed fallback. Guardrail rejects empty text,
  leftover `{ … }` JSON, and markdown dumps. `source` is in-memory.
  `streamStaffAssistantChat` holds candidate `text-*` until that commit
  so a tripped guardrail is never briefly shown. Tool progress, result
  surfaces, and HITL events keep streaming immediately. Do **not** apply
  hold-candidate to the test-only host.
- **New** `runStaffAssistantHostTurn` (`src/runtime/`, ADR-0037) —
  tests invoke this loop directly. Do **not** retarget
  `POST /assistant/chat`. Usable model prose is the bubble. Guardrail
  rejects leftover `{ … }` JSON only — not `**`, and not markdown
  tables. Do not use `presentOrderCreatedSpeech` or catalog domain-error
  copy as the winner. `commitHostSpeech` does not call `commitTurnSpeech`.
  The new loop must not call the gate. It default-attaches the permitted
  tool set plus BM25 (`staffAssistantTools`); “давай ще один” still has
  tools. The system prompt is identity, language, HITL/safety, and card
  style — not a module how-to dump and not a speech-rewrite instruction
  for tables or `**`. `source` stays in-memory.
  Optional `checkpoint` is `begin` → `stageRun` (mint `executionId`) →
  execute with that id → `finishRun` → `complete` (SHO-521). Do not use
  a model `toolCallId` as the retry key.

Do not delete a **surface** (registry / cards). Do not add a second
model call to summarize the card. Do not re-introduce a JSON spoken
envelope, a presenter that serializes rows, or live≠persisted replies.

## Gate (SHO-513 / SHO-523)

The live `/assistant/chat` host still classifies
`{ mode: chitchat | capability | job, confidence }` until T5.
High-confidence chitchat attaches no tools; job, capability, and
fail-open (low confidence / error) attach the full catalog plus BM25.

The **new** host (`runStaffAssistantHostTurn` / unpublished
`createStaffAssistantHostApp`) does not construct or call that
classifier. It always attaches the permitted tool set plus BM25. Do not
replace the gate with another classifier. Keep `gate.ts` while the old
host imports it.

It does not force a tool. Call one terminal tool per job; do not
narrate instead of calling.

## Tests

No live LLM in CI. Inject `MockLanguageModelV3`. Façade tests must prove
the mapped canonical input, compact output before clip, and that
`execute` is called with the registry name plus `toolCallId`. Composition
tests against the real `orders.list` contract live in `apps/api`.
