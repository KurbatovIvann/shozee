import type { SuiteCoverageManifest } from "@showzy/core";

export const docGenerationSuiteCoverage = {
  isolation: [
    "docGeneration.getArtifact",
    "docGeneration.listLayouts",
    "docGeneration.markFailed",
    "docGeneration.renderPdf",
    "docGeneration.resolveLayout",
  ],
  publicProjection: [],
  consumerIsolation: [],
  accountIsolation: [],
  shareIsolation: [],
  idempotency: ["docGeneration.markFailed"],
  events: ["docGeneration"],
  atomic: [
    {
      caller: "docGeneration.renderPdf",
      callee: "files.recordGeneratedObject",
    },
  ],
  jobIsolation: [],
} as const satisfies SuiteCoverageManifest;
