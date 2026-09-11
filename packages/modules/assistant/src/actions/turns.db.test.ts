/**
 * Accepting, starting and finishing a turn against a real database
 * (SHO-560, ADR-0039).
 *
 * The turn row is the conversation's lease and the command's receipt, written
 * in one transaction with the messages. Everything a test here claims about
 * time is a comparison Postgres makes against its own clock: the test
 * container's clock is not the host's.
 */
import { randomUUID } from "node:crypto";

import { executeAction } from "@showzy/core";
import {
  ConflictError,
  CoreInvariantError,
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
} from "@showzy/core/errors";
import {
  createTestKit,
  crossTenantSuite,
  isolationCase,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import { auditLog } from "@showzy/db";
import { user } from "@showzy/db/schema/auth";
import {
  assistantChatMessages,
  assistantConversations,
  assistantTurns,
} from "@showzy/db/schema/assistant";
import { companyMembers } from "@showzy/db/schema/companies";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { acceptTurn } from "./accept-turn.js";
import { finishTurn } from "./finish-turn.js";
import { insertChatMessage } from "./insert-chat-message.js";
import { listStaleTurns } from "./list-stale-turns.js";
import { readChatMessages } from "./read-chat-messages.js";
import { startTurn } from "./start-turn.js";
import { updateChatMessage } from "./update-chat-message.js";

const ANNA_BIND = "anna:company-a";
const BORIS_BIND = "boris:company-b";
const HOLD = {
  companyReservedMicroUsd: 100_000,
  globalReservedMicroUsd: 100_000,
  kyivDate: "2026-09-11",
};
const TIMEOUT_MS = 180_000;

const borisInB = {
  userId: kitIdentities.users.boris,
  companyId: kitIdentities.companies.b,
};

const clerks = {
  denied: randomUUID(),
  employee: randomUUID(),
};

/** Conversations and turns the isolation suite runs against. */
const isolation = {
  accept: randomUUID(),
  start: randomUUID(),
  startCommand: randomUUID(),
  finish: randomUUID(),
  finishCommand: randomUUID(),
  foreign: randomUUID(),
};

let kit: TestKit;

function textMessage(
  messageId: string,
  role: "user" | "assistant",
  text: string,
  status: "complete" | "streaming",
) {
  return {
    messageId,
    role,
    createdAt: "2026-09-11T10:00:00.000Z",
    parts: [{ kind: "text", text, status }],
  };
}

function chatAccept(
  conversationId: string,
  commandId: string = randomUUID(),
  bind: string = ANNA_BIND,
) {
  const userMessageId = randomUUID();
  const placeholderId = randomUUID();
  return {
    conversationId,
    kind: "chat" as const,
    commandId,
    sessionId: "session-anna",
    userMessage: {
      messageId: userMessageId,
      bind,
      message: textMessage(userMessageId, "user", "привіт", "complete"),
    },
    placeholder: {
      messageId: placeholderId,
      bind,
      message: textMessage(placeholderId, "assistant", "", "streaming"),
    },
    budgetHold: HOLD,
  };
}

function ref(conversationId: string, commandId: string) {
  return { conversationId, kind: "chat" as const, commandId };
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

async function turnRows(conversationId: string) {
  return kit.db.runtime.db
    .select()
    .from(assistantTurns)
    .where(eq(assistantTurns.conversationId, conversationId));
}

async function messageIds(conversationId: string): Promise<string[]> {
  const page = await kit.invoke(
    readChatMessages,
    { conversationId, limit: 100 },
    {},
  );
  return page.records.map((record) => record.messageId);
}

beforeAll(async () => {
  kit = await createTestKit();

  await kit.db.runtime.db.insert(user).values([
    {
      id: clerks.denied,
      name: "Denied Clerk",
      email: "denied@assistant-turns.test",
    },
    {
      id: clerks.employee,
      name: "Employee Clerk",
      email: "employee@assistant-turns.test",
    },
  ]);
  await kit.db.runtime.db.insert(companyMembers).values([
    {
      companyId: kitIdentities.companies.a,
      userId: clerks.denied,
      role: "employee",
      permissions: { granted: [], denied: ["assistant:use"] },
    },
    {
      companyId: kitIdentities.companies.a,
      userId: clerks.employee,
      role: "employee",
      permissions: { granted: ["assistant:use"], denied: [] },
    },
  ]);

  await newConversation(undefined, isolation.accept);
  await newConversation(undefined, isolation.start);
  await newConversation(undefined, isolation.finish);
  await newConversation(borisInB, isolation.foreign);
  await kit.invoke(
    acceptTurn,
    chatAccept(isolation.start, isolation.startCommand),
    {},
  );
  await kit.invoke(
    acceptTurn,
    chatAccept(isolation.finish, isolation.finishCommand),
    {},
  );
}, 180_000);

afterAll(async () => {
  await kit.db.close();
});

crossTenantSuite(
  () => kit,
  [
    isolationCase(
      acceptTurn,
      { input: chatAccept(isolation.accept) },
      { input: chatAccept(isolation.foreign) },
    ),
    isolationCase(
      startTurn,
      {
        input: {
          ...ref(isolation.start, isolation.startCommand),
          timeoutMs: TIMEOUT_MS,
        },
      },
      {
        input: {
          ...ref(isolation.foreign, isolation.startCommand),
          timeoutMs: TIMEOUT_MS,
        },
      },
    ),
    isolationCase(
      finishTurn,
      {
        input: {
          ...ref(isolation.finish, isolation.finishCommand),
          status: "done",
        },
      },
      {
        input: {
          ...ref(isolation.foreign, isolation.finishCommand),
          status: "done",
        },
      },
    ),
    isolationCase(
      listStaleTurns,
      { input: { queuedStaleAfterMs: 60_000, limit: 10 } },
      { input: { queuedStaleAfterMs: 60_000, limit: 10 } },
    ),
  ],
);

describe("accepting a turn", () => {
  it("stores the person's message, the placeholder and the turn together", async () => {
    const conversationId = await newConversation();
    const requestId = randomUUID();
    const input = chatAccept(conversationId);

    const result = await kit.invoke(
      acceptTurn,
      input,
      {},
      { request: { requestId } },
    );

    expect(result).toEqual({
      outcome: "accepted",
      conversationId,
      turn: {
        conversationId,
        kind: "chat",
        commandId: input.commandId,
        status: "queued",
        placeholderMessageId: input.placeholder.messageId,
        userMessageId: input.userMessage.messageId,
        continuesCommandId: null,
      },
    });

    const page = await kit.invoke(
      readChatMessages,
      { conversationId, limit: 10 },
      {},
    );
    expect(page.records).toEqual([
      {
        seq: 1,
        messageId: input.userMessage.messageId,
        bind: ANNA_BIND,
        message: input.userMessage.message,
        revision: 1,
      },
      {
        seq: 2,
        messageId: input.placeholder.messageId,
        bind: ANNA_BIND,
        message: input.placeholder.message,
        revision: 1,
      },
    ]);

    // What the worker and the reconciler read instead of a request.
    const rows = await turnRows(conversationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      companyId: kitIdentities.companies.a,
      kind: "chat",
      commandId: input.commandId,
      status: "queued",
      userId: kitIdentities.users.anna,
      sessionId: "session-anna",
      requestId,
      companyReservedMicroUsd: 100_000,
      globalReservedMicroUsd: 100_000,
      budgetKyivDate: "2026-09-11",
      continuesCommandId: null,
      startedAt: null,
      deadlineAt: null,
      finishedAt: null,
    });

    const audit = await kit.db.runtime.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.requestId, requestId));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: "assistant.acceptTurn",
      companyId: kitIdentities.companies.a,
      actorId: kitIdentities.users.anna,
      targetType: "conversation",
      targetId: conversationId,
      outcome: "ok",
    });
  });

  it("refuses a second accept while a turn is active, and writes nothing", async () => {
    const conversationId = await newConversation();
    await kit.invoke(acceptTurn, chatAccept(conversationId), {});

    const second = await kit.invoke(acceptTurn, chatAccept(conversationId), {});

    expect(second).toEqual({ outcome: "busy", conversationId });
    expect(await messageIds(conversationId)).toHaveLength(2);
    expect(await turnRows(conversationId)).toHaveLength(1);
  });

  it("gives one message pair and one active turn for a repeated command, in any casing", async () => {
    const conversationId = await newConversation();
    const commandId = randomUUID();
    const shouted = chatAccept(
      conversationId.toUpperCase(),
      commandId.toUpperCase(),
    );

    const first = await kit.invoke(acceptTurn, shouted, {});
    const again = await kit.invoke(acceptTurn, shouted, {});
    const lower = await kit.invoke(
      acceptTurn,
      chatAccept(conversationId, commandId),
      {},
    );

    expect(first.outcome).toBe("accepted");
    expect(again.outcome).toBe("replayed");
    expect(lower.outcome).toBe("replayed");
    if (first.outcome === "busy" || lower.outcome === "busy") {
      return;
    }
    // Stored and returned in one casing, which is the casing a job id is
    // derived from.
    expect(first.conversationId).toBe(conversationId);
    expect(first.turn.commandId).toBe(commandId);
    expect(lower.turn).toEqual(first.turn);
    expect(await messageIds(conversationId)).toEqual([
      shouted.userMessage.messageId.toLowerCase(),
      shouted.placeholder.messageId.toLowerCase(),
    ]);
    expect(await turnRows(conversationId)).toHaveLength(1);
  });

  it("replays a command whose turn has already ended, rather than running it again", async () => {
    const conversationId = await newConversation();
    const input = chatAccept(conversationId);
    await kit.invoke(acceptTurn, input, {});
    await kit.invoke(
      finishTurn,
      { ...ref(conversationId, input.commandId), status: "done" },
      {},
    );

    const retried = await kit.invoke(acceptTurn, input, {});

    expect(retried).toMatchObject({
      outcome: "replayed",
      turn: { status: "done" },
    });
    expect(await messageIds(conversationId)).toHaveLength(2);
  });

  it("stores an answer as one placeholder carrying the earned card, and no person's message", async () => {
    const conversationId = await newConversation();
    const placeholderId = randomUUID();
    const card = {
      kind: "card",
      cardId: "order:1",
      revision: 1,
      type: "order",
      payload: { orderId: randomUUID() },
    };
    const placeholder = {
      messageId: placeholderId,
      role: "assistant",
      createdAt: "2026-09-11T10:00:00.000Z",
      parts: [card, { kind: "text", text: "", status: "streaming" }],
    };

    const result = await kit.invoke(
      acceptTurn,
      {
        conversationId,
        kind: "answer",
        commandId: randomUUID(),
        sessionId: "session-anna",
        placeholder: {
          messageId: placeholderId,
          bind: ANNA_BIND,
          message: placeholder,
        },
        budgetHold: HOLD,
      },
      {},
    );

    expect(result).toMatchObject({
      outcome: "accepted",
      turn: {
        kind: "answer",
        userMessageId: null,
        placeholderMessageId: placeholderId,
      },
    });
    const page = await kit.invoke(
      readChatMessages,
      { conversationId, limit: 10 },
      {},
    );
    expect(page.records.map((record) => record.message)).toEqual([placeholder]);
  });

  /**
   * One transaction, not three writes: a placeholder the log refuses takes the
   * person's message and the claim down with it.
   */
  it("commits nothing when the placeholder cannot be stored", async () => {
    const conversationId = await newConversation();
    const taken = randomUUID();
    await kit.invoke(
      insertChatMessage,
      {
        conversationId,
        messageId: taken,
        bind: ANNA_BIND,
        message: textMessage(taken, "assistant", "earlier", "complete"),
      },
      {},
    );
    const input = chatAccept(conversationId);

    await expect(
      kit.invoke(
        acceptTurn,
        {
          ...input,
          placeholder: { ...input.placeholder, messageId: taken },
        },
        {},
      ),
    ).rejects.toBeInstanceOf(ConflictError);

    expect(await messageIds(conversationId)).toEqual([taken]);
    expect(await turnRows(conversationId)).toHaveLength(0);
  });

  it("continues under the command of the first interrupted turn of the chain", async () => {
    const conversationId = await newConversation();
    const first = chatAccept(conversationId);
    await kit.invoke(acceptTurn, first, {});
    await kit.invoke(
      finishTurn,
      { ...ref(conversationId, first.commandId), status: "interrupted" },
      {},
    );

    const second = chatAccept(conversationId);
    const continued = await kit.invoke(
      acceptTurn,
      { ...second, continuesCommandId: first.commandId.toUpperCase() },
      {},
    );
    expect(continued).toMatchObject({
      outcome: "accepted",
      turn: { continuesCommandId: first.commandId },
    });
    await kit.invoke(
      finishTurn,
      { ...ref(conversationId, second.commandId), status: "interrupted" },
      {},
    );

    const third = chatAccept(conversationId);
    const again = await kit.invoke(
      acceptTurn,
      { ...third, continuesCommandId: second.commandId },
      {},
    );
    // Its tools replay the first turn's writes, not a second attempt at them.
    expect(again).toMatchObject({
      outcome: "accepted",
      turn: { continuesCommandId: first.commandId },
    });
    await kit.invoke(
      finishTurn,
      { ...ref(conversationId, third.commandId), status: "done" },
      {},
    );

    await expect(
      kit.invoke(
        acceptTurn,
        { ...chatAccept(conversationId), continuesCommandId: third.commandId },
        {},
      ),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("is not-found for a conversation that does not exist, a colleague's, or another company's", async () => {
    const conversationId = await newConversation();
    const commandId = randomUUID();
    await kit.invoke(acceptTurn, chatAccept(conversationId, commandId), {});
    const colleague = {
      userId: clerks.employee,
      companyId: kitIdentities.companies.a,
    };

    for (const [target, actor] of [
      [randomUUID(), {}],
      [conversationId, colleague],
      [conversationId, borisInB],
    ] as const) {
      await expect(
        kit.invoke(acceptTurn, chatAccept(target), actor),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        kit.invoke(
          startTurn,
          { ...ref(target, commandId), timeoutMs: TIMEOUT_MS },
          actor,
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        kit.invoke(
          finishTurn,
          { ...ref(target, commandId), status: "failed" },
          actor,
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    }
    // And a command the conversation never accepted.
    await expect(
      kit.invoke(
        startTurn,
        { ...ref(conversationId, randomUUID()), timeoutMs: TIMEOUT_MS },
        {},
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect((await turnRows(conversationId))[0]?.status).toBe("queued");
  });

  it("refuses a person without assistant:use to accept, start or finish", async () => {
    const conversationId = await newConversation();
    const commandId = randomUUID();
    await kit.invoke(acceptTurn, chatAccept(conversationId, commandId), {});
    const denied = {
      userId: clerks.denied,
      companyId: kitIdentities.companies.a,
    };

    await expect(
      kit.invoke(acceptTurn, chatAccept(conversationId), denied),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      kit.invoke(
        startTurn,
        { ...ref(conversationId, commandId), timeoutMs: TIMEOUT_MS },
        denied,
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      kit.invoke(
        finishTurn,
        { ...ref(conversationId, commandId), status: "failed" },
        denied,
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    expect((await turnRows(conversationId))[0]?.status).toBe("queued");
  });

  it("refuses a chat accept without the person's message", async () => {
    const conversationId = await newConversation();
    const { userMessage, ...withoutMessage } = chatAccept(conversationId);
    expect(userMessage).toBeDefined();

    await expect(
      kit.invoke(acceptTurn, withoutMessage, {}),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await turnRows(conversationId)).toHaveLength(0);
  });
});

/**
 * The claim is safe under concurrency because a unique violation waits for the
 * winner to commit and is then answered by re-reading. Several rounds, so the
 * two calls genuinely overlap rather than one finishing first.
 */
describe("two accepts at once", () => {
  const ROUNDS = 5;

  it("of the same command: one is accepted and the other replays it", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const conversationId = await newConversation();
      const input = chatAccept(conversationId);

      const outcomes = await Promise.all([
        kit.invoke(acceptTurn, input, {}),
        kit.invoke(acceptTurn, input, {}),
      ]);

      expect(outcomes.map((outcome) => outcome.outcome).sort()).toEqual([
        "accepted",
        "replayed",
      ]);
      expect(await messageIds(conversationId)).toHaveLength(2);
      expect(await turnRows(conversationId)).toHaveLength(1);
    }
  });

  it("of two commands: one is accepted and the other is busy", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const conversationId = await newConversation();

      const outcomes = await Promise.all([
        kit.invoke(acceptTurn, chatAccept(conversationId), {}),
        kit.invoke(acceptTurn, chatAccept(conversationId), {}),
      ]);

      expect(outcomes.map((outcome) => outcome.outcome).sort()).toEqual([
        "accepted",
        "busy",
      ]);
      expect(await messageIds(conversationId)).toHaveLength(2);
      const rows = await turnRows(conversationId);
      expect(rows.filter((row) => row.status === "queued")).toHaveLength(1);
      expect(rows).toHaveLength(1);
    }
  });
});

describe("starting and finishing a turn", () => {
  it("keeps the session only while the turn is active", async () => {
    for (const status of ["done", "failed", "interrupted"] as const) {
      const conversationId = await newConversation();
      const input = chatAccept(conversationId);
      await kit.invoke(acceptTurn, input, {});
      expect((await turnRows(conversationId))[0]?.sessionId).toBe(
        "session-anna",
      );

      await kit.invoke(
        finishTurn,
        { ...ref(conversationId, input.commandId), status },
        {},
      );

      expect((await turnRows(conversationId))[0]).toMatchObject({
        status,
        sessionId: null,
        userId: kitIdentities.users.anna,
      });
    }
  });

  it("frees the conversation on finish, and says what it found when there is nothing to do", async () => {
    const conversationId = await newConversation();
    const input = chatAccept(conversationId);
    const turn = ref(conversationId, input.commandId);
    await kit.invoke(acceptTurn, input, {});

    const started = await kit.invoke(
      startTurn,
      { ...turn, timeoutMs: TIMEOUT_MS },
      {},
    );
    expect(started).toMatchObject({ outcome: "started", conversationId });
    expect(
      await kit.invoke(startTurn, { ...turn, timeoutMs: TIMEOUT_MS }, {}),
    ).toEqual({ outcome: "not_queued", conversationId, status: "running" });

    // Both times are the database's own, set in one statement.
    const running = (await turnRows(conversationId))[0];
    expect(
      (running?.deadlineAt?.getTime() ?? 0) -
        (running?.startedAt?.getTime() ?? 0),
    ).toBe(TIMEOUT_MS);
    if (started.outcome === "started") {
      expect(new Date(started.deadlineAt).getTime()).toBe(
        running?.deadlineAt?.getTime(),
      );
    }

    // Still busy while it runs.
    expect(
      (await kit.invoke(acceptTurn, chatAccept(conversationId), {})).outcome,
    ).toBe("busy");

    expect(
      await kit.invoke(finishTurn, { ...turn, status: "done" }, {}),
    ).toEqual({ outcome: "finished", conversationId, status: "done" });
    // A late interruption cannot overwrite how the turn ended.
    expect(
      await kit.invoke(finishTurn, { ...turn, status: "interrupted" }, {}),
    ).toEqual({ outcome: "already_finished", conversationId, status: "done" });
    expect(
      await kit.invoke(startTurn, { ...turn, timeoutMs: TIMEOUT_MS }, {}),
    ).toEqual({ outcome: "not_queued", conversationId, status: "done" });
    expect((await turnRows(conversationId))[0]?.finishedAt).not.toBeNull();

    const next = await kit.invoke(acceptTurn, chatAccept(conversationId), {});
    expect(next.outcome).toBe("accepted");
  });

  it("finishes a turn that never started", async () => {
    const conversationId = await newConversation();
    const input = chatAccept(conversationId);
    await kit.invoke(acceptTurn, input, {});

    expect(
      await kit.invoke(
        finishTurn,
        { ...ref(conversationId, input.commandId), status: "failed" },
        {},
      ),
    ).toEqual({ outcome: "finished", conversationId, status: "failed" });
  });
});

describe("the reconciler's read", () => {
  /**
   * The isolation suite runs a global system action only in the scope it has,
   * so the refusal of every other caller is proven here.
   */
  it("is refused to a staff caller and to a tenant-scoped system caller", async () => {
    const input = { queuedStaleAfterMs: 60_000, limit: 10 };
    const request = () => ({
      requestId: randomUUID(),
      correlationId: randomUUID(),
      channel: "system" as const,
    });

    await expect(
      executeAction(kit.pipeline, {
        action: listStaleTurns,
        input,
        request: { ...request(), channel: "ui" as const },
        principal: {
          mode: "staff",
          session: { userId: kitIdentities.users.anna },
          companySelector: kitIdentities.companies.a,
        },
      }),
    ).rejects.toBeInstanceOf(CoreInvariantError);
    await expect(
      executeAction(kit.pipeline, {
        action: listStaleTurns,
        input,
        request: request(),
        principal: {
          mode: "system",
          serviceName: "assistant-reconciler",
          scope: { scope: "tenant", companyId: kitIdentities.companies.a },
        },
      }),
    ).rejects.toBeInstanceOf(CoreInvariantError);
  });

  it("returns exactly the stale turns, across companies, oldest first", async () => {
    const ageTurn = async (conversationId: string, age: string) => {
      await kit.db.runtime.db
        .update(assistantTurns)
        .set({ createdAt: sql`now() - ${age}::interval` })
        .where(eq(assistantTurns.conversationId, conversationId));
    };

    // Company A: accepted ten minutes ago and never started — its job is lost.
    const queuedOld = await newConversation();
    const queuedOldInput = chatAccept(queuedOld);
    await kit.invoke(acceptTurn, queuedOldInput, {});
    await ageTurn(queuedOld, "10 minutes");

    // Company B: running past its deadline — its worker is gone.
    const runningPast = await newConversation(borisInB);
    const runningPastInput = chatAccept(runningPast, randomUUID(), BORIS_BIND);
    await kit.invoke(acceptTurn, runningPastInput, borisInB);
    await kit.invoke(
      startTurn,
      {
        ...ref(runningPast, runningPastInput.commandId),
        timeoutMs: TIMEOUT_MS,
      },
      borisInB,
    );
    await kit.db.runtime.db
      .update(assistantTurns)
      .set({
        createdAt: sql`now() - interval '5 minutes'`,
        deadlineAt: sql`now() - interval '1 second'`,
      })
      .where(eq(assistantTurns.conversationId, runningPast));

    // Not stale: accepted just now; running in time; old but finished.
    const queuedFresh = await newConversation();
    await kit.invoke(acceptTurn, chatAccept(queuedFresh), {});
    const runningInTime = await newConversation();
    const runningInTimeInput = chatAccept(runningInTime);
    await kit.invoke(acceptTurn, runningInTimeInput, {});
    await kit.invoke(
      startTurn,
      {
        ...ref(runningInTime, runningInTimeInput.commandId),
        timeoutMs: TIMEOUT_MS,
      },
      {},
    );
    await ageTurn(runningInTime, "20 minutes");
    const finishedOld = await newConversation();
    const finishedOldInput = chatAccept(finishedOld);
    await kit.invoke(acceptTurn, finishedOldInput, {});
    await kit.invoke(
      finishTurn,
      { ...ref(finishedOld, finishedOldInput.commandId), status: "done" },
      {},
    );
    await ageTurn(finishedOld, "30 minutes");

    const fixtures = new Set([
      queuedOld,
      runningPast,
      queuedFresh,
      runningInTime,
      finishedOld,
    ]);
    const stale = await kit.invoke(
      listStaleTurns,
      { queuedStaleAfterMs: 60_000, limit: 100 },
      {},
    );

    expect(
      stale.turns.filter((turn) => fixtures.has(turn.conversationId)),
    ).toEqual([
      {
        companyId: kitIdentities.companies.a,
        conversationId: queuedOld,
        kind: "chat",
        commandId: queuedOldInput.commandId,
        status: "queued",
        placeholderMessageId: queuedOldInput.placeholder.messageId,
        budgetHold: HOLD,
        staleness: "queued_without_start",
      },
      {
        companyId: kitIdentities.companies.b,
        conversationId: runningPast,
        kind: "chat",
        commandId: runningPastInput.commandId,
        status: "running",
        placeholderMessageId: runningPastInput.placeholder.messageId,
        budgetHold: HOLD,
        staleness: "running_past_deadline",
      },
    ]);
  });

  it("stops at the limit it was given", async () => {
    for (let n = 0; n < 3; n += 1) {
      const conversationId = await newConversation();
      await kit.invoke(acceptTurn, chatAccept(conversationId), {});
      await kit.db.runtime.db
        .update(assistantTurns)
        .set({ createdAt: sql`now() - interval '2 hours'` })
        .where(
          and(
            eq(assistantTurns.conversationId, conversationId),
            eq(assistantTurns.status, "queued"),
          ),
        );
    }

    const page = await kit.invoke(
      listStaleTurns,
      { queuedStaleAfterMs: 60_000, limit: 2 },
      {},
    );

    expect(page.turns).toHaveLength(2);
  });
});

describe("a message's revision", () => {
  it("starts at 1 and rises by one with each update, and a page read returns it", async () => {
    const conversationId = await newConversation();
    const input = chatAccept(conversationId);
    await kit.invoke(acceptTurn, input, {});

    for (const expected of [2, 3]) {
      const updated = await kit.invoke(
        updateChatMessage,
        {
          conversationId,
          seq: 2,
          messageId: input.placeholder.messageId,
          message: input.placeholder.message,
        },
        {},
      );
      expect(updated).toEqual({ conversationId, seq: 2, revision: expected });
    }

    const page = await kit.invoke(
      readChatMessages,
      { conversationId, limit: 10 },
      {},
    );
    expect(page.records.map((record) => record.revision)).toEqual([1, 3]);

    const stored = await kit.db.runtime.db
      .select({ revision: assistantChatMessages.revision })
      .from(assistantChatMessages)
      .where(eq(assistantChatMessages.messageId, input.placeholder.messageId));
    expect(stored).toEqual([{ revision: 3 }]);
  });
});
