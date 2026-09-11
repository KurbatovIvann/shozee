# Shozee 2.0 — Architecture Blueprint

> Approved target architecture, technology stack, and feature pipeline.
> Shipped behavior is recorded by current code/tests and Linear; this is not
> a deployment inventory. Documentation map: [README](README.md).
> Status: approved. Date: August 2026.
> Sources: audit of Showzy V1 (apps/api ~36k lines, apps/web ~119k,
> apps/mobile ~58k, 77+ tables, 83 migrations, ~240 RLS policies).

---

## 1. Product

Shozee is a business operating platform for small businesses in Ukraine with
a public and authenticated consumer discovery surface plus bounded social
engagement (ADR-0020). It is not a people-discovery network or multi-seller
checkout marketplace. It replaces the zoo of services a micro-business
juggles (Instagram + Telegram + spreadsheets + Taxer) with a single app. The
reference user is a home confectionery.

- **Company profile** with a catalog and flexible pricing (5 levels: personal price → client price list → group price list → default price list → base price). Validated on a real case: separate prices for coffee shops, regular customers, and loyal customers.
- **Canonical flow (destination):** customer → company profile → cart → checkout (account required) → **redirect to chat** with an order card. The company confirms/edits/cancels the order in chat. **Chat is the operational core of the destination product.** Launch sequence, including owner-first panel-before-cabinet, is `docs/scope.md` — do not treat the destination flow as the first-release build order.
- **B2B add-on**: a customer with a legal profile (sole proprietor / legal entity) gets document workflow — contracts, invoices, delivery notes, **QES signing** (DSTU, ASiC-E) — the private key never leaves the device. Owner-first launch ships documents from **staff** orders with share via link/QR/print; two-sided signing in the customer cabinet is customer expansion.
- **Two management surfaces**: company panel (owner-first launch) and customer cabinet (customer expansion).
- **Consumer engagement**: company follows, product likes/comments, private
  Following collections, and public counters; no public social graph.
  Destination product; not owner-first launch UI.
- **Integrations**: Nova Poshta (customer-checkout expansion); Monobank acquiring + bank statements as the foundation of accounting (post-launch), Resend, SMS.
- **AI assistant** with tool calling — at parity with the UI (panel first).
- **Client strategy: mobile-first** (panel, then cabinet). Web is a post-launch phase, with universal links.

Full scope analysis (what we carry over / simplify / drop) and the roadmap:
`docs/scope.md`.

### Rewrite goal

**AI-first interface**: two parallel interfaces — a classic UI and an AI chat —
that perform **the same actions** (ADR-0008). The AI can show data in chat, open
modals, fill forms, execute operations. Development follows the feature loop
(ADR-0023): 90–100% of the code is written by AI agents.

**Same actions means task-complete jobs (ADR-0033), not screen widgets.** A
staff list answers a bounded question (a page **or** a server aggregate)
without N+1 `get` and without JSON clipping as truth. A write accepts a
stable id or a unique human reference. Cross-module user jobs stay several
writes (customer, then prices, then order) — never a workflow mega-action.
`aiExposure: "exposed"` is a product choice; composition-only `ctx.call`
reads are not tools. Lists grow by additive filter fields, not new public
action names.

### V1 problems that motivated the rewrite

1. **Two data paths**: clients hit Supabase directly (CRUD via PostgREST + ~240 RLS policies + 79 RPCs) and NestJS in parallel (chat, documents, payments, AI). Logic is smeared across RLS, triggers, RPCs, and the API.
2. **No shared contract**: DTOs are hand-duplicated in web and mobile (`documents-api.ts` vs `get-panel-documents.ts`).
3. **Vendor lock-in on Supabase** (Auth, Storage, PostgREST, typegen).
4. **The AI assistant is ad-hoc**: its own tool set, disconnected from UI actions.

---

## 2. Architectural principles

1. **One data path.** All business logic goes through the API only. Clients never touch the DB directly. RLS disappears; authorization lives in code.
2. **The action registry is the single source of truth.** Every business operation has a client-safe `defineActionContract` descriptor and a server `implementAction` binding (ADR-0016). The descriptor drives transport, validation, permissions, and protocol requirements. Exposed AI tools may map their schema in `packages/ai` (ADR-0033); both channels execute the same handler.
3. **Interface parity is guaranteed physically**: the classic UI and the AI call the same handler.
4. **Explicit code, no magic.** No decorators with hidden behavior, no DI containers, no "default" conventions. An agent must see the whole flow in the code.
5. **Static guarantees above all.** TypeScript strict end-to-end: DB schema → types → API contract → clients → AI tools. An agent's mistake = red CI, not a bug report.
6. **Human-in-the-loop for the irreversible.** QES signing, payments, deletions — the AI prepares, a human confirms.
7. **Modular monolith.** Clear module boundaries (ESLint boundaries), shared DB, one deployment. Microservices — no.

### 2.1 Foundation invariants (part of phase 0 definition of done)

These are not "best practices for later" — they are entry criteria verified by
tests before any domain module is built:

1. **Tenant isolation.** It must be impossible for a business action to read or write another company's data. Tenant scope is derived by core from verified staff membership, a typed customer/public target resolver, explicit system scope, or null company for `consumer` and declared public global discovery projections (ADR-0013, ADR-0018, ADR-0020) — never accepted from input as an access grant. Verified by an automated cross-tenant test suite that every module inherits. This is what replaces the deleted ~240 RLS policies: code + tests instead of DB policies.
2. **Idempotency.** Order creation, payments, document generation, Nova Poshta calls, webhooks, and AI-invoked actions are safely retryable (idempotency keys where needed). Retries come from everywhere: workers, webhook redelivery, the AI loop.
3. **Money model: immutable snapshots.** An order item stores `unitPriceSnapshot`, `quantity`, `discountSnapshot`, `taxSnapshot`, `total` captured at creation time. An old order is never recomputed from current pricing. Critical given 5-level dynamic pricing and future accounting built on real transactions.
4. **Observability / audit.** Every authorized tenant-scoped action carries `request_id`, accountable `actor_id` (user or system), invocation `channel` (`ui`/`ai`/`system`/`webhook`), resolved `company_id`, and `action`; declared global system work has null company. Unauthenticated public reads use synthetic log actor `anonymous` and cannot emit domain events or durable audit rows. `audit: true` actions write an audit record. AI is a channel acting on behalf of a user, not an independently accountable principal. Non-negotiable because actions will be invoked by AI.
5. **Projections never own domain state.** Chat is the primary interaction surface for orders, but the order domain is the source of truth: an order card in chat is a projection updated by domain events (`orders.confirm` → `orders.confirmed` → card update). A chat message stores `orderId`, never order status. `orders` does not know chat exists — it emits events; `chat` subscribes and materializes cards. The same rule applies to every future projection (dashboards, notifications, analytics).

---

## 3. Technology stack (final)

| Layer | Technology | Rationale |
| --- | --- | --- |
| Runtime | **Node.js 22 LTS + TypeScript (strict)** | The whole ecosystem (UAPKI WASM, Puppeteer, Socket.IO) is proven on Node |
| Monorepo | **Turborepo + pnpm** | Already works; shared packages are critical for agents |
| HTTP framework | **Hono** (`@hono/node-server`) | Minimal, fetch-native, explicit. SSE, raw body, streaming proxy — out of the box. Heavy stuff (Puppeteer, WASM, queues) lives outside the framework |
| API contract | **oRPC** | End-to-end types for web/mobile + OpenAPI autogeneration. Kills the hand-written DTO duplicates |
| Database | **PostgreSQL 17** (self-hosted) | Extensions: pg_trgm + unaccent. Scheduled work moves to BullMQ, so pg_cron is dropped with v1 invite/analytics jobs; pgvector/pg_partman return only if their dropped features return |
| ORM / migrations | **Drizzle ORM + drizzle-kit** | Schema in TypeScript = source of types; SQL-like API without magic; versioned migrations |
| Auth | **better-auth** | Self-hosted TS library: email/phone OTP, sessions, native Drizzle integration |
| Storage | **S3-compatible** (Garage locally → Cloudflare R2 in prod) | Replaces Supabase Storage; signed URLs work the same. ADR-0027 |
| Queues | **BullMQ + Redis** | Decision revised after the audit: Redis is mandatory anyway (Socket.IO adapter, cache, leader election), and patterns for 7 queues are already established |
| Realtime | **Socket.IO + Redis adapter** | Carried over from the current system almost unchanged |
| Reliable events | **Transactional outbox** (`domain_events` + `FOR UPDATE SKIP LOCKED` + LISTEN/NOTIFY) | Already implemented correctly — carried over |
| Validation | **Zod v4** | One schema: form → API → AI tool → DB boundary |
| AI | **Vercel AI SDK 7** (`ai` + one `@ai-sdk/<provider>`) — ADR-0032 | Thin model/stream/tool loop over the action registry. Provider-agnostic. Not a coding harness |
| Mobile | **Expo + expo-router + Unistyles** — **primary client** | Mobile-first: all V2 functionality (panel + customer cabinet + AI chat) in the app |
| Web panel | **Vite SPA + TanStack Router** (`apps/web`) — ADR-0030 | Staff panel per the web canvas: typed multi-level routing, static deploy behind a same-origin proxy to `/rpc` + `/api/auth` |
| Web storefront | Separate later app (framework chosen in that phase) — ADR-0030 | Storefront by link (SEO/SSR), consumer cabinet; needs the `consumer`/`search` API surface first |
| Web UI | **Tailwind 4 + react-hook-form** + selectively vendored shadcn/ui (Radix) primitives | Magic Patterns tokens are the theme source; shadcn only for behavior-heavy primitives (ADR-0030) |
| QES | **`@showzy/document-signing`** (UAPKI: WASM web/node, Nitro native) | The verified crypto core carries over unchanged (bindings, ASiC-E, tests, signing vectors); the integration surface (storage, auth context, module wiring) is re-audited against the new architecture |
| PDF | **Puppeteer** + React SSR of Plate documents | Carried over |
| Logs / tracing | **pino + OpenTelemetry + Sentry** | Structured logs with request-id from day one |
| Tests | **Vitest** (unit/integration) + **Testcontainers** (Postgres in tests) + **Maestro** (mobile e2e) + Playwright (web phase) | Agents must have a fast local feedback loop |
| Deployment | **Docker Compose** locally → VPS (Coolify) | No vendor lock-in; horizontal API scaling + separate workers |

### What we deliberately do NOT take

- **Supabase** — decomposed (Postgres + better-auth + S3 + Socket.IO + app-level permissions).
- **NestJS** — decorators/DI hide the flow from agents; all the value (guards, pipes) is reproduced by the action registry in ~10× less code.
- **Encore** — framework-shaped vendor; our workload (Socket.IO, Puppeteer, WASM) does not fit its managed-primitives model. But its lesson is taken: durability decisions are fixed by the architecture, not by the agent.
- **tRPC** — oRPC gives the same + OpenAPI for external consumers.
- **RLS** — authorization only in code (`defineActionContract.permissions`); the `has_company_permission` model is carried over conceptually 1:1.
- **Microservices, GraphQL, event sourcing** — needless complexity for a team of agents.
- **Coding / agent harnesses** (DeepSeek Harness, Claude Agent SDK, Google ADK, Mastra as a second runtime) — the model’s environment is the staff action registry, not a shell or filesystem (ADR-0032). Vercel AI Gateway is not a required path; keys stay in `packages/config`.

---

## 4. The core: action registry

The descriptor is client-safe (`@showzy/core/contract`); `implementAction`
binds server callbacks; `executeAction` applies the runtime protocols.
See [core §2](specs/core.md#2-the-action-contract) for mandatory and
conditional metadata and [core §4](specs/core.md#4-execution-pipeline) for
execution order.

Use checked-in examples rather than a second schema in this blueprint:

- [orders.create contract](../packages/modules/orders/src/actions/create.contract.ts)
  and [implementation](../packages/modules/orders/src/actions/create.ts):
  staff write with human references, snapshots, audit, and events.
- [orders.list contract](../packages/modules/orders/src/actions/list.contract.ts):
  bounded pages and aggregates (ADR-0033).
- [AI adapters](../packages/ai/AGENTS.md): mapped input/output over the same
  registry action, without a second domain API.

Risk and confirmation are declared per action. `read`, `draft`, `write`,
and `high` describe execution policy; they do not imply that every action
is an exposed AI tool. High-risk operations use the confirmation protocol
in [core §7](specs/core.md#7-confirmation-protocol-requiresconfirmation).
QES private keys stay on the device.

### Client-side AI UI tools (destination, executed on the client)

The names below illustrate intended interactions, not a list of currently
registered tools. Check `packages/ai` and the app adapters for shipped support.

- `ui.navigate(route)` — go to a page
- `ui.openModal(modal, props)` — open a modal/form
- `ui.prefillForm(formId, values)` — fill a form (the user sees and confirms)
- `ui.highlight(elementId)` — highlight an element
- Generative UI: tool results render with the same components as the classic UI (order card, product list, document).

### Human-in-the-loop

QES signing, payment execution, irreversible deletions: the AI calls a
preparatory action → the UI shows a confirmation → the user performs the final
step. The QES private key is physically inaccessible to the server and the AI.

---

## 5. Monorepo structure

```
showzy/
├─ apps/
│  ├─ api/            # Hono: mounts the oRPC router + webhooks + SSE + Socket.IO
│  ├─ worker/         # BullMQ processors, outbox poller, cron (separate process)
│  ├─ mobile/         # Expo — primary client (V2 launch)
│  └─ web/            # Vite SPA + TanStack Router — staff panel (ADR-0030)
├─ packages/
│  ├─ core/           # action descriptors/runtime, registry, contexts, event protocols
│  ├─ db/             # Drizzle schema (source of types), migrations, seed
│  ├─ contract/       # oRPC router generated from the action registry
│  ├─ modules/        # domain modules (see §6) — actions + services + events
│  ├─ ai/             # AI SDK 7 loop, system prompts, UI tools, generative mappings (ADR-0032)
│  ├─ document-signing/  # UAPKI (crypto core carried over; integration re-audited)
│  ├─ validation/     # shared Zod schemas (carried over, extended)
│  ├─ copy/           # client-safe staff copy shared by mobile and web
│  ├─ module-kit/     # server module micro-utilities (ADR-0031)
│  ├─ ui/             # shared design tokens/types for web+mobile
│  ├─ config/         # validated runtime env (Zod-parsed process.env; no secrets in code)
│  └─ tooling/        # eslint presets (boundaries!), tsconfig, prettier
├─ docs/
│  ├─ blueprint.md              # this document
│  ├─ specs/          # protocol manuals for frozen foundation packages
│  ├─ archive/        # humans only; agents must not open (ADR-0033)
│  └─ plans/          # historical breakdowns; new work is Linear feature cards
└─ .claude/          # Claude Code harness (ADR-0040); CLAUDE.md imports AGENTS.md
   ├─ rules/          # constitution (prohibitions + conventions), DoD, path-scoped area rules
   ├─ skills/         # /feature /ticket /conveyor /verify /review-pr /guard /scaffold + code-pattern skills
   ├─ agents/         # implementer, reviewer, guardian, ci-triage
   └─ scripts/        # verify.mjs (local CI parity), merge-gate.mjs
```

### Domain modules (packages/modules/*)

**V2 launch:** `companies` (company/team/RBAC/profile/publication, business
categories, follows) · `customers` (CRM/groups/counterparties/legal profiles) · `catalog`
(products, variants, categories, likes, comments) · `pricing` (five-level
rules) · `orders` (carts, snapshots, log, fixed statuses) · `payments`
(invoice/manual) · `chat` · `documents` · `doc-generation` · `doc-signing` ·
`delivery` (Nova Poshta) · `reference-data` · `notifications` · `invites` ·
`files` · `feature-flags` · `search` (public/consumer FTS/trigram projections)
· `assistant`.

**Post-launch:** `analytics` (only when a useful dashboard is defined) ·
`acquiring` · `banking` · `subscriptions`.

Exact table/capability ownership and sanctioned composition edges are tracked
in `docs/module-ownership.md`; feature cards and executable contracts
refine but may not silently move these boundaries.

Boundary rule: a module's server barrel exports only actions/events and its
client-safe barrel only descriptors. Directly importing another module's
internal files is an ESLint error.

---

## 6. Key data migration decisions

| What | Decision |
| --- | --- |
| DB schema (77+ tables) | **Not** carried over 1:1. Every object appears in the v1→v2 migration matrix as keep/transform/drop and maps to one owning V2 module; text+CHECK is preferred over enums |
| ~240 RLS policies | Deleted. Logic → `permissions` on actions. The largest rethinking effort |
| ~79 RPC functions | Rewritten as ordinary module functions on Drizzle (transactions in code) |
| ~82 triggers | A conscious decision for each: technical ones (updated_at, counters) stay in the DB; business logic (numbering, auto-statuses) moves up into code |
| Outbox (`domain_events`) | Protocol carried over and hardened: SKIP LOCKED + LISTEN/NOTIFY dispatch, per-consumer delivery/dedup/retry state |
| Storage buckets | v1 four buckets collapse to one `S3_BUCKET`; prefixes in the object key, metadata in the DB (ADR-0027) |
| `database.types.ts` (typegen) | Disappears — types are born from the Drizzle schema |
| Auth users | Export from Supabase Auth → import into better-auth (phones/emails preserved) |

The object-level ledger and per-module completion gate live in
`docs/reference/v1-migration-matrix.md`. A domain schema task cannot start
while its source rows are `REVIEW` or lack the required column mapping.

---

## 7. Feature pipeline

Day-to-day process is ADR-0023. Constitution (this document §2–§6, accepted
ADRs, prohibitions) does not change when a feature ships. The executable
contract of a feature is `*.contract.ts` plus the required tests — not a
module markdown novel.

### 7.1 Work loop

```
PLANNER → EXECUTOR → VERIFIER → GUARDIAN (optional)
(human+agent)  (agent)    (CI + agent)   (sensitive / first slice)
```

Optional: `/conveyor` on a **feature parent** runs a parent orchestrator
that launches those roles per child (ADR-0029). The parent does not
implement.

1. **Planner** (`/feature`). Human names a user-visible capability. The
   agent produces a Linear feature card, a ticket graph, and a 5–15 file
   context pack. Contested APIs get a contract-first `*.contract.ts`
   ticket. No `docs/specs/<module>.md`. Product forks stop and ask.
2. **Executor** (`/ticket` on a **leaf**, or an `implementer` subagent
   launched by `/conveyor`). One executor per ticket, one branch, one draft
   PR. Copies the **golden files for that layer**. Runs the verify loop
   (`node .claude/scripts/verify.mjs`) until CI-equivalent checks are green.
   Tests follow the definition of done — not a red-then-green ritual.
3. **Verifier.** CI always. `reviewer` subagent in `bugs` mode on routine,
   `full` mode on sensitive, first-slice, and UI PRs. Rubric is
   constitution, ADRs, golden fidelity, feature card, real tests — not an
   archived spec section. On a parent conveyor, the parent launches it.
4. **Guardian** (`/guard`, optional). Sensitive surfaces, the first
   golden backend or UI slice, first use of a new principal or composition
   edge. Architecture/security pass. ADR deviation is a stop.
5. **Golden slices.** Patterns are locked in TypeScript, not in novels.
   The first merged backend slice (schema + read action + write/event if
   needed + tests) is the API template. A golden UI slice (one panel
   screen) waits on the Experience Foundation UX gate. Agents copy by
   layer — not API+UI in one blob. The Encore lesson stands: an agent on
   an empty framework invents anti-patterns.
6. **CI.** Merge policy requires green: format + secret/dependency
   checks → `tsc --noEmit` → ESLint (boundaries, no `any`, no foreign
   module internals) → Vitest (unit + integration with Testcontainers
   Postgres) → action/event contract checks (mandatory metadata including
   `principal`/`transport`, pairing, resolver and event definitions) →
   migration drift/safety → e2e smoke: Playwright against the built web
   panel (SHO-331); Maestro once mobile screens exist. A parent conveyor
   squash-merges a child when those Actions jobs are green and the
   parent-launched `reviewer` / `guardian` subagents for the lane have no
   blocking findings (a launched `reviewer` must APPROVE with nits
   already applied on that branch).
   A leaf `/ticket` without a parent still does not merge itself.
   Actual GitHub enforcement and its accepted limitations are documented
   in [branch protection](operations/branch-protection.md); policy is not
   proof that repository settings enforce every gate.

Leftover phase 0–1 foundation work may still use `/scaffold` on the
allowlisted packages. New domain work uses `/feature`.

### 7.2 Rules for agents (`.claude/rules/`)

- **Code conventions**: action naming (`<module>.<verb>`), module structure, error style (typed, no bare `throw new Error`).
- **Prohibitions**: raw SQL outside approved Drizzle/foundation exceptions; DB access outside a handler/service/typed target resolver; `any`/`as unknown as`; new dependencies without approval; changing `packages/core` in module tasks; silent product forks.
- **Definition of Done**: required tests for every action (happy + mode-appropriate authorization denial + validation/output failure + metadata-required protocols), proving tests for schema/config, feature-card acceptance, green CI.
- **Context**: every package has an `AGENTS.md` with local instructions (as in the current repo). Feature executors read the ticket's context pack, not every package manual.

### 7.3 Model selection

Roles use the Claude model that fits the job (ADR-0040): Opus for the
planner, the parent orchestrator, sensitive / first-slice executors, and
the independent `reviewer` / `guardian`; Sonnet for mechanical, routine,
and UI executors; Haiku for CI log triage. The per-role table and the token
economy rules live in `docs/pipeline.md`.

Independent review is CI plus the `reviewer` / `guardian` subagents the
lane requires, and either a human merge (leaf `/ticket`) or a
parent-conveyor squash-merge (ADR-0029).

Practice in Claude Code: feature cards — plan mode `/feature`;
implementation — `/conveyor SHO-<parent>` for the whole graph (one
`implementer` per child in its own worktree), or `claude -w sho-<n>` +
`/ticket SHO-<n>` for a single leaf; review — `reviewer` from the parent
or `/review-pr`; safety — `guardian` / `/guard` when the lane requires it.
See `docs/pipeline.md` for the day-to-day workflow including Linear.

### 7.4 Pipeline health metrics

- % of PRs merged without human edits (target: >80% after the golden backend slice stabilizes).
- Number of review iterations per PR (target: ≤2).
- Time from feature card to green CI.
- Regressions reaching main (target: ~0 — caught in CI/review).

---

## 8. Roadmap (mobile-first)

Detailed roadmap with readiness criteria: `docs/scope.md` §7.
Condensed view (owner-first first; numbered expansion phases are not first-release work):

| Phase | Contents | Result |
| --- | --- | --- |
| **0. Foundation** | Monorepo, CI, Docker Compose (Postgres+Redis+Garage), core/db/contract, better-auth, API/worker + Expo skeleton, minimal Universal/App Links, payment + feature-flag skeletons, security/operations baseline, **foundation invariants (§2.1) verified by tests** | A skeleton on which agents can work in parallel |
| **1. Reference slices** | Merge approved minimal prerequisite schemas, then pricing resolution + a thin order → outbox → **order-card projection** (not the chat platform) | Query and transactional/event templates to copy + a proven pipeline |
| **‖ Experience Foundation** | Magic Patterns canvas → Unistyles theme/primitives for the **panel**. V1 is domain reference, not visual acceptance (ADR-0024). Figma is not a gate. AI is the center tab | Panel UX gate passed |
| **2. Company operating core** | `companies`, `catalog` (with variants), `customers`/groups, `invites`, `pricing` full UI + mobile **panel** screens | Company and catalog created from a phone |
| **5a. Staff commerce** | Staff `orders.create`/`confirm`/`get`, push, no customer checkout | The owner records an order in the panel |
| **8. Documents + QES** | `documents`, `doc-generation`, `doc-signing` + share (link/QR/print) + mobile-editing spike | Owner generates, signs, and hands over a document |
| **9. AI experience** | `packages/ai` (AI SDK 7, ADR-0032) over the action registry; classic/AI parity in the panel | AI performs the same actions as the UI |
| **🚀 Owner-first production** | Clean-database bootstrap, panel parity, internal rollout → stores | The owner starts on V2 without V1 data migration |
| **3–4, 5b, 6–7. Customer expansion** | Presence, discovery, customer checkout, chat platform, order collaboration | The §1 destination flow; see `docs/scope.md` §7 |
| **10. Web** | `apps/web` panel SPA (ADR-0030): full panel + Plate template editor; storefront (SEO) + cabinet follow as a separate SSR app | Orders without the app |
| **11. Acquiring** | `acquiring` on top of the ready payment abstraction | Online payment |
| **12. Bank + accounting** | `banking`: statements, matching; income ledger on real transactions (Taxer replacement) | Ledger from bank transactions; tax filing is later |

Documents (8) precede the chat platform (6). Do not implement phases 6–7 as
owner-first work.

---

## 9. Scaling (built in from day one)

- API — stateless, horizontal scaling behind the Socket.IO Redis adapter.
- Workers — a separate process (`apps/worker`), scales independently; Puppeteer lives only there.
- Postgres — vertically + a read replica for analytics/search when needed.
- L1 cache (memory) + L2 (Redis) — pattern from the current system.
- Rate limiting on actions (especially AI calls) — in the core action execution pipeline (`packages/core`), designed in the core spec.
- Structured logs with `request_id`/`action`/`companyId` — correlation from HTTP to worker.
