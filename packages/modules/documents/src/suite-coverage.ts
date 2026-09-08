import type { SuiteCoverageManifest } from "@showzy/core";

/**
 * Isolation lists `documents.attachSignedShare` because the contract check
 * requires every registered action in crossTenantSuite (core.md §12).
 * Idempotency is omitted for that write: it is delivery-backed.
 */
export const documentsSuiteCoverage = {
  isolation: [
    "documents.attachSignedShare",
    "documents.cancel",
    "documents.createFromOrder",
    "documents.get",
    "documents.getForGeneration",
    "documents.getShared",
    "documents.list",
    "documents.lockIssuedForSigning",
    "documents.requestSign",
    "documents.searchMatches",
    "documents.share",
  ],
  publicProjection: [],
  consumerIsolation: [],
  accountIsolation: [],
  shareIsolation: [],
  idempotency: [
    "documents.cancel",
    "documents.createFromOrder",
    "documents.requestSign",
    "documents.share",
  ],
  events: ["documents"],
  atomic: [],
} as const satisfies SuiteCoverageManifest;
