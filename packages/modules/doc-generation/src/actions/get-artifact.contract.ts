/**
 * Staff internal artifact read (SHO-236 / feature SHO-227). Nested from
 * `documents.get` and `documents.share`. Mechanical: the action name is
 * `docGeneration.getArtifact` because core rejects a hyphen in the module
 * segment (package remains `@showzy/doc-generation`). `timeout: 2000` is a
 * single job-row lookup. Missing jobs are not-found so cross-tenant
 * isolation cannot distinguish "no job" from "foreign document" as a
 * ready file; the panel maps not-found to `{ status: "pending", fileId: null }`.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

export const generationJobStatusSchema = z.enum(["pending", "ready", "failed"]);

export const getArtifactInputSchema = z.strictObject({
  documentId: z.uuid(),
});

export const getArtifactOutputSchema = z.object({
  status: generationJobStatusSchema,
  fileId: z.uuid().nullable(),
});

export const getArtifactContract = defineActionContract({
  name: "docGeneration.getArtifact",
  description:
    "Return the generation job status and artifact file id for a document in the active company. Used by the staff panel and share mint. Missing and foreign-company jobs fail with not-found. Company id is never input.",
  principal: "staff",
  transport: "internal",
  input: getArtifactInputSchema,
  output: getArtifactOutputSchema,
  permissions: ["documents:view"],
  aiExposure: "internal",
  risk: "read",
  requiresConfirmation: false,
  idempotent: false,
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: ["NOT_FOUND"],
  audit: false,
  timeout: 2_000,
});
