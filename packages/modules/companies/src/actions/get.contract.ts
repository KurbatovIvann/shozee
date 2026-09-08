/**
 * Staff company get (SHO-224 / feature SHO-222; SHO-537 amends
 * permissions). Mechanical choices copied from
 * `customers.getCounterparty` / the shared company view:
 * - Input is `{}`. Company id is never input (ADR-0013); missing or
 *   foreign membership is core permission denial.
 * - Output is identity from `companies` plus `legal` (null when no
 *   `company_legal_info` row). Unchanged in SHO-537.
 * - `permissions: ["companies:view"]` — same key as
 *   `companies.getSellerFacts`. Ukrainian EDR identity is
 *   register-public; IBAN is invoice-public. Seeded for every default
 *   staff role (owner implicit). `settings:payments` stays on
 *   `companies.updateLegal` only.
 * - `timeout: 5000` matches the golden staff reads.
 * - No `rateLimit` override — staff default 120/min per user.
 * - `idempotent: false` like other staff reads: core.md §5 treats reads
 *   as naturally idempotent (no key, no storage).
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import { companyViewSchema } from "./company-view.contract.js";

export const getCompanyInputSchema = z.strictObject({});

export const getCompanyOutputSchema = companyViewSchema;

export const getCompanyContract = defineActionContract({
  name: "companies.get",
  description:
    "Return the staff member's active company identity (id, trade name, slug, numbering prefix) and seller legal requisites. Any staff of the active company may call this; legal is null when the company has no legal-info row yet. Company id is never input; missing companies:view, missing membership, and foreign membership fail with the same permission denial and do not leak another company's legal row.",
  principal: "staff",
  transport: "client",
  input: getCompanyInputSchema,
  output: getCompanyOutputSchema,
  permissions: ["companies:view"],
  aiExposure: "exposed",
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
