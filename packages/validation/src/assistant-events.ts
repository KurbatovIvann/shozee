/**
 * The assistant's event stream, as a client reads it (ADR-0039, SHO-562).
 *
 * `GET /assistant/kit/events` answers with server-sent events. Every connection
 * begins with a `snapshot` of the conversation's latest window; after it come
 * the events a running turn publishes. Nothing is replayed: an event lost while
 * a client was away costs nothing, because the next connection starts from a
 * snapshot again.
 *
 * Declared here rather than beside the server's channel names because a phone
 * parses these and may import only client-safe packages (contract.md §2). The
 * server validates everything it publishes against these same schemas
 * (`@showzy/assistant-runtime`), so a producer and a reader cannot disagree
 * about a field.
 */
import { z } from "zod";

import {
  assistantChatMessageSchema,
  assistantChatWindowSchema,
} from "./assistant-chat.js";

/**
 * How often a live stream sends a comment line when nothing else happened
 * (ADR-0039, starting values). A client that hears nothing for several of these
 * may treat the stream as dead and reconnect.
 */
export const ASSISTANT_EVENTS_HEARTBEAT_MS = 15_000;

/** Which accept produced a turn. Pinned to the module's turn row in `apps/api`. */
export const assistantStreamTurnKindSchema = z.enum(["chat", "answer"]);

/** How a turn ended. Pinned to the module's finish outcome in `apps/api`. */
export const assistantStreamTurnStatusSchema = z.enum([
  "done",
  "failed",
  "interrupted",
]);

/** The conversation as it stands when the connection opened. Always first. */
export const assistantSnapshotEventSchema = z.strictObject({
  type: z.literal("snapshot"),
  window: assistantChatWindowSchema,
});

export const assistantTurnStartedEventSchema = z.strictObject({
  type: z.literal("turn.started"),
  conversationId: z.uuid(),
  kind: assistantStreamTurnKindSchema,
  commandId: z.uuid(),
});

/**
 * The latest message, whole, with its stored `revision`. A client holding
 * another copy of the same message keeps whichever revision is higher.
 */
export const assistantMessageUpdatedEventSchema = z.strictObject({
  type: z.literal("message.updated"),
  conversationId: z.uuid(),
  message: assistantChatMessageSchema,
});

/**
 * The turn's outcome and the window after it. The window is there, not only the
 * last message, because its `openPause` is the authority on which question is
 * answerable, and no single message can say that.
 *
 * It is absent when the reconciler ended the turn rather than the process that
 * ran it (SHO-570): that pass acts for no person, and a conversation is read as
 * the person whose conversation it is. A client that receives one without a
 * window has been told the turn ended and reads the conversation itself.
 */
export const assistantTurnFinishedEventSchema = z.strictObject({
  type: z.literal("turn.finished"),
  kind: assistantStreamTurnKindSchema,
  commandId: z.uuid(),
  status: assistantStreamTurnStatusSchema,
  window: assistantChatWindowSchema.optional(),
});

/**
 * Names held for later and never sent now. `text.delta` is streaming tokens;
 * its payload is decided when that ships, so no schema is guessed here and no
 * publisher can produce one.
 */
export const ASSISTANT_RESERVED_EVENT_TYPES = ["text.delta"] as const;

/** What a running turn publishes. A snapshot is never published: each connection reads its own. */
export const assistantPublishedEventSchema = z.discriminatedUnion("type", [
  assistantTurnStartedEventSchema,
  assistantMessageUpdatedEventSchema,
  assistantTurnFinishedEventSchema,
]);

export type AssistantPublishedEvent = z.output<
  typeof assistantPublishedEventSchema
>;

/** Everything a stream may carry. */
export const assistantStreamEventSchema = z.discriminatedUnion("type", [
  assistantSnapshotEventSchema,
  assistantTurnStartedEventSchema,
  assistantMessageUpdatedEventSchema,
  assistantTurnFinishedEventSchema,
]);

export type AssistantStreamEvent = z.output<typeof assistantStreamEventSchema>;

/**
 * One server-sent event as a client receives it: the SSE `event` name and its
 * `data` line. The name must agree with the payload's own `type`; anything
 * unreadable, reserved or unknown answers `null`, for the client to skip.
 */
export function parseAssistantStreamEvent(
  eventName: string,
  data: string,
): AssistantStreamEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return null;
  }
  const parsed = assistantStreamEventSchema.safeParse(raw);
  if (!parsed.success || parsed.data.type !== eventName) {
    return null;
  }
  return parsed.data;
}
