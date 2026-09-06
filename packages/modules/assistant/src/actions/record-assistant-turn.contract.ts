/**
 * Internal staff write: persist an assistant turn (text + tool-run rows).
 * SSE (T4) will call this. Mechanical: `timeout: 5000` is one message
 * insert plus up to 50 tool-run inserts. Result ids are uuids only —
 * never order or document status. Company id is never input.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import {
  TOOL_RUNS_MAX,
  messageBodySchema,
  toolRunInputSchema,
  toolRunViewSchema,
} from "./conversation-view.contract.js";

export const recordAssistantTurnInputSchema = z.strictObject({
  conversationId: z.uuid(),
  body: messageBodySchema,
  toolRuns: z.array(toolRunInputSchema).max(TOOL_RUNS_MAX).default([]),
});

export const recordAssistantTurnOutputSchema = z.object({
  conversationId: z.uuid(),
  messageId: z.uuid(),
  toolRuns: z.array(toolRunViewSchema),
});

export const recordAssistantTurnContract = defineActionContract({
  name: "assistant.recordAssistantTurn",
  description:
    "Record an assistant turn on a staff conversation in the active company: assistant text plus tool-run rows (action name, toolCallId, optional challengeId, result ids, outcome). Outcome is success, error, confirmation_required, or choice_required. challengeId is the opaque interaction id for confirmation or choice. Result ids are traces, not order or document status. Missing or foreign-company conversations fail with the same not-found. Company id is never input. Internal — not mounted on HTTP. Re-submitting the identical payload with the same idempotency key returns the already-recorded turn and does not insert duplicates.",
  principal: "staff",
  transport: "internal",
  input: recordAssistantTurnInputSchema,
  output: recordAssistantTurnOutputSchema,
  permissions: ["assistant:use"],
  aiExposure: "internal",
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
