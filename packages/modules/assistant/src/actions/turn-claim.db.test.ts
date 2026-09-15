import { randomUUID } from "node:crypto";

import { executeAction } from "@showzy/core";
import { ConflictError, NotFoundError } from "@showzy/core/errors";
import {
  createTestKit,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import { createDbClient } from "@showzy/db";
import {
  assistantConversations,
  assistantTurns,
} from "@showzy/db/schema/assistant";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { acceptTurn } from "./accept-turn.js";
import { finishTurn } from "./finish-turn.js";
import { insertChatMessage } from "./insert-chat-message.js";
import { interruptTurn } from "./interrupt-turn.js";
import { readChatMessages } from "./read-chat-messages.js";
import { readChatState } from "./read-chat-state.js";
import { startTurn } from "./start-turn.js";
import { updateChatMessage } from "./update-chat-message.js";
import { writeChatState } from "./write-chat-state.js";
import { writeChatStateInputSchema } from "./write-chat-state.contract.js";

const BIND = "anna:company-a";
const HOLD = {
  companyReservedMicroUsd: 100_000,
  globalReservedMicroUsd: 100_000,
  kyivDate: "2026-09-14",
};
const FIRST = { role: "user", content: "перше" };
const OLD_REPLY = { role: "assistant", content: "стара відповідь" };
const SECOND = { role: "user", content: "друге" };
const CLAIM_READ = /from "assistant_turns".* for share/s;
const TURN_END = 'update "assistant_turns"';

type Deps = Parameters<typeof executeAction>[0];

const annaInA = {
  userId: kitIdentities.users.anna,
  companyId: kitIdentities.companies.a,
};
const borisInB = {
  userId: kitIdentities.users.boris,
  companyId: kitIdentities.companies.b,
};

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
    createdAt: "2026-09-14T10:00:00.000Z",
    parts: [{ kind: "text", text: "", status: "complete" }],
  };
}

function chatAccept(
  conversationId: string,
  message: { role: string; content: string },
) {
  const userMessageId = randomUUID();
  const placeholderId = randomUUID();
  return {
    conversationId,
    kind: "chat" as const,
    commandId: randomUUID(),
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
    budgetHold: HOLD,
    history: { kind: "append" as const, message },
  };
}

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

async function staleRunningTurn(
  author: { readonly userId: string; readonly companyId: string } = annaInA,
) {
  const conversationId = randomUUID();
  await kit.db.runtime.db.insert(assistantConversations).values({
    id: conversationId,
    companyId: author.companyId,
    userId: author.userId,
  });
  const accept = chatAccept(conversationId, FIRST);
  await kit.invoke(acceptTurn, accept, author);
  const turn = {
    conversationId,
    kind: "chat" as const,
    commandId: accept.commandId,
  };
  await kit.invoke(startTurn, { ...turn, timeoutMs: 180_000 }, author);
  await kit.db.runtime.db
    .update(assistantTurns)
    .set({ deadlineAt: sql`now() - interval '1 second'` })
    .where(eq(assistantTurns.conversationId, conversationId));
  return {
    turn,
    claim: { kind: turn.kind, commandId: turn.commandId },
    placeholder: accept.placeholder,
  };
}

function interrupt(turn: {
  conversationId: string;
  kind: "chat";
  commandId: string;
}) {
  const requestId = randomUUID();
  return executeAction(kit.pipeline, {
    action: interruptTurn,
    input: turn,
    request: { requestId, correlationId: requestId, channel: "system" },
    principal: {
      mode: "system",
      serviceName: "assistant-reconciler",
      scope: { scope: "tenant", companyId: kitIdentities.companies.a },
    },
  });
}

async function lockWaitOrDone(done: Promise<unknown>): Promise<void> {
  const deadline = Date.now() + 8_000;
  const progress = { settled: false };
  void done.finally(() => {
    progress.settled = true;
  });
  while (Date.now() < deadline && !progress.settled) {
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
}

type Pause = "before_claim" | "after_claim";

async function raceWorkerWrite(options: {
  readonly claimStatement: (text: string) => boolean;
  readonly pause: Pause;
  readonly write: (deps: Deps) => Promise<unknown>;
  readonly turn: Awaited<ReturnType<typeof staleRunningTurn>>["turn"];
}) {
  const paused = deferred();
  const release = deferred();
  const state = { claimSent: false, held: false };
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
        const text = typeof config === "string" ? config : config.text;
        const isClaim = options.claimStatement(text);
        const pauseHere =
          !state.held &&
          (options.pause === "before_claim" ? isClaim : state.claimSent);
        if (isClaim) {
          state.claimSent = true;
        }
        if (pauseHere) {
          state.held = true;
          paused.resolve();
          await release.promise;
        }
        return send(config, values);
      },
    });
  });

  const writing = options.write({ ...kit.pipeline, db: client.db });
  const writeSettled = writing.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  try {
    await Promise.race([paused.promise, writeSettled]);
    const next = chatAccept(options.turn.conversationId, SECOND);
    const endAndAccept = (async () => {
      const ended = await interrupt(options.turn);
      const accepted = await kit.invoke(acceptTurn, next, {});
      return { ended, accepted };
    })();
    const sequenceSettled = endAndAccept.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    if (options.pause === "after_claim") {
      await lockWaitOrDone(sequenceSettled);
    } else {
      await sequenceSettled;
    }
    release.resolve();
    const [writer, sequence] = await Promise.all([
      writeSettled,
      sequenceSettled,
    ]);
    if (!sequence.ok) {
      throw sequence.error;
    }
    return { writer, sequence: sequence.value, next };
  } finally {
    release.resolve();
    await writeSettled;
    await client.pool.end();
  }
}

async function storedHistory(conversationId: string) {
  return (await kit.invoke(readChatState, { conversationId }, {})).history;
}

async function latestMessageId(conversationId: string) {
  const page = await kit.invoke(
    readChatMessages,
    { conversationId, limit: 1 },
    {},
  );
  return page.records[0]?.messageId;
}

describe("worker writes are fenced by the turn claim", () => {
  it("stores a claimed history save while the turn is running", async () => {
    const { turn, claim } = await staleRunningTurn();

    await kit.invoke(
      writeChatState,
      {
        conversationId: turn.conversationId,
        history: [FIRST, OLD_REPLY],
        claim,
      },
      {},
    );

    expect(await storedHistory(turn.conversationId)).toEqual([
      FIRST,
      OLD_REPLY,
    ]);
  });

  it("refuses a claim that names a running turn of another conversation", async () => {
    const running = await staleRunningTurn();
    const other = await staleRunningTurn();

    await expect(
      kit.invoke(
        writeChatState,
        {
          conversationId: other.turn.conversationId,
          history: [OLD_REPLY],
          claim: running.claim,
        },
        {},
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(await storedHistory(other.turn.conversationId)).toEqual([FIRST]);
  });

  it("refuses a company-A caller whose claim names a running turn of company B", async () => {
    const own = await staleRunningTurn(annaInA);
    const foreign = await staleRunningTurn(borisInB);
    const save = (conversationId: string) =>
      kit.invoke(
        writeChatState,
        { conversationId, history: [OLD_REPLY], claim: foreign.claim },
        annaInA,
      );

    await expect(save(own.turn.conversationId)).rejects.toBeInstanceOf(
      ConflictError,
    );
    await expect(save(foreign.turn.conversationId)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(await storedHistory(own.turn.conversationId)).toEqual([FIRST]);
    expect(
      (
        await kit.invoke(
          readChatState,
          { conversationId: foreign.turn.conversationId },
          borisInB,
        )
      ).history,
    ).toEqual([FIRST]);
  });

  it("refuses a claim that is not a turn kind", () => {
    expect(
      writeChatStateInputSchema.safeParse({
        conversationId: randomUUID(),
        history: [],
        claim: { kind: "job", commandId: randomUUID() },
      }).success,
    ).toBe(false);
  });

  it("refuses a claimed card update once the turn has ended", async () => {
    const { turn, claim, placeholder } = await staleRunningTurn();
    const stored = (
      await kit.invoke(
        readChatMessages,
        { conversationId: turn.conversationId, limit: 1 },
        {},
      )
    ).records[0];
    if (stored === undefined) {
      throw new Error("expected the placeholder");
    }
    const update = (withClaim: boolean, revision: number) =>
      kit.invoke(
        updateChatMessage,
        {
          conversationId: turn.conversationId,
          seq: stored.seq,
          messageId: placeholder.messageId,
          revision,
          message: textMessage(placeholder.messageId, "assistant"),
          ...(withClaim ? { claim } : {}),
        },
        {},
      );

    const whileRunning = await update(true, stored.revision);
    await interrupt(turn);

    await expect(update(true, whileRunning.revision)).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(await update(false, whileRunning.revision)).toMatchObject({
      revision: whileRunning.revision + 1,
    });
  });

  describe("a history save that read the claim, raced by the end and a new accept", () => {
    const save = async (pause: Pause) => {
      const { turn, claim } = await staleRunningTurn();
      const race = await raceWorkerWrite({
        claimStatement: (text) => CLAIM_READ.test(text),
        pause,
        turn,
        write: (deps) =>
          kit.invoke(
            writeChatState,
            {
              conversationId: turn.conversationId,
              history: [FIRST, OLD_REPLY],
              claim,
            },
            {},
            { deps },
          ),
      });
      return { turn, race };
    };

    it("commits before the end when it holds the claim first", async () => {
      const { turn, race } = await save("after_claim");

      expect(race.writer.ok).toBe(true);
      expect(race.sequence.ended).toMatchObject({ outcome: "interrupted" });
      expect(race.sequence.accepted).toMatchObject({ outcome: "accepted" });
      expect(await storedHistory(turn.conversationId)).toEqual([
        FIRST,
        OLD_REPLY,
        SECOND,
      ]);
    });

    it("is refused when the end commits first, and the new accept's history stands", async () => {
      const { turn, race } = await save("before_claim");

      expect(race.writer.ok).toBe(false);
      expect(race.writer.ok ? null : race.writer.error).toBeInstanceOf(
        ConflictError,
      );
      expect(race.sequence.accepted).toMatchObject({ outcome: "accepted" });
      expect(await storedHistory(turn.conversationId)).toEqual([FIRST, SECOND]);
    });
  });

  describe("a card write that read the claim, raced by the end and a new accept", () => {
    const card = async (pause: Pause) => {
      const { turn, claim } = await staleRunningTurn();
      const cardId = randomUUID();
      const race = await raceWorkerWrite({
        claimStatement: (text) => CLAIM_READ.test(text),
        pause,
        turn,
        write: (deps) =>
          kit.invoke(
            insertChatMessage,
            {
              conversationId: turn.conversationId,
              messageId: cardId,
              bind: BIND,
              message: textMessage(cardId, "assistant"),
              claim,
            },
            {},
            { deps },
          ),
      });
      return { turn, race };
    };

    it("commits before the end, and the new accept's placeholder is the latest", async () => {
      const { turn, race } = await card("after_claim");

      expect(race.writer.ok).toBe(true);
      expect(race.sequence.accepted).toMatchObject({ outcome: "accepted" });
      expect(await latestMessageId(turn.conversationId)).toBe(
        race.next.placeholder.messageId,
      );
    });

    it("is refused when the end commits first", async () => {
      const { turn, race } = await card("before_claim");

      expect(race.writer.ok ? null : race.writer.error).toBeInstanceOf(
        ConflictError,
      );
      expect(race.sequence.accepted).toMatchObject({ outcome: "accepted" });
      expect(await latestMessageId(turn.conversationId)).toBe(
        race.next.placeholder.messageId,
      );
    });
  });

  describe("a finish raced by the end and a new accept", () => {
    const finish = async (pause: Pause) => {
      const { turn } = await staleRunningTurn();
      const race = await raceWorkerWrite({
        claimStatement: (text) => text.startsWith(TURN_END),
        pause,
        turn,
        write: (deps) =>
          kit.invoke(finishTurn, { ...turn, status: "done" }, {}, { deps }),
      });
      const nextTurn = (
        await kit.db.runtime.db
          .select()
          .from(assistantTurns)
          .where(
            and(
              eq(assistantTurns.conversationId, turn.conversationId),
              eq(assistantTurns.commandId, race.next.commandId),
            ),
          )
      )[0];
      return { race, nextTurn };
    };

    it("ends the turn before the interrupt when it holds the row first", async () => {
      const { race, nextTurn } = await finish("after_claim");

      expect(race.writer).toMatchObject({
        ok: true,
        value: { outcome: "finished", status: "done" },
      });
      expect(race.sequence.ended).toMatchObject({
        outcome: "already_finished",
      });
      expect(nextTurn).toMatchObject({
        status: "queued",
        companyReservedMicroUsd: HOLD.companyReservedMicroUsd,
      });
    });

    it("takes nothing when the end commits first, and the new turn keeps its hold", async () => {
      const { race, nextTurn } = await finish("before_claim");

      expect(race.writer).toMatchObject({
        ok: true,
        value: { outcome: "already_finished", status: "interrupted" },
      });
      expect(nextTurn).toMatchObject({
        status: "queued",
        companyReservedMicroUsd: HOLD.companyReservedMicroUsd,
      });
    });
  });

  it("an accept still stores its messages and history in one transaction", async () => {
    const { turn, placeholder } = await staleRunningTurn();
    await interrupt(turn);
    const next = chatAccept(turn.conversationId, SECOND);
    next.placeholder.messageId = placeholder.messageId;

    await expect(kit.invoke(acceptTurn, next, {})).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(await storedHistory(turn.conversationId)).toEqual([FIRST]);
    expect(await latestMessageId(turn.conversationId)).toBe(
      placeholder.messageId,
    );
    const rows = await kit.db.runtime.db
      .select({ id: assistantTurns.id })
      .from(assistantTurns)
      .where(eq(assistantTurns.commandId, next.commandId));
    expect(rows).toHaveLength(0);
  });
});
