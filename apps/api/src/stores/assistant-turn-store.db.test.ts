/**
 * The turn store against a real database, read back through the kit a client
 * is served by (SHO-560, ADR-0039).
 *
 * What this proves that the module's own suite cannot: the messages the runtime
 * builds for an accept are ones the kit's window and the client's schema read;
 * the job the accept names is the job the reconciler rebuilds from the row
 * alone, whatever casing the request carried; and a request that stored no
 * turn gives its budget reservation back.
 */
import { randomUUID } from "node:crypto";

import { chatWindowSchema } from "@showzy/assistant-kit";
import {
  AssistantKitConversationGoneError,
  DEFAULT_STAFF_ASSISTANT_BUDGET_LIMITS,
  aiCompanyBudgetKey,
  aiGlobalBudgetKey,
  assistantTurnJobId,
  assistantTurnMessageId,
  createMemoryAiBudgetStore,
  createPostgresAssistantStaleTurns,
  createPostgresAssistantTurnForJob,
  createPostgresAssistantTurnStore,
  enforceStaffAssistantBudget,
  releaseUnusedReservation,
  type AiBudgetStore,
  type StaffAssistantBudgetHold,
} from "@showzy/assistant-runtime";
import { ConflictError, PermissionDeniedError } from "@showzy/core/errors";
import {
  createTestKit,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import {
  assistantConversations,
  assistantTurns,
} from "@showzy/db/schema/assistant";
import { user } from "@showzy/db/schema/auth";
import { companyMembers } from "@showzy/db/schema/companies";
import { assistantChatWindowSchema } from "@showzy/validation/assistant-chat";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createActionRegistry } from "../registry.js";
import { createAssistantKitRuntime } from "../http/assistant-kit-runtime.js";

let kit: TestKit;

const anna = {
  userId: kitIdentities.users.anna,
  companySelector: kitIdentities.companies.a,
  requestId: randomUUID(),
  clientIp: "127.0.0.1",
};
const annaBind = `${anna.userId}:${anna.companySelector}`;
const hold = {
  companyReservedUsd: 0.1,
  globalReservedUsd: 0.1,
  kyivDate: "2026-09-11",
};

/** For the tests that are not about the budget: nothing was reserved. */
const nothingReserved = {
  budgetHold: hold,
  releaseUnusedHold: () => Promise.resolve(),
};

/** Pauses only; the kit reads one to fill `openPause`. */
function memoryRedis() {
  const rows = new Map<string, string>();
  return {
    eval: () => Promise.resolve(null),
    get: (key: string) => Promise.resolve(rows.get(key) ?? null),
    set: () => Promise.resolve("OK"),
    del: () => Promise.resolve(1),
  } as never;
}

function kitFor() {
  return createAssistantKitRuntime({
    auth: { api: { getSession: () => Promise.resolve(null) } },
    registry: createActionRegistry(),
    pipeline: kit.pipeline,
    model: "mock",
    redis: memoryRedis(),
  }).forCaller(anna).kit;
}

function turns() {
  return createPostgresAssistantTurnStore({ pipeline: kit.pipeline }, anna);
}

async function newConversation(
  owner: { companyId: string; userId: string } = {
    companyId: kitIdentities.companies.a,
    userId: kitIdentities.users.anna,
  },
): Promise<string> {
  const id = randomUUID();
  await kit.db.runtime.db
    .insert(assistantConversations)
    .values({ id, ...owner });
  return id;
}

/**
 * Makes a conversation's turn look accepted ten minutes ago — a job that was
 * lost. The interval is Postgres's own, so the reconciler's comparison never
 * meets a host clock.
 */
async function ageTurn(conversationId: string): Promise<void> {
  const aged = await kit.db.runtime.db
    .update(assistantTurns)
    .set({ createdAt: sql`now() - interval '10 minutes'` })
    .where(eq(assistantTurns.conversationId, conversationId))
    .returning({ id: assistantTurns.id });
  expect(aged.length).toBe(1);
}

/** The holds the turn rows of a conversation store, in micro-USD. */
async function storedHolds(
  conversationId: string,
): Promise<{ company: number; global: number }[]> {
  const rows = await kit.db.runtime.db
    .select({
      company: assistantTurns.companyReservedMicroUsd,
      global: assistantTurns.globalReservedMicroUsd,
    })
    .from(assistantTurns)
    .where(eq(assistantTurns.conversationId, conversationId));
  return rows;
}

/**
 * A real reservation against an in-memory budget, the way the route makes one,
 * and the release the store is handed for it.
 */
async function reserve(
  budgetStore: AiBudgetStore,
  /**
   * The turn this reservation is for. The same identity the accept below is
   * given: since SHO-572 a reservation is recorded under the turn's own id, so
   * a helper that reserved for a different turn than it accepted would be
   * releasing someone else's record.
   */
  turn: { readonly conversationId: string; readonly commandId: string },
): Promise<{
  readonly budgetHold: StaffAssistantBudgetHold;
  readonly releaseUnusedHold: () => Promise<void>;
}> {
  const identity = { kind: "chat" as const, ...turn };
  const reserved = await enforceStaffAssistantBudget({
    logger: kit.pipeline.logger,
    requestId: randomUUID(),
    userId: anna.userId,
    companyId: anna.companySelector,
    turn: identity,
    skipTurnLimit: true,
    budgetStore,
    limits: DEFAULT_STAFF_ASSISTANT_BUDGET_LIMITS,
  });
  return {
    budgetHold: reserved.hold,
    // Exactly what the route hands the store: a request gives back only a
    // reservation it took itself.
    releaseUnusedHold: () =>
      releaseUnusedReservation({
        logger: kit.pipeline.logger,
        requestId: randomUUID(),
        ref: { ...identity, companyId: anna.companySelector },
        reservation: reserved,
        budgetStore,
      }),
  };
}

async function reservedUsd(
  budgetStore: AiBudgetStore,
  kyivDate: string,
): Promise<{ company: number; global: number }> {
  return {
    company: await budgetStore.read(
      aiCompanyBudgetKey(anna.companySelector, kyivDate),
    ),
    global: await budgetStore.read(aiGlobalBudgetKey(kyivDate)),
  };
}

beforeAll(async () => {
  kit = await createTestKit();
}, 180_000);

afterAll(async () => {
  await kit.db.close();
});

describe("accepting a turn through the runtime", () => {
  it("stores a window the kit and a client both read, under ids the command names", async () => {
    const conversationId = await newConversation();
    const commandId = randomUUID();

    const accepted = await turns().accept({
      kind: "chat",
      conversationId: conversationId.toUpperCase(),
      commandId: commandId.toUpperCase(),
      bind: annaBind,
      text: "створи замовлення",
      sessionId: "session-anna",
      ...nothingReserved,
    });

    expect(accepted.outcome).toBe("accepted");
    const window = await kitFor().messages.read({
      conversationId,
      bind: annaBind,
    });
    expect(chatWindowSchema.parse(window)).toEqual(window);
    expect(assistantChatWindowSchema.safeParse(window).success).toBe(true);
    expect(window.messages).toEqual([
      {
        messageId: assistantTurnMessageId({ kind: "chat", commandId }, "user"),
        role: "user",
        createdAt: expect.any(String) as string,
        parts: [
          { kind: "text", text: "створи замовлення", status: "complete" },
        ],
        revision: 1,
      },
      {
        messageId: assistantTurnMessageId(
          { kind: "chat", commandId },
          "assistant",
        ),
        role: "assistant",
        createdAt: expect.any(String) as string,
        parts: [{ kind: "text", text: "", status: "streaming" }],
        revision: 1,
      },
    ]);
  });

  it("replays a repeated command in another casing, names the same job, and writes nothing", async () => {
    const conversationId = await newConversation();
    const commandId = randomUUID();
    const input = {
      kind: "chat" as const,
      conversationId,
      commandId: commandId.toUpperCase(),
      bind: annaBind,
      text: "привіт",
      sessionId: "session-anna",
      ...nothingReserved,
    };

    const first = await turns().accept(input);
    const again = await turns().accept({ ...input, commandId });

    expect(first.outcome).toBe("accepted");
    expect(again.outcome).toBe("replayed");
    if (
      (first.outcome !== "accepted" && first.outcome !== "replayed") ||
      (again.outcome !== "accepted" && again.outcome !== "replayed")
    ) {
      return;
    }
    expect(assistantTurnJobId(again.job)).toBe(assistantTurnJobId(first.job));
    expect(
      (await kitFor().messages.read({ conversationId, bind: annaBind }))
        .messages,
    ).toHaveLength(2);
  });

  it("stores an answer's earned card on its placeholder, and no person's message", async () => {
    const conversationId = await newConversation();
    const card = {
      kind: "card" as const,
      cardId: "order:1",
      revision: 1,
      type: "order",
      payload: { orderId: randomUUID() },
    };

    const accepted = await turns().accept({
      kind: "answer",
      conversationId,
      commandId: randomUUID(),
      bind: annaBind,
      earned: [card],
      sessionId: "session-anna",
      ...nothingReserved,
    });

    expect(accepted).toMatchObject({
      outcome: "accepted",
      turn: { kind: "answer", userMessageId: null },
    });
    const window = await kitFor().messages.read({
      conversationId,
      bind: annaBind,
    });
    expect(assistantChatWindowSchema.safeParse(window).success).toBe(true);
    expect(window.messages.map((message) => message.parts)).toEqual([
      [card, { kind: "text", text: "", status: "streaming" }],
    ]);
  });
});

/**
 * Every accept is preceded by a reservation. Only a stored turn keeps it — the
 * row then holds it for the worker or the reconciler. Every other outcome gives
 * it back, and leaves the stored turn's hold as it was.
 */
describe("the budget reservation of an accept", () => {
  const chat = (conversationId: string) => ({
    kind: "chat" as const,
    conversationId,
    bind: annaBind,
    text: "привіт",
    sessionId: "session-anna",
  });

  it("is kept by the accepted turn and released when another turn is busy", async () => {
    const budget = createMemoryAiBudgetStore();
    const conversationId = await newConversation();
    const acceptedCommandId = randomUUID();
    const busyCommandId = randomUUID();
    const first = await reserve(budget, {
      conversationId,
      commandId: acceptedCommandId,
    });

    const accepted = await turns().accept({
      ...chat(conversationId),
      commandId: acceptedCommandId,
      ...first,
    });
    const busy = await turns().accept({
      ...chat(conversationId),
      commandId: busyCommandId,
      ...(await reserve(budget, {
        conversationId,
        commandId: busyCommandId,
      })),
    });

    expect(accepted.outcome).toBe("accepted");
    expect(busy).toEqual({ outcome: "busy" });
    expect(await reservedUsd(budget, first.budgetHold.kyivDate)).toEqual({
      company: 0.1,
      global: 0.1,
    });
    expect(await storedHolds(conversationId)).toEqual([
      { company: 100_000, global: 100_000 },
    ]);
  });

  it("is released when the command replays", async () => {
    const budget = createMemoryAiBudgetStore();
    const conversationId = await newConversation();
    const commandId = randomUUID();
    const first = await reserve(budget, { conversationId, commandId });
    await turns().accept({ ...chat(conversationId), commandId, ...first });

    // The retry is the same turn, so it finds the first attempt's reservation
    // and takes none of its own (SHO-572) — and must not give back the one the
    // accepted row is holding.
    const replayed = await turns().accept({
      ...chat(conversationId),
      commandId,
      ...(await reserve(budget, { conversationId, commandId })),
    });

    expect(replayed.outcome).toBe("replayed");
    expect(await reservedUsd(budget, first.budgetHold.kyivDate)).toEqual({
      company: 0.1,
      global: 0.1,
    });
    expect(await storedHolds(conversationId)).toEqual([
      { company: 100_000, global: 100_000 },
    ]);
  });

  it("is released when the log belongs to another owner token", async () => {
    const budget = createMemoryAiBudgetStore();
    const conversationId = await newConversation();
    const acceptedCommandId = randomUUID();
    const first = await reserve(budget, {
      conversationId,
      commandId: acceptedCommandId,
    });
    const accepted = await turns().accept({
      ...chat(conversationId),
      commandId: acceptedCommandId,
      ...first,
    });
    if (accepted.outcome !== "accepted") {
      throw new Error(`expected accepted, got ${accepted.outcome}`);
    }
    await turns().finish(accepted.turn, "done");
    // Finishing took the hold off the row (SHO-561); the refusal below must
    // leave the row as the finish left it.
    const heldAfterFinish = await storedHolds(conversationId);
    expect(heldAfterFinish).toEqual([{ company: 0, global: 0 }]);

    const refusedCommandId = randomUUID();
    const refused = await turns().accept({
      ...chat(conversationId),
      bind: "someone-else",
      commandId: refusedCommandId,
      ...(await reserve(budget, {
        conversationId,
        commandId: refusedCommandId,
      })),
    });

    expect(refused).toEqual({ outcome: "wrong_owner" });
    expect(await reservedUsd(budget, first.budgetHold.kyivDate)).toEqual({
      company: 0.1,
      global: 0.1,
    });
    expect(await storedHolds(conversationId)).toEqual(heldAfterFinish);
  });

  it("is released when the accept is refused as a conflict", async () => {
    const budget = createMemoryAiBudgetStore();
    const conversationId = await newConversation();
    const commandId = randomUUID();
    const reserved = await reserve(budget, { conversationId, commandId });

    await expect(
      turns().accept({
        ...chat(conversationId),
        commandId,
        // Nothing was interrupted, so there is nothing to continue.
        continuesCommandId: randomUUID(),
        ...reserved,
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    expect(await reservedUsd(budget, reserved.budgetHold.kyivDate)).toEqual({
      company: 0,
      global: 0,
    });
    expect(await storedHolds(conversationId)).toEqual([]);
  });

  it("is released when the conversation is gone, and says nothing about it", async () => {
    const budget = createMemoryAiBudgetStore();
    const foreign = await newConversation({
      companyId: kitIdentities.companies.b,
      userId: kitIdentities.users.boris,
    });

    for (const conversationId of [foreign, randomUUID()]) {
      const commandId = randomUUID();
      const reserved = await reserve(budget, { conversationId, commandId });
      await expect(
        turns().accept({
          ...chat(conversationId),
          commandId,
          ...reserved,
        }),
      ).rejects.toBeInstanceOf(AssistantKitConversationGoneError);
      expect(await reservedUsd(budget, reserved.budgetHold.kyivDate)).toEqual({
        company: 0,
        global: 0,
      });
    }
    expect(await storedHolds(foreign)).toEqual([]);
  });
});

describe("the reconciler", () => {
  /**
   * The job payload is the turn's identity and nothing else, so a lost job is
   * rebuilt from the row. If the row's kind or command disagreed with what the
   * accept derived, one turn would have two job ids and run twice.
   */
  it("rebuilds from the row alone the job id the accept derived", async () => {
    const conversationId = await newConversation();
    const commandId = randomUUID();
    const request = {
      kind: "chat" as const,
      conversationId: conversationId.toUpperCase(),
      commandId: commandId.toUpperCase(),
    };
    const derivedAtAccept = assistantTurnJobId(request);

    const accepted = await turns().accept({
      ...request,
      bind: annaBind,
      text: "привіт",
      sessionId: "session-anna",
      ...nothingReserved,
    });
    if (accepted.outcome !== "accepted") {
      throw new Error(`expected accepted, got ${accepted.outcome}`);
    }
    // The job was lost and the turn never started.
    await ageTurn(conversationId);

    const stale = (
      await createPostgresAssistantStaleTurns({ pipeline: kit.pipeline }).list({
        requestId: randomUUID(),
      })
    ).find((row) => row.turn.conversationId === conversationId);

    expect(stale).toMatchObject({
      companyId: kitIdentities.companies.a,
      staleness: "queued_without_start",
      turn: { kind: "chat", conversationId, commandId },
    });
    expect(assistantTurnJobId(accepted.job)).toBe(derivedAtAccept);
    expect(stale === undefined ? null : assistantTurnJobId(stale.job)).toBe(
      derivedAtAccept,
    );
  });

  it("stops listing a turn once it has started and finished", async () => {
    const conversationId = await newConversation();
    const accepted = await turns().accept({
      kind: "chat",
      conversationId,
      commandId: randomUUID(),
      bind: annaBind,
      text: "привіт",
      sessionId: "session-anna",
      ...nothingReserved,
    });
    if (accepted.outcome !== "accepted") {
      throw new Error(`expected accepted, got ${accepted.outcome}`);
    }
    await ageTurn(conversationId);

    expect((await turns().start(accepted.turn)).outcome).toBe("started");
    expect(await turns().finish(accepted.turn, "interrupted")).toEqual({
      outcome: "finished",
      status: "interrupted",
      releasedHold: hold,
    });

    const listed = await createPostgresAssistantStaleTurns({
      pipeline: kit.pipeline,
    }).list({ requestId: randomUUID() });
    expect(
      listed.some((row) => row.turn.conversationId === conversationId),
    ).toBe(false);
  });
});

/**
 * What the worker will do with a job: read the turn it names, and run the
 * turn's actions as the caller that read produced — the row's user, company
 * and request, with no client IP (SHO-561).
 */
describe("the turn a job names", () => {
  it("runs as the row's user with no client IP, and hands its hold out once", async () => {
    const conversationId = await newConversation();
    const accepted = await turns().accept({
      kind: "chat",
      conversationId: conversationId.toUpperCase(),
      commandId: randomUUID().toUpperCase(),
      bind: annaBind,
      text: "привіт",
      sessionId: "session-anna",
      ...nothingReserved,
    });
    if (accepted.outcome !== "accepted") {
      throw new Error(`expected accepted, got ${accepted.outcome}`);
    }
    const forJob = createPostgresAssistantTurnForJob({
      pipeline: kit.pipeline,
    });

    const found = await forJob.read({
      job: accepted.job,
      requestId: randomUUID(),
    });

    expect(found).toMatchObject({
      companyId: kitIdentities.companies.a,
      turn: {
        kind: "chat",
        conversationId,
        commandId: accepted.turn.commandId,
      },
      status: "queued",
      deadlineAt: null,
      budgetHold: hold,
      continuationRootCommandId: accepted.turn.commandId,
      caller: {
        userId: anna.userId,
        companySelector: kitIdentities.companies.a,
        requestId: anna.requestId,
      },
    });
    if (found === null || found.caller === null) {
      throw new Error("expected a verified caller for a queued turn");
    }
    expect(found.caller).not.toHaveProperty("clientIp");

    // Core runs a staff action without an IP: the caller is enough.
    const asTurn = createPostgresAssistantTurnStore(
      { pipeline: kit.pipeline },
      found.caller,
    );
    expect((await asTurn.start(found.turn)).outcome).toBe("started");
    // A started turn gives no caller: only a queued turn is started from one.
    expect(
      await forJob.read({ job: accepted.job, requestId: randomUUID() }),
    ).toMatchObject({ status: "running", caller: null });
    expect(await asTurn.finish(found.turn, "done")).toEqual({
      outcome: "finished",
      status: "done",
      releasedHold: hold,
    });
    expect(await asTurn.finish(found.turn, "failed")).toEqual({
      outcome: "already_finished",
      status: "done",
      releasedHold: null,
    });
    expect(
      await forJob.read({ job: accepted.job, requestId: randomUUID() }),
    ).toMatchObject({
      status: "done",
      budgetHold: { companyReservedUsd: 0, globalReservedUsd: 0 },
      // A replayed job for an ended turn is no way to act as its author.
      caller: null,
    });
  });

  /**
   * The verified caller names a person, not a grant: core checks the author's
   * membership again on every action, IP or not, so a member removed after the
   * accept is refused at the turn's next action.
   */
  it("refuses the turn's actions once its author is no longer a member", async () => {
    const clerkId = randomUUID();
    await kit.db.runtime.db.insert(user).values({
      id: clerkId,
      name: "Leaving Clerk",
      email: `${clerkId}@assistant-turn-store.test`,
    });
    await kit.db.runtime.db.insert(companyMembers).values({
      companyId: kitIdentities.companies.a,
      userId: clerkId,
      role: "employee",
      permissions: { granted: ["assistant:use"], denied: [] },
    });
    const clerk = {
      userId: clerkId,
      companySelector: kitIdentities.companies.a,
      requestId: randomUUID(),
    };
    const forJob = createPostgresAssistantTurnForJob({
      pipeline: kit.pipeline,
    });

    const acceptAndRead = async () => {
      const conversationId = await newConversation({
        companyId: kitIdentities.companies.a,
        userId: clerkId,
      });
      const accepted = await createPostgresAssistantTurnStore(
        { pipeline: kit.pipeline },
        clerk,
      ).accept({
        kind: "chat",
        conversationId,
        commandId: randomUUID(),
        bind: `${clerkId}:${kitIdentities.companies.a}`,
        text: "привіт",
        sessionId: "session-clerk",
        ...nothingReserved,
      });
      if (accepted.outcome !== "accepted") {
        throw new Error(`expected accepted, got ${accepted.outcome}`);
      }
      const found = await forJob.read({
        job: accepted.job,
        requestId: randomUUID(),
      });
      if (found === null || found.caller === null) {
        throw new Error("expected a verified caller for a queued turn");
      }
      return {
        job: accepted.job,
        turn: found.turn,
        asTurn: createPostgresAssistantTurnStore(
          { pipeline: kit.pipeline },
          found.caller,
        ),
      };
    };
    const queued = await acceptAndRead();
    const running = await acceptAndRead();
    expect((await running.asTurn.start(running.turn)).outcome).toBe("started");

    const removed = await kit.db.runtime.db
      .delete(companyMembers)
      .where(eq(companyMembers.userId, clerkId))
      .returning({ id: companyMembers.id });
    expect(removed.length).toBe(1);

    await expect(queued.asTurn.start(queued.turn)).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
    await expect(
      running.asTurn.finish(running.turn, "done"),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(
      await forJob.read({ job: queued.job, requestId: randomUUID() }),
    ).toMatchObject({ status: "queued", budgetHold: hold });
    expect(
      await forJob.read({ job: running.job, requestId: randomUUID() }),
    ).toMatchObject({ status: "running", budgetHold: hold });
  });

  it("finds nothing for a job nobody accepted", async () => {
    expect(
      await createPostgresAssistantTurnForJob({ pipeline: kit.pipeline }).read({
        job: {
          version: 1,
          kind: "chat",
          conversationId: randomUUID(),
          commandId: randomUUID(),
        },
        requestId: randomUUID(),
      }),
    ).toBeNull();
  });
});
