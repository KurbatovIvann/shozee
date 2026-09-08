import type { SuiteCoverageManifest } from "@showzy/core";

export const ordersSuiteCoverage = {
  isolation: [
    "orders.create",
    "orders.confirm",
    "orders.start",
    "orders.complete",
    "orders.cancel",
    "orders.get",
    "orders.list",
    "orders.searchMatches",
  ],
  publicProjection: [],
  consumerIsolation: [],
  accountIsolation: [],
  shareIsolation: [],
  idempotency: [
    "orders.create",
    "orders.confirm",
    "orders.start",
    "orders.complete",
    "orders.cancel",
  ],
  events: ["orders"],
  atomic: [],
} as const satisfies SuiteCoverageManifest;
