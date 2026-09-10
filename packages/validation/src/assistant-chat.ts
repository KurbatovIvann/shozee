/**
 * The client-readable half of the assistant chat protocol.
 *
 * `@showzy/assistant-kit` owns the server side of these shapes. A client app
 * may not import that package (client apps are limited to the client-safe
 * packages, contract.md §2), and the kit may not import this one — it carries
 * no knowledge of this product. So the shape is declared on both sides, and
 * `apps/api` — the one place allowed to see both — pins them together with a
 * conformance test. One drifting field fails that test rather than a screen.
 *
 * Two halves live here. The document and pause schemas are the protocol, and
 * would be identical for any product. The prompt schemas below them are this
 * product's vocabulary: what a question *is*. The API imports those instead of
 * declaring its own, so a picker's cap is one number, not two.
 */
import { z } from "zod";

/* ------------------------------------------------------------------ *
 * The protocol: what a stored conversation looks like on the wire.
 * ------------------------------------------------------------------ */

export const assistantPauseStatusSchema = z.enum([
  "open",
  "claimed",
  "answered",
  "cancelled",
  "expired",
]);

/**
 * Everything a client may see of an open question. There is deliberately no
 * field able to hold the server's `secret`: what an option *means* is resolved
 * on the server, so a client sends back an `optionId` and nothing else.
 */
export const assistantPauseSchema = z.strictObject({
  kind: z.string().min(1),
  interactionId: z.uuid(),
  revision: z.number().int().positive(),
  status: assistantPauseStatusSchema,
  /** Validated by the kind's own prompt schema below, not here. */
  prompt: z.unknown(),
  expiresAt: z.string().min(1),
});

export type AssistantPause = z.output<typeof assistantPauseSchema>;

export const assistantChatTextStatusSchema = z.enum([
  "streaming",
  "complete",
  "error",
]);

/**
 * `type` and `payload` are an `AssistantSurfaceData` from
 * `./assistant-surfaces`, written by the server when the card was produced.
 * Left unvalidated here on purpose: that union has no schema — it is a parse
 * result, not an input shape — so the reader localizes defensively and drops a
 * payload it cannot render. Named as a gap rather than papered over.
 */
export const assistantChatPartSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("text"),
    text: z.string(),
    status: assistantChatTextStatusSchema,
  }),
  z.strictObject({
    kind: z.literal("card"),
    cardId: z.string().min(1).max(128),
    revision: z.number().int().positive(),
    type: z.string().min(1).max(64),
    payload: z.unknown(),
  }),
  z.strictObject({
    kind: z.literal("interaction"),
    interactionId: z.uuid(),
    revision: z.number().int().positive(),
    pause: assistantPauseSchema,
  }),
]);

export type AssistantChatPart = z.output<typeof assistantChatPartSchema>;

export const assistantChatMessageSchema = z.strictObject({
  messageId: z.uuid(),
  role: z.enum(["user", "assistant"]),
  createdAt: z.string().min(1),
  parts: z.array(assistantChatPartSchema),
});

export type AssistantChatMessage = z.output<typeof assistantChatMessageSchema>;

/**
 * A window onto the conversation: its latest messages, or the page before a
 * cursor, each exactly as stored.
 *
 * `olderCursor` says where the page before these messages starts, and is null
 * when nothing precedes them. It is opaque — a client hands it back as `before`
 * and never reads it.
 *
 * `openPause` is the authority on which question is answerable — not the
 * `interaction` parts, which are snapshots of the moment each was asked. An
 * answered question simply stops appearing here, so a client needs no local
 * memory of what it has already answered.
 */
export const assistantChatDocumentSchema = z.strictObject({
  conversationId: z.uuid(),
  messages: z.array(assistantChatMessageSchema),
  olderCursor: z.string().min(1).nullable(),
  openPause: assistantPauseSchema.nullable(),
});

export type AssistantChatDocument = z.output<
  typeof assistantChatDocumentSchema
>;

/* ------------------------------------------------------------------ *
 * This product's vocabulary: the kinds of question it asks.
 * ------------------------------------------------------------------ */

/**
 * Cap on a picker. A UI decision, not a protocol one: a six-flavour product
 * needs more than five, and a list past twenty stops being a choice.
 */
export const ASSISTANT_CHOICE_OPTIONS_MAX = 20;

export const assistantChoiceOptionSchema = z.strictObject({
  optionId: z.string().min(1).max(128),
  label: z.string().min(1).max(400),
  detail: z.string().min(1).max(400).optional(),
});

export const assistantChoicePromptSchema = z.strictObject({
  subject: z.string().min(1).max(200),
  options: z
    .array(assistantChoiceOptionSchema)
    .min(1)
    .max(ASSISTANT_CHOICE_OPTIONS_MAX),
  /** True when the real list was longer than the cap above. */
  optionsTruncated: z.boolean(),
});

export const assistantConfirmationPromptSchema = z.strictObject({
  summary: z.string().min(1).max(2000),
});

export type AssistantChoiceOption = z.output<
  typeof assistantChoiceOptionSchema
>;

/** An open question with its prompt already parsed. */
export type AssistantInteraction =
  | {
      readonly kind: "choice";
      readonly interactionId: string;
      readonly revision: number;
      readonly subject: string;
      readonly options: readonly AssistantChoiceOption[];
      readonly optionsTruncated: boolean;
    }
  | {
      readonly kind: "confirmation";
      readonly interactionId: string;
      readonly revision: number;
      readonly summary: string;
    };

/**
 * `null` for a kind this build does not know, or a prompt that does not parse.
 *
 * Both are the forward-compatibility case: a phone that has not been updated
 * reading a conversation from a newer server. Rendering nothing is correct
 * there; rendering a half-built card is not.
 */
export function assistantInteractionFromPause(
  pause: AssistantPause,
): AssistantInteraction | null {
  if (pause.kind === "choice") {
    const prompt = assistantChoicePromptSchema.safeParse(pause.prompt);
    return prompt.success
      ? {
          kind: "choice",
          interactionId: pause.interactionId,
          revision: pause.revision,
          subject: prompt.data.subject,
          options: prompt.data.options,
          optionsTruncated: prompt.data.optionsTruncated,
        }
      : null;
  }
  if (pause.kind === "confirmation") {
    const prompt = assistantConfirmationPromptSchema.safeParse(pause.prompt);
    return prompt.success
      ? {
          kind: "confirmation",
          interactionId: pause.interactionId,
          revision: pause.revision,
          summary: prompt.data.summary,
        }
      : null;
  }
  return null;
}
