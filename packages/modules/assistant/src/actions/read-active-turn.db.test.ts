import { randomUUID } from "node:crypto";

import { ValidationError } from "@showzy/core/errors";
import {
  createTestKit,
  crossTenantSuite,
  isolationCase,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import { assistantConversations } from "@showzy/db/schema/assistant";
import { describe, expect, it, beforeAll, afterAll } from "vitest";

import { acceptTurn } from "./accept-turn.js";
import { finishTurn } from "./finish-turn.js";
import { readActiveTurn } from "./read-active-turn.js";
import { readLatestInterruptedTurn } from "./read-latest-interrupted-turn.js";

const ANNA_BIND = "anna:company-a";
const HOLD = {
  companyReservedMicroUsd: 0,
  globalReservedMicroUsd: 0,
  kyivDate: "2026-09-12",
};

const borisInB = {
  userId: kitIdentities.users.boris,
  companyId: kitIdentities.companies.b,
};

let kit: TestKit;

function textMessage(
  messageId: string,
  role: "user" | "assistant",
  text: string,
) {
  return {
    messageId,
    role,
    createdAt: "2026-09-12T10:00:00.000Z",
    parts: [{ kind: "text", text, status: "complete" }],
  };
}

function chatAccept(conversationId: string, commandId: string = randomUUID()) {
  const userMessageId = randomUUID();
  const placeholderId = randomUUID();
  return {
    conversationId,
    kind: "chat" as const,
    commandId,
    sessionId: "session-anna",
    userMessage: {
      messageId: userMessageId,
      bind: ANNA_BIND,
      message: textMessage(userMessageId, "user", "привіт"),
    },
    placeholder: {
      messageId: placeholderId,
      bind: ANNA_BIND,
      message: textMessage(placeholderId, "assistant", ""),
    },
    budgetHold: HOLD,
  };
}

async function newConversation(
  owner: { companyId: string; userId: string } = {
    companyId: kitIdentities.companies.a,
    userId: kitIdentities.users.anna,
  },
  id: string = randomUUID(),
): Promise<string> {
  await kit.db.runtime.db.insert(assistantConversations).values({
    id,
    companyId: owner.companyId,
    userId: owner.userId,
  });
  return id;
}

beforeAll(async () => {
  kit = await createTestKit();
}, 120_000);

afterAll(async () => {
  await kit.db.close();
});

describe("assistant.readActiveTurn", () => {
  it("reads null for a conversation with no turn", async () => {
    const conversationId = await newConversation();

    const result = await kit.invoke(readActiveTurn, { conversationId }, {});

    expect(result).toEqual({ turn: null });
  });

  it("reads the queued turn holding the conversation", async () => {
    const conversationId = await newConversation();
    const commandId = randomUUID();
    await kit.invoke(acceptTurn, chatAccept(conversationId, commandId), {});

    const result = await kit.invoke(readActiveTurn, { conversationId }, {});

    expect(result).toEqual({ turn: { id: commandId, status: "queued" } });
  });

  it("reads null once the turn has ended", async () => {
    const conversationId = await newConversation();
    const commandId = randomUUID();
    await kit.invoke(acceptTurn, chatAccept(conversationId, commandId), {});
    await kit.invoke(
      finishTurn,
      { conversationId, kind: "chat", commandId, status: "done" },
      {},
    );

    const result = await kit.invoke(readActiveTurn, { conversationId }, {});

    expect(result).toEqual({ turn: null });
  });

  it("refuses an invalid conversation id", async () => {
    await expect(
      kit.invoke(readActiveTurn, { conversationId: "not-a-uuid" }, {}),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("assistant.readLatestInterruptedTurn", () => {
  it("reads null when nothing is interrupted", async () => {
    const conversationId = await newConversation();

    const result = await kit.invoke(
      readLatestInterruptedTurn,
      { conversationId },
      {},
    );

    expect(result).toEqual({ commandId: null });
  });

  it("reads the interrupted turn's own command", async () => {
    const conversationId = await newConversation();
    const commandId = randomUUID();
    await kit.invoke(acceptTurn, chatAccept(conversationId, commandId), {});
    await kit.invoke(
      finishTurn,
      { conversationId, kind: "chat", commandId, status: "interrupted" },
      {},
    );

    const result = await kit.invoke(
      readLatestInterruptedTurn,
      { conversationId },
      {},
    );

    expect(result).toEqual({ commandId });
  });

  it("reads the most recent interrupted turn when more than one exists", async () => {
    const conversationId = await newConversation();
    const first = randomUUID();
    const second = randomUUID();
    await kit.invoke(acceptTurn, chatAccept(conversationId, first), {});
    await kit.invoke(
      finishTurn,
      { conversationId, kind: "chat", commandId: first, status: "interrupted" },
      {},
    );
    await kit.invoke(acceptTurn, chatAccept(conversationId, second), {});
    await kit.invoke(
      finishTurn,
      {
        conversationId,
        kind: "chat",
        commandId: second,
        status: "interrupted",
      },
      {},
    );

    const result = await kit.invoke(
      readLatestInterruptedTurn,
      { conversationId },
      {},
    );

    expect(result).toEqual({ commandId: second });
  });
});

const isolationConversations = {
  own: randomUUID(),
  foreign: randomUUID(),
};

beforeAll(async () => {
  await newConversation(undefined, isolationConversations.own);
  await newConversation(borisInB, isolationConversations.foreign);
}, 120_000);

crossTenantSuite(
  () => kit,
  [
    isolationCase(
      readActiveTurn,
      { input: { conversationId: isolationConversations.own } },
      { input: { conversationId: isolationConversations.foreign } },
    ),
    isolationCase(
      readLatestInterruptedTurn,
      { input: { conversationId: isolationConversations.own } },
      { input: { conversationId: isolationConversations.foreign } },
    ),
  ],
);
