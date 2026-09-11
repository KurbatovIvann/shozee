import type { z } from "zod";

import type { InteractionRegistry, InteractionType } from "./interaction.js";

/**
 * Everything this package needs from the outside, and nothing more.
 *
 * The kit owns no storage. A test supplies a Map and needs no Redis, no
 * Postgres and no model. That is the whole reason these are interfaces:
 * the protocol is verifiable without infrastructure.
 */

/** Compare-and-set key store. Redis in production. */
export interface PauseStore {
  get(key: string): Promise<string | null>;
  /** False when the key already exists — this is the one-open-pause guard. */
  setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean>;
  /** False on mismatch — this is the exactly-once claim. */
  compareAndSet(key: string, expected: string, next: string): Promise<boolean>;
  /**
   * False when the key held something else, or nothing.
   *
   * The releasing half of a lease. A plain delete would let a holder whose ttl
   * had already run out remove the lock that someone else has since taken —
   * rare, and exactly the kind of rare that later reads as a mystery.
   */
  deleteIfEquals(key: string, expected: string): Promise<boolean>;
  delete(key: string): Promise<void>;
}

/**
 * One message as the log stores it.
 *
 * `message` is opaque to the store and validated by the kit on the way out.
 * `seq` belongs to the store: assigned on insert, never reused.
 */
export interface StoredMessage {
  readonly seq: number;
  readonly messageId: string;
  /** The owner token the message was written under. */
  readonly bind: string;
  readonly message: unknown;
  /**
   * Also the store's: 1 on insert, raised by one on every update. It is how a
   * reader holding two copies of one message keeps the newer, so it travels
   * with the message in every window rather than being part of what was
   * written.
   */
  readonly revision: number;
}

/**
 * A conversation's transcript, stored as the log it is.
 *
 * A message is written by the request that produced it and never touched once
 * that request ends. So there is no "write the conversation" here: there is
 * adding a message at the end, and replacing the one message still being
 * written. The shape of the port is what keeps an older message out of reach —
 * nothing can address one except by the pair a caller has just read as the
 * latest.
 */
export interface MessageLogStore {
  /**
   * Oldest first within the page. Without `beforeSeq` this is the latest page;
   * `hasOlder` says whether anything precedes it.
   */
  page(
    conversationId: string,
    options: { readonly beforeSeq?: number; readonly limit: number },
  ): Promise<{
    readonly records: readonly StoredMessage[];
    readonly hasOlder: boolean;
  }>;
  /** Rejects a message id the conversation already holds. Never an update. */
  insert(
    conversationId: string,
    record: {
      readonly messageId: string;
      readonly bind: string;
      readonly message: unknown;
    },
  ): Promise<{ readonly seq: number }>;
  /** Rejects when `seq` and `messageId` together name no stored message. */
  update(
    conversationId: string,
    record: {
      readonly seq: number;
      readonly messageId: string;
      readonly message: unknown;
    },
  ): Promise<void>;
}

export interface Clock {
  now(): Date;
}

export interface Ids {
  uuid(): string;
}

export interface KitDeps<
  T extends Record<string, InteractionType<z.ZodType, z.ZodType, never>>,
> {
  readonly pauses: PauseStore;
  readonly messages: MessageLogStore;
  readonly clock: Clock;
  readonly ids: Ids;
  /** The kinds this deployment accepts. Their ttl travels with them. */
  readonly interactions: InteractionRegistry<T>;
  /**
   * How many messages one read of the conversation returns. The consumer's to
   * choose: it is a question of what a screen shows and what a response costs,
   * not of the protocol.
   */
  readonly window: { readonly messages: number };
  /**
   * A stored message this build cannot parse — written by a newer deploy and
   * read by an older one, typically. It is skipped and never overwritten; this
   * is how the consumer gets to say so in its own logs.
   */
  readonly onUnreadableMessage?: (event: {
    readonly conversationId: string;
    readonly seq: number;
  }) => void;
}
