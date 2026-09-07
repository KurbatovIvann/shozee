# Shozee 2.0 — Scope and Roadmap

> Review of the current system's functionality: what we carry over, simplify,
> defer, and drop. Companion to `blueprint.md`.
> Status: approved by the owner (2026-08-17). Contentious decisions are marked
> ⚠ — they can be reversed before the start of the phase they affect.
>
> ⚠ **Owner-first launch (2026-08-19):** the first production release is the
> **company panel** (staff/AI). The customer cabinet, public storefront,
> consumer discovery, and the business-chat platform are **customer
> expansion**, not dropped. The §1.1 customer flow remains the product
> destination; it is not the readiness criterion of the first release.

---

## 1. Product positioning

**Shozee is a business operating platform with public/authenticated consumer
discovery and bounded social engagement — not a people-discovery network or
multi-seller checkout marketplace.**

The product was born from real pain: a home confectionery whose communication
and management are scattered across Instagram, Telegram, spreadsheets, and
Taxer. Shozee **replaces this zoo of services** rather than aggregating it.

⚠ **Owner-first launch** ships the company panel only. Three entry paths
into a company remain the **destination** product (ADR-0018, ADR-0020) and
are built in customer expansion, not in the first release:

1. **Discovery** — anyone may browse published companies/products; an
   authenticated user can personalize discovery and engage (ADR-0020).
2. **Invite** — a token/link that creates or enriches a CRM relationship
   on accept (group and price list from the token; ADR-0028).
3. **Direct link** — a Universal/App Link to a specific company profile.

Owner-first intake is staff (and AI over the same actions): the owner
captures an order that arrived outside Shozee (Instagram, Telegram, phone)
into the panel. Cold-traffic web SEO is not a mobile-launch priority.
Public user graphs/activity feeds, embeddings, and GPS-radius discovery
remain dropped.

### 1.1 Canonical order flow (product destination)

⚠ **Not the first-release readiness criterion.** Preserve the architecture
(principals, `orders` as source of truth, chat as projection, ADR-0011).
Do not implement customer checkout, the chat platform, or the customer
cabinet until customer expansion.

```
Customer (sole proprietor or regular) → company profile → cart → order
confirmation → REDIRECT TO CHAT with an order card
```

- Both sides see the order in chat. The company **confirms / cancels /
  clarifies details / edits the order** right in the chat.
- **Chat is the primary interaction surface for orders**, not an extra
  feature. Architecturally, however, the order domain is the source of truth
  and chat is a projection: an order card stores `orderId` and is updated by
  domain events (`orders.confirm` → `orders.confirmed` → card update).
  **Chat never owns order state**, and `orders` does not know chat exists
  (see blueprint §2.1, invariant 5).
- For B2B customers (sole proprietor / legal entity) the same flow + a
  document-workflow add-on: contracts, invoices, delivery notes, QES signing.
  B2B ≠ a separate flow; it is a CRM customer with a legal face
  (counterparty / legal profile) who gets additional actions
  (ADR-0028).
- Two management surfaces **in the destination product**: the company panel
  (owner/staff) and the customer cabinet (own orders, chat, documents).
  **Owner-first launch ships the panel only.** The cabinet is customer
  expansion. Until then, a signed document is handed over by link, QR, or
  print — the counterparty does not need a Shozee account.
- **Orders require an account** when the customer places them in-app (no
  anonymous checkout — owner's decision: security matters more than
  conversion). Staff-created orders in the panel require a CRM customer.

### 1.2 Client strategy: mobile-first, panel first

**Owner's decision: all functionality ships in the mobile app first. Owner-first
launch is the company panel. The customer side of the same Expo app is
customer expansion. Web remains a separate post-launch phase.**

Rationale: the target user (a micro-business owner) lives on her phone, not at
a laptop. Owner-first launch still needs minimal iOS Universal Links / Android
App Links for QES callbacks and document-share links: open the installed app,
otherwise show a small install landing page. Invites, public company links,
and order/chat notifications arrive with customer expansion. Phase 10 (web)
adds the full "open the app or continue in the browser" experience.

A consequence to accept consciously: at owner-first launch, document template
customization is limited (the Plate editor is a desktop-grade thing). Launch
runs on default templates with requisites substitution; full editing arrives
with the web phase or with a mobile editor after the research spike (see §9).

---

## 2. CORE — carried over

### 2.1 Owner-first launch (mobile panel)

| Functionality | Notes |
| --- | --- |
| Companies, team, RBAC, legal requisites (sole proprietor / legal entity) | The permission model carries over 1:1 into action permissions |
| Catalog: products, categories, images, **variants** | ⚠ Variants stay in owner-first launch — a basic catalog need |
| **Pricing: 5 levels** (personal → client price list → group price list → default price list → base) | Confirmed by the owner on a real case: separate prices for coffee shops, regular and loyal customers. One of the pipeline's two reference slices |
| Customers (CRM), groups, invites | Staff add/invite customers. Invite accept creates CRM. Counterparties are the legal face, linked to a customer when one exists (ADR-0028). Discovery and direct-link intake are customer expansion (ADR-0018) |
| **Staff orders** | Panel (and AI over the same actions) creates/confirms/gets orders for a CRM customer. Action log. No customer checkout in this release |
| Documents: default templates, numbering, PDF generation | Puppeteer worker. Template customization — post-launch (§1.2) |
| **QES signing** (ASiC-E, mobile Nitro + node verify) + pki-proxy | `@showzy/document-signing`: the verified crypto core, tests, and signing vectors carry over unchanged; the integration surface is re-audited against the new architecture |
| Document share | Owner signs and hands over a link, QR, or print. Counterparty need not have a Shozee account |
| **Expo push** | The owner must see a new order in the panel instantly. Finish device registration (unfinished in 1.x). Socket.IO chat realtime is customer expansion |
| Notifications: in-app + push + email (Resend) + SMS (OTP) | Owner-facing in this release |
| KVED/CPV classifiers | Static data, needed for legal requisites |
| **AI layer**: assistant over the action registry, UI tools, generative UI | In the panel from owner-first launch (in 1.x it was web-only). Human confirms before an order or document is committed |

### 2.2 Customer expansion (same product, later)

Not dropped. Architecture (principals, publication, chat as projection) is
defined as destination scope by the accepted ADRs. Do not implement as owner-first launch work.

| Functionality | Notes |
| --- | --- |
| Public discovery + engagement | Public company/product/comment reads; authenticated follows, likes, comments, and private Following collections (ADR-0020) |
| Company profile as storefront + cart + checkout | Account required (OTP). Payment — by invoice until acquiring (see §4) |
| **Orders + chat — one vertical slice** | Checkout → redirect to chat; confirm/edit/cancel in chat. Chat never owns order state (blueprint §2.1, invariant 5) |
| Customer cabinet | Own orders, chat, documents |
| Socket.IO realtime chat | Conversations, messages, presence |
| Nova Poshta in checkout | City/branch/street search + reference-data sync — with customer checkout, not with staff-only orders |

---

## 3. SIMPLIFIED

| Was | Becomes in 2.0 | ⚠ |
| --- | --- | --- |
| Custom status engine: workflow templates, transitions, automations | A fixed set of order statuses + simple auto-transitions from payment/delivery. The full constructor — a separate phase after launch, if there is demand | ⚠ |
| Analytics: partitioned event pipeline (pg_partman, queue, daily aggregates) | No launch dashboard or placeholder. Add a focused post-launch projection only after useful metrics are approved | |
| Search: FTS + trigram + pgvector embeddings (OpenAI) | FTS + trigram only. No embeddings, no embedding queue | |
| Subscriptions: plans + billing + feature flags | Only a feature-flag skeleton (toggling features). Billing — after launch | |
| Admin area (templates, delivery) | Minimum: seed default document templates via migrations; a full admin area — with the web phase | |
| Auth hooks (custom OTP delivery for Supabase) | Disappears as a module — it's just provider config in better-auth | |

---

## 4. DEFERRED (needed, but not in owner-first launch)

| Functionality | When | Rationale |
| --- | --- | --- |
| **Customer expansion** (public profile/showcase, discovery, customer checkout, chat platform, order collaboration in chat, customer cabinet) | After owner-first production; see §7 | Architecture stays (ADR-0013, ADR-0018, ADR-0020, chat as projection). UI and the chat platform are not first-release work |
| **Web version** (storefront by link, customer cabinet, full panel, desktop template editor) | Phase 10 — after customer expansion has a contract | Owner's decision: mobile-first. Web sits on the same oRPC contract — no logic is rewritten, only UI |
| ⚠ **Mono acquiring** (online payment + fiscalization) | Phase 11 | Owner-first payment is invoice-as-document. **Phase 0 requirement:** a `payments` module owns payment records/status and the provider interface; orders link to payment IDs and react to payment events, so acquiring plugs in without changing core |
| **Monobank statements + accounting** | Phase 12 | Status elevated: statements are the **foundation of future accounting** (income ledger, tax reporting — a Taxer replacement). Accounting is built on real bank transactions, not on orders. **Phase 0 requirement:** financial data (amounts, currency, payment↔order↔document links) is designed carefully from day one. Not in the documents slice |
| Mobile document template editing | Research spike in parallel with the documents phase (see §9) | Owner: "would be really cool, but technically hard" |
| DOCX export of documents | On user demand | PDF covers the main case |
| Company verifications | Together with billing | |
| Full workflow-status constructor | On demand | See §3 |

---

## 5. DROPPED

| Functionality | Volume that disappears | Why |
| --- | --- | --- |
| **Meta messaging** (Instagram/Messenger) | The channels module: webhooks, Graph API, per-minute cron import, meta-message queue, `messaging_contacts` and `meta_data_deletion_requests` tables, rawBody verification, Meta compliance | Owner's decision + the replacement strategy (§1). The system's largest external dependency; chat becomes single-channel and drastically simpler |
| **Public social graph / activity feed** | User discovery, follower/liker identity lists, public activity feed | V2 retains public counters and private own-user collections, not people discovery |
| **GPS-radius discovery** | Near-me/radius ranking and distance UI | City/area filters remain |
| **Embeddings + pgvector** | OpenAI queue, HNSW indexes, embedding columns on 3 tables | Served the marketplace's semantic search; FTS + trigram is retained for discovery |
| **Anonymous accounts / guest checkout** | Anonymous identity and order flow | Public reads need no account; all social/commerce writes require authentication |
| **Company reviews** | Coming-soon placeholder and future rating model | Product comments remain; company ratings are not planned |
| **LiqPay** | Webhook, result pages | One acquirer (Mono) is enough |
| **Meest** | Enums, a half-built integration | Nova Poshta only |
| Dead code | web-push, empty deprecated email/sms controllers, TipTap as a second editor | |

**Effect:** Meta, a second acquirer, embeddings, geo-radius search, and the web
client still disappear from owner-first launch. Customer expansion returns
bounded social and in-app checkout/chat without a separate engagement module.
Owner-first is a clean implementation, not a legacy backend port.

---

## 6. Updated module list (packages/modules/*)

**Owner-first launch:** `companies` (team/RBAC/profile/requisites) ·
`customers` (CRM/groups/staff counterparties) · `catalog` · `pricing` ·
`orders` (staff create/confirm/get; fixed statuses; owns `company_statuses`) ·
`payments` (invoice/manual + provider interface) · `chat` (**order-card
projection only** in this release) · `documents` · `doc-generation` ·
`doc-signing` · `reference-data` (KVED/CPV) · `notifications` · `invites` ·
`files` (attachments + signed upload URLs) · `feature-flags` · `assistant`

**Customer expansion (same repo, later):** remainder of `companies`
(publication/showcase/follows) · `search` · `catalog` public/consumer reads ·
`delivery` (Nova Poshta at checkout) · chat platform (conversations,
realtime) · customer-principal order/chat/document actions

**Post-launch:** `analytics` (when a useful dashboard is defined) ·
`acquiring` (ph.11) · `banking` + accounting (ph.12) · `subscriptions`/billing
· workflow constructor

**Infrastructure:** `pki-proxy` (part of the doc-signing surface)

The exact ownership/composition ledger is `docs/module-ownership.md`.

---

## 7. Roadmap (mobile-first)

Principle: every product phase ends with a working vertical slice in the
mobile app. The **Experience Foundation** (ADR-0024) runs as a parallel
workstream and gates **panel** UI. Visuals come from the Magic Patterns
canvas; V1 mobile is domain/edge-case reference only. Customer-facing
screens are not an owner-first launch gate.

**Build owner-first first.** Customer expansion phases keep their historical
numbers (3–4, 6–7, and customer checkout in 5) so existing tickets and
foundation notes still resolve; they are **not** in the first production
release.

| # | Phase | When | Contents | Readiness criterion |
| --- | --- | --- | --- | --- |
| 0 | **Foundation** | Owner-first | Unchanged: monorepo, CI, Compose, core/db/contract, better-auth, API/worker, Expo skeleton, links/install fallback, backup baseline, invariant suites. `payments` + `feature-flags` skeletons as milestone H after fnd-G2 | An agent can add an action and see green CI; the app signs in; cross-tenant/protocol suites pass |
| 1 | **Reference slices** | Owner-first | (a) pricing resolution; (b) thin order → outbox → **order-card projection** (not the chat platform) | Two exemplary references + proven pipeline |
| ‖ | **Experience Foundation** | Owner-first (panel) | Magic Patterns canvas → Unistyles theme + shared primitives. V1 is domain reference, not visual acceptance. AI is the center tab (ADR-0024) | Panel UX gate opened |
| 2 | **Company operating core** | Owner-first | `companies` (onboarding, team, RBAC, requisites), `catalog`, `customers`/groups, `invites`, `pricing` full UI. Mobile **panel** screens: products, prices, customers | A company is created from a phone; catalog fills; a customer is invited |
| 5a | **Staff commerce** | Owner-first | `orders` staff create/confirm/get, immutable snapshots, fixed statuses, log, `notifications` + **Expo push**. No customer cart/checkout. CRM exists because staff/invite created it | The owner (or AI, after human confirm) records an order; push arrives; status progresses without chat |
| 8 | **Documents + QES** | Owner-first (before chat) | Counterparty requisites, `documents` from an order (default templates), `doc-generation`, `doc-signing`, share via link/QR/print. Signing by the owner. Research spike §9 in parallel | An invoice/delivery note is generated, signed, and handed over without a customer account |
| 9 | **AI experience** | Owner-first | `packages/ai`: AI SDK 7 loop (ADR-0032) over the action registry, UI tools, generative UI, HITL for QES | The AI in the **panel** performs the same actions as the UI |
| — | **🚀 Owner-first production** | — | Clean-database bootstrap, panel parity, TestFlight/internal → stores | The confectionery **owner** runs catalog, customers, orders, and documents from a phone |
| 3 | **Company presence** | Customer expansion | Public profile/showcase, taxonomy, social links, follows, deep links | A public visitor evaluates a company |
| 4 | **Consumer discovery** | Customer expansion | Public/consumer FTS+trigram, filters, likes/comments/Following | Browse and engagement follow ADR-0020; visuals follow the canvas |
| 5b | **Customer commerce** | Customer expansion | Cart, `orders.checkout` (atomic CRM link), `delivery`/Nova Poshta, customer reads | A customer places an order from her phone |
| 6 | **Chat platform** | Customer expansion | Conversations, messages, reactions, attachments, realtime, presence | Both sides can converse in-app |
| 7 | **Order collaboration in chat** | Customer expansion | Order card in conversation, redirect-to-chat, confirm/edit/cancel in thread | The §1.1 destination flow works end-to-end |
| 10 | **Web** | Post-expansion | Next.js storefront, cabinet, full panel, Plate editor | A customer without the app can continue in the browser |
| 11 | **Acquiring** | Post-launch | Mono invoices, webhooks, fiscalization — payment abstraction from phase 0 | Online payment in checkout |
| 12 | **Bank + accounting** | Post-launch | `banking`: statements, matching, income ledger, export for tax (Taxer replacement) | The owner sees real income; tax filing is a later layer on this ledger |
| 13 | **On demand** | — | Billing, workflow constructor, DOCX, analytics, mobile template editor | — |

Staff commerce (5a) may proceed once phase 2 is stable. Documents (8) starts
once staff orders exist. Chat platform (6) and order collaboration (7) start
only in customer expansion, after customer commerce (5b). Do not run 6/7 as
owner-first work.

### Why the AI experience is phase 9, not phase 1

AI tools are generated from the action registry. While there are no actions,
the assistant has nothing to execute. But the registry itself (phase 0) is
designed with AI requirements from day one: each action's `description` is
written as an instruction for the model, and every action carries AI/risk
metadata (`aiExposure`, `risk`, `requiresConfirmation`, `idempotent` — see
blueprint §4) from its first commit. This is what makes phase 9 "connect the
LLM to the existing capability graph" instead of "rewrite half the backend
for AI". The visible chat interface appears once there is a critical mass of
actions.

---

## 8. Decision register

| Decision | Accepted | Status / how to reverse |
| --- | --- | --- |
| Bounded social engagement | Company follows, product likes/comments, private Following, public counters | Destination (customer expansion); ADR-0020. No public user graph |
| Public discovery | Published company/product/comment reads without authentication | Destination (customer expansion); writes still require an account |
| Mobile vs web | **Mobile-first**, owner-first launch = **panel**; customer app later; web — phase 10 | ⚠ 2026-08-19: panel first |
| Anonymous orders | No — account only (OTP) when the customer checks out in-app | Approved by the owner: security > conversion |
| Meta messaging | Dropped | Approved by the owner |
| Chat platform in first release | No — order-card projection only; conversations are customer expansion | ⚠ 2026-08-19 |
| Acquiring in owner-first launch | No — invoice-as-document | ⚠ Pull phase 11 before a later launch; +3–4 weeks. The phase-0 payment abstraction makes this painless |
| Monobank statements | Phase 12, accounting foundation | Next after owner-first documents, not in the documents slice |
| Status constructor | Simplified to fixed statuses | ⚠ `orders` owns `company_statuses`; V2 seeds a fixed set |
| Product variants | In owner-first launch | ⚠ If deadlines squeeze — moved out of phase 2 into a separate one |
| 5-level pricing | In owner-first launch without simplifications | Approved by the owner on a real case |

---

## 9. Research spike: document editing on mobile

The owner wants the ability to edit documents from a phone; it is known to be
technically hard. The spike runs in parallel with the documents phase, time-boxed
(1–2 weeks of agent work); the result is a prototype or a substantiated "no".

**Primary candidate:** Expo DOM components (`"use dom"`) — an Expo mechanism
that renders React DOM components inside a native app. Hypothesis: the same
Plate editor that will run in the web phase launches as a DOM component inside
the app. Upside: one editor for all platforms, zero duplication. Risks to
verify: performance on long documents, keyboard/scroll/selection behavior on
iOS and Android, bundle size.

**Fallbacks:** (a) a WebView with a simplified editor; (b) a mobile
"structural" editor without rich text — editing fields, line items, and
amounts without free-form layout (covers 90% of real needs: fix an amount or
add a line item to an invoice).

**V2 minimum without the spike:** documents are generated from default
templates; only data (requisites, line items, amounts) is edited via regular
forms. Owner-first handover is link, QR, or print.
