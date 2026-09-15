import type { SuiteCoverageManifest } from "@showzy/core";

/**
 * Isolation lists `chat.upsertOrderCard` as well as `getOrderCard` because
 * the contract check requires every registered action in crossTenantSuite
 * (core.md §12). Idempotency is omitted: the write is delivery-backed.
 */
export const chatSuiteCoverage = {
  isolation: ["chat.getOrderCard", "chat.upsertOrderCard"],
  publicProjection: [],
  consumerIsolation: [],
  accountIsolation: [],
  shareIsolation: [],
  idempotency: [],
  events: ["chat"],
  atomic: [],
  jobIsolation: [],
} as const satisfies SuiteCoverageManifest;
