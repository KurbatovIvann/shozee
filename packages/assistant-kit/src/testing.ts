/**
 * In-memory ports. The point of the port interfaces: the whole protocol is
 * verifiable with a Map — no Redis, no database, no model, no clock drift.
 *
 * Not exported from the package root; consumers import `./testing`.
 */
import {
  simulateReadableStream,
  type LanguageModel,
  type ModelMessage,
} from "ai";
import { MockLanguageModelV4 } from "ai/test";

import type { z } from "zod";

import { providerToolCallId, type ProviderToolCallId } from "./ids.js";
import type { InteractionRegistry, InteractionType } from "./interaction.js";
import type {
  Clock,
  Ids,
  KitDeps,
  MessageLogStore,
  PauseStore,
  StoredMessage,
} from "./ports.js";
import type { Continuation } from "./pause.js";

export interface MemoryPauseStore extends PauseStore {
  readonly entries: Map<string, string>;
}

export function memoryPauseStore(): MemoryPauseStore {
  const entries = new Map<string, string>();
  return {
    entries,
    get(key) {
      return Promise.resolve(entries.get(key) ?? null);
    },
    setIfAbsent(key, value) {
      if (entries.has(key)) {
        return Promise.resolve(false);
      }
      entries.set(key, value);
      return Promise.resolve(true);
    },
    compareAndSet(key, expected, next) {
      if (entries.get(key) !== expected) {
        return Promise.resolve(false);
      }
      entries.set(key, next);
      return Promise.resolve(true);
    },
    deleteIfEquals(key, expected) {
      if (entries.get(key) !== expected) {
        return Promise.resolve(false);
      }
      entries.delete(key);
      return Promise.resolve(true);
    },
    delete(key) {
      entries.delete(key);
      return Promise.resolve();
    },
  };
}

export interface MemoryMessageLog extends MessageLogStore {
  /** How many inserts and updates were accepted. */
  readonly writes: number;
}

/**
 * The log, with the refusals a real store makes: a repeated message id on
 * insert, and a `(seq, messageId)` pair that names nothing on update. Without
 * them a suite here would prove behaviour the database then contradicts.
 *
 * Messages are cloned in and out, so a test cannot pass by holding a reference
 * the kit later mutates.
 */
export function memoryMessageLog(): MemoryMessageLog {
  const byConversation = new Map<string, StoredMessage[]>();
  let writes = 0;
  return {
    get writes() {
      return writes;
    },
    page(conversationId, options) {
      const all = byConversation.get(conversationId) ?? [];
      const before = options.beforeSeq;
      const eligible =
        before === undefined ? all : all.filter((held) => held.seq < before);
      return Promise.resolve({
        records: structuredClone(
          eligible.slice(Math.max(0, eligible.length - options.limit)),
        ),
        hasOlder: eligible.length > options.limit,
      });
    },
    insert(conversationId, record) {
      const all = byConversation.get(conversationId) ?? [];
      if (all.some((held) => held.messageId === record.messageId)) {
        return Promise.reject(
          new Error(`message ${record.messageId} is already stored`),
        );
      }
      const seq = (all.at(-1)?.seq ?? 0) + 1;
      byConversation.set(conversationId, [
        ...all,
        { seq, ...structuredClone(record) },
      ]);
      writes += 1;
      return Promise.resolve({ seq });
    },
    update(conversationId, record) {
      const all = byConversation.get(conversationId) ?? [];
      const at = all.findIndex(
        (held) =>
          held.seq === record.seq && held.messageId === record.messageId,
      );
      const held = all[at];
      if (held === undefined) {
        return Promise.reject(
          new Error(
            `no message ${record.messageId} at ${String(record.seq)} to update`,
          ),
        );
      }
      const next = [...all];
      next[at] = { ...held, message: structuredClone(record.message) };
      byConversation.set(conversationId, next);
      writes += 1;
      return Promise.resolve();
    },
  };
}

export interface TestClock extends Clock {
  advance(ms: number): void;
}

export function fixedClock(
  start = new Date("2026-09-09T12:00:00.000Z"),
): TestClock {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    advance: (ms) => {
      current += ms;
    },
  };
}

/** Deterministic, and still a legal uuid so wire schemas parse. */
export function counterIds(): Ids {
  let n = 0;
  return {
    uuid() {
      n += 1;
      return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
    },
  };
}

export interface TestDeps<
  T extends Record<string, InteractionType<z.ZodType, z.ZodType, never>>,
> extends KitDeps<T> {
  readonly pauses: MemoryPauseStore;
  readonly messages: MemoryMessageLog;
  readonly clock: TestClock;
  /** What `onUnreadableMessage` was told, in order. */
  readonly unreadable: {
    readonly conversationId: string;
    readonly seq: number;
  }[];
}

/**
 * Messages per read when a suite does not say. Small enough that a paging test
 * needs no hundreds of writes; large enough that no other test reaches it.
 */
const TEST_WINDOW_MESSAGES = 20;

/**
 * The registry is a parameter, not a default: what kinds of question exist is
 * the consumer's decision, and a fixture here would quietly become a shipped
 * vocabulary.
 */
export function testDeps<
  T extends Record<string, InteractionType<z.ZodType, z.ZodType, never>>,
>(
  interactions: InteractionRegistry<T>,
  options?: { readonly windowMessages?: number },
): TestDeps<T> {
  const unreadable: TestDeps<T>["unreadable"] = [];
  return {
    pauses: memoryPauseStore(),
    messages: memoryMessageLog(),
    clock: fixedClock(),
    ids: counterIds(),
    interactions,
    window: { messages: options?.windowMessages ?? TEST_WINDOW_MESSAGES },
    unreadable,
    onUnreadableMessage: (event) => {
      unreadable.push(event);
    },
  };
}

/** Unwraps in tests only. Production code branches on the variant. */
export function toolCallId(raw: string): ProviderToolCallId {
  const parsed = providerToolCallId(raw);
  if (parsed.kind !== "ok") {
    throw new Error(`test fixture used an illegal tool call id: ${raw}`);
  }
  return parsed.id;
}

/**
 * Shaped like what `streamText` actually accumulates: the assistant tool-call
 * **and** the tool-result the pausing tool returned. Measured with a
 * `MockLanguageModelV4`, not assumed — an earlier fixture omitted the tool
 * message and hid the fact that resume must replace an output rather than
 * append one.
 */
export function pausedHistory(options?: {
  readonly id?: string;
  readonly name?: string;
  readonly placeholder?: unknown;
}): ModelMessage[] {
  const id = options?.id ?? "toolu_01";
  const name = options?.name ?? "widget_create";
  return [
    { role: "user", content: "do the thing" },
    {
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: id, toolName: name, input: { q: 1 } },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: id,
          toolName: name,
          output: {
            type: "json",
            value: (options?.placeholder ?? { status: "paused" }) as never,
          },
        },
      ],
    },
  ];
}

export function continuationOf(options?: {
  readonly messages?: readonly ModelMessage[];
  readonly id?: string;
  readonly name?: string;
}): Continuation {
  const id = options?.id ?? "toolu_01";
  const name = options?.name ?? "widget_create";
  return {
    messages: options?.messages ?? pausedHistory({ id, name }),
    pausedToolCall: { id: toolCallId(id), name },
  };
}

/**
 * Deterministic providers.
 *
 * The chunk shapes here were measured against `ai@7.0.87`, not assumed: a V4
 * `finish` part carries a structured `finishReason` and `usage`, and a
 * malformed one is swallowed — the stream completes, `finishReason` reads
 * `other`, and tools never execute. That failure looks exactly like a passing
 * test, so this knowledge belongs in one place rather than in each suite.
 */
const STUB_USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

export function stubTextStep(text: string): { stream: ReadableStream } {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        { type: "text-start" as const, id: "t1" },
        { type: "text-delta" as const, id: "t1", delta: text },
        { type: "text-end" as const, id: "t1" },
        {
          type: "finish" as const,
          finishReason: { unified: "stop" as const, raw: "end_turn" },
          usage: STUB_USAGE,
        },
      ],
    }),
  };
}

export function stubToolCallStep(
  toolCallId: string,
  toolName: string,
  input: unknown,
): { stream: ReadableStream } {
  const serialized = JSON.stringify(input);
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        { type: "tool-input-start" as const, id: toolCallId, toolName },
        {
          type: "tool-input-delta" as const,
          id: toolCallId,
          delta: serialized,
        },
        { type: "tool-input-end" as const, id: toolCallId },
        { type: "tool-call" as const, toolCallId, toolName, input: serialized },
        {
          type: "finish" as const,
          finishReason: { unified: "tool-calls" as const, raw: "tool_use" },
          usage: STUB_USAGE,
        },
      ],
    }),
  };
}

/** Successive `streamText` steps consume successive entries. */
export function stubModel(
  steps: readonly { stream: ReadableStream }[],
): LanguageModel {
  return new MockLanguageModelV4({
    doStream: [...steps] as never,
  });
}

export function stubTextModel(text: string): LanguageModel {
  return stubModel([stubTextStep(text)]);
}

/** A provider that fails before producing anything. */
export function stubBrokenModel(message = "provider is down"): LanguageModel {
  return new MockLanguageModelV4({
    doStream: () => Promise.reject(new Error(message)),
  });
}

/**
 * A provider that serves the given steps and then fails.
 *
 * Distinct from `stubBrokenModel` in a way that matters: measured against
 * `ai@7.0.87`, a failure on the **first** call rejects every promise on the
 * result, while a failure after a step has finished rejects none of them —
 * `text` reads `""`, `finishReason` reads `"other"`, and the run looks like a
 * model that had nothing to say. The two are different code paths in the host,
 * so they need different providers here.
 *
 * `before` runs just before the failing call, for a test that needs to abort at
 * that exact point.
 */
export function stubModelFailingAfter(
  steps: readonly { stream: ReadableStream }[],
  options?: { readonly message?: string; readonly before?: () => void },
): LanguageModel {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: () => {
      const step = steps[call];
      call += 1;
      if (step !== undefined) {
        return Promise.resolve(step as never);
      }
      options?.before?.();
      return Promise.reject(new Error(options?.message ?? "provider is down"));
    },
  });
}
