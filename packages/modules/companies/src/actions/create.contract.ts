/**
 * Account write contract for SHO-127 (feature SHO-125): create a company
 * and bootstrap the caller as its owner. Card-named metadata: account
 * principal, client transport, no permissions, write risk, exposed to AI,
 * no confirmation, idempotent, audited, no events.
 *
 * Mechanical choices the feature card left unnamed:
 * - `timeout: 5000` — one execution transaction with a handful of
 *   statements and no nested `ctx.call`s, same budget as the golden reads.
 * - `rateLimit` 10 per 300s per user instead of the account default
 *   (90/min): creating a company is a rare onboarding action, and the
 *   slower refill (one token per 30s) keeps the inherited account
 *   rate-limit assertion deterministic under parallel CI load (the
 *   90/min default refills a token every ~667ms — faster than 90 write
 *   invocations complete on a loaded runner).
 * - `name` is trimmed and capped at 120 characters — long enough for any
 *   Ukrainian business name, short enough for list rows and audit hashes.
 * - Output is the caller's owner-membership view (same shape as
 *   `companies.listMine` rows) so the mobile handoff can select the new
 *   company and persist the selector without a second round-trip.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import { companyMembershipViewSchema } from "./list-mine.contract.js";

export const CREATE_COMPANY_NAME_MAX = 120;
export const CREATE_COMPANY_SLUG_MIN = 3;
export const CREATE_COMPANY_SLUG_MAX = 48;

/** Canvas slug format: lowercase Latin letters, digits, internal hyphens. */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const companySlugSchema = z
  .string()
  .min(CREATE_COMPANY_SLUG_MIN)
  .max(CREATE_COMPANY_SLUG_MAX)
  .regex(SLUG_PATTERN, {
    message:
      "Slug must use lowercase Latin letters and digits with internal hyphens.",
  });

export const companyNameSchema = z
  .string()
  .trim()
  .min(1, { message: "Company name must not be blank." })
  .max(CREATE_COMPANY_NAME_MAX);

/**
 * Only the business name and public slug. `companyId`, `userId`,
 * membership identity, role, permissions, and `prefix` are never input
 * (ADR-0013; the numbering prefix is generated server-side).
 */
export const createCompanyInputSchema = z.strictObject({
  name: companyNameSchema,
  slug: companySlugSchema,
});

export const createCompanyOutputSchema = companyMembershipViewSchema;

export const createCompanyContract = defineActionContract({
  name: "companies.create",
  description:
    "Create a company owned by the authenticated user. Takes only the business name and public slug; the unique numbering prefix is generated server-side from the name. Atomically inserts the company and the caller's owner membership and returns that membership with the company identity (id, name, slug, prefix) and an empty effective permissions array (owner-all is not enumerated). Re-submitting the identical name and slug by the same owner returns the already-created company; a slug occupied by any other company is a conflict.",
  principal: "account",
  transport: "client",
  input: createCompanyInputSchema,
  output: createCompanyOutputSchema,
  permissions: [],
  aiExposure: "exposed",
  risk: "write",
  requiresConfirmation: false,
  idempotent: true,
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: ["VALIDATION", "CONFLICT"],
  audit: true,
  timeout: 5_000,
  rateLimit: { scope: "user", limit: 10, windowSec: 300 },
});
