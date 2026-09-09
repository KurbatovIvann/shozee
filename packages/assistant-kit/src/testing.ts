/**
 * In-memory ports. The point of the port interfaces: the whole protocol is
 * verifiable with a Map — no Redis, no database, no model, no clock drift.
 *
 * Not exported from the package root; consumers import `./testing`.
 */
import type { ModelMessage } from "ai";

import { providerToolCallId, type ProviderToolCallId } from "./ids.js";
import type { Clock, Ids, KitDeps, PauseStore, DocumentStore } from "./ports.js";
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

export function fixedClock(start = new Date("2026-09-09T12:00:00.000Z")): TestClock {
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

export const TEST_CHOICE_TTL_MS = 15 * 60 * 1000;
export const TEST_CONFIRMATION_TTL_MS = 5 * 60 * 1000;

export interface TestDeps extends KitDeps {
  readonly pauses: MemoryPauseStore;
  readonly documents: MemoryDocumentStore;
  readonly clock: TestClock;
}

export function testDeps(): TestDeps {
  return {
    pauses: memoryPauseStore(),
    documents: memoryDocumentStore(),
    clock: fixedClock(),
    ids: counterIds(),
    choiceTtlMs: TEST_CHOICE_TTL_MS,
    confirmationTtlMs: TEST_CONFIRMATION_TTL_MS,
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
      content: [{ type: "tool-call", toolCallId: id, toolName: name, input: { q: 1 } }],
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
            value: (options?.placeholder ?? { status: "needs_choice" }) as never,
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
