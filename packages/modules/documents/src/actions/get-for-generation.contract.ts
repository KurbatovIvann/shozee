/**
 * System tenant read of an issued document for PDF substitution (SHO-236).
 * Implied facts action: `docGeneration.renderPdf` cannot query `documents`
 * (ADR-0014) and cannot `ctx.call` staff `documents.get` (same-principal
 * reads only). Output reuses `documentViewSchema`. Mechanical: `timeout:
 * 5000` matches `companies.getSellerFacts`. Company id is never input.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import { documentViewSchema } from "./document-view.contract.js";

export const getForGenerationInputSchema = z.strictObject({
  documentId: z.uuid(),
});

export const getForGenerationOutputSchema = documentViewSchema;

export const getForGenerationContract = defineActionContract({
  name: "documents.getForGeneration",
  description:
    "Return the tenant document snapshots and immutable line copies for system PDF rendering. Missing or foreign-company documents fail with not-found. Company id is never input. Internal facts read for docGeneration.renderPdf and docGeneration.markFailed; not a client route.",
  principal: "system",
  systemScope: "tenant",
  transport: "internal",
  input: getForGenerationInputSchema,
  output: getForGenerationOutputSchema,
  permissions: [],
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
