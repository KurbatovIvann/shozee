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
  PauseStore,
  DocumentStore,
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
    delete(key) {
      entries.delete(key);
      return Promise.resolve();
    },
  };
}

export interface MemoryDocumentStore extends DocumentStore {
  readonly writes: unknown[];
}

export function memoryDocumentStore(): MemoryDocumentStore {
  const byConversation = new Map<string, unknown>();
  const writes: unknown[] = [];
  return {
    writes,
    read(conversationId) {
      return Promise.resolve(byConversation.get(conversationId) ?? null);
    },
    write(conversationId, write) {
      writes.push(write);
      byConversation.set(conversationId, write);
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
  readonly documents: MemoryDocumentStore;
  readonly clock: TestClock;
}

/**
 * The registry is a parameter, not a default: what kinds of question exist is
 * the consumer's decision, and a fixture here would quietly become a shipped
 * vocabulary.
 */
export function testDeps<
  T extends Record<string, InteractionType<z.ZodType, z.ZodType, never>>,
>(interactions: InteractionRegistry<T>): TestDeps<T> {
  return {
    pauses: memoryPauseStore(),
    documents: memoryDocumentStore(),
    clock: fixedClock(),
    ids: counterIds(),
    interactions,
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
