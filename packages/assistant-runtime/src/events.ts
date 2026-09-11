/**
 * The assistant's event channel contract (ADR-0039, SHO-562).
 *
 * The worker publishes what a turn did (SHO-561); the API subscribes and
 * streams it to whoever is watching. Neither may import the other, so what they
 * must agree on lives here beside the queue contract: the channel a
 * conversation's events travel on, the presence key that says whether anybody
 * is watching (read by push, SHO-564), and the envelope an event is carried in.
 *
 * The payload schemas are client-safe and live in
 * `@showzy/validation/assistant-events`, because a phone parses them. This file
 * adds only what is the servers' business. Pure names, numbers and schemas; the
 * Redis half is `stores/assistant-events-redis.ts`.
 *
 * Both live on the shared, non-persistent Redis (`REDIS_URL`): nothing here
 * needs to survive a restart. A lost event is covered by the snapshot every
 * connection starts with, and presence is rebuilt by the streams themselves.
 */
import {
  assistantPublishedEventSchema,
  type AssistantPublishedEvent,
} from "@showzy/validation/assistant-events";
import { z } from "zod";

export { ASSISTANT_EVENTS_HEARTBEAT_MS } from "@showzy/validation/assistant-events";

/**
 * Which conversation, in which company. The company is the verified one: the
 * API's after the caller's read succeeded, the worker's from the turn row.
 */
export interface AssistantConversationAddress {
  readonly companyId: string;
  readonly conversationId: string;
}

export const ASSISTANT_EVENTS_CHANNEL_PREFIX = "assistant:events:";
export const ASSISTANT_PRESENCE_KEY_PREFIX = "assistant:presence:";
export const ASSISTANT_STREAM_SLOTS_KEY_PREFIX = "assistant:streams:";

/**
 * Company first, then conversation, both lowercased. Postgres returns a uuid
 * lowercase and a client may send one in any case; the API names the channel
 * from the request and the worker from the turn row, so the casing must not be
 * able to put them on two channels. `assistantTurnJobId` does the same.
 */
function addressPart(address: AssistantConversationAddress): string {
  return `${address.companyId.toLowerCase()}:${address.conversationId.toLowerCase()}`;
}

/** One pub/sub channel per conversation, namespaced by company. */
export function assistantConversationChannel(
  address: AssistantConversationAddress,
): string {
  return `${ASSISTANT_EVENTS_CHANNEL_PREFIX}${addressPart(address)}`;
}

/** The live streams on one conversation, each with its own deadline. */
export function assistantPresenceKey(
  address: AssistantConversationAddress,
): string {
  return `${ASSISTANT_PRESENCE_KEY_PREFIX}${addressPart(address)}`;
}

/** One person's open streams, across every conversation and company. */
export function assistantStreamSlotsKey(userId: string): string {
  return `${ASSISTANT_STREAM_SLOTS_KEY_PREFIX}${userId}`;
}

/**
 * How long a stream counts as watching without being refreshed. Three
 * heartbeats: a stream refreshes on each, so only a process that died without
 * closing its streams leaves an entry, and only for this long.
 */
export const ASSISTANT_PRESENCE_TTL_MS = 45_000;

/**
 * Open streams one person may hold at once, across devices and tabs. A phone
 * holds one; the rest is headroom for a panel tab or two and a reconnect that
 * overlaps its predecessor. A policy value, changed with a proving test.
 */
export const ASSISTANT_STREAMS_PER_USER = 5;

/**
 * A stream that delivered no event for this long is closed. The client
 * reconnects when it next needs to — returning to the foreground, sending — and
 * starts from a snapshot, so closing costs nothing and bounds how long one
 * authorization is relied on.
 */
export const ASSISTANT_STREAM_IDLE_MS = 10 * 60_000;

/**
 * Frames a stream may hold for its client and not yet have written. A turn
 * publishes a handful — a start, an update per card or step, a finish — and a
 * client that reads keeps this near zero. A backlog past it means the client
 * stopped reading: its socket holds the writes, and every frame waiting behind
 * them, a finished turn's whole window included, stays in memory until it
 * reads. Ending the stream lets all of it go with the subscription, presence
 * and slot, and the client's next connection starts from a snapshot — the
 * recovery ADR-0039 relies on for any gap. A policy value, changed with a
 * proving test.
 */
export const ASSISTANT_STREAM_PENDING_WRITES_MAX = 64;

/** What travels on a channel: a versioned envelope around one published event. */
export const assistantEventEnvelopeSchema = z.strictObject({
  version: z.literal(1),
  event: assistantPublishedEventSchema,
});

/**
 * Serialises an event for a channel, refusing one the client schema would not
 * accept — at the producer, where the bug is, rather than on every phone.
 */
export function encodeAssistantEvent(event: AssistantPublishedEvent): string {
  return JSON.stringify(
    assistantEventEnvelopeSchema.parse({ version: 1, event }),
  );
}

/** The event a channel message carries, or `null` for anything unreadable. */
export function decodeAssistantEvent(
  raw: string,
): AssistantPublishedEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = assistantEventEnvelopeSchema.safeParse(value);
  return parsed.success ? parsed.data.event : null;
}
