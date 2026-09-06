/**
 * Staff client signing-state read (SHO-254 / SHO-256 / feature SHO-251).
 * Nested from `documents.get`. Mechanical: the action name is
 * `docSigning.get` because core rejects a hyphen in the module segment
 * (package remains `@showzy/doc-signing`). `timeout: 5000` is own-table
 * reads after SHO-256 dropped the T1 reverse `documents.get` existence
 * call (otherwise the call graph and ESM graph cycle).
 *
 * Import this handler from `@showzy/doc-signing/get`, not the barrel.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

export const signingStatusSchema = z.enum([
  "unsigned",
  "pending",
  "supplier_signed",
]);

export const getSigningInputSchema = z.strictObject({
  documentId: z.uuid(),
});

export const getSigningOutputSchema = z.object({
  status: signingStatusSchema,
  requestId: z.uuid().optional(),
  signedFileId: z.uuid().optional(),
});

export const getSigningContract = defineActionContract({
  name: "docSigning.get",
  description:
    "Return supplier signing state for a document in the active company: unsigned, a live pending request, or a recorded supplier ASiC. Used by the staff panel. Missing and foreign-company ids report unsigned (signing-owned state only; existence stays on documents.get). Company id is never input.",
  principal: "staff",
  transport: "client",
  input: getSigningInputSchema,
  output: getSigningOutputSchema,
  permissions: ["documents:view"],
  aiExposure: "internal",
  risk: "read",
  requiresConfirmation: false,
  idempotent: false,
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: ["VALIDATION"],
  audit: false,
  timeout: 5_000,
});
