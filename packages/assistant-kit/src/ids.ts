/**
 * Identifiers the kit refuses to accept in an illegal shape.
 *
 * A provider rejects `tool_use.id` outside `^[a-zA-Z0-9_-]+$`. A host that
 * mints its own resume ids can therefore build a history the provider 400s
 * on, and a 400 with no committed write reads as a successful empty turn.
 * The kit does not sanitize at the provider boundary — an id that cannot be
 * sent cannot be stored, so there is one representation, not two.
 */
import { z } from "zod";

export const PROVIDER_TOOL_CALL_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

export const providerToolCallIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(PROVIDER_TOOL_CALL_ID_PATTERN, "tool call id must be [a-zA-Z0-9_-]+")
  .brand<"ProviderToolCallId">();

/**
 * A tool-call id that the provider will accept. Only `providerToolCallId`
 * produces one, so a `Continuation` cannot carry an unsendable id.
 */
export type ProviderToolCallId = z.output<typeof providerToolCallIdSchema>;

export type ProviderToolCallIdResult =
  | { readonly kind: "ok"; readonly id: ProviderToolCallId }
  | { readonly kind: "illegal"; readonly raw: string };

/** Nothing in the kit throws. Callers branch. */
export function providerToolCallId(raw: string): ProviderToolCallIdResult {
  const parsed = providerToolCallIdSchema.safeParse(raw);
  return parsed.success
    ? { kind: "ok", id: parsed.data }
    : { kind: "illegal", raw };
}

export const interactionIdSchema = z.uuid();
export const conversationIdSchema = z.uuid();
export const cardIdSchema = z.string().min(1).max(128);

/** Monotonic per interaction. A new revision invalidates an older answer. */
export const revisionSchema = z.number().int().positive();
