# ADR-0007: BullMQ + Redis for queues (pg-boss rejected)

- **Status**: Superseded by ADR-0041 (background jobs)
- **Date**: 2026-08-16

## Context

An earlier draft recommended pg-boss to avoid adding Redis at the start. The
v1 audit invalidated that premise: Redis is mandatory regardless — Socket.IO
adapter for multi-instance realtime, L2 cache, and cron leader election all
require it. v1 already runs 7 BullMQ queues with established retry/backoff
patterns.

## Decision

BullMQ on Redis for all background jobs. Redis ships in Docker Compose next
to Postgres from day one.

## Alternatives considered

- **pg-boss** — rejected: its only advantage (no Redis dependency) is void
  since Redis is required anyway; BullMQ is more mature for our patterns.
- **Managed queues (SQS, Cloud Tasks)** — rejected: vendor lock-in the
  rewrite explicitly avoids.

## Consequences

- Realtime, cache, and queues share one Redis instance initially; can split
  later without code changes.
- Note: reliable *domain event* delivery is not BullMQ's job — that is the
  transactional outbox (ADR-0012). BullMQ handles execution (PDF, email,
  push, sync jobs).
