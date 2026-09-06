/**
 * Internal staff read: `{ role, permissions }` from `ctx.membership`.
 * Owner-all is not enumerated into the permissions array; `staffHasPermission`
 * short-circuits it at filter time (T1/T4). Mechanical: `timeout: 5000`,
 * empty input, company id is never input.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import { companyRoleSchema } from "./conversation-view.contract.js";

export const getStaffActorInputSchema = z.strictObject({});

export const getStaffActorOutputSchema = z.object({
  role: companyRoleSchema,
  permissions: z.array(z.string()),
});

export const getStaffActorContract = defineActionContract({
  name: "assistant.getStaffActor",
  description:
    "Return the verified staff membership role and stored effective permissions for the active company. Owner-all is not enumerated as a finite permission list. Company id is never input. Does not query company_members. Internal — not mounted on HTTP.",
  principal: "staff",
  transport: "internal",
  input: getStaffActorInputSchema,
  output: getStaffActorOutputSchema,
  permissions: ["assistant:use"],
  aiExposure: "internal",
  risk: "read",
  requiresConfirmation: false,
  idempotent: false,
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: [],
  audit: false,
  timeout: 5_000,
});
