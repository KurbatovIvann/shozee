import { randomUUID } from "node:crypto";

import { acceptTurn, finishTurn, startTurn } from "@showzy/assistant";
import { ConflictError } from "@showzy/core/errors";
import {
  createTestKit,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import { assistantConversations } from "@showzy/db/schema/assistant";
import { ASSISTANT_TURN_CLAIM_LOST_MESSAGE } from "@showzy/validation/assistant-turn-claim";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPostgresAssistantKitMessageLog } from "./assistant-kit-postgres-stores.js";

const COMPANY = kitIdentities.companies.a;
const BIND = "anna:company-a";

let kit: TestKit;

beforeAll(async () => {
  kit = await createTestKit();
}, 180_000);

afterAll(async () => {
  await kit.db.close();
});

function textMessage(messageId: string, role: "user" | "assistant") {
  return {
    messageId,
    role,
    createdAt: "2026-09-15T10:00:00.000Z",
    parts: [{ kind: "text", text: "", status: "complete" }],
  };
}

async function runningTurn() {
  const conversationId = randomUUID();
  await kit.db.runtime.db.insert(assistantConversations).values({
    id: conversationId,
    companyId: COMPANY,
    userId: kitIdentities.users.anna,
  });
  const userMessageId = randomUUID();
  const placeholderId = randomUUID();
  const commandId = randomUUID();
  await kit.invoke(
    acceptTurn,
    {
      conversationId,
      kind: "chat",
      commandId,
      sessionId: "session-anna",
      userMessage: {
        messageId: userMessageId,
        bind: BIND,
        message: textMessage(userMessageId, "user"),
      },
      placeholder: {
        messageId: placeholderId,
        bind: BIND,
        message: textMessage(placeholderId, "assistant"),
      },
      budgetHold: {
        companyReservedMicroUsd: 100_000,
        globalReservedMicroUsd: 100_000,
        kyivDate: "2026-09-15",
      },
      history: {
        kind: "append",
        message: { role: "user", content: "привіт" },
      },
    },
    {},
  );
  const turn = { conversationId, kind: "chat" as const, commandId };
  await kit.invoke(startTurn, { ...turn, timeoutMs: 180_000 }, {});
  const messages = createPostgresAssistantKitMessageLog(
    { pipeline: kit.pipeline },
    {
      userId: kitIdentities.users.anna,
      companySelector: COMPANY,
      requestId: randomUUID(),
    },
    { kind: turn.kind, commandId },
  );
  const placeholder = (await messages.page(conversationId, { limit: 1 }))
    .records[0];
  if (placeholder === undefined) {
    throw new Error("expected the placeholder");
  }
  return { turn, messages, placeholder };
}

async function endTurn(turn: Awaited<ReturnType<typeof runningTurn>>["turn"]) {
  await kit.invoke(finishTurn, { ...turn, status: "done" }, {});
}

describe("a claimed message update", () => {
  it("answers false for a revision another writer moved on, while the claim holds", async () => {
    const { turn, messages, placeholder } = await runningTurn();
    const write = () =>
      messages.update(turn.conversationId, {
        seq: placeholder.seq,
        messageId: placeholder.messageId,
        revision: placeholder.revision,
        message: textMessage(placeholder.messageId, "assistant"),
      });

    expect(await write()).toBe(true);
    expect(await write()).toBe(false);
  });

  it("fails at once with the lost-claim conflict once the turn has ended", async () => {
    const { turn, messages, placeholder } = await runningTurn();
    await endTurn(turn);

    const refused = await messages
      .update(turn.conversationId, {
        seq: placeholder.seq,
        messageId: placeholder.messageId,
        revision: placeholder.revision,
        message: textMessage(placeholder.messageId, "assistant"),
      })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(refused).toBeInstanceOf(ConflictError);
    expect(refused).toMatchObject({
      clientMessage: ASSISTANT_TURN_CLAIM_LOST_MESSAGE,
    });
  });
});
