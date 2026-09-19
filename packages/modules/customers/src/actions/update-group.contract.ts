import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import {
  groupDescriptionSchema,
  groupNameSchema,
  groupViewSchema,
} from "./group-view.contract.js";

export const updateGroupInputSchema = z.strictObject({
  id: z.uuid(),
  name: groupNameSchema,
  description: groupDescriptionSchema.nullable(),
  priceListId: z.uuid().nullable().optional(),
});

export const updateGroupOutputSchema = groupViewSchema;

export const updateGroupContract = defineActionContract({
  name: "customers.updateGroup",
  description:
    "Update the name, description, and price-list assignment of a customer group in the staff member's active company. The slug stays the previous value. Changes only the fields it names: an omitted description or price list keeps its stored value and an explicit null clears it. A null price list returns the group to inherit the company default. Missing groups and groups that belong to another company fail with the same not-found. Company id is never input. Re-submitting the identical payload with the same idempotency key returns the same view without a second write.",
  principal: "staff",
  transport: "client",
  input: updateGroupInputSchema,
  output: updateGroupOutputSchema,
  permissions: ["customers:edit"],
  aiExposure: "exposed",
  risk: "write",
  requiresConfirmation: false,
  idempotent: true,
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: ["VALIDATION", "NOT_FOUND"],
  audit: true,
  timeout: 5_000,
});
