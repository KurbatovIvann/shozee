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
import { auditLog, createDbClient } from "@showzy/db";
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
import { interruptTurn } from "./interrupt-turn.js";
import { listStaleTurns } from "./list-stale-turns.js";
import { readChatMessages } from "./read-chat-messages.js";
import { readTurnForJob } from "./read-turn-for-job.js";
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
  interrupt: randomUUID(),
  interruptCommand: randomUUID(),
  foreign: randomUUID(),
  /** A turn of company B, so a foreign interrupt has a real row to miss. */
  foreignCommand: randomUUID(),
};

const EMPTY_HOLD = {
  ...HOLD,
  companyReservedMicroUsd: 0,
  globalReservedMicroUsd: 0,
};

type TurnRef = {
  readonly conversationId: string;
  readonly kind: "chat" | "answer";
  readonly commandId: string;
};

function systemRequest() {
  const requestId = randomUUID();
  return { requestId, correlationId: requestId, channel: "system" as const };
}

/** The reconciler's interrupt, inside one company. */
function interruptAs(
  companyId: string,
  turn: TurnRef,
  requestId?: string,
  deps: Parameters<typeof executeAction>[0] = kit.pipeline,
) {
  return executeAction(deps, {
    action: interruptTurn,
    input: turn,
    request:
      requestId === undefined
        ? systemRequest()
        : { requestId, correlationId: requestId, channel: "system" as const },
    principal: {
      mode: "system",
      serviceName: "assistant-reconciler",
      scope: { scope: "tenant", companyId },
    },
  });
}

/** The worker's read of the turn its job names. */
function readForJob(turn: TurnRef) {
  return executeAction(kit.pipeline, {
    action: readTurnForJob,
    input: turn,
    request: systemRequest(),
    principal: {
      mode: "system",
      serviceName: "assistant-worker",
      scope: { scope: "global" },
    },
  });
}

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

/**
 * Moves a running turn's deadline behind or ahead of Postgres `now()`, in SQL,
 * so a test never compares a host time with the container's.
 */
async function setDeadline(
  conversationId: string,
  when: "passed" | "ahead",
): Promise<void> {
  const moved = await kit.db.runtime.db
    .update(assistantTurns)
    .set({
      deadlineAt:
        when === "passed"
          ? sql`now() - interval '1 second'`
          : sql`now() + interval '1 hour'`,
    })
    .where(
      and(
        eq(assistantTurns.conversationId, conversationId),
        eq(assistantTurns.status, "running"),
      ),
    )
    .returning({ id: assistantTurns.id });
  expect(moved).toHaveLength(1);
}

/**
 * Moves a queued turn's accept back, in SQL, so Postgres judges it past (or
 * inside) the abandon threshold against its own clock.
 */
async function ageQueuedTurn(
  conversationId: string,
  age: string,
): Promise<void> {
  const moved = await kit.db.runtime.db
    .update(assistantTurns)
    .set({ createdAt: sql`now() - ${age}::interval` })
    .where(
      and(
        eq(assistantTurns.conversationId, conversationId),
        eq(assistantTurns.status, "queued"),
      ),
    )
    .returning({ id: assistantTurns.id });
  expect(moved).toHaveLength(1);
}

/** Starts an accepted turn and puts its deadline behind it: a stale turn. */
async function startPastDeadline(
  turn: TurnRef,
  actor: { userId: string; companyId: string } | Record<string, never> = {},
): Promise<void> {
  await kit.invoke(startTurn, { ...turn, timeoutMs: TIMEOUT_MS }, actor);
  await setDeadline(turn.conversationId, "passed");
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
  await newConversation(undefined, isolation.interrupt);
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
  await kit.invoke(
    acceptTurn,
    chatAccept(isolation.interrupt, isolation.interruptCommand),
    {},
  );
  await kit.invoke(
    acceptTurn,
    chatAccept(isolation.foreign, isolation.foreignCommand, BORIS_BIND),
    borisInB,
  );
  // Both stale, so the interrupt's own case ends one and its foreign case has
  // a turn it would end if company scope did not stop it.
  await startPastDeadline(ref(isolation.interrupt, isolation.interruptCommand));
  await startPastDeadline(
    ref(isolation.foreign, isolation.foreignCommand),
    borisInB,
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
    isolationCase(
      readTurnForJob,
      { input: ref(isolation.start, isolation.startCommand) },
      { input: ref(isolation.foreign, isolation.foreignCommand) },
    ),
    isolationCase(
      interruptTurn,
      { input: ref(isolation.interrupt, isolation.interruptCommand) },
      { input: ref(isolation.foreign, isolation.foreignCommand) },
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

  /**
   * A receipt is this command in this conversation (SHO-567). The same client
   * token sent to another of the caller's conversations is a new command there.
   */
  it("accepts a command in a second conversation after it ended in the first", async () => {
    const first = await newConversation();
    const second = await newConversation();
    const commandId = randomUUID();
    await kit.invoke(acceptTurn, chatAccept(first, commandId), {});
    await kit.invoke(
      finishTurn,
      { ...ref(first, commandId), status: "done" },
      {},
    );

    const accepted = await kit.invoke(
      acceptTurn,
      chatAccept(second, commandId),
      {},
    );

    expect(accepted).toMatchObject({
      outcome: "accepted",
      conversationId: second,
      turn: { commandId, status: "queued" },
    });
    expect(await turnRows(second)).toHaveLength(1);
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

  /**
   * The same races, one interleaving at a time instead of by luck (SHO-567).
   * The winner holds its transaction open at commit, with its messages and turn
   * written. The loser lets it commit before each statement it sends to claim
   * the conversation, up to its first write, and once more while that write
   * waits on the winner's key. No point may change the answer.
   */
  it("of the same command: the other replays wherever the winner's commit lands", async () => {
    const races = await everyCommitPoint(async (point) => {
      const conversationId = await newConversation();
      const input = chatAccept(conversationId);
      const race = await raceAccepts(input, input, point);
      expect(await messageIds(conversationId)).toHaveLength(2);
      expect(await turnRows(conversationId)).toHaveLength(1);
      return race;
    });

    expect(races).toEqual(
      races.map((race) => ({
        committedBefore: race.committedBefore,
        winner: "accepted",
        loser: "replayed",
      })),
    );
  });

  it("of two commands: the other is busy wherever the winner's commit lands", async () => {
    const races = await everyCommitPoint(async (point) => {
      const conversationId = await newConversation();
      const race = await raceAccepts(
        chatAccept(conversationId),
        chatAccept(conversationId),
        point,
      );
      expect(await messageIds(conversationId)).toHaveLength(2);
      expect(await turnRows(conversationId)).toHaveLength(1);
      return race;
    });

    expect(races).toEqual(
      races.map((race) => ({
        committedBefore: race.committedBefore,
        winner: "accepted",
        loser: "busy",
      })),
    );
  });
});

/**
 * Where the winner committed, as seen from the loser: before its n-th claim
 * statement (`"<n>:read"` or `"<n>:write"`), or `"waiting"` — after its first
 * write was sent and seen waiting on the winner's lock.
 */
interface RaceResult {
  readonly committedBefore: string;
  readonly winner: string;
  readonly loser: string;
}

/** Before the loser's n-th claim statement, or while its first write waits. */
type CommitPoint = number | "while_waiting";

/** A claim reads the turns; the first write stores the person's message. */
const TURN_TABLE = '"assistant_turns"';
const MESSAGE_WRITE = 'insert into "assistant_chat_messages"';
const MAX_CLAIM_STATEMENTS = 10;

function deferred() {
  let resolve: () => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

/**
 * The kit's pipeline on a one-connection pool of its own, whose statements
 * pass through `gate` before they are sent. The gate decides what the other
 * transaction has committed when each statement runs.
 */
function gatedPipeline(gate: (text: string) => Promise<void>) {
  const databaseUrl = kit.db.runtime.pool.options.connectionString;
  if (databaseUrl === undefined) {
    throw new Error("expected the test pool's connection string");
  }
  const client = createDbClient({ databaseUrl, max: 1 });
  client.pool.on("connect", (connection) => {
    const send: (
      config: string | { readonly text: string },
      values?: unknown[],
    ) => Promise<unknown> = connection.query.bind(connection);
    Object.defineProperty(connection, "query", {
      value: async (
        config: string | { readonly text: string },
        values?: unknown[],
      ) => {
        await gate(typeof config === "string" ? config : config.text);
        return send(config, values);
      },
    });
  });
  return {
    deps: { ...kit.pipeline, db: client.db },
    close: () => client.pool.end(),
  };
}

/** Resolves once a session of this test's database waits on a lock. */
async function waitForLockWait(): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const result = await kit.db.admin.query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock'",
      [kit.db.name],
    );
    if ((result.rows[0]?.n ?? 0) > 0) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
  throw new Error("timed out waiting for the loser to wait on the winner");
}

/**
 * Accepts `winnerInput` and holds it at commit, then accepts `loserInput` and
 * commits the winner at `point` of the loser's claim.
 */
async function raceAccepts(
  winnerInput: ReturnType<typeof chatAccept>,
  loserInput: ReturnType<typeof chatAccept>,
  point: CommitPoint,
): Promise<RaceResult> {
  const held = deferred();
  const release = deferred();
  const state: {
    winnerWroteTurn: boolean;
    claims: number;
    committedBefore: string | undefined;
    waiting: Promise<unknown>;
  } = {
    winnerWroteTurn: false,
    claims: 0,
    committedBefore: undefined,
    waiting: Promise.resolve(),
  };

  const winnerPool = gatedPipeline(async (text) => {
    if (text.startsWith(`insert into ${TURN_TABLE}`)) {
      state.winnerWroteTurn = true;
    }
    if (text === "commit" && state.winnerWroteTurn) {
      held.resolve();
      await release.promise;
    }
  });
  const loserPool = gatedPipeline(async (text) => {
    const write = text.startsWith(MESSAGE_WRITE);
    if (
      state.committedBefore !== undefined ||
      (!write && !text.includes(TURN_TABLE))
    ) {
      return;
    }
    state.claims += 1;
    if (point === "while_waiting") {
      if (write) {
        state.committedBefore = "waiting";
        state.waiting = (async () => {
          await waitForLockWait();
          release.resolve();
          await winner;
        })();
      }
      return;
    }
    if (state.claims === point || write) {
      state.committedBefore = `${String(state.claims)}:${write ? "write" : "read"}`;
      release.resolve();
      await winner;
    }
  });

  const winner = kit.invoke(
    acceptTurn,
    winnerInput,
    {},
    { deps: winnerPool.deps },
  );
  try {
    // A winner that fails before its commit must fail the race, not hang it.
    await Promise.race([held.promise, winner]);
    const loser = await kit.invoke(
      acceptTurn,
      loserInput,
      {},
      { deps: loserPool.deps },
    );
    await state.waiting;
    return {
      committedBefore: state.committedBefore ?? "never",
      winner: (await winner).outcome,
      loser: loser.outcome,
    };
  } finally {
    release.resolve();
    await winner.catch(() => undefined);
    await winnerPool.close();
    await loserPool.close();
  }
}

/**
 * Runs a race for every point of the loser's claim: before each statement up
 * to its first write, then while that write waits.
 */
async function everyCommitPoint(
  run: (point: CommitPoint) => Promise<RaceResult>,
): Promise<RaceResult[]> {
  const races: RaceResult[] = [];
  for (let before = 1; before <= MAX_CLAIM_STATEMENTS; before += 1) {
    const race = await run(before);
    races.push(race);
    if (race.committedBefore.endsWith(":write")) {
      races.push(await run("while_waiting"));
      return races;
    }
  }
  throw new Error("the loser sent no write within its claim statements");
}

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
    ).toEqual({
      outcome: "finished",
      conversationId,
      status: "done",
      releasedHold: HOLD,
    });
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
    ).toEqual({
      outcome: "finished",
      conversationId,
      status: "failed",
      releasedHold: HOLD,
    });
  });
});

/**
 * A hold leaves its row once. The worker's finish and the reconciler's
 * interrupt each zero it in the statement that ends the turn, and only that
 * call is handed it, so nobody can settle or release it twice (SHO-561).
 */
describe("ending a turn takes its hold off the row", () => {
  async function storedHold(conversationId: string) {
    const row = (await turnRows(conversationId))[0];
    return {
      companyReservedMicroUsd: row?.companyReservedMicroUsd,
      globalReservedMicroUsd: row?.globalReservedMicroUsd,
    };
  }

  it("hands the hold to the first finish and none to a second", async () => {
    const conversationId = await newConversation();
    const input = chatAccept(conversationId);
    const turn = ref(conversationId, input.commandId);
    await kit.invoke(acceptTurn, input, {});

    const first = await kit.invoke(finishTurn, { ...turn, status: "done" }, {});
    const second = await kit.invoke(
      finishTurn,
      { ...turn, status: "failed" },
      {},
    );

    expect(first).toEqual({
      outcome: "finished",
      conversationId,
      status: "done",
      releasedHold: HOLD,
    });
    expect(second).toEqual({
      outcome: "already_finished",
      conversationId,
      status: "done",
    });
    expect(await storedHold(conversationId)).toEqual({
      companyReservedMicroUsd: 0,
      globalReservedMicroUsd: 0,
    });
  });

  it("interrupts a running turn past its deadline once, audited in its company", async () => {
    const conversationId = await newConversation();
    const input = chatAccept(conversationId);
    const turn = ref(conversationId, input.commandId.toUpperCase());
    await kit.invoke(acceptTurn, input, {});
    await startPastDeadline(turn);
    const requestId = randomUUID();

    const first = await interruptAs(kitIdentities.companies.a, turn, requestId);
    const second = await interruptAs(kitIdentities.companies.a, turn);

    expect(first).toEqual({
      outcome: "interrupted",
      conversationId,
      from: "running",
      releasedHold: HOLD,
    });
    expect(second).toEqual({
      outcome: "already_finished",
      conversationId,
      status: "interrupted",
    });
    expect((await turnRows(conversationId))[0]).toMatchObject({
      status: "interrupted",
      sessionId: null,
      companyReservedMicroUsd: 0,
      globalReservedMicroUsd: 0,
    });
    expect((await turnRows(conversationId))[0]?.finishedAt).not.toBeNull();

    const audit = await kit.db.runtime.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.requestId, requestId));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: "assistant.interruptTurn",
      companyId: kitIdentities.companies.a,
      targetType: "conversation",
      targetId: conversationId,
      outcome: "ok",
    });

    // The conversation is free again.
    expect(
      (await kit.invoke(acceptTurn, chatAccept(conversationId), {})).outcome,
    ).toBe("accepted");
  });

  /**
   * Only a server-side timeout ends a started turn early, and only the abandon
   * threshold ends a queued one (ADR-0039 as amended, SHO-570). A turn the
   * reconciler listed as queued too long may have been started by a late worker
   * since; interrupting it would free the conversation under that worker and
   * release a hold the model is still spending.
   */
  it("leaves a queued turn inside the abandon threshold and a running turn inside its deadline as they are", async () => {
    const queued = await newConversation();
    const queuedInput = chatAccept(queued);
    await kit.invoke(acceptTurn, queuedInput, {});
    // Stale enough for the reconciler to re-enqueue, far from abandoned.
    await kit.db.runtime.db
      .update(assistantTurns)
      .set({ createdAt: sql`now() - interval '5 minutes'` })
      .where(eq(assistantTurns.conversationId, queued));

    const running = await newConversation();
    const runningInput = chatAccept(running);
    const runningTurn = ref(running, runningInput.commandId);
    await kit.invoke(acceptTurn, runningInput, {});
    await kit.invoke(startTurn, { ...runningTurn, timeoutMs: TIMEOUT_MS }, {});
    await setDeadline(running, "ahead");

    expect(
      await interruptAs(
        kitIdentities.companies.a,
        ref(queued, queuedInput.commandId),
      ),
    ).toEqual({
      outcome: "not_stale",
      conversationId: queued,
      status: "queued",
    });
    expect(await interruptAs(kitIdentities.companies.a, runningTurn)).toEqual({
      outcome: "not_stale",
      conversationId: running,
      status: "running",
    });

    for (const [conversationId, status] of [
      [queued, "queued"],
      [running, "running"],
    ] as const) {
      expect((await turnRows(conversationId))[0]).toMatchObject({
        status,
        sessionId: "session-anna",
        finishedAt: null,
        companyReservedMicroUsd: HOLD.companyReservedMicroUsd,
        globalReservedMicroUsd: HOLD.globalReservedMicroUsd,
      });
      // Still holding its conversation.
      expect(
        (await kit.invoke(acceptTurn, chatAccept(conversationId), {})).outcome,
      ).toBe("busy");
    }
  });

  /**
   * A queued turn that can never start — its author lost membership, or its job
   * is refused every time — would otherwise hold its conversation and its
   * reservation for ever (SHO-570 conveyor decision). It never reached the
   * model, so the hold comes back to the caller, which `from: "queued"` says.
   */
  it("ends a queued turn nobody started within the abandon threshold, and frees its conversation", async () => {
    const conversationId = await newConversation();
    const input = chatAccept(conversationId);
    const turn = ref(conversationId, input.commandId);
    await kit.invoke(acceptTurn, input, {});
    await ageQueuedTurn(conversationId, "16 minutes");

    expect(await interruptAs(kitIdentities.companies.a, turn)).toEqual({
      outcome: "interrupted",
      conversationId,
      from: "queued",
      releasedHold: HOLD,
    });

    expect((await turnRows(conversationId))[0]).toMatchObject({
      status: "interrupted",
      sessionId: null,
      startedAt: null,
      companyReservedMicroUsd: 0,
      globalReservedMicroUsd: 0,
    });
    expect(
      (await kit.invoke(acceptTurn, chatAccept(conversationId), {})).outcome,
    ).toBe("accepted");
  });

  /** The start is a compare-and-set on `queued`, so the interrupt lost it. */
  it("leaves an abandoned turn a worker started first alone", async () => {
    const conversationId = await newConversation();
    const input = chatAccept(conversationId);
    const turn = ref(conversationId, input.commandId);
    await kit.invoke(acceptTurn, input, {});
    await ageQueuedTurn(conversationId, "16 minutes");
    await kit.invoke(startTurn, { ...turn, timeoutMs: TIMEOUT_MS }, {});

    expect(await interruptAs(kitIdentities.companies.a, turn)).toEqual({
      outcome: "not_stale",
      conversationId,
      status: "running",
    });
    expect((await turnRows(conversationId))[0]).toMatchObject({
      status: "running",
      companyReservedMicroUsd: HOLD.companyReservedMicroUsd,
    });
  });

  it("never ends a turn that already ended, whichever of the two came first", async () => {
    const finishedFirst = await newConversation();
    const finishedInput = chatAccept(finishedFirst);
    const finishedTurn = ref(finishedFirst, finishedInput.commandId);
    await kit.invoke(acceptTurn, finishedInput, {});
    await kit.invoke(finishTurn, { ...finishedTurn, status: "done" }, {});

    expect(await interruptAs(kitIdentities.companies.a, finishedTurn)).toEqual({
      outcome: "already_finished",
      conversationId: finishedFirst,
      status: "done",
    });

    const interruptedFirst = await newConversation();
    const interruptedInput = chatAccept(interruptedFirst);
    const interruptedTurn = ref(interruptedFirst, interruptedInput.commandId);
    await kit.invoke(acceptTurn, interruptedInput, {});
    await startPastDeadline(interruptedTurn);
    await interruptAs(kitIdentities.companies.a, interruptedTurn);

    // A late done from a worker cannot overwrite the interruption.
    expect(
      await kit.invoke(finishTurn, { ...interruptedTurn, status: "done" }, {}),
    ).toEqual({
      outcome: "already_finished",
      conversationId: interruptedFirst,
      status: "interrupted",
    });
  });

  it("gives the hold to exactly one of a finish and an interrupt that race", async () => {
    for (let round = 0; round < 5; round += 1) {
      const conversationId = await newConversation();
      const input = chatAccept(conversationId);
      const turn = ref(conversationId, input.commandId);
      await kit.invoke(acceptTurn, input, {});
      await startPastDeadline(turn);

      const outcomes = await Promise.all([
        kit.invoke(finishTurn, { ...turn, status: "done" }, {}),
        interruptAs(kitIdentities.companies.a, turn),
      ]);

      expect(
        outcomes.flatMap((outcome) =>
          "releasedHold" in outcome ? [outcome.releasedHold] : [],
        ),
      ).toEqual([HOLD]);
      expect(await storedHold(conversationId)).toEqual({
        companyReservedMicroUsd: 0,
        globalReservedMicroUsd: 0,
      });
    }
  });

  it("is not-found for another company's turn, and a missing one", async () => {
    await expect(
      interruptAs(
        kitIdentities.companies.a,
        ref(isolation.foreign, isolation.foreignCommand),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      interruptAs(kitIdentities.companies.a, ref(randomUUID(), randomUUID())),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect((await turnRows(isolation.foreign))[0]).toMatchObject({
      status: "running",
      companyReservedMicroUsd: HOLD.companyReservedMicroUsd,
    });
  });
});

/**
 * The same at-most-once property, one interleaving at a time instead of by luck.
 * The first ender holds its transaction open at commit, with the row updated
 * and locked; the second is sent, seen waiting on that lock, and only then is
 * the first let go. The lock in `finaliseTurn`'s sub-select is what makes the
 * second re-read the ended row and take nothing.
 */
describe("a finish and an interrupt, the second waiting on the first", () => {
  type Ender = "finish" | "interrupt";
  interface Ended {
    readonly outcome: string;
    readonly releasedHold: unknown;
  }

  async function endTurn(
    ender: Ender,
    turn: TurnRef,
    deps: Parameters<typeof executeAction>[0],
  ): Promise<Ended> {
    const ended =
      ender === "finish"
        ? await kit.invoke(
            finishTurn,
            { ...turn, status: "done" },
            {},
            { deps },
          )
        : await interruptAs(kitIdentities.companies.a, turn, undefined, deps);
    return {
      outcome: ended.outcome,
      releasedHold: "releasedHold" in ended ? ended.releasedHold : null,
    };
  }

  async function holdThenWait(holder: Ender) {
    const waiter: Ender = holder === "finish" ? "interrupt" : "finish";
    const conversationId = await newConversation();
    const input = chatAccept(conversationId);
    const turn = ref(conversationId, input.commandId);
    await kit.invoke(acceptTurn, input, {});
    await startPastDeadline(turn);

    const held = deferred();
    const release = deferred();
    const state = { updatedTurn: false };
    const holderPool = gatedPipeline(async (text) => {
      if (text.startsWith(`update ${TURN_TABLE}`)) {
        state.updatedTurn = true;
      }
      if (text === "commit" && state.updatedTurn) {
        held.resolve();
        await release.promise;
      }
    });
    const waiterPool = gatedPipeline(() => Promise.resolve());

    const holding = endTurn(holder, turn, holderPool.deps);
    try {
      // A holder that fails before its commit must fail the test, not hang it.
      await Promise.race([held.promise, holding]);
      const waiting = endTurn(waiter, turn, waiterPool.deps);
      const settled = Promise.allSettled([holding, waiting]);
      try {
        await waitForLockWait();
      } finally {
        release.resolve();
      }
      const [holderResult, waiterResult] = await settled;
      if (holderResult.status === "rejected") {
        throw holderResult.reason;
      }
      if (waiterResult.status === "rejected") {
        throw waiterResult.reason;
      }
      return {
        conversationId,
        holder: holderResult.value,
        waiter: waiterResult.value,
      };
    } finally {
      release.resolve();
      await holding.catch(() => undefined);
      await holderPool.close();
      await waiterPool.close();
    }
  }

  it("a finish holding the row leaves the waiting interrupt nothing", async () => {
    const race = await holdThenWait("finish");

    expect(race.holder).toEqual({ outcome: "finished", releasedHold: HOLD });
    expect(race.waiter).toEqual({
      outcome: "already_finished",
      releasedHold: null,
    });
    expect((await turnRows(race.conversationId))[0]).toMatchObject({
      status: "done",
      companyReservedMicroUsd: 0,
      globalReservedMicroUsd: 0,
    });
  });

  it("an interrupt holding the row leaves the waiting finish nothing", async () => {
    const race = await holdThenWait("interrupt");

    expect(race.holder).toEqual({ outcome: "interrupted", releasedHold: HOLD });
    expect(race.waiter).toEqual({
      outcome: "already_finished",
      releasedHold: null,
    });
    expect((await turnRows(race.conversationId))[0]).toMatchObject({
      status: "interrupted",
      companyReservedMicroUsd: 0,
      globalReservedMicroUsd: 0,
    });
  });

  it("refuses the interrupt to a staff caller and to a global system caller", async () => {
    const conversationId = await newConversation();
    const input = chatAccept(conversationId);
    const turn = ref(conversationId, input.commandId);
    await kit.invoke(acceptTurn, input, {});

    await expect(
      executeAction(kit.pipeline, {
        action: interruptTurn,
        input: turn,
        request: { ...systemRequest(), channel: "ui" as const },
        principal: {
          mode: "staff",
          session: { userId: kitIdentities.users.anna },
          companySelector: kitIdentities.companies.a,
        },
      }),
    ).rejects.toBeInstanceOf(CoreInvariantError);
    await expect(
      executeAction(kit.pipeline, {
        action: interruptTurn,
        input: turn,
        request: systemRequest(),
        principal: {
          mode: "system",
          serviceName: "assistant-reconciler",
          scope: { scope: "global" },
        },
      }),
    ).rejects.toBeInstanceOf(CoreInvariantError);
    expect((await turnRows(conversationId))[0]?.status).toBe("queued");
  });

  it("refuses an interrupt that is not a turn's identity", async () => {
    const conversationId = await newConversation();
    const input = chatAccept(conversationId);
    await kit.invoke(acceptTurn, input, {});

    await expect(
      interruptAs(kitIdentities.companies.a, {
        ...ref(conversationId, input.commandId),
        commandId: "not-a-uuid",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect((await turnRows(conversationId))[0]?.status).toBe("queued");
  });
});

describe("the worker's read of the turn a job names", () => {
  it("returns what the worker needs, from ids in any casing", async () => {
    const conversationId = await newConversation();
    const input = chatAccept(conversationId);
    const requestId = randomUUID();
    await kit.invoke(acceptTurn, input, {}, { request: { requestId } });
    await kit.invoke(
      startTurn,
      { ...ref(conversationId, input.commandId), timeoutMs: TIMEOUT_MS },
      {},
    );

    const read = await readForJob({
      conversationId: conversationId.toUpperCase(),
      kind: "chat",
      commandId: input.commandId.toUpperCase(),
    });

    const row = (await turnRows(conversationId))[0];
    expect(read).toEqual({
      turn: {
        companyId: kitIdentities.companies.a,
        conversationId,
        kind: "chat",
        commandId: input.commandId,
        userId: kitIdentities.users.anna,
        requestId,
        status: "running",
        placeholderMessageId: input.placeholder.messageId,
        deadlineAt: row?.deadlineAt?.toISOString(),
        budgetHold: HOLD,
        continuationRootCommandId: input.commandId,
      },
    });
    expect(read.turn).not.toHaveProperty("sessionId");

    await kit.invoke(
      finishTurn,
      { ...ref(conversationId, input.commandId), status: "done" },
      {},
    );
    expect(
      (await readForJob(ref(conversationId, input.commandId))).turn,
    ).toMatchObject({ status: "done", budgetHold: EMPTY_HOLD });
  });

  it("names the first turn of a continuation chain as the command its tools key under", async () => {
    const conversationId = await newConversation();
    const first = chatAccept(conversationId);
    await kit.invoke(acceptTurn, first, {});
    await startPastDeadline(ref(conversationId, first.commandId));
    await interruptAs(
      kitIdentities.companies.a,
      ref(conversationId, first.commandId),
    );
    const second = chatAccept(conversationId);
    await kit.invoke(
      acceptTurn,
      { ...second, continuesCommandId: first.commandId },
      {},
    );

    expect(
      (await readForJob(ref(conversationId, second.commandId))).turn,
    ).toMatchObject({
      commandId: second.commandId,
      status: "queued",
      deadlineAt: null,
      continuationRootCommandId: first.commandId,
    });
  });

  it("returns no turn for an identity nobody accepted, including another kind", async () => {
    const conversationId = await newConversation();
    const input = chatAccept(conversationId);
    await kit.invoke(acceptTurn, input, {});

    expect(await readForJob(ref(randomUUID(), input.commandId))).toEqual({
      turn: null,
    });
    expect(
      await readForJob({
        conversationId,
        kind: "answer",
        commandId: input.commandId,
      }),
    ).toEqual({ turn: null });
  });

  it("reads a turn of any company", async () => {
    expect(
      (await readForJob(ref(isolation.foreign, isolation.foreignCommand))).turn,
    ).toMatchObject({
      companyId: kitIdentities.companies.b,
      userId: kitIdentities.users.boris,
    });
  });

  it("is refused to a staff caller and to a tenant-scoped system caller", async () => {
    const turn = ref(isolation.start, isolation.startCommand);

    await expect(
      executeAction(kit.pipeline, {
        action: readTurnForJob,
        input: turn,
        request: { ...systemRequest(), channel: "ui" as const },
        principal: {
          mode: "staff",
          session: { userId: kitIdentities.users.anna },
          companySelector: kitIdentities.companies.a,
        },
      }),
    ).rejects.toBeInstanceOf(CoreInvariantError);
    await expect(
      executeAction(kit.pipeline, {
        action: readTurnForJob,
        input: turn,
        request: systemRequest(),
        principal: {
          mode: "system",
          serviceName: "assistant-worker",
          scope: { scope: "tenant", companyId: kitIdentities.companies.a },
        },
      }),
    ).rejects.toBeInstanceOf(CoreInvariantError);
  });

  it("refuses a job identity that is not one, and a company id", async () => {
    await expect(
      readForJob({ ...ref(randomUUID(), randomUUID()), commandId: "job-1" }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      executeAction(kit.pipeline, {
        action: readTurnForJob,
        input: {
          ...ref(isolation.start, isolation.startCommand),
          companyId: kitIdentities.companies.a,
        },
        request: systemRequest(),
        principal: {
          mode: "system",
          serviceName: "assistant-worker",
          scope: { scope: "global" },
        },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
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

    // Company A: queued past the abandon threshold — it can never start.
    const queuedAbandoned = await newConversation();
    const queuedAbandonedInput = chatAccept(queuedAbandoned);
    await kit.invoke(acceptTurn, queuedAbandonedInput, {});
    await ageTurn(queuedAbandoned, "20 minutes");

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
      queuedAbandoned,
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
      // Oldest first: abandoned at twenty minutes, then the one whose job was
      // lost ten minutes ago, then the running turn accepted five minutes ago.
      {
        companyId: kitIdentities.companies.a,
        conversationId: queuedAbandoned,
        kind: "chat",
        commandId: queuedAbandonedInput.commandId,
        status: "queued",
        placeholderMessageId: queuedAbandonedInput.placeholder.messageId,
        budgetHold: HOLD,
        staleness: "queued_abandoned",
      },
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
          revision: expected - 1,
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

  /**
   * A turn's message has two writers once the reconciler can end a turn the
   * worker is still writing (SHO-570). Each stores a whole payload, so an
   * update from a revision the message no longer has must store nothing rather
   * than erase what it never read.
   */
  it("refuses an update from a revision the message has moved past, and stores nothing", async () => {
    const conversationId = await newConversation();
    const input = chatAccept(conversationId);
    await kit.invoke(acceptTurn, input, {});
    const placeholder = {
      conversationId,
      seq: 2,
      messageId: input.placeholder.messageId,
    };
    const byTheOther = { ...input.placeholder.message, parts: [] };
    await kit.invoke(
      updateChatMessage,
      { ...placeholder, revision: 1, message: byTheOther },
      {},
    );

    await expect(
      kit.invoke(
        updateChatMessage,
        {
          ...placeholder,
          revision: 1,
          message: { ...input.placeholder.message, parts: ["late"] },
        },
        {},
      ),
    ).rejects.toBeInstanceOf(ConflictError);

    const stored = await kit.db.runtime.db
      .select({
        message: assistantChatMessages.message,
        revision: assistantChatMessages.revision,
      })
      .from(assistantChatMessages)
      .where(eq(assistantChatMessages.messageId, input.placeholder.messageId));
    expect(stored).toEqual([{ message: byTheOther, revision: 2 }]);

    // Reading it again and writing from what is stored now is accepted.
    expect(
      await kit.invoke(
        updateChatMessage,
        { ...placeholder, revision: 2, message: input.placeholder.message },
        {},
      ),
    ).toEqual({ conversationId, seq: 2, revision: 3 });
  });

  it("is not-found, not a conflict, for a pair that names no message", async () => {
    const conversationId = await newConversation();
    await kit.invoke(acceptTurn, chatAccept(conversationId), {});

    await expect(
      kit.invoke(
        updateChatMessage,
        {
          conversationId,
          seq: 2,
          messageId: randomUUID(),
          revision: 1,
          message: {},
        },
        {},
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

/**
 * Exactly one of a start and an abandoned turn's interrupt wins, whichever
 * reaches the row first, and the loser is told (SHO-570). The winner holds its
 * transaction open with the row updated and locked; the loser is sent, seen
 * waiting on that lock, and only then is the winner let go.
 */
describe("a start and a queued turn's interrupt, the second waiting on the first", () => {
  async function holdThenWait(holder: "start" | "interrupt") {
    const conversationId = await newConversation();
    const input = chatAccept(conversationId);
    const turn = ref(conversationId, input.commandId);
    await kit.invoke(acceptTurn, input, {});
    await ageQueuedTurn(conversationId, "16 minutes");

    const held = deferred();
    const release = deferred();
    const state = { updatedTurn: false };
    const holderPool = gatedPipeline(async (text) => {
      if (text.startsWith(`update ${TURN_TABLE}`)) {
        state.updatedTurn = true;
      }
      if (text === "commit" && state.updatedTurn) {
        held.resolve();
        await release.promise;
      }
    });
    const waiterPool = gatedPipeline(() => Promise.resolve());

    const start = (deps: Parameters<typeof executeAction>[0]) =>
      kit.invoke(startTurn, { ...turn, timeoutMs: TIMEOUT_MS }, {}, { deps });
    const interrupt = (deps: Parameters<typeof executeAction>[0]) =>
      interruptAs(kitIdentities.companies.a, turn, undefined, deps);

    const holding =
      holder === "start" ? start(holderPool.deps) : interrupt(holderPool.deps);
    try {
      await Promise.race([held.promise, holding]);
      const waiting =
        holder === "start"
          ? interrupt(waiterPool.deps)
          : start(waiterPool.deps);
      const settled = Promise.allSettled([holding, waiting]);
      try {
        await waitForLockWait();
      } finally {
        release.resolve();
      }
      const [holderResult, waiterResult] = await settled;
      if (holderResult.status === "rejected") {
        throw holderResult.reason;
      }
      if (waiterResult.status === "rejected") {
        throw waiterResult.reason;
      }
      return {
        conversationId,
        holder: holderResult.value,
        waiter: waiterResult.value,
      };
    } finally {
      release.resolve();
      await holding.catch(() => undefined);
      await holderPool.close();
      await waiterPool.close();
    }
  }

  it("a start holding the row leaves the waiting interrupt nothing", async () => {
    const race = await holdThenWait("start");

    expect(race.holder).toMatchObject({ outcome: "started" });
    expect(race.waiter).toEqual({
      outcome: "not_stale",
      conversationId: race.conversationId,
      status: "running",
    });
    expect((await turnRows(race.conversationId))[0]).toMatchObject({
      status: "running",
      companyReservedMicroUsd: HOLD.companyReservedMicroUsd,
    });
  });

  it("an interrupt holding the row leaves the waiting start nothing, and the hold once", async () => {
    const race = await holdThenWait("interrupt");

    expect(race.holder).toEqual({
      outcome: "interrupted",
      conversationId: race.conversationId,
      from: "queued",
      releasedHold: HOLD,
    });
    expect(race.waiter).toEqual({
      outcome: "not_queued",
      conversationId: race.conversationId,
      status: "interrupted",
    });
    expect((await turnRows(race.conversationId))[0]).toMatchObject({
      status: "interrupted",
      startedAt: null,
      companyReservedMicroUsd: 0,
      globalReservedMicroUsd: 0,
    });
  });
});
