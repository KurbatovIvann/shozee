# ADR-0011: Chat is a projection; the order domain owns state

- **Status**: Accepted
- **Date**: 2026-08-16

## Context

The core UX: checkout redirects into a chat where both parties see the order
and confirm/edit/cancel it. Phrased carelessly ("orders live in chat"), this
UX concept becomes a dangerous domain architecture — agents would start
storing order state in chat messages, creating two sources of truth.

## Decision

Chat is the primary *interaction surface* for orders; the order domain is
the *source of truth*. A chat order card stores `orderId` and renders a
projection updated by domain events (`orders.confirm` → `orders.confirmed` →
card update). The `orders` module does not know chat exists — it emits
events; `chat` subscribes and materializes cards. The same rule applies to
every projection (dashboards, notifications, analytics).

## Alternatives considered

- **Order state embedded in chat messages** — rejected: state duplication,
  unanswerable "which is true?" questions, impossible event replay.
- **Chat module calling orders module directly** — rejected: violates module
  boundaries; events keep the dependency one-directional.

## Consequences

- Foundation invariant #5 (blueprint §2.1): "projections never own domain
  state" — enforced in review and by prohibition rules.
- Order cards update via the outbox → event bus → chat subscription path,
  which must exist by phase 3 (order vertical).
- Amended by ADR-0034 (2026-09-07): "never duplicates domain state" means
  never as a projection or source of truth. A bounded model-prompt cache
  that no client renders (`assistant_tool_runs.model_trace`) is prompt
  state, not a projection.
