import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  backfillCatalogRenditionsJob,
  sweepAbandonedUploadsJob,
} from "@showzy/files";
import { describe, expect, it } from "vitest";

import { cleanupIdempotencyKeysJob } from "./maintenance.js";
import {
  BULLMQ_PREFIX,
  MAINTENANCE_LOCK_DURATION_MS,
  MAINTENANCE_QUEUE_NAME,
} from "./policy.js";

function source(file: string): string {
  return readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), file),
    "utf8",
  );
}

describe("worker job policy", () => {
  it("keeps the BullMQ maintenance queue for the assistant reconciler only", () => {
    expect(BULLMQ_PREFIX).toBe("showzy");
    expect(MAINTENANCE_QUEUE_NAME).toBe("maintenance");
    expect(MAINTENANCE_LOCK_DURATION_MS).toBe(60_000);
    const jobsSource = source("jobs.ts");
    expect(jobsSource).not.toMatch(/\bpdf\b/i);
    expect(jobsSource).not.toContain("cleanupExpiredIdempotencyKeys");
    expect(jobsSource).not.toContain("@showzy/files");
  });

  it("runs idempotency cleanup only through the worker.cleanupIdempotencyKeys action, never on the outbox loop", () => {
    expect(source("loop.ts")).not.toContain("cleanupExpiredIdempotencyKeys");
  });

  it("schedules maintenance from the job declarations: sweep and backfill every 5 minutes, cleanup hourly", () => {
    expect(sweepAbandonedUploadsJob.cron).toBe("*/5 * * * *");
    expect(backfillCatalogRenditionsJob.cron).toBe("*/5 * * * *");
    expect(cleanupIdempotencyKeysJob.cron).toBe("0 * * * *");
    for (const job of [
      sweepAbandonedUploadsJob,
      backfillCatalogRenditionsJob,
      cleanupIdempotencyKeysJob,
    ]) {
      expect(job).toMatchObject({ scope: "global", lifecycle: "periodic" });
    }
  });

  it("binds and probes the files object store at worker boot, then closes it", () => {
    const bootSource = source("boot.ts");
    expect(bootSource).toContain('from "@showzy/files/storage"');
    expect(bootSource).toContain("configureFilesObjectStore");
    expect(bootSource).toContain("probeFilesObjectStore");
    expect(bootSource).toContain("closeFilesObjectStore");
    expect(bootSource).not.toMatch(/setInterval\s*\(/);
  });
});
