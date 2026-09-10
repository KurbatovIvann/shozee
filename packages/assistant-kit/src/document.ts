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
 *
 * The conversation is stored as a log of messages, not as one document. A
 * message is never touched once the request that wrote it ends, so "stored as
 * settled, returned as stored" holds per message, and a read returns a window
 * onto the log rather than the whole of it (SHO-555).
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

/**
 * A position in the log, as a client sees it: opaque. It is the stored sequence
 * number of the oldest message a read returned, and a read given it as
 * `before` returns the page that ends just before that message.
 */
export const chatCursorSchema = z.string().regex(/^[1-9][0-9]{0,8}$/);

/**
 * What a read returns: a window onto the log, not the whole of it.
 *
 * `messages` are the latest ones the consumer's window allows — or the page
 * before a cursor, when one was asked for — each exactly as stored.
 * `olderCursor` is null when nothing precedes them. Whose conversation it is
 * does not travel: every stored message carries the owner it was written under,
 * and a read by anyone else comes back empty.
 */
export const chatDocumentSchema = z.strictObject({
  conversationId: z.uuid(),
  messages: z.array(documentMessageSchema),
  olderCursor: chatCursorSchema.nullable(),
  /** Present only while an interaction is open. Read from the pause store. */
  openPause: publicPauseSchema.nullable(),
});

export type ChatDocument = z.output<typeof chatDocumentSchema>;

/**
 * The one way a turn changes the stored document: parts added to a message.
 *
 * A card is addressed by `cardId` **within its message**. Adding a card whose
 * id the message already holds replaces that card where it stands and raises
 * its revision; it never puts a second card beside it. That is what makes the
 * next page of a list, or a rollup folded into it, an update rather than a
 * second record. Another message is another scope: a list shown in an earlier
 * turn stays as it was shown.
 *
 * The rule is enforced here, by the writer, rather than chosen by whoever
 * produces a card. It used to be a second write kind, `replace_card`, that a
 * producer had to remember to pick — none did, and one list rendered as two
 * cards (SHO-551).
 *
 * Only the latest message can be written to. An id that names it merges into
 * it; any other id starts a new message, and one the log already holds further
 * back is refused rather than reopened.
 */
export interface DocumentWrite {
  readonly kind: "append";
  readonly messageId: string;
  /** Needed because append may be the write that creates the message. */
  readonly role: DocumentMessage["role"];
  readonly parts: readonly DocumentPart[];
}

/**
 * `incoming` added to a message that already holds `existing`, by the rule on
 * `DocumentWrite`. A card's revision counts its writes in the message, so the
 * revision a replacement arrives with is not the one it is stored with.
 *
 * Shared with the host, which reports the parts of a turn: a report that
 * applied its own idea of "the same card" would be a second derivation, and
 * live and reload would disagree about how many cards there are.
 */
export function appendParts(
  existing: readonly DocumentPart[],
  incoming: readonly DocumentPart[],
): DocumentPart[] {
  const parts = [...existing];
  for (const part of incoming) {
    if (part.kind !== "card") {
      parts.push(part);
      continue;
    }
    const at = parts.findIndex(
      (held) => held.kind === "card" && held.cardId === part.cardId,
    );
    const held = parts[at];
    if (held?.kind !== "card") {
      parts.push(part);
      continue;
    }
    parts[at] = { ...part, revision: held.revision + 1 };
  }
  return parts;
}
