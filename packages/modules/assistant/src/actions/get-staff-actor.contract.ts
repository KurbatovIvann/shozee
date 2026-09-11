/**
 * Internal staff read: `{ companyId, role, permissions }` from the verified
 * staff context. Owner-all is not enumerated into the permissions array;
 * `staffHasPermission` short-circuits it at filter time (T1/T4). Mechanical:
 * `timeout: 5000`, empty input, company id is never input.
 *
 * `companyId` is the context's, not the selector a request sent: the company
 * the membership was verified in. What the assistant's event channel is named
 * from (SHO-562).
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import { companyRoleSchema } from "./conversation-view.contract.js";

export const getStaffActorInputSchema = z.strictObject({});

export const getStaffActorOutputSchema = z.object({
  companyId: z.uuid(),
  role: companyRoleSchema,
  permissions: z.array(z.string()),
});

export const getStaffActorContract = defineActionContract({
  name: "assistant.getStaffActor",
  description:
    "Return the verified company, staff membership role and stored effective permissions for the active company. Owner-all is not enumerated as a finite permission list. Company id is never input. Does not query company_members. Internal — not mounted on HTTP.",
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
