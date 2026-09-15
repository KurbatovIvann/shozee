import type { SuiteCoverageManifest } from "@showzy/core";

export const companiesSuiteCoverage = {
  isolation: [
    "companies.create",
    "companies.get",
    "companies.getSellerFacts",
    "companies.listMine",
    "companies.updateLegal",
  ],
  publicProjection: [],
  consumerIsolation: [],
  accountIsolation: ["companies.listMine", "companies.create"],
  shareIsolation: [],
  idempotency: ["companies.create", "companies.updateLegal"],
  events: [],
  atomic: [],
  jobIsolation: [],
} as const satisfies SuiteCoverageManifest;
