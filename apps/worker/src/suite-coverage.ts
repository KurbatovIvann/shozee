import type { SuiteCoverageManifest } from "@showzy/core";

export const workerSuiteCoverage = {
  isolation: ["worker.cleanupIdempotencyKeys"],
  publicProjection: [],
  consumerIsolation: [],
  accountIsolation: [],
  shareIsolation: [],
  idempotency: [],
  events: [],
  atomic: [],
  jobIsolation: ["worker"],
} as const satisfies SuiteCoverageManifest;
