/**
 * The kit's invariants against a real Redis, not a Map.
 *
 * The package's own suite proves the protocol with an in-memory store. That
 * proves the logic; it does not prove that the port was implemented correctly.
 * This runs the two invariants that depend entirely on the store — exactly-once
 * claim under concurrency, and one open pause per conversation — through Lua on
 * a real server.
 */
import { randomUUID } from "node:crypto";

import {
  createAssistantKit,
  createInteractions,
  defineInteraction,
  resolved,
  unresolvable,
} from "@showzy/assistant-kit";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  assistantKitDocumentKey,
  assistantKitHistoryKey,
  createRedisAssistantKitDocumentStore,
  createRedisAssistantKitHistoryStore,
  createRedisAssistantKitPauseStore,
} from "./assistant-kit-stores.js";

let container: StartedRedisContainer;
let redis: Redis;

beforeAll(async () => {
  container = await new RedisContainer("redis:8-alpine").start();
  redis = new Redis(container.getConnectionUrl());
}, 180_000);

afterAll(async () => {
  await redis.quit();
  await container.stop();
});

const pick = defineInteraction<{ readonly byOption: Record<string, string> }>()({
  ttlMs: 60_000,
  prompt: z.strictObject({ question: z.string().min(1) }),
  answer: z.strictObject({ chose: z.string().min(1) }),
  resolve: ({ answer, secret }) => {
    const value = secret.byOption[answer.chose];
    return value === undefined ? unresolvable("no such option") : resolved(value);
  },
});

const interactions = createInteractions({ pick });

function kitOn(): ReturnType<typeof createAssistantKit<{ pick: typeof pick }>> {
  return createAssistantKit({
    pauses: createRedisAssistantKitPauseStore(redis),
    documents: createRedisAssistantKitDocumentStore(redis),
    clock: { now: () => new Date() },
    ids: { uuid: () => randomUUID() },
    interactions,
  });
}

function openInput(conversationId: string, bind: string) {
  return {
    conversationId,
    bind,
    kind: "pick" as const,
    prompt: { question: "which one" },
    secret: { byOption: { a: "value-a" } },
    continuation: {
      messages: [{ role: "user" as const, content: "do it" }],
      pausedToolCall: { id: "toolu_1" as never, name: "thing" },
    },
  };
}

describe("the pause store, on Lua", () => {
  it("gives exactly one winner when three answers arrive together", async () => {
    const kit = kitOn();
    const conversationId = randomUUID();
    const bind = `owner:${randomUUID()}`;
    const opened = await kit.open(openInput(conversationId, bind));
    if (opened.kind !== "opened") throw new Error("expected opened");

    const claim = {
      conversationId,
      bind,
      interactionId: opened.pause.interactionId,
      revision: 1,
      answer: { chose: "a" },
    };
    const results = await Promise.all([
      kit.claim(claim),
      kit.claim(claim),
      kit.claim(claim),
    ]);

    expect(results.filter((result) => result.kind === "claimed")).toHaveLength(1);
    expect(results.filter((result) => result.kind === "gone")).toHaveLength(2);
  });

  it("holds one open pause per conversation", async () => {
    const kit = kitOn();
    const conversationId = randomUUID();
    const bind = `owner:${randomUUID()}`;

    const first = await kit.open(openInput(conversationId, bind));
    const second = await kit.open(openInput(conversationId, bind));

    expect(first.kind).toBe("opened");
    expect(second.kind).toBe("already_open");
  });

  it("keeps the original deadline through a claim", async () => {
    const kit = kitOn();
    const conversationId = randomUUID();
    const bind = `owner:${randomUUID()}`;
    const opened = await kit.open(openInput(conversationId, bind));
    if (opened.kind !== "opened") throw new Error("expected opened");
    const key = `kit:pause:${conversationId}`;

    const before = await redis.pttl(key);
    await kit.claim({
      conversationId,
      bind,
      interactionId: opened.pause.interactionId,
      revision: 1,
      answer: { chose: "a" },
    });
    const after = await redis.pttl(key);

    // `KEEPTTL`: touching a pause must not let it outlive its own deadline.
    expect(after).toBeGreaterThan(0);
    expect(after).toBeLessThanOrEqual(before);
  });

  it("frees the conversation after abandon", async () => {
    const kit = kitOn();
    const conversationId = randomUUID();
    const bind = `owner:${randomUUID()}`;
    const opened = await kit.open(openInput(conversationId, bind));
    if (opened.kind !== "opened") throw new Error("expected opened");

    await kit.abandon({
      conversationId,
      bind,
      interactionId: opened.pause.interactionId,
    });

    expect(await kit.peek({ conversationId, bind })).toBeNull();
    expect((await kit.open(openInput(conversationId, bind))).kind).toBe("opened");
  });
});

describe("the document store, on real bytes", () => {
  it("round-trips a document and refuses another owner's write", async () => {
    const kit = kitOn();
    const conversationId = randomUUID();
    const bind = `owner:${randomUUID()}`;
    const messageId = randomUUID();

    await kit.document.write(
      { conversationId, bind },
      {
        kind: "append",
        messageId,
        role: "assistant",
        parts: [{ kind: "text", text: "stored", status: "complete" }],
      },
    );

    const mine = await kit.document.read({ conversationId, bind });
    expect(mine.messages).toHaveLength(1);

    const theirs = { conversationId, bind: `owner:${randomUUID()}` };
    const refused = await kit.document.write(theirs, {
      kind: "append",
      messageId: randomUUID(),
      role: "assistant",
      parts: [{ kind: "text", text: "not yours", status: "complete" }],
    });

    expect(refused.kind).toBe("wrong_owner");
    expect((await kit.document.read(theirs)).messages).toEqual([]);
    const stored = await redis.get(assistantKitDocumentKey(conversationId));
    expect(stored).not.toContain("not yours");
  });

  it("survives unreadable bytes rather than failing the conversation", async () => {
    const kit = kitOn();
    const conversationId = randomUUID();
    const bind = `owner:${randomUUID()}`;
    await redis.set(assistantKitDocumentKey(conversationId), "{not json");

    const document = await kit.document.read({ conversationId, bind });

    expect(document.messages).toEqual([]);
  });
});

describe("the history store", () => {
  it("round-trips provider messages per owner and conversation", async () => {
    const store = createRedisAssistantKitHistoryStore(redis);
    const scope = { conversationId: randomUUID(), bind: `owner:${randomUUID()}` };
    const other = { conversationId: scope.conversationId, bind: "someone-else" };

    await store.save(scope, [{ role: "user", content: "hello" }]);

    expect(await store.load(scope)).toEqual([{ role: "user", content: "hello" }]);
    // Keyed by owner as well, so one tenant's history is not another's.
    expect(await store.load(other)).toEqual([]);
    expect(assistantKitHistoryKey(scope)).not.toBe(assistantKitHistoryKey(other));
  });
});
