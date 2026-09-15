import { defineJob, jobPayload } from "@showzy/core";

import { BACKFILL_CATALOG_RENDITIONS_INTERVAL_MS } from "../services/backfill-catalog-renditions.js";

const MINUTE_MS = 60_000;

const SWEEP_ABANDONED_UPLOADS_INTERVAL_MS = 5 * MINUTE_MS;

function everyIntervalCron(intervalMs: number): string {
  return `*/${String(intervalMs / MINUTE_MS)} * * * *`;
}

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
  cron: everyIntervalCron(SWEEP_ABANDONED_UPLOADS_INTERVAL_MS),
});

export const backfillCatalogRenditionsJob = defineJob({
  ...globalPeriodic,
  name: "files.backfillCatalogRenditions",
  cron: everyIntervalCron(BACKFILL_CATALOG_RENDITIONS_INTERVAL_MS),
});
