import type { SuiteCoverageManifest } from "@showzy/core";

/**
 * Isolation lists `search.query` because the contract check requires every
 * registered action in crossTenantSuite (core.md §12). Fan-out isolation
 * runs in `query.db.test.ts`.
 */
export const searchSuiteCoverage = {
  isolation: ["search.query"],
  publicProjection: [],
  consumerIsolation: [],
  accountIsolation: [],
  shareIsolation: [],
  idempotency: [],
  events: [],
  atomic: [],
} as const satisfies SuiteCoverageManifest;
