import type { SuiteCoverageManifest } from "@showzy/core";

/**
 * Isolation lists every registered action (core.md §12). Abandon is
 * delivery-backed so it stays off idempotency. Start is a client write
 * with domain pending-row replay; metadata `idempotent: false` so the
 * protocol cache cannot freeze the short-lived URL.
 */
export const docSigningSuiteCoverage = {
  isolation: [
    "docSigning.abandonRequest",
    "docSigning.complete",
    "docSigning.get",
    "docSigning.getSupplierSignedFlags",
    "docSigning.start",
  ],
  publicProjection: [],
  consumerIsolation: [],
  accountIsolation: [],
  shareIsolation: [],
  idempotency: ["docSigning.complete"],
  events: ["docSigning"],
  atomic: [
    {
      caller: "docSigning.complete",
      callee: "files.recordSigningObject",
    },
  ],
  jobIsolation: [],
} as const satisfies SuiteCoverageManifest;
