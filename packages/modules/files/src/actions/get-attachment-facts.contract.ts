/**
 * Internal ownership facts for later `ctx.call` (SHO-112 / files-T3).
 *
 * Mechanical choices copied from `catalog.getProductPricingFacts` — do not
 * invent a second facts shape:
 * - `timeout: 5000` is the fixture default. A later `ctx.call` from catalog
 *   media shares this remaining budget; raise the *caller's* timeout if the
 *   combined read is tight.
 * - Input is `fileIds` (min 1, max 50). Output is `{ files: [...] }` of unique
 *   ready rows in first-seen order, not per-id with silent omit.
 * - The ready-file item shape is `fileReadyViewSchema` (no object key, no
 *   signed URL — security-operations.md §3).
 * - The whole batch fails with not-found when any id is missing, pending, or
 *   outside the company.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import { fileReadyViewSchema } from "./file-view.contract.js";

/** Batch ceiling named on the files-T3 ticket. */
export const ATTACHMENT_FACTS_MAX_IDS = 50;

export const getAttachmentFactsInputSchema = z.object({
  fileIds: z.array(z.uuid()).min(1).max(ATTACHMENT_FACTS_MAX_IDS),
});

export const getAttachmentFactsOutputSchema = z.object({
  files: z.array(fileReadyViewSchema),
});

export const getAttachmentFactsContract = defineActionContract({
  name: "files.getAttachmentFacts",
  description:
    "Return ownership facts for a batch of ready private catalog files in the staff member's active company. Each file includes id, purpose, MIME type, size, checksum, and ready status. The whole batch fails with not-found when any id is missing, still pending, or outside the company. Object keys and signed URLs are never returned.",
  principal: "staff",
  transport: "internal",
  input: getAttachmentFactsInputSchema,
  output: getAttachmentFactsOutputSchema,
  permissions: ["files:view"],
  aiExposure: "internal",
  risk: "read",
  requiresConfirmation: false,
  idempotent: false,
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: ["VALIDATION", "NOT_FOUND"],
  audit: false,
  timeout: 5_000,
});
