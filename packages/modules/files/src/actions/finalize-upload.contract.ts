/**
 * Staff write: verify the uploaded object and mark the file ready.
 * Mechanical: `timeout: 15000` is the API→R2 budget for one finalize of up
 * to 10 MiB: unlocked Head+GetObject of staging plus SHA-256, then a short
 * `SELECT … FOR UPDATE` for Head (etag/size) + PutObject of the hashed
 * buffer + four catalog WebP renditions + UPDATE. Garage-on-localhost is
 * not the budget. Keep 15s until production p99 GET+PUT of 10 MiB plus
 * sharp hits the deadline. Missing or foreign fileIds are not-found (no
 * existence leak).
 * Same-tenant objects that fail size, magic-byte, MIME, checksum, prefix,
 * or catalog-decode checks fail validation. A second call on an
 * already-ready file returns the same view and fills missing rendition
 * objects without rewriting the original.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import { fileReadyViewSchema } from "./file-view.contract.js";

export const finalizeUploadInputSchema = z.object({
  fileId: z.uuid(),
});

export const finalizeUploadOutputSchema = fileReadyViewSchema;

export const finalizeUploadContract = defineActionContract({
  name: "files.finalizeUpload",
  description:
    "Finalize a pending catalog upload in the active company. Reads the handshake staging object, then verifies size, magic bytes against the declared MIME, SHA-256 checksum, and the server-derived key prefix, then writes those already-hashed bytes onto the durable catalog key and four named WebP renditions (thumb/card/hero/full) at derived keys. Undecodable or over-limit pixel images fail validation and stay pending. A leftover PUT that changes staging after that read fails validation rather than marking the file ready. Executables, archives, and HEIC fail validation even when the declared MIME is an image. Missing or foreign-company files fail with not-found. A second finalize of a ready file returns the same view and fills missing rendition objects without rewriting the original bytes or checksum.",
  principal: "staff",
  transport: "client",
  input: finalizeUploadInputSchema,
  output: finalizeUploadOutputSchema,
  permissions: ["files:upload"],
  aiExposure: "exposed",
  risk: "write",
  requiresConfirmation: false,
  idempotent: true,
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: ["VALIDATION", "NOT_FOUND"],
  audit: true,
  timeout: 15_000,
});
