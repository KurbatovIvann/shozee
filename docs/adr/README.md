# Architecture Decision Records

Every significant architectural decision is recorded here. The blueprint
(`docs/blueprint.md`) describes the *current* target architecture; ADRs record
*why* it looks that way and what alternatives were rejected — so agents (and
humans) don't relitigate settled questions or silently deviate.

## Rules

- **Agents must not contradict an accepted ADR.** If an implementation task
  seems to require deviating from one, stop and report — a new ADR
  (superseding the old one) must be accepted first.
- New ADRs are proposed via PR using `template.md`, numbered sequentially.
- Status lifecycle: `Proposed` → `Accepted` → (`Superseded by ADR-XXXX` | `Deprecated`).

## Index

| # | Title | Status |
| --- | --- | --- |
| [0001](0001-full-typescript-stack-on-node.md) | Full TypeScript stack on Node.js (Go rejected) | Accepted |
| [0002](0002-decompose-supabase.md) | Decompose Supabase into self-hosted components | Accepted |
| [0003](0003-hono-http-framework.md) | Hono as the HTTP framework | Accepted |
| [0004](0004-orpc-api-contract.md) | oRPC for the API contract | Accepted |
| [0005](0005-drizzle-orm.md) | Drizzle ORM + drizzle-kit | Accepted |
| [0006](0006-better-auth.md) | better-auth for authentication | Accepted |
| [0007](0007-bullmq-redis.md) | BullMQ + Redis for queues (pg-boss rejected) | Accepted |
| [0008](0008-action-registry.md) | Action registry as the single source of truth | Accepted |
| [0009](0009-authorization-in-code-no-rls.md) | Authorization in code, no RLS | Accepted |
| [0010](0010-mobile-first-client-strategy.md) | Mobile-first client strategy | Accepted |
| [0011](0011-chat-is-a-projection.md) | Chat is a projection; the order domain owns state | Accepted |
| [0012](0012-carry-over-outbox-and-qes-core.md) | Carry over the outbox pattern and the QES crypto core | Accepted |
| [0013](0013-principal-model-and-action-context.md) | Principal model — staff, customer, public, system, consumer, account, share | Accepted |
| [0014](0014-drizzle-schema-placement.md) | Drizzle schema lives in packages/db, one file per owning module | Accepted |
| [0015](0015-cross-module-composition.md) | Cross-module composition — internal calls for queries, events for effects | Accepted |
| [0016](0016-client-safe-action-descriptors.md) | Client-safe action descriptors and server implementations | Accepted |
| [0017](0017-design-system-first-dual-flow-ux.md) | Design-system-first, mobile-first, dual-flow UX | Superseded by ADR-0019 |
| [0018](0018-consumer-discovery-and-principal.md) | Consumer discovery and the `consumer` principal | Accepted |
| [0019](0019-v1-mobile-canonical-ux.md) | V1 mobile is the canonical V2 UX baseline | Superseded by ADR-0024 |
| [0020](0020-public-discovery-and-social-engagement.md) | Public discovery and aggregate-owned social engagement | Accepted |
| [0021](0021-same-transaction-atomic-capabilities.md) | Same-transaction atomic cross-module capabilities | Accepted |
| [0022](0022-share-principal-unauthenticated-capability-writes.md) | `share` principal — unauthenticated capability-token writes | Accepted |
| [0023](0023-feature-pipeline.md) | Feature pipeline replaces SDD stages | Accepted |
| [0024](0024-magic-patterns-canonical-ux.md) | Magic Patterns canvas is the canonical V2 UX | Accepted |
| [0025](0025-same-tenant-composite-foreign-keys.md) | Same-tenant composite foreign keys | Accepted |
| [0026](0026-golden-slice-confirm-is-status-only.md) | Golden-slice confirm is status-only | Accepted |
| [0027](0027-s3-stand-in-is-garage.md) | S3 stand-in is Garage (R2 in prod) | Accepted |
| [0028](0028-customer-spine-and-invite-crm.md) | Customer is the commercial spine; invite accept creates CRM | Accepted |
| [0029](0029-autonomous-feature-conveyor.md) | Autonomous parent conveyor (writer ≠ reviewer at the parent) | Accepted |
| [0030](0030-web-panel-spa-and-deferred-storefront.md) | Web panel is a Vite SPA; storefront is a separate later app | Accepted |
| [0031](0031-module-kit-server-micro-utilities.md) | Server module micro-utilities live in `@showzy/module-kit` | Accepted |
| [0032](0032-ai-sdk-7-thin-loop-no-harness.md) | AI loop is AI SDK 7; no coding harness | Accepted |
| [0033](0033-channel-neutral-actions.md) | Channel-neutral actions — task-complete lists and reference writes | Accepted |
