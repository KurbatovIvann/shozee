/**
 * The chat document: the one thing both live and reload render.
 *
 * Parts are stored when they are settled, not re-derived later from model
 * prompt state. Two renderers reading two derivations is how a turn can show
 * one card live and a different set after reload, and how the same entity can
 * appear twice.
 *
 * A card part is a snapshot of the moment it was written. Following it should
 * re-read the live record; whatever owns that record stays the authority if
 * the two disagree.
 */
import { z } from "zod";

import { cardIdSchema, interactionIdSchema, revisionSchema } from "./ids.js";
import { publicPauseSchema } from "./pause.js";

export const textPartStatusSchema = z.enum(["streaming", "complete", "error"]);

/**
 * `complete` is set when generation finished, never to mark a write. A write
 * is proven by its surface part; a provider failure must not be able to
 * present itself as a successful reply.
 */
export const documentPartSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("text"),
    text: z.string(),
    status: textPartStatusSchema,
  }),
  z.strictObject({
    kind: z.literal("card"),
    cardId: cardIdSchema,
    revision: revisionSchema,
    /** Whatever the caller's own card registry calls this. */
    type: z.string().min(1).max(64),
    payload: z.unknown(),
  }),
  z.strictObject({
    kind: z.literal("interaction"),
    interactionId: interactionIdSchema,
    revision: revisionSchema,
    pause: publicPauseSchema,
  }),
]);

export type DocumentPart = z.output<typeof documentPartSchema>;

export const documentMessageSchema = z.strictObject({
  messageId: z.uuid(),
  role: z.enum(["user", "assistant"]),
  createdAt: z.string().min(1),
  parts: z.array(documentPartSchema),
});

export type DocumentMessage = z.output<typeof documentMessageSchema>;

export const chatDocumentSchema = z.strictObject({
  conversationId: z.uuid(),
  /**
   * Whose document this is. Stamped on the first write and matched on every
   * read: without it a conversation id alone would be enough to read someone
   * else's chat, since an id is not a secret.
   */
  bind: z.string().min(1),
  messages: z.array(documentMessageSchema),
  /** Present only while an interaction is open. Read from the pause store. */
  openPause: publicPauseSchema.nullable(),
});

export type ChatDocument = z.output<typeof chatDocumentSchema>;

/**
 * A surface part is addressed by `cardId`. Writing the same `cardId` with a
 * higher revision replaces it; it never appends a second card. This is what
 * makes "next page of the list" an update rather than a new entity.
 */
export type DocumentWrite =
  | {
      readonly kind: "append";
      readonly messageId: string;
      /** Needed because append may be the write that creates the message. */
      readonly role: DocumentMessage["role"];
      readonly parts: readonly DocumentPart[];
    }
  | {
      readonly kind: "replace_card";
      readonly messageId: string;
      readonly part: Extract<DocumentPart, { kind: "card" }>;
    };
