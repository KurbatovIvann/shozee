/**
 * Staff read: short-lived signed GETs for a batch of ready catalog files.
 * Mechanical: `timeout: 5000` is one tenant-scoped lookup plus local
 * presigns (max `ATTACHMENT_FACTS_MAX_IDS`) and HeadObject of each
 * derived key when `rendition` is set. Pending, missing, and
 * foreign files fail the whole batch with not-found (same as
 * `files.getAttachmentFacts`). One `rendition` applies to every id; a
 * missing variant object fails the whole batch. Authorization is
 * rechecked when URLs are issued. URLs are not stored. Duplicate ids
 * collapse to first-seen unique order (same batch convention as
 * attachment facts).
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import { catalogRenditionSchema } from "../wire.contract.js";
import { ATTACHMENT_FACTS_MAX_IDS } from "./get-attachment-facts.contract.js";
import { getDownloadUrlOutputSchema } from "./get-download-url.contract.js";

export const getDownloadUrlsInputSchema = z.object({
  fileIds: z.array(z.uuid()).min(1).max(ATTACHMENT_FACTS_MAX_IDS),
  rendition: catalogRenditionSchema.optional(),
});

export const getDownloadUrlsOutputSchema = z.object({
  files: z.array(getDownloadUrlOutputSchema),
});

export const getDownloadUrlsContract = defineActionContract({
  name: "files.getDownloadUrls",
  description:
    "Return short-lived signed GET URLs for a batch of ready private catalog files in the active company. Input is fileIds (min 1, max 50) and an optional rendition applied to every id. Output is { files: [{ fileId, downloadUrl, expiresAt }] } in first-seen unique order. The whole batch fails with not-found when any id is missing, still pending, or outside the company, or when a requested rendition object is missing. Omitted rendition signs each original with the stored image MIME (image/jpeg|png|webp); a present rendition signs the derived WebP (thumb|card|hero|full) with Content-Type image/webp and Content-Disposition inline. Clients never receive or choose the object key as a durable field.",
  principal: "staff",
  transport: "client",
  input: getDownloadUrlsInputSchema,
  output: getDownloadUrlsOutputSchema,
  permissions: ["files:view"],
  aiExposure: "internal",
  risk: "read",
  requiresConfirmation: false,
  idempotent: false,
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: ["VALIDATION", "NOT_FOUND"],
  audit: false,
  timeout: 5_000,
});
