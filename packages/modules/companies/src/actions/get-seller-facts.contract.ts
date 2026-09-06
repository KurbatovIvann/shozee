/**
 * Staff internal seller facts (SHO-230 / feature SHO-227) so
 * `documents.createFromOrder` can snapshot numbering prefix + legal
 * without `settings:payments`. Mechanical choices copied from
 * `companies.get` / `catalog.getProductOrderFacts`:
 * - Input is `{}`. Company id is never input (ADR-0013); missing or
 *   foreign membership is core permission denial.
 * - Output reuses `companyViewSchema` — identity plus `legal` (null when
 *   no `company_legal_info` row). No second projection.
 * - `timeout: 5000` matches the golden staff reads.
 * - No `rateLimit` override — staff default 120/min per user.
 * - `idempotent: false` like other staff reads: core.md §5 treats reads
 *   as naturally idempotent (no key, no storage).
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import { companyViewSchema } from "./company-view.contract.js";

export const getSellerFactsInputSchema = z.strictObject({});

export const getSellerFactsOutputSchema = companyViewSchema;

export const getSellerFactsContract = defineActionContract({
  name: "companies.getSellerFacts",
  description:
    "Return the staff member's active company identity (id, trade name, slug, numbering prefix) and seller legal requisites for document snapshots. Legal is null when the company has no legal-info row yet. Company id is never input; missing and foreign membership fail with the same permission denial and do not leak another company's legal row. Requires documents:view, not settings:payments.",
  principal: "staff",
  transport: "internal",
  input: getSellerFactsInputSchema,
  output: getSellerFactsOutputSchema,
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
