/**
 * The implementation. Every branch exists because a scenario demanded it;
 * nothing is defensive for its own sake.
 *
 * Two things it deliberately does not do. It does not parse a pause's
 * `secret` — that value is round-tripped, not interpreted. And it does not
 * reshape a document on read: it validates and returns the stored object, so
 * what a reload renders is byte-identical to what the live turn wrote.
 */
import type { ToolResultPart } from "ai";
import type { z } from "zod";

import type {
  ChatDocument,
  DocumentMessage,
  DocumentPart,
  DocumentWrite,
} from "./document.js";
import { chatDocumentSchema } from "./document.js";
import { providerToolCallIdSchema } from "./ids.js";
import type {
  AnyInteraction,
  InteractionType,
  Resolution,
} from "./interaction.js";
import type {
  AssistantKit,
  OpenPauseInput,
  OpenPauseResult,
  RevisePauseResult,
} from "./kit.js";
import { TURN_LEASE_MS } from "./kit.js";
import type {
  ClaimResult,
  PauseRecord,
  PauseScope,
  PublicPause,
  ResumeInput,
} from "./pause.js";
import type { KitDeps } from "./ports.js";

type AnyTypes = Record<string, InteractionType<z.ZodType, z.ZodType, never>>;

/** One open interaction per conversation is the key itself, not a query. */
function pauseKey(conversationId: string): string {
  return `pause:${conversationId}`;
}

/** One running turn per conversation, by the same means. */
function turnKey(conversationId: string): string {
  return `turn:${conversationId}`;
}

interface StoredRecord {
  readonly raw: string;
  readonly record: PauseRecord;
}

/** The only way to produce a wire view. `secret` has no path out of here. */
function publicPauseOf(record: PauseRecord): PublicPause {
  return {
    kind: record.kind,
    interactionId: record.interactionId,
    revision: record.revision,
    status: record.status,
    prompt: record.prompt,
    expiresAt: record.expiresAt,
  };
}

/**
 * A stored record whose tool-call id no longer parses is corruption, not a
 * pause. Treating it as absent keeps an unsendable id from reaching the
 * provider by a second route.
 */
function decode(raw: string): PauseRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as PauseRecord;
  if (
    typeof record.kind !== "string" ||
    typeof record.interactionId !== "string" ||
    typeof record.revision !== "number" ||
    typeof record.expiresAt !== "string" ||
    typeof record.continuation !== "object"
  ) {
    return null;
  }
  return providerToolCallIdSchema.safeParse(
    record.continuation.pausedToolCall.id,
  ).success
    ? record
    : null;
}

function isExpired(record: PauseRecord, now: Date): boolean {
  return now.getTime() >= Date.parse(record.expiresAt);
}

/** Claimed, cancelled or past its ttl — the record no longer holds the slot. */
function holdsTheSlot(record: PauseRecord, now: Date): boolean {
  return record.status === "open" && !isExpired(record, now);
}

/**
 * The registry erases each kind's type parameters, so calling `resolve`
 * through it needs this one cast. The pairing of answer and secret was
 * guaranteed where the kind was defined.
 */
function resolveThrough(
  type: AnyInteraction,
  answer: unknown,
  secret: unknown,
): Resolution {
  const resolve = type.resolve as (input: {
    readonly answer: unknown;
    readonly secret: unknown;
  }) => Resolution;
  return resolve({ answer, secret });
}

function emptyDocument(scope: PauseScope): ChatDocument {
  return {
    conversationId: scope.conversationId,
    bind: scope.bind,
    messages: [],
    openPause: null,
  };
}

/**
 * Validated, then returned as stored — a re-serialisation would make a reload a
 * second derivation of the document rather than the same one.
 *
 * A document owned by someone else reads as an empty one, which is also what a
 * conversation that does not exist looks like. A conversation id is not a
 * secret, so the two must be indistinguishable.
 */
function storedDocument(raw: unknown, scope: PauseScope): ChatDocument {
  if (!chatDocumentSchema.safeParse(raw).success) {
    return emptyDocument(scope);
  }
  const document = raw as ChatDocument;
  return document.bind === scope.bind ? document : emptyDocument(scope);
}

export function createAssistantKit<T extends AnyTypes>(
  deps: KitDeps<T>,
): AssistantKit<T> {
  /**
   * A record whose `bind` does not match reads as absent. The same answer as
   * "no such pause", on purpose — a cross-owner probe must not be
   * distinguishable from a miss.
   */
  async function readRecord(scope: PauseScope): Promise<StoredRecord | null> {
    const raw = await deps.pauses.get(pauseKey(scope.conversationId));
    if (raw === null) {
      return null;
    }
    const record = decode(raw);
    if (record === null || record.bind !== scope.bind) {
      return null;
    }
    return { raw, record };
  }

  /** Slot occupancy ignores `bind`: one open pause per conversation, full stop. */
  async function readSlot(
    conversationId: string,
  ): Promise<StoredRecord | null> {
    const raw = await deps.pauses.get(pauseKey(conversationId));
    if (raw === null) {
      return null;
    }
    const record = decode(raw);
    return record === null ? null : { raw, record };
  }

  async function put(
    record: PauseRecord,
    expected: string | null,
  ): Promise<boolean> {
    const key = pauseKey(record.conversationId);
    const next = JSON.stringify(record);
    if (expected !== null) {
      return deps.pauses.compareAndSet(key, expected, next);
    }
    const ttl = Math.max(
      1,
      Date.parse(record.expiresAt) - deps.clock.now().getTime(),
    );
    return deps.pauses.setIfAbsent(key, next, ttl);
  }

  /**
   * Build a record, or say why the kind or the payload is unacceptable. The
   * ttl comes from the kind, so one question can wait longer than another
   * without this package knowing either name.
   */
  function build(
    scope: PauseScope,
    input: Omit<OpenPauseInput<T>, "conversationId" | "bind">,
    identity: { readonly interactionId: string; readonly revision: number },
  ):
    | { readonly kind: "built"; readonly record: PauseRecord }
    | Extract<OpenPauseResult, { kind: "unknown_kind" | "invalid_prompt" }> {
    const type = deps.interactions.get(input.kind);
    if (type === undefined) {
      return { kind: "unknown_kind", kindName: input.kind };
    }
    const prompt = type.prompt.safeParse(input.prompt);
    if (!prompt.success) {
      return { kind: "invalid_prompt", reason: prompt.error.message };
    }
    return {
      kind: "built",
      record: {
        kind: input.kind,
        bind: scope.bind,
        interactionId: identity.interactionId,
        revision: identity.revision,
        conversationId: scope.conversationId,
        status: "open",
        continuation: input.continuation,
        prompt: prompt.data,
        secret: input.secret,
        expiresAt: new Date(
          deps.clock.now().getTime() + type.ttlMs,
        ).toISOString(),
      },
    };
  }

  /** Read first, then claim the slot. Two attempts absorb a lost race. */
  async function install(record: PauseRecord): Promise<OpenPauseResult> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const existing = await readSlot(record.conversationId);
      if (
        existing !== null &&
        holdsTheSlot(existing.record, deps.clock.now())
      ) {
        return {
          kind: "already_open",
          current: publicPauseOf(existing.record),
        };
      }
      if (await put(record, existing === null ? null : existing.raw)) {
        return { kind: "opened", pause: publicPauseOf(record) };
      }
    }
    const last = await readSlot(record.conversationId);
    // Unreachable with a real compare-and-set store. `already_open` is the safe
    // direction either way: the caller must not proceed with this pause.
    return {
      kind: "already_open",
      current: publicPauseOf(last === null ? record : last.record),
    };
  }

  return {
    interactions: deps.interactions,

    async open(input) {
      const scope = { conversationId: input.conversationId, bind: input.bind };
      const built = build(scope, input, {
        interactionId: deps.ids.uuid(),
        revision: 1,
      });
      return built.kind === "built" ? await install(built.record) : built;
    },

    async peek(scope) {
      const existing = await readRecord(scope);
      return existing !== null &&
        holdsTheSlot(existing.record, deps.clock.now())
        ? publicPauseOf(existing.record)
        : null;
    },

    async claim(input): Promise<ClaimResult> {
      const existing = await readRecord(input);
      if (
        existing === null ||
        existing.record.interactionId !== input.interactionId ||
        existing.record.status !== "open"
      ) {
        return { kind: "gone" };
      }
      const { record, raw } = existing;
      if (isExpired(record, deps.clock.now())) {
        return { kind: "expired" };
      }
      if (record.revision !== input.revision) {
        return { kind: "stale", current: publicPauseOf(record) };
      }
      const type = deps.interactions.get(record.kind);
      if (type === undefined) {
        // The pause outlived the deploy that removed its kind.
        return { kind: "unknown_kind", kindName: record.kind };
      }
      const answer = type.answer.safeParse(input.answer);
      if (!answer.success) {
        return { kind: "invalid_answer", reason: answer.error.message };
      }
      const resolution = resolveThrough(type, answer.data, record.secret);
      if (resolution.kind === "unresolvable") {
        // Decided before the claim is spent: a meaningless answer does not
        // burn the one claim this pause has.
        return { kind: "unresolvable", reason: resolution.reason };
      }
      // The one atomic point: whoever wins this compare-and-set owns the answer.
      const claimed: PauseRecord = { ...record, status: "claimed" };
      return (await put(claimed, raw))
        ? { kind: "claimed", record: claimed, value: resolution.value }
        : { kind: "gone" };
    },

    resume(claimed, output): ResumeInput {
      const { continuation } = claimed.record;
      const paused = continuation.pausedToolCall.id;
      const resolvedOutput = {
        type: "json",
        value: output,
      } as ToolResultPart["output"];
      return {
        messages: continuation.messages.map((message) =>
          message.role !== "tool"
            ? message
            : {
                ...message,
                content: message.content.map((part) =>
                  part.type === "tool-result" && part.toolCallId === paused
                    ? { ...part, output: resolvedOutput }
                    : part,
                ),
              },
        ),
      };
    },

    async revise(input): Promise<RevisePauseResult> {
      const existing = await readRecord(input);
      if (
        existing === null ||
        existing.record.interactionId !== input.interactionId ||
        existing.record.status !== "open"
      ) {
        return { kind: "gone" };
      }
      const built = build(input, input.next, {
        interactionId: existing.record.interactionId,
        revision: existing.record.revision + 1,
      });
      if (built.kind !== "built") {
        return built;
      }
      return (await put(built.record, existing.raw))
        ? { kind: "opened", pause: publicPauseOf(built.record) }
        : { kind: "already_open", current: publicPauseOf(existing.record) };
    },

    async abandon(input) {
      const existing = await readRecord(input);
      if (
        existing === null ||
        existing.record.interactionId !== input.interactionId
      ) {
        return { kind: "gone" };
      }
      await deps.pauses.delete(pauseKey(input.conversationId));
      return { kind: "cancelled" };
    },

    async release(input) {
      const existing = await readRecord(input);
      if (
        existing === null ||
        existing.record.interactionId !== input.interactionId ||
        existing.record.status !== "claimed"
      ) {
        return { kind: "gone" };
      }
      const reopened: PauseRecord = { ...existing.record, status: "open" };
      return (await put(reopened, existing.raw))
        ? { kind: "released" }
        : { kind: "gone" };
    },

    turn: {
      async begin(scope, options) {
        const token = deps.ids.uuid();
        const took = await deps.pauses.setIfAbsent(
          turnKey(scope.conversationId),
          token,
          options?.ttlMs ?? TURN_LEASE_MS,
        );
        return took ? { kind: "began", token } : { kind: "busy" };
      },
      end(scope, token) {
        return deps.pauses.deleteIfEquals(turnKey(scope.conversationId), token);
      },
    },

    document: {
      async read(scope) {
        const stored = storedDocument(
          await deps.documents.read(scope.conversationId),
          scope,
        );
        const existing = await readRecord(scope);
        const openPause =
          existing !== null && holdsTheSlot(existing.record, deps.clock.now())
            ? publicPauseOf(existing.record)
            : null;
        return { ...stored, openPause };
      },

      async write(scope, write: DocumentWrite) {
        const raw = await deps.documents.read(scope.conversationId);
        const parsed = chatDocumentSchema.safeParse(raw);
        if (parsed.success && (raw as ChatDocument).bind !== scope.bind) {
          return { kind: "wrong_owner" };
        }
        const current = storedDocument(raw, scope);
        const messages = [...current.messages];
        const index = messages.findIndex(
          (message) => message.messageId === write.messageId,
        );
        const existing: DocumentMessage | undefined =
          index === -1 ? undefined : messages[index];
        const parts: DocumentPart[] =
          existing === undefined ? [] : [...existing.parts];

        if (write.kind === "append") {
          parts.push(...write.parts);
        } else {
          const at = parts.findIndex(
            (part) => part.kind === "card" && part.cardId === write.part.cardId,
          );
          // Same cardId is an update. A second card is how one record showed twice.
          if (at === -1) {
            parts.push(write.part);
          } else {
            parts[at] = write.part;
          }
        }

        const next: DocumentMessage =
          existing === undefined
            ? {
                messageId: write.messageId,
                role: write.kind === "append" ? write.role : "assistant",
                createdAt: deps.clock.now().toISOString(),
                parts,
              }
            : { ...existing, parts };

        if (index === -1) {
          messages.push(next);
        } else {
          messages[index] = next;
        }

        await deps.documents.write(scope.conversationId, {
          ...current,
          conversationId: scope.conversationId,
          bind: scope.bind,
          messages,
        });
        return { kind: "written" };
      },
    },
  };
}
