/**
 * System write: persist ready metadata for a worker-PUT generated PDF.
 * Mechanical: `timeout: 15000` covers one GetObject + SHA-256 of up to
 * 25 MiB (security-operations.md §3 PDF ceiling), matching finalize's
 * API→R2 budget. Tenant scope comes from the enqueuing system context;
 * `companyId` is never input. Catalog purpose is rejected at the schema
 * (literal `document` only). The URL is not stored.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import { documentReadyViewSchema } from "./file-view.contract.js";
import {
  checksumSha256Schema,
  documentByteSizeSchema,
  documentMimeTypeSchema,
  documentPurposeSchema,
} from "../wire.contract.js";

export const recordGeneratedObjectInputSchema = z.object({
  fileId: z.uuid(),
  purpose: documentPurposeSchema,
  mimeType: documentMimeTypeSchema,
  byteSize: documentByteSizeSchema,
  checksumSha256: checksumSha256Schema,
});

export const recordGeneratedObjectOutputSchema = documentReadyViewSchema;

export const recordGeneratedObjectContract = defineActionContract({
  name: "files.recordGeneratedObject",
  description:
    "Record a ready private generated-document PDF after the worker has PUT the object. Inserts purpose=document metadata in the enqueuing system tenant with MIME application/pdf and a null uploader. The durable object key is server-derived ({companyId}/documents/{fileId}); clients never supply a key, URL, bucket, or company id. Catalog purpose is rejected. A retry of an already-ready matching row returns the same view. Missing objects, foreign-company ids, and catalog rows fail without leaking existence as a downloadable document. Object keys and signed URLs are never returned.",
  principal: "system",
  systemScope: "tenant",
  transport: "internal",
  input: recordGeneratedObjectInputSchema,
  output: recordGeneratedObjectOutputSchema,
  permissions: [],
  aiExposure: "internal",
  risk: "write",
  requiresConfirmation: false,
  idempotent: true,
  emits: [],
  atomicCalls: [],
  atomicCallers: ["docGeneration.renderPdf"],
  errors: ["VALIDATION", "NOT_FOUND", "CONFLICT"],
  audit: true,
  timeout: 15_000,
});
