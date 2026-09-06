/**
 * System backfill of named catalog WebP renditions (SHO-248 / files-T16).
 * Global system write, internal, audited, idempotent. Empty input inspects
 * one rotating page of ready `purpose=catalog` files whose derived keys
 * are missing; `limit` only bounds how many files receive PutObject work
 * in that page.
 * Keys are derived from each row's `companyId`, never from input.
 * `companyId` is not an input field.
 *
 * Mechanical choices the feature card left unnamed:
 * - `timeout: 30000` covers Head+Get+sharp+Put for a fill batch of 20
 *   on Garage (same ceiling as `files.sweepAbandonedUploads`). HeadObject
 *   for a SQL page of 20 runs concurrently so already-complete files do
 *   not serialize the tick past the deadline.
 * - Each invocation inspects one SQL page of 20 and returns — the sweep
 *   golden. Completes in that page do not consume fill budget and must
 *   not scan further pages in the same tick. Which page is
 *   `inspectOffset` of COUNT(ready catalog) by the 5-minute worker
 *   interval (duplicated in the files module; files does not import
 *   `apps/worker`). Optional `limit` bounds PutObject fills within that
 *   page (idempotency conflict payload). A later fillable row still
 *   inside the page is picked up on a subsequent tick.
 * - Missing originals and undecodable bytes are skipped and logged
 *   without consuming the fill budget, so one bad file cannot starve
 *   the rest of the inspected page.
 * - Output is counts. Object keys, URLs, and file ids are omitted
 *   (security-operations.md §3).
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

/** Inspect page and default fill size; one page per invocation. */
export const BACKFILL_BATCH_LIMIT = 20;

export const backfillCatalogRenditionsInputSchema = z.object({
  limit: z.number().int().min(1).max(BACKFILL_BATCH_LIMIT).optional(),
});

export const backfillCatalogRenditionsOutputSchema = z.object({
  filled: z.number().int().nonnegative(),
  alreadyComplete: z.number().int().nonnegative(),
  skippedMissingOriginal: z.number().int().nonnegative(),
  skippedUndecodable: z.number().int().nonnegative(),
});

export const backfillCatalogRenditionsContract = defineActionContract({
  name: "files.backfillCatalogRenditions",
  description:
    "Backfill named catalog WebP renditions for ready purpose=catalog files whose derived keys are missing. Inspects one bounded page of ready catalog rows across companies per invocation and returns. Reuses the finalize encode pipeline (pixel cap, EXIF bake, no upscale, metadata stripping). Puts only missing {companyId}/catalog/{fileId}/{thumb|card|hero|full} objects. Does not rewrite originals, checksums, byte_size, object_key, or status. Skips purpose=document. Missing originals and undecodable bytes are skipped and logged so the rest of the page still completes. Object keys and URLs are never returned.",
  principal: "system",
  systemScope: "global",
  transport: "internal",
  input: backfillCatalogRenditionsInputSchema,
  output: backfillCatalogRenditionsOutputSchema,
  permissions: [],
  aiExposure: "internal",
  risk: "write",
  requiresConfirmation: false,
  idempotent: true,
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: ["VALIDATION"],
  audit: true,
  timeout: 30_000,
});
