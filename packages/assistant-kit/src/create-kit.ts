/**
 * The implementation. Every branch exists because a scenario in
 * `SCENARIOS.md` demanded it; nothing is defensive for its own sake.
 *
 * Two things this file deliberately does not do. It does not validate
 * `resolvedInput` — the kit has no opinion about a caller's canonical input,
 * so that value is round-tripped, not parsed. And it does not reshape a
 * document on read: it validates and returns the stored object, so what
 * reload renders is byte-identical to what live wrote.
 */
import type {
  ChatDocument,
  DocumentMessage,
  DocumentPart,
  DocumentWrite,
} from "./document.js";
import { chatDocumentSchema } from "./document.js";
import { providerToolCallIdSchema } from "./ids.js";
import type {
  AssistantKit,
  OpenPauseInput,
  OpenPauseResult,
  RevisePauseResult,
} from "./kit.js";
import type { KitDeps } from "./ports.js";
import type {
  Answer,
  AnswerKind,
  ClaimResult,
  PauseKind,
  PauseRecord,
  PublicPause,
  ResumeInput,
} from "./pause.js";

/** One open interaction per conversation is the key itself, not a query. */
function pauseKey(conversationId: string): string {
  return `pause:${conversationId}`;
}

const ANSWERS_BY_KIND: Readonly<Record<PauseKind, readonly AnswerKind[]>> = {
  choice: ["select", "text"],
  confirmation: ["approve", "reject", "text"],
};

type AnyRecord = PauseRecord<unknown>;

interface StoredRecord {
  readonly raw: string;
  readonly record: AnyRecord;
}

function optionMapOf(
  options: readonly { readonly optionId: string; readonly entityId: string }[],
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const option of options) {
    map[option.optionId] = option.entityId;
  }
  return map;
}

/** The only way to produce a wire view. `entityId` has no path out of here. */
function publicPauseOf(record: AnyRecord): PublicPause {
  return {
    kind: record.kind,
    interactionId: record.interactionId,
    revision: record.revision,
    status: record.status,
    subject: record.subject,
    ...(record.summary !== undefined ? { summary: record.summary } : {}),
    options: record.options.map((option) => ({
      optionId: option.optionId,
      label: option.label,
      ...(option.detail !== undefined ? { detail: option.detail } : {}),
    })),
    optionsTruncated: record.optionsTruncated,
    expiresAt: record.expiresAt,
  };
}

/**
 * A stored record whose tool-call id no longer parses is corruption, not a
 * pause. Treating it as absent keeps an unsendable id from reaching the
 * provider by a second route.
 */
function decode(raw: string): AnyRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as AnyRecord;
  if (
    typeof record.interactionId !== "string" ||
    typeof record.revision !== "number" ||
    typeof record.expiresAt !== "string" ||
    typeof record.continuation !== "object"
  ) {
    return null;
  }
  const id = providerToolCallIdSchema.safeParse(
    record.continuation.pausedToolCall.id,
  );
  return id.success ? record : null;
}

function isExpired(record: AnyRecord, now: Date): boolean {
  return now.getTime() >= Date.parse(record.expiresAt);
}

/** Claimed, cancelled or past its ttl — the record no longer holds the slot. */
function holdsTheSlot(record: AnyRecord, now: Date): boolean {
  return record.status === "open" && !isExpired(record, now);
}

function recordFrom<TInput>(
  conversationId: string,
  outcome: OpenPauseInput<TInput>["outcome"],
  continuation: PauseRecord<TInput>["continuation"],
  identity: { readonly interactionId: string; readonly revision: number },
  deps: KitDeps,
): PauseRecord<TInput> {
  const isChoice = outcome.kind === "needs_choice";
  const ttl = isChoice ? deps.choiceTtlMs : deps.confirmationTtlMs;
  const options = isChoice ? outcome.options : [];
  return {
    kind: isChoice ? "choice" : "confirmation",
    interactionId: identity.interactionId,
    revision: identity.revision,
    conversationId,
    status: "open",
    continuation,
    resolvedInput: outcome.resume,
    optionMap: optionMapOf(options),
    // A confirmation has no list to choose from, so its summary is the subject.
    subject: isChoice ? outcome.subject : outcome.summary,
    options,
    optionsTruncated: isChoice ? outcome.optionsTruncated : false,
    ...(isChoice ? {} : { summary: outcome.summary }),
    ...(!isChoice && outcome.challengeRef !== undefined
      ? { challengeRef: outcome.challengeRef }
      : {}),
    expiresAt: new Date(deps.clock.now().getTime() + ttl).toISOString(),
  };
}

function emptyDocument(conversationId: string): ChatDocument {
  return { conversationId, messages: [], openPause: null };
}

function storedDocument(raw: unknown, conversationId: string): ChatDocument {
  // Validated, then returned as stored — a re-serialisation would make reload
  // a second derivation of the document rather than the same one.
  return chatDocumentSchema.safeParse(raw).success
    ? (raw as ChatDocument)
    : emptyDocument(conversationId);
}

export function createAssistantKit(deps: KitDeps): AssistantKit {
  async function readRecord(conversationId: string): Promise<StoredRecord | null> {
    const raw = await deps.pauses.get(pauseKey(conversationId));
    if (raw === null) {
      return null;
    }
    const record = decode(raw);
    return record === null ? null : { raw, record };
  }

  async function put<TInput>(
    record: PauseRecord<TInput>,
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

  /** Read first, then claim the slot. Two attempts absorb a lost race. */
  async function install<TInput>(
    record: PauseRecord<TInput>,
  ): Promise<OpenPauseResult> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const existing = await readRecord(record.conversationId);
      if (existing !== null && holdsTheSlot(existing.record, deps.clock.now())) {
        return { kind: "already_open", current: publicPauseOf(existing.record) };
      }
      if (await put(record, existing === null ? null : existing.raw)) {
        return { kind: "opened", pause: publicPauseOf(record) };
      }
    }
    const last = await readRecord(record.conversationId);
    // Unreachable with a real compare-and-set store. `already_open` is the safe
    // direction either way: the caller must not proceed with this pause.
    return {
      kind: "already_open",
      current: publicPauseOf(last === null ? record : last.record),
    };
  }

  return {
    open<TInput>(input: OpenPauseInput<TInput>): Promise<OpenPauseResult> {
      return install(
        recordFrom(
          input.conversationId,
          input.outcome,
          input.continuation,
          { interactionId: deps.ids.uuid(), revision: 1 },
          deps,
        ),
      );
    },

    async peek(conversationId) {
      const existing = await readRecord(conversationId);
      return existing !== null && holdsTheSlot(existing.record, deps.clock.now())
        ? publicPauseOf(existing.record)
        : null;
    },

    async claim<TInput>(input: {
      readonly conversationId: string;
      readonly interactionId: string;
      readonly revision: number;
      readonly answer: Answer;
    }): Promise<ClaimResult<TInput>> {
      const existing = await readRecord(input.conversationId);
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
      const accepted = ANSWERS_BY_KIND[record.kind];
      if (!accepted.includes(input.answer.kind)) {
        return { kind: "wrong_answer_kind", expected: accepted };
      }
      // The one atomic point: whoever wins this compare-and-set owns the answer.
      const claimed: AnyRecord = { ...record, status: "claimed" };
      return (await put(claimed, raw))
        ? { kind: "claimed", record: claimed as PauseRecord<TInput> }
        : { kind: "gone" };
    },

    resume<TInput>(
      claimed: Extract<ClaimResult<TInput>, { kind: "claimed" }>,
      output: unknown,
    ): ResumeInput {
      const { continuation } = claimed.record;
      return {
        messages: continuation.messages,
        toolResult: {
          toolCallId: continuation.pausedToolCall.id,
          toolName: continuation.pausedToolCall.name,
          output,
        },
      };
    },

    entityIdFor(record, optionId) {
      return record.optionMap[optionId];
    },

    async revise<TInput>(input: {
      readonly conversationId: string;
      readonly interactionId: string;
      readonly next: Omit<OpenPauseInput<TInput>, "conversationId">;
    }): Promise<RevisePauseResult> {
      const existing = await readRecord(input.conversationId);
      if (
        existing === null ||
        existing.record.interactionId !== input.interactionId ||
        existing.record.status !== "open"
      ) {
        return { kind: "gone" };
      }
      const revised = recordFrom(
        input.conversationId,
        input.next.outcome,
        input.next.continuation,
        {
          interactionId: existing.record.interactionId,
          revision: existing.record.revision + 1,
        },
        deps,
      );
      return (await put(revised, existing.raw))
        ? { kind: "opened", pause: publicPauseOf(revised) }
        : { kind: "already_open", current: publicPauseOf(existing.record) };
    },

    async abandon(input) {
      const existing = await readRecord(input.conversationId);
      if (
        existing === null ||
        existing.record.interactionId !== input.interactionId
      ) {
        return { kind: "gone" };
      }
      await deps.pauses.delete(pauseKey(input.conversationId));
      return { kind: "cancelled" };
    },

    document: {
      async read(conversationId) {
        const stored = storedDocument(
          await deps.documents.read(conversationId),
          conversationId,
        );
        const existing = await readRecord(conversationId);
        const openPause =
          existing !== null && holdsTheSlot(existing.record, deps.clock.now())
            ? publicPauseOf(existing.record)
            : null;
        return { ...stored, openPause };
      },

      async write(conversationId, write: DocumentWrite) {
        const current = storedDocument(
          await deps.documents.read(conversationId),
          conversationId,
        );
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
            (part) => part.kind === "surface" && part.cardId === write.part.cardId,
          );
          // Same cardId is an update. A second card is how one entity showed twice.
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

        await deps.documents.write(conversationId, {
          ...current,
          conversationId,
          messages,
        });
      },
    },
  };
}
