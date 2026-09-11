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
  createPostgresAssistantTurnStore,
  enforceStaffAssistantBudget,
  releaseStaffAssistantBudgetHold,
  type AiBudgetStore,
  type StaffAssistantBudgetHold,
} from "@showzy/assistant-runtime";
import { ConflictError } from "@showzy/core/errors";
import {
  createTestKit,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import { assistantConversations } from "@showzy/db/schema/assistant";
import { assistantChatWindowSchema } from "@showzy/validation/assistant-chat";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createActionRegistry } from "../composition.js";
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
  const aged = await kit.db.admin.query(
    "update assistant_turns set created_at = now() - interval '10 minutes' where conversation_id = $1",
    [conversationId],
  );
  expect(aged.rowCount).toBe(1);
}

/** The holds the turn rows of a conversation store, in micro-USD. */
async function storedHolds(
  conversationId: string,
): Promise<{ company: number; global: number }[]> {
  const rows = await kit.db.admin.query<{ company: number; global: number }>(
    "select company_reserved_micro_usd::int as company, global_reserved_micro_usd::int as global from assistant_turns where conversation_id = $1",
    [conversationId],
  );
  return rows.rows;
}

/**
 * A real reservation against an in-memory budget, the way the route makes one,
 * and the release the store is handed for it.
 */
async function reserve(budgetStore: AiBudgetStore): Promise<{
  readonly budgetHold: StaffAssistantBudgetHold;
  readonly releaseUnusedHold: () => Promise<void>;
}> {
  const reserved = await enforceStaffAssistantBudget({
    logger: kit.pipeline.logger,
    requestId: randomUUID(),
    userId: anna.userId,
    companyId: anna.companySelector,
    skipTurnLimit: true,
    budgetStore,
    limits: DEFAULT_STAFF_ASSISTANT_BUDGET_LIMITS,
  });
  return {
    budgetHold: reserved,
    releaseUnusedHold: () =>
      releaseStaffAssistantBudgetHold({
        logger: kit.pipeline.logger,
        requestId: randomUUID(),
        companyId: anna.companySelector,
        hold: reserved,
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
      },
      {
        messageId: assistantTurnMessageId(
          { kind: "chat", commandId },
          "assistant",
        ),
        role: "assistant",
        createdAt: expect.any(String) as string,
        parts: [{ kind: "text", text: "", status: "streaming" }],
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
    const first = await reserve(budget);

    const accepted = await turns().accept({
      ...chat(conversationId),
      commandId: randomUUID(),
      ...first,
    });
    const busy = await turns().accept({
      ...chat(conversationId),
      commandId: randomUUID(),
      ...(await reserve(budget)),
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
    const first = await reserve(budget);
    await turns().accept({ ...chat(conversationId), commandId, ...first });

    const replayed = await turns().accept({
      ...chat(conversationId),
      commandId,
      ...(await reserve(budget)),
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
    const first = await reserve(budget);
    const accepted = await turns().accept({
      ...chat(conversationId),
      commandId: randomUUID(),
      ...first,
    });
    if (accepted.outcome !== "accepted") {
      throw new Error(`expected accepted, got ${accepted.outcome}`);
    }
    await turns().finish(accepted.turn, "done");

    const refused = await turns().accept({
      ...chat(conversationId),
      bind: "someone-else",
      commandId: randomUUID(),
      ...(await reserve(budget)),
    });

    expect(refused).toEqual({ outcome: "wrong_owner" });
    expect(await reservedUsd(budget, first.budgetHold.kyivDate)).toEqual({
      company: 0.1,
      global: 0.1,
    });
    expect(await storedHolds(conversationId)).toEqual([
      { company: 100_000, global: 100_000 },
    ]);
  });

  it("is released when the accept is refused as a conflict", async () => {
    const budget = createMemoryAiBudgetStore();
    const conversationId = await newConversation();
    const reserved = await reserve(budget);

    await expect(
      turns().accept({
        ...chat(conversationId),
        commandId: randomUUID(),
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
      const reserved = await reserve(budget);
      await expect(
        turns().accept({
          ...chat(conversationId),
          commandId: randomUUID(),
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
      budgetHold: hold,
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
    });

    const listed = await createPostgresAssistantStaleTurns({
      pipeline: kit.pipeline,
    }).list({ requestId: randomUUID() });
    expect(
      listed.some((row) => row.turn.conversationId === conversationId),
    ).toBe(false);
  });
});
