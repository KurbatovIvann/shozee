import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

export const LIST_NAME_INDEX_CUSTOMERS_MAX = 20_000;
export const LIST_NAME_INDEX_GROUPS_MAX = 5_000;

const nameIndexEntrySchema = z.strictObject({
  id: z.uuid(),
  name: z.string().min(1),
});

const nameIndexListSchema = z.strictObject({
  items: z.array(nameIndexEntrySchema),
  truncated: z.boolean(),
});

export const listNameIndexInputSchema = z.strictObject({});

export const listNameIndexOutputSchema = z.strictObject({
  customers: nameIndexListSchema,
  groups: nameIndexListSchema,
});

export const listNameIndexContract = defineActionContract({
  name: "customers.listNameIndex",
  description:
    "Return every active CRM customer and every customer group in the staff member's active company as ids and names only, for the Шо parse context (ADR-0051). Archived customers are excluded. No phone, email, or any other contact field is returned: a phone or email a person says is an unchecked reference the server resolves. Each list is capped (20000 customers, 5000 groups) and sets truncated when more rows exist. Company id is never input. Internal — not mounted on HTTP.",
  principal: "staff",
  transport: "internal",
  input: listNameIndexInputSchema,
  output: listNameIndexOutputSchema,
  permissions: ["customers:view"],
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
