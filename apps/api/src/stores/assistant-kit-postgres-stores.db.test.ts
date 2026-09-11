/**
 * The durable half of a conversation, against a real database.
 *
 * The claim being tested is the one phase 1 exists for: a conversation survives
 * the process that produced it. Everything else about the kit is proven with a
 * Map; this cannot be, because "it is still there tomorrow" is a property of the
 * store and nothing else.
 *
 * Driven through `createAssistantKitRuntime`, not through HTTP — the question is
 * whether the ports are wired to Postgres and scoped to the caller, and an app
 * with auth in front of it would only make that harder to see.
 */
import { randomUUID } from "node:crypto";

import type { ModelMessage } from "@showzy/assistant-kit";
import {
  ASSISTANT_CHAT_WINDOW_MESSAGES,
  AssistantKitConversationGoneError,
} from "@showzy/assistant-runtime";
import { createActionRegistry } from "../composition.js";
import {
  createTestKit,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import { assistantConversations } from "@showzy/db/schema/assistant";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AssistantKitRuntime } from "../http/assistant-kit-http.js";
import { createAssistantKitRuntime } from "../http/assistant-kit-runtime.js";

let kit: TestKit;
const conversationId = randomUUID();
const longConversationId = randomUUID();
const otherConversationId = randomUUID();

const anna = {
  userId: kitIdentities.users.anna,
  companySelector: kitIdentities.companies.a,
  requestId: randomUUID(),
  clientIp: "127.0.0.1",
};

const boris = {
  userId: kitIdentities.users.boris,
  companySelector: kitIdentities.companies.b,
  requestId: randomUUID(),
  clientIp: "127.0.0.1",
};

const annaBind = `${anna.userId}:${anna.companySelector}`;

/** Pauses only. A deadline and an atomic claim are not what this suite is about. */
function memoryRedis() {
  const rows = new Map<string, string>();
  return {
    eval: (_lua: string, _keys: number, key: string, value: string) => {
      if (rows.has(key)) {
        return Promise.resolve(null);
      }
      rows.set(key, value);
      return Promise.resolve("OK");
    },
    get: (key: string) => Promise.resolve(rows.get(key) ?? null),
    set: (key: string, value: string) => {
      rows.set(key, value);
      return Promise.resolve("OK");
    },
    del: (key: string) => {
      rows.delete(key);
      return Promise.resolve(1);
    },
  } as never;
}

/**
 * A fresh runtime every time, so nothing can be carried between assertions in
 * process memory. If a message survives, it survived in the database.
 */
function runtime(): AssistantKitRuntime {
  return createAssistantKitRuntime({
    auth: { api: { getSession: () => Promise.resolve(null) } },
    registry: createActionRegistry(),
    pipeline: kit.pipeline,
    model: "mock",
    redis: memoryRedis(),
  });
}

function say(text: string, messageId: string = randomUUID()) {
  return {
    kind: "append" as const,
    messageId,
    role: "user" as const,
    parts: [{ kind: "text" as const, text, status: "complete" as const }],
  };
}

beforeAll(async () => {
  kit = await createTestKit();
  await kit.db.runtime.db.insert(assistantConversations).values([
    {
      id: conversationId,
      companyId: kitIdentities.companies.a,
      userId: kitIdentities.users.anna,
      title: "Durable",
    },
    {
      id: longConversationId,
      companyId: kitIdentities.companies.a,
      userId: kitIdentities.users.anna,
      title: "Long",
    },
    {
      id: otherConversationId,
      companyId: kitIdentities.companies.b,
      userId: kitIdentities.users.boris,
      title: "Someone else's",
    },
  ]);
}, 180_000);

afterAll(async () => {
  await kit.db.close();
});

describe("the conversation, across processes", () => {
  it("is still there for a runtime that never saw it written", async () => {
    const scope = { conversationId, bind: annaBind };
    await runtime().forCaller(anna).kit.messages.write(scope, say("Готово."));

    const read = await runtime().forCaller(anna).kit.messages.read(scope);

    expect(read.messages).toHaveLength(1);
    expect(read.messages[0]?.parts[0]).toEqual({
      kind: "text",
      text: "Готово.",
      status: "complete",
    });
  });

  it("keeps the model history for the next turn", async () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "привіт" },
      { role: "assistant", content: "Готово." },
    ];
    const scope = { conversationId, bind: annaBind };

    await runtime().forCaller(anna).history.save(scope, messages);

    expect(await runtime().forCaller(anna).history.load(scope)).toEqual(
      messages,
    );
  });

  /**
   * Found on a phone, not in a test: the SDK's tool-call parts carry optional
   * fields as an explicit `undefined`, and the audit hook hashes an action's
   * input before it runs and refuses `undefined` outright. So an unnormalised
   * history failed the write rather than being quietly cleaned by Postgres —
   * and it failed *after* the transcript write had already succeeded, leaving a
   * turn stored with no memory of itself.
   */
  it("stores a history whose parts carry undefined fields", async () => {
    const scope = { conversationId, bind: annaBind };
    const messages: ModelMessage[] = [
      { role: "user", content: "створи замовлення" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "toolu_1",
            toolName: "orders_create",
            input: { customerQuery: "Катя" },
          },
        ],
      },
    ];
    // The SDK hands the part back with this key present and undefined.
    // `exactOptionalPropertyTypes` forbids writing that directly, which is
    // exactly why the compiler could not see the bug: the type says the key is
    // absent or a boolean, and the runtime value is neither.
    const [, assistant] = messages;
    const sent = (assistant as { content: Record<string, unknown>[] })
      .content[0];
    Object.assign(sent ?? {}, { providerExecuted: undefined });

    await runtime().forCaller(anna).history.save(scope, messages);

    const loaded = await runtime().forCaller(anna).history.load(scope);
    const part = (loaded[1] as { content: { providerExecuted?: unknown }[] })
      .content[0];
    // The key is gone rather than null: that is what `jsonb` would have done
    // anyway, and the SDK reads an absent optional the same way.
    expect(part).not.toHaveProperty("providerExecuted");
    expect(part).toMatchObject({ toolCallId: "toolu_1" });
  });

  /**
   * Stored whole, sent windowed. The row holds what the last turn ran with;
   * how much of it the next turn is told about is a budget decision, and it is
   * taken on the way out so there is one place that makes it.
   */
  it("stores every turn and hands back only the recent ones", async () => {
    const scope = { conversationId, bind: annaBind };
    const many: ModelMessage[] = Array.from({ length: 10 }, (_, index) => [
      { role: "user" as const, content: `запит ${String(index + 1)}` },
      { role: "assistant" as const, content: `відповідь ${String(index + 1)}` },
    ]).flat();

    await runtime().forCaller(anna).history.save(scope, many);
    const loaded = await runtime().forCaller(anna).history.load(scope);

    const asked = loaded
      .filter((message) => message.role === "user")
      .map((message) =>
        typeof message.content === "string" ? message.content : "",
      );
    expect(asked).toEqual([
      "запит 5",
      "запит 6",
      "запит 7",
      "запит 8",
      "запит 9",
      "запит 10",
    ]);
  });

  /**
   * SHO-555. One conversation is where a year of daily use accumulates, so a
   * read carries one window and a cursor, and the rest is a page away.
   */
  it("pages a long conversation back without a gap or a repeat", async () => {
    const scope = { conversationId: longConversationId, bind: annaBind };
    const total = ASSISTANT_CHAT_WINDOW_MESSAGES + 5;
    for (let n = 1; n <= total; n += 1) {
      await runtime()
        .forCaller(anna)
        .kit.messages.write(scope, say(`запит ${String(n)}`));
    }

    const latest = await runtime().forCaller(anna).kit.messages.read(scope);
    expect(latest.messages).toHaveLength(ASSISTANT_CHAT_WINDOW_MESSAGES);
    expect(latest.olderCursor).not.toBeNull();

    const older = await runtime()
      .forCaller(anna)
      .kit.messages.read(scope, { before: latest.olderCursor ?? "" });
    expect(older.olderCursor).toBeNull();

    const texts = [...older.messages, ...latest.messages].map((message) =>
      message.parts[0]?.kind === "text" ? message.parts[0].text : "",
    );
    expect(texts).toEqual(
      Array.from({ length: total }, (_, index) => `запит ${String(index + 1)}`),
    );
  });

  it("refuses to reopen a message that is no longer the latest", async () => {
    const scope = { conversationId, bind: annaBind };
    const first = randomUUID();
    await runtime()
      .forCaller(anna)
      .kit.messages.write(scope, say("one", first));
    await runtime().forCaller(anna).kit.messages.write(scope, say("two"));
    const before = await runtime().forCaller(anna).kit.messages.read(scope);

    await expect(
      runtime()
        .forCaller(anna)
        .kit.messages.write(scope, say("rewritten", first)),
    ).rejects.toThrow();

    expect(await runtime().forCaller(anna).kit.messages.read(scope)).toEqual(
      before,
    );
  });

  it("refuses another tenant's conversation, and says nothing about it", async () => {
    const scoped = runtime().forCaller(anna);

    await expect(
      scoped.kit.messages.read({
        conversationId: otherConversationId,
        bind: `${boris.userId}:${boris.companySelector}`,
      }),
    ).rejects.toBeInstanceOf(AssistantKitConversationGoneError);
  });

  it("answers the same way for a conversation that never existed", async () => {
    const scoped = runtime().forCaller(anna);
    const unknown = randomUUID();

    // Identical to the refusal above: the store cannot tell the two apart and
    // must not, or a conversation id becomes a way to probe for one.
    await expect(
      scoped.kit.messages.read({ conversationId: unknown, bind: "anna" }),
    ).rejects.toBeInstanceOf(AssistantKitConversationGoneError);
  });
});
