/**
 * Staff client catalog of system PDF layouts (SHO-363 / feature SHO-362).
 * Tiny static list — not an `orders.list` page query. Optional `type`
 * filter. Company id is never input. `timeout: 2000` matches getArtifact.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import {
  documentLayoutRowSchema,
  documentLayoutTypeSchema,
} from "./layout.contract.js";

export const listLayoutsInputSchema = z.strictObject({
  type: documentLayoutTypeSchema.optional(),
});

export const listLayoutsOutputSchema = z.strictObject({
  layouts: z.array(documentLayoutRowSchema),
});

export const listLayoutsContract = defineActionContract({
  name: "docGeneration.listLayouts",
  description:
    "List the system PDF layouts staff can pick when issuing a payment invoice or delivery note. Optional type filter returns only that document type. Layouts are a code catalog, not tenant rows. Company id is never input.",
  principal: "staff",
  transport: "client",
  input: listLayoutsInputSchema,
  output: listLayoutsOutputSchema,
  permissions: ["documents:view"],
  aiExposure: "exposed",
  risk: "read",
  requiresConfirmation: false,
  idempotent: false,
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: ["VALIDATION"],
  audit: false,
  timeout: 2_000,
});
