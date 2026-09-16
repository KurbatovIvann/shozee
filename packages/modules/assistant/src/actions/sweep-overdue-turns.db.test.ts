import { randomUUID } from "node:crypto";

import { executeAction } from "@showzy/core";
import {
  CoreInvariantError,
  NotFoundError,
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
import {
  assistantConversations,
  assistantTurns,
} from "@showzy/db/schema/assistant";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { acceptTurn } from "./accept-turn.js";
import { finishTurn } from "./finish-turn.js";
import { readLatestInterruptedTurn } from "./read-latest-interrupted-turn.js";
import { startTurn } from "./start-turn.js";
import { sweepOverdueTurns } from "./sweep-overdue-turns.js";

const HOLD = {
  companyReservedMicroUsd: 100_000,
  globalReservedMicroUsd: 50_000,
  kyivDate: "2026-09-15",
};

const anna = {
  userId: kitIdentities.users.anna,
  companyId: kitIdentities.companies.a,
  bind: "anna:company-a",
};
const boris = {
  userId: kitIdentities.users.boris,
  companyId: kitIdentities.companies.b,
  bind: "boris:company-b",
};
interface Owner {
  readonly userId: string;
  readonly companyId: string;
  readonly bind: string;
}

interface Turn {
  readonly conversationId: string;
  readonly kind: "chat" | "answer";
  readonly commandId: string;
  readonly placeholderMessageId: string;
}

let kit: TestKit;

beforeAll(async () => {
  kit = await createTestKit();
}, 180_000);

afterAll(async () => {
  await kit.db.close();
});

function actorOf(owner: Owner) {
  return { userId: owner.userId, companyId: owner.companyId };
}

function message(messageId: string, role: "user" | "assistant") {
  return {
    messageId,
    role,
    createdAt: "2026-09-15T10:00:00.000Z",
    parts: [
      {
        kind: "text",
        text: "",
        status: role === "user" ? "complete" : "streaming",
      },
    ],
  };
}

async function accepted(
  owner: Owner = anna,
  kind: "chat" | "answer" = "chat",
  ids: { conversationId: string; commandId: string } = {
    conversationId: randomUUID(),
    commandId: randomUUID(),
  },
): Promise<Turn> {
  const { conversationId, commandId } = ids;
  await kit.db.runtime.db.insert(assistantConversations).values({
    id: conversationId,
    companyId: owner.companyId,
    userId: owner.userId,
  });
  const placeholderMessageId = randomUUID();
  const userMessageId = randomUUID();
  await kit.invoke(
    acceptTurn,
    {
      conversationId,
      kind,
      commandId,
      sessionId: "session",
      ...(kind === "chat"
        ? {
            userMessage: {
              messageId: userMessageId,
              bind: owner.bind,
              message: message(userMessageId, "user"),
            },
            history: {
              kind: "append" as const,
              message: { role: "user", content: "hi" },
            },
          }
        : { history: { kind: "replace" as const, history: [] } }),
      placeholder: {
        messageId: placeholderMessageId,
        bind: owner.bind,
        message: message(placeholderMessageId, "assistant"),
      },
      budgetHold: HOLD,
    },
    actorOf(owner),
  );
  return { conversationId, kind, commandId, placeholderMessageId };
}

function identity(turn: Turn) {
  return {
    conversationId: turn.conversationId,
    kind: turn.kind,
    commandId: turn.commandId,
  };
}

async function acceptedAgo(
  age: string,
  owner: Owner = anna,
  kind: "chat" | "answer" = "chat",
  ids?: { conversationId: string; commandId: string },
) {
  const turn = await accepted(owner, kind, ids);
  await kit.db.runtime.db
    .update(assistantTurns)
    .set({ createdAt: sql`now() - ${age}::interval` })
    .where(eq(assistantTurns.conversationId, turn.conversationId));
  return turn;
}

async function running(
  deadline: "passed" | "ahead",
  owner: Owner = anna,
): Promise<Turn> {
  const turn = await acceptedAgo("20 minutes", owner);
  await kit.invoke(
    startTurn,
    { ...identity(turn), timeoutMs: 180_000 },
    actorOf(owner),
  );
  await kit.db.runtime.db
    .update(assistantTurns)
    .set({
      deadlineAt:
        deadline === "passed"
          ? sql`now() - interval '1 second'`
          : sql`now() + interval '1 hour'`,
    })
    .where(eq(assistantTurns.conversationId, turn.conversationId));
  return turn;
}

function systemRequest(requestId: string = randomUUID()) {
  return { requestId, correlationId: requestId, channel: "system" as const };
}

function sweepAs(
  companyId: string,
  turns: readonly Turn[] | readonly unknown[],
) {
  return executeAction(kit.pipeline, {
    action: sweepOverdueTurns,
    input: {
      turns: turns.map((turn) => (isTurn(turn) ? identity(turn) : turn)),
    },
    request: systemRequest(),
    principal: {
      mode: "system",
      serviceName: "assistant.sweepOverdueTurns",
      scope: { scope: "tenant", companyId },
    },
  });
}

function isTurn(value: unknown): value is Turn {
  return (
    typeof value === "object" &&
    value !== null &&
    "placeholderMessageId" in value
  );
}

async function row(turn: Turn) {
  const [stored] = await kit.db.runtime.db
    .select()
    .from(assistantTurns)
    .where(eq(assistantTurns.conversationId, turn.conversationId));
  return stored;
}

const isolation = {
  own: {
    conversationId: randomUUID(),
    kind: "chat" as const,
    commandId: randomUUID(),
  },
  foreign: {
    conversationId: randomUUID(),
    kind: "chat" as const,
    commandId: randomUUID(),
  },
};

beforeAll(async () => {
  await acceptedAgo("16 minutes", anna, "chat", isolation.own);
  await acceptedAgo("16 minutes", boris, "chat", isolation.foreign);
}, 180_000);

crossTenantSuite(
  () => kit,
  [
    isolationCase(
      sweepOverdueTurns,
      { input: { turns: [isolation.own] } },
      { input: { turns: [isolation.foreign] } },
    ),
  ],
);

describe("the start deadline and the running deadline", () => {
  it("are distinct: a queued turn is overdue fifteen minutes after its accept, a running one only past its own deadline", async () => {
    const queuedInside = await acceptedAgo("14 minutes");
    const queuedPast = await acceptedAgo("16 minutes");
    const runningInside = await running("ahead");
    const runningPast = await running("passed");
    const fixtures = [queuedInside, queuedPast, runningInside, runningPast];

    const swept = await sweepAs(anna.companyId, fixtures);

    expect(
      [...swept.ended].sort((a, b) =>
        a.conversationId.localeCompare(b.conversationId),
      ),
    ).toEqual(
      [
        {
          ...identity(queuedPast),
          placeholderMessageId: queuedPast.placeholderMessageId,
          from: "queued",
          endReason: "not_started",
          releasedHold: HOLD,
        },
        {
          ...identity(runningPast),
          placeholderMessageId: runningPast.placeholderMessageId,
          from: "running",
          endReason: "timeout",
          releasedHold: HOLD,
        },
      ].sort((a, b) => a.conversationId.localeCompare(b.conversationId)),
    );
    await expect(row(queuedInside)).resolves.toMatchObject({
      status: "queued",
      endReason: null,
    });
    await expect(row(runningInside)).resolves.toMatchObject({
      status: "running",
      endReason: null,
    });
    await expect(row(queuedPast)).resolves.toMatchObject({
      status: "interrupted",
      endReason: "not_started",
      startedAt: null,
      sessionId: null,
      companyReservedMicroUsd: 0,
      globalReservedMicroUsd: 0,
    });
    await expect(row(runningPast)).resolves.toMatchObject({
      status: "interrupted",
      endReason: "timeout",
    });
  });
});

describe("sweeping overdue turns", () => {
  it("audits the pass under its own request id, not a shared name", async () => {
    const turn = await acceptedAgo("16 minutes");
    const requestId = randomUUID();

    await executeAction(kit.pipeline, {
      action: sweepOverdueTurns,
      input: { turns: [identity(turn)] },
      request: systemRequest(requestId),
      principal: {
        mode: "system",
        serviceName: "assistant.sweepOverdueTurns",
        scope: { scope: "tenant", companyId: anna.companyId },
      },
    });

    const rows = await kit.db.runtime.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.requestId, requestId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "assistant.sweepOverdueTurns",
      companyId: anna.companyId,
      targetType: "assistant_turns_sweep",
      targetId: requestId,
      outcome: "ok",
    });
  });

  it("hands a hold out once: a replay of the batch ends nothing", async () => {
    const turn = await acceptedAgo("16 minutes");

    const first = await sweepAs(anna.companyId, [turn, turn]);
    const second = await sweepAs(anna.companyId, [turn]);

    expect(first.ended).toHaveLength(1);
    expect(second).toEqual({ ended: [] });
  });

  it("gives the hold to exactly one of two sweeps that race", async () => {
    const turn = await acceptedAgo("16 minutes");

    const results = await Promise.all([
      sweepAs(anna.companyId, [turn]),
      sweepAs(anna.companyId, [turn]),
    ]);

    expect(results.flatMap((result) => result.ended)).toHaveLength(1);
  });

  it("succeeds with nothing for an empty batch and for own rows that no longer need recovery", async () => {
    const finished = await acceptedAgo("16 minutes");
    await kit.invoke(
      finishTurn,
      { ...identity(finished), status: "done" },
      actorOf(anna),
    );
    const fresh = await accepted();

    await expect(sweepAs(anna.companyId, [])).resolves.toEqual({ ended: [] });
    await expect(sweepAs(anna.companyId, [finished, fresh])).resolves.toEqual({
      ended: [],
    });
    await expect(row(finished)).resolves.toMatchObject({
      status: "done",
      endReason: null,
    });
    await expect(row(fresh)).resolves.toMatchObject({ status: "queued" });
  });

  it("fails closed for another company's identity and ends none of its own batch", async () => {
    const own = await acceptedAgo("16 minutes");
    const foreign = await acceptedAgo("16 minutes", boris);

    await expect(
      sweepAs(anna.companyId, [own, foreign]),
    ).rejects.toBeInstanceOf(NotFoundError);

    await expect(row(own)).resolves.toMatchObject({ status: "queued" });
    await expect(row(foreign)).resolves.toMatchObject({ status: "queued" });
  });

  it("leaves company B untouched by company A's pass", async () => {
    const own = await acceptedAgo("16 minutes");
    const foreign = await acceptedAgo("16 minutes", boris);

    await sweepAs(anna.companyId, [own]);

    await expect(row(own)).resolves.toMatchObject({ status: "interrupted" });
    await expect(row(foreign)).resolves.toMatchObject({
      status: "queued",
      endReason: null,
    });
  });

  it("refuses a staff caller and a global system caller, and a company in the input", async () => {
    const turn = await acceptedAgo("16 minutes");

    await expect(
      executeAction(kit.pipeline, {
        action: sweepOverdueTurns,
        input: { turns: [identity(turn)] },
        request: { ...systemRequest(), channel: "ui" as const },
        principal: {
          mode: "staff",
          session: { userId: anna.userId },
          companySelector: anna.companyId,
        },
      }),
    ).rejects.toBeInstanceOf(CoreInvariantError);
    await expect(
      executeAction(kit.pipeline, {
        action: sweepOverdueTurns,
        input: { turns: [identity(turn)] },
        request: systemRequest(),
        principal: {
          mode: "system",
          serviceName: "assistant.sweepOverdueTurns",
          scope: { scope: "global" },
        },
      }),
    ).rejects.toBeInstanceOf(CoreInvariantError);
    await expect(
      sweepAs(anna.companyId, [
        { ...identity(turn), companyId: anna.companyId },
      ]),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(row(turn)).resolves.toMatchObject({ status: "queued" });
  });

  it("stores not_started on an answer turn and a snapshot read returns it with the continuation's command", async () => {
    const turn = await acceptedAgo("16 minutes", anna, "answer");

    await sweepAs(anna.companyId, [turn]);

    await expect(
      kit.invoke(
        readLatestInterruptedTurn,
        { conversationId: turn.conversationId },
        actorOf(anna),
      ),
    ).resolves.toEqual({ commandId: turn.commandId, endReason: "not_started" });
  });
});

describe("the stored end reason", () => {
  it("belongs only to an interrupted turn, and not_started only to one that never started", async () => {
    const queued = await accepted();
    const started = await running("passed");
    await kit.invoke(
      finishTurn,
      { ...identity(started), status: "interrupted" },
      actorOf(anna),
    );

    await expect(
      kit.db.runtime.db
        .update(assistantTurns)
        .set({ endReason: "timeout" })
        .where(eq(assistantTurns.conversationId, queued.conversationId)),
    ).rejects.toThrow();
    await expect(
      kit.db.runtime.db
        .update(assistantTurns)
        .set({ endReason: "not_started" })
        .where(eq(assistantTurns.conversationId, started.conversationId)),
    ).rejects.toThrow();
    await expect(row(started)).resolves.toMatchObject({
      status: "interrupted",
      endReason: null,
    });
  });
});
