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

import type { ChatDocument, ModelMessage } from "@showzy/assistant-kit";
import { createActionRegistry } from "../composition.js";
import {
  createTestKit,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import { assistantConversations } from "@showzy/db/schema/assistant";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAssistantKitRuntime } from "../http/assistant-kit-runtime.js";
import type { AssistantKitRuntime } from "../http/assistant-kit-http.js";
import { AssistantKitConversationGoneError } from "./assistant-kit-postgres-stores.js";

let kit: TestKit;
const conversationId = randomUUID();
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
 * process memory. If a document survives, it survived in the database.
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

function documentFor(text: string): ChatDocument {
  return {
    conversationId,
    bind: `${anna.userId}:${anna.companySelector}`,
    messages: [
      {
        messageId: randomUUID(),
        role: "assistant",
        createdAt: "2026-09-10T10:00:00.000Z",
        parts: [{ kind: "text", text, status: "complete" }],
      },
    ],
    openPause: null,
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
    const written = documentFor("Готово.");
    await runtime()
      .forCaller(anna)
      .kit.document.write(
        { conversationId, bind: written.bind },
        {
          kind: "append",
          messageId: written.messages[0]?.messageId ?? "",
          role: "assistant",
          parts: [...(written.messages[0]?.parts ?? [])],
        },
      );

    const read = await runtime()
      .forCaller(anna)
      .kit.document.read({ conversationId, bind: written.bind });

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
    const scope = {
      conversationId,
      bind: `${anna.userId}:${anna.companySelector}`,
    };

    await runtime().forCaller(anna).history.save(scope, messages);

    expect(await runtime().forCaller(anna).history.load(scope)).toEqual(
      messages,
    );
  });

  /**
   * The two halves share a row. A document write that blanked the history would
   * leave the next turn with no memory of the conversation it is in — and the
   * failure would look like the model forgetting, not like a store bug.
   */
  /**
   * Found on a phone, not in a test: the SDK's tool-call parts carry optional
   * fields as an explicit `undefined`, and the audit hook hashes an action's
   * input before it runs and refuses `undefined` outright. So an unnormalised
   * history failed the write rather than being quietly cleaned by Postgres —
   * and it failed *after* the document write had already succeeded, leaving a
   * turn stored with no memory of itself.
   */
  it("stores a history whose parts carry undefined fields", async () => {
    const scope = {
      conversationId,
      bind: `${anna.userId}:${anna.companySelector}`,
    };
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
    const scope = {
      conversationId,
      bind: `${anna.userId}:${anna.companySelector}`,
    };
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

  it("does not let one half overwrite the other", async () => {
    const scope = {
      conversationId,
      bind: `${anna.userId}:${anna.companySelector}`,
    };
    await runtime()
      .forCaller(anna)
      .history.save(scope, [{ role: "user", content: "kept" }]);

    await runtime()
      .forCaller(anna)
      .kit.document.write(scope, {
        kind: "append",
        messageId: randomUUID(),
        role: "user",
        parts: [{ kind: "text", text: "another", status: "complete" }],
      });

    expect(await runtime().forCaller(anna).history.load(scope)).toEqual([
      { role: "user", content: "kept" },
    ]);
  });

  it("refuses another tenant's conversation, and says nothing about it", async () => {
    const scoped = runtime().forCaller(anna);

    await expect(
      scoped.kit.document.read({
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
      scoped.kit.document.read({ conversationId: unknown, bind: "anna" }),
    ).rejects.toBeInstanceOf(AssistantKitConversationGoneError);
  });
});
