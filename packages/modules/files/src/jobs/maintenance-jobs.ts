import { defineJob, jobPayload } from "@showzy/core";

import { BACKFILL_CATALOG_RENDITIONS_INTERVAL_MS } from "../services/backfill-catalog-renditions.js";

const MINUTE_MS = 60_000;

const globalPeriodic = {
  scope: "global",
  payload: jobPayload({}),
  discriminator: [],
  lifecycle: "periodic",
  retries: 0,
  attemptTimeoutMs: 60_000,
} as const;

export const sweepAbandonedUploadsJob = defineJob({
  ...globalPeriodic,
  name: "files.sweepAbandonedUploads",
  cron: "*/5 * * * *",
});

export const backfillCatalogRenditionsJob = defineJob({
  ...globalPeriodic,
  name: "files.backfillCatalogRenditions",
  cron: `*/${String(BACKFILL_CATALOG_RENDITIONS_INTERVAL_MS / MINUTE_MS)} * * * *`,
});
