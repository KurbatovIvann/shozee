/**
 * Staff read: short-lived signed PUT for a pending signing file.
 * Mechanical: `timeout: 5000` is one tenant-scoped lookup plus local presign.
 * Ready, missing, foreign, catalog/document, and pending files whose PUT
 * would outlive the abandoned-at cutoff are not-found. Authorization is
 * rechecked when the URL is issued. The URL is not stored.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

export const getSigningUploadUrlInputSchema = z.object({
  fileId: z.uuid(),
});

export const getSigningUploadUrlOutputSchema = z.object({
  fileId: z.uuid(),
  uploadUrl: z.url(),
  expiresAt: z.iso.datetime(),
});

export const getSigningUploadUrlContract = defineActionContract({
  name: "files.getSigningUploadUrl",
  description:
    "Return a short-lived signed PUT URL for a pending private signing file in the active company. Ready, missing, foreign-company, catalog, document, or pending files whose remaining life is shorter than the PUT TTL plus skew margin fail with not-found. The handshake PUT targets {companyId}/uploads/{fileId} (derived in code, never stored). Clients never receive or choose the durable object key as a durable field. If the previous PUT expired inside the remint window, call this action again; do not mint a new requestSigningUpload idempotency key. If remint is not-found because remaining life is too short, call requestSigningUpload with a new idempotency key.",
  principal: "staff",
  transport: "client",
  input: getSigningUploadUrlInputSchema,
  output: getSigningUploadUrlOutputSchema,
  permissions: ["documents:edit"],
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
