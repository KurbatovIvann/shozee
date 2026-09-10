/**
 * The pause store's invariants against a real Redis, not a Map.
 *
 * The package's own suite proves the protocol with an in-memory store. That
 * proves the logic; it does not prove that the port was implemented correctly.
 * This runs the invariants that depend entirely on the store — exactly-once
 * claim under concurrency, one open pause per conversation, and a deadline that
 * survives being touched — through Lua on a real server.
 *
 * The document and the history are not here any more: they are Postgres, and
 * their round trip is proven in the assistant module's own database suite.
 */
import { randomUUID } from "node:crypto";

import {
  createAssistantKit,
  createInteractions,
  defineInteraction,
  resolved,
  unresolvable,
} from "@showzy/assistant-kit";
import { memoryMessageLog } from "@showzy/assistant-kit/testing";
import {
  RedisContainer,
  type StartedRedisContainer,
} from "@testcontainers/redis";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createRedisAssistantKitCommands,
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

const pick = defineInteraction<{ readonly byOption: Record<string, string> }>()(
  {
    ttlMs: 60_000,
    prompt: z.strictObject({ question: z.string().min(1) }),
    answer: z.strictObject({ chose: z.string().min(1) }),
    resolve: ({ answer, secret }) => {
      const value = secret.byOption[answer.chose];
      return value === undefined
        ? unresolvable("no such option")
        : resolved(value);
    },
  },
);

const interactions = createInteractions({ pick });

/** The pause store is what this suite is about; the transcript is in memory. */
function kitOn(): ReturnType<typeof createAssistantKit<{ pick: typeof pick }>> {
  return createAssistantKit({
    pauses: createRedisAssistantKitPauseStore(redis),
    messages: memoryMessageLog(),
    clock: { now: () => new Date() },
    ids: { uuid: () => randomUUID() },
    interactions,
    window: { messages: 20 },
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

    expect(results.filter((result) => result.kind === "claimed")).toHaveLength(
      1,
    );
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
    expect((await kit.open(openInput(conversationId, bind))).kind).toBe(
      "opened",
    );
  });
});

/**
 * The releasing half of a lease, which the turn lock is built on (SHO-548).
 *
 * A plain `DEL` would let a holder whose ttl had already run out remove the
 * lock a later turn has since taken, and then two turns run at once — produced
 * by the cleanup of the thing meant to stop it.
 */
describe("deleteIfEquals", () => {
  it("removes the key only for the holder that set it", async () => {
    const store = createRedisAssistantKitPauseStore(redis);
    const key = `lease:${randomUUID()}`;
    await store.setIfAbsent(key, "mine", 60_000);

    expect(await store.deleteIfEquals(key, "someone else")).toBe(false);
    expect(await store.get(key)).toBe("mine");

    expect(await store.deleteIfEquals(key, "mine")).toBe(true);
    expect(await store.get(key)).toBeNull();
  });

  it("reports a key that was already gone", async () => {
    const store = createRedisAssistantKitPauseStore(redis);

    expect(await store.deleteIfEquals(`lease:${randomUUID()}`, "mine")).toBe(
      false,
    );
  });
});

/**
 * The command receipt, on the same Redis (SHO-547).
 *
 * A Map proves the rule; only the server proves the port. The case that
 * matters is the one a Map cannot show: two requests arriving together, which
 * is what a phone with a retry timer actually does.
 */
describe("the command receipt", () => {
  const ref = () => ({
    route: "chat" as const,
    bind: `owner:${randomUUID()}`,
    conversationId: randomUUID(),
    commandId: randomUUID(),
  });

  it("is taken once and replayed after", async () => {
    const commands = createRedisAssistantKitCommands(redis);
    const command = ref();

    expect(await commands.take(command)).toBe(true);
    expect(await commands.take(command)).toBe(false);
  });

  it("gives a command back when the request did nothing", async () => {
    const commands = createRedisAssistantKitCommands(redis);
    const command = ref();

    await commands.take(command);
    await commands.release(command);

    expect(await commands.take(command)).toBe(true);
  });

  it("admits exactly one of eight simultaneous attempts", async () => {
    const commands = createRedisAssistantKitCommands(redis);
    const command = ref();

    const results = await Promise.all(
      Array.from({ length: 8 }, () => commands.take(command)),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("expires, so a token burned before any work heals itself", async () => {
    const commands = createRedisAssistantKitCommands(redis, 40);
    const command = ref();

    expect(await commands.take(command)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(await commands.take(command)).toBe(true);
  });

  it("keeps a send and an answer apart under one token", async () => {
    const commands = createRedisAssistantKitCommands(redis);
    const chat = ref();

    expect(await commands.take(chat)).toBe(true);
    // A client that labelled both with one token must still get both done.
    expect(await commands.take({ ...chat, route: "answer" })).toBe(true);
  });
});
