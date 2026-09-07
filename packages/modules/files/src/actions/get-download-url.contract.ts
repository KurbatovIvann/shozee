/**
 * Staff read: short-lived signed GET for a ready catalog file.
 * Mechanical: `timeout: 5000` is one tenant-scoped lookup plus local presign
 * (and a HeadObject when `rendition` is set). Pending, missing, and foreign
 * files are not-found. A present `rendition` whose object is missing is
 * not-found (no original fallback). Authorization is rechecked when the
 * URL is issued. The URL is not stored.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import { catalogRenditionSchema } from "../wire.contract.js";

export const getDownloadUrlInputSchema = z.object({
  fileId: z.uuid(),
  rendition: catalogRenditionSchema.optional(),
});

export const getDownloadUrlOutputSchema = z.object({
  fileId: z.uuid(),
  downloadUrl: z.url(),
  expiresAt: z.iso.datetime(),
});

export const getDownloadUrlContract = defineActionContract({
  name: "files.getDownloadUrl",
  description:
    "Return a short-lived signed GET URL for a ready private catalog file in the active company. Optional rendition (thumb|card|hero|full) signs the derived WebP object with Content-Type image/webp and Content-Disposition inline. Omitted rendition signs the original catalog object with the stored image MIME (image/jpeg|png|webp). A missing rendition object fails with not-found and does not fall back to the original. Pending, missing, or foreign-company files fail with not-found. Clients never receive or choose the object key as a durable field.",
  principal: "staff",
  transport: "client",
  input: getDownloadUrlInputSchema,
  output: getDownloadUrlOutputSchema,
  permissions: ["files:view"],
  aiExposure: "internal",
  risk: "read",
  requiresConfirmation: false,
  idempotent: false,
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: ["NOT_FOUND"],
  audit: false,
  timeout: 5_000,
});
