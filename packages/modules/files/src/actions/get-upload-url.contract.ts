/**
 * Staff read: short-lived signed PUT for a pending catalog file.
 * Mechanical: `timeout: 5000` is one tenant-scoped lookup plus local presign.
 * Ready, missing, foreign, and pending files whose PUT would outlive the
 * abandoned-at cutoff are not-found. Authorization is rechecked when the
 * URL is issued. The URL is not stored.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

export const getUploadUrlInputSchema = z.object({
  fileId: z.uuid(),
});

export const getUploadUrlOutputSchema = z.object({
  fileId: z.uuid(),
  uploadUrl: z.url(),
  expiresAt: z.iso.datetime(),
});

export const getUploadUrlContract = defineActionContract({
  name: "files.getUploadUrl",
  description:
    "Return a short-lived signed PUT URL for a pending private catalog file in the active company. Ready, missing, foreign-company, or pending files whose remaining life is shorter than the PUT TTL plus skew margin fail with not-found. The handshake PUT targets {companyId}/uploads/{fileId} (derived in code, never stored). Clients never receive or choose the durable object key as a durable field. If the previous PUT expired inside the remint window, call this action again; do not mint a new requestUpload idempotency key. If remint is not-found because remaining life is too short, call requestUpload with a new idempotency key.",
  principal: "staff",
  transport: "client",
  input: getUploadUrlInputSchema,
  output: getUploadUrlOutputSchema,
  permissions: ["files:upload"],
  aiExposure: "exposed",
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
