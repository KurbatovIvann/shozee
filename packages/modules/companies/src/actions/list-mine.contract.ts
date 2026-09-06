/**
 * Account read contract for SHO-126 (feature SHO-125). Mechanical choices
 * the feature card left unnamed, following the golden read contract
 * (pricing.resolveProductPrices):
 * - `aiExposure: "exposed"` — a safe own-user read, the account-session
 *   tool the AI surface lists (contract.md §2).
 * - `timeout: 5000` matches the golden read actions.
 * - `rateLimit` is omitted so the action uses the account default (90/min
 *   per user, core.md §10). SHO-126's 30/120s override was a CI workaround
 *   for a live-clock isolation-suite race; SHO-146 froze that suite clock.
 * - Output wrapper is `{ memberships: [...] }`; stable order is membership
 *   `created_at` then membership id, so renames cannot reshuffle the list.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

/** Foundation role vocabulary (companies-foundation.md §2). */
export const companyMemberRoleSchema = z.enum([
  "owner",
  "admin",
  "manager",
  "employee",
]);

export const companyMembershipViewSchema = z.object({
  membershipId: z.uuid(),
  role: companyMemberRoleSchema,
  /**
   * Effective keys for this membership after role defaults, explicit
   * grants, and explicit denies (deny wins). Owner-all is not listed —
   * `role: "owner"` remains the owner short-circuit.
   */
  permissions: z.array(z.string()),
  company: z.object({
    id: z.uuid(),
    name: z.string(),
    slug: z.string(),
    prefix: z.string(),
  }),
});

/** Never accepts a user, company, or membership identifier (ADR-0013). */
export const listMineInputSchema = z.strictObject({});

export const listMineOutputSchema = z.object({
  memberships: z.array(companyMembershipViewSchema),
});

export const listMineContract = defineActionContract({
  name: "companies.listMine",
  description:
    "List the authenticated user's own company memberships with each company's identity (id, name, slug, numbering prefix), the caller's membership id and role, and the caller's effective permission keys for that membership, in stable creation order. Returns an empty list for an account with no memberships. Takes no input; the caller is derived from the verified session only. Owner-all is not enumerated as a finite key list.",
  principal: "account",
  transport: "client",
  input: listMineInputSchema,
  output: listMineOutputSchema,
  permissions: [],
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
