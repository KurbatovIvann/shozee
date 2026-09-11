/**
 * The shapes shared by the three message-log actions.
 *
 * A stored message is opaque to this module. Its shape belongs to the runtime
 * that writes it, and a schema here would be a second definition to keep in
 * step with the first — so all that is checked is that it is an object, which
 * is what a `jsonb` row that must never be `null` needs.
 */
import { z } from "zod";

/** The most messages one page read may return. */
export const CHAT_MESSAGES_PAGE_MAX = 100;

/** The runtime's owner token. Compared by the runtime, never interpreted here. */
const CHAT_MESSAGE_BIND_MAX = 512;

export const chatMessageBindSchema = z
  .string()
  .min(1)
  .max(CHAT_MESSAGE_BIND_MAX);

export const chatMessagePayloadSchema = z.record(z.string(), z.unknown());

export const chatMessageSeqSchema = z.number().int().positive();

export const chatMessageRecordSchema = z.strictObject({
  seq: chatMessageSeqSchema,
  messageId: z.uuid(),
  bind: z.string(),
  message: chatMessagePayloadSchema,
});
