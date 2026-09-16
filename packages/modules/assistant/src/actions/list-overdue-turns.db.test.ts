import { randomUUID } from "node:crypto";

import { executeAction } from "@showzy/core";
import { CoreInvariantError, ValidationError } from "@showzy/core/errors";
import {
  createTestKit,
  crossTenantSuite,
  isolationCase,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import {
  assistantConversations,
  assistantTurns,
} from "@showzy/db/schema/assistant";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { acceptTurn } from "./accept-turn.js";
import { listOverdueTurns } from "./list-overdue-turns.js";
import { startTurn } from "./start-turn.js";

const HOLD = {
  companyReservedMicroUsd: 100_000,
  globalReservedMicroUsd: 50_000,
  kyivDate: "2026-09-15",
};

const anna: Owner = {
  userId: kitIdentities.users.anna,
  companyId: kitIdentities.companies.a,
  bind: "anna:company-a",
};
const boris: Owner = {
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
  readonly companyId: string;
  readonly conversationId: string;
  readonly kind: "chat" | "answer";
  readonly commandId: string;
}

let kit: TestKit;

beforeAll(async () => {
  kit = await createTestKit();
}, 180_000);

afterAll(async () => {
  await kit.db.close();
});

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

async function accepted(owner: Owner = anna): Promise<Turn> {
  const conversationId = randomUUID();
  const commandId = randomUUID();
  const userMessageId = randomUUID();
  const placeholderMessageId = randomUUID();
  await kit.db.runtime.db.insert(assistantConversations).values({
    id: conversationId,
    companyId: owner.companyId,
    userId: owner.userId,
  });
  await kit.invoke(
    acceptTurn,
    {
      conversationId,
      kind: "chat",
      commandId,
      sessionId: "session",
      userMessage: {
        messageId: userMessageId,
        bind: owner.bind,
        message: message(userMessageId, "user"),
      },
      placeholder: {
        messageId: placeholderMessageId,
        bind: owner.bind,
        message: message(placeholderMessageId, "assistant"),
      },
      budgetHold: HOLD,
      history: { kind: "append", message: { role: "user", content: "hi" } },
    },
    { userId: owner.userId, companyId: owner.companyId },
  );
  return {
    companyId: owner.companyId,
    conversationId,
    kind: "chat",
    commandId,
  };
}

async function age(turn: Turn, interval: string): Promise<Turn> {
  await kit.db.runtime.db
    .update(assistantTurns)
    .set({ createdAt: sql`now() - ${interval}::interval` })
    .where(eq(assistantTurns.conversationId, turn.conversationId));
  return turn;
}

async function started(
  turn: Turn,
  deadline: "passed" | "ahead",
  owner: Owner = anna,
): Promise<Turn> {
  await kit.invoke(
    startTurn,
    {
      conversationId: turn.conversationId,
      kind: turn.kind,
      commandId: turn.commandId,
      timeoutMs: 180_000,
    },
    { userId: owner.userId, companyId: owner.companyId },
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

function listAs(
  input: unknown,
  scope: "global" | "tenant" = "global",
): Promise<{ turns: readonly Turn[]; next: Turn | null }> {
  const requestId = randomUUID();
  return executeAction(kit.pipeline, {
    action: listOverdueTurns,
    input,
    request: { requestId, correlationId: requestId, channel: "system" },
    principal: {
      mode: "system",
      serviceName: "assistant.sweepOverdueTurns",
      scope:
        scope === "global"
          ? { scope: "global" }
          : { scope: "tenant", companyId: anna.companyId },
    },
  });
}

async function everyPage(limit: number): Promise<Turn[]> {
  const seen: Turn[] = [];
  let after: Turn | null = null;
  for (;;) {
    const page: { turns: readonly Turn[]; next: Turn | null } = await listAs({
      limit,
      ...(after === null ? {} : { after }),
    });
    seen.push(...page.turns);
    if (page.next === null) {
      return seen;
    }
    after = page.next;
  }
}

function key(turn: Turn): string {
  return `${turn.companyId}:${turn.conversationId}:${turn.kind}:${turn.commandId}`;
}

let foreignOverdue: Turn;

beforeAll(async () => {
  await age(await accepted(anna), "16 minutes");
  foreignOverdue = await age(await accepted(boris), "16 minutes");
}, 180_000);

crossTenantSuite(
  () => kit,
  [
    isolationCase(
      listOverdueTurns,
      { input: { limit: 10 } },
      { input: { limit: 10 } },
    ),
  ],
);

describe("the overdue discovery read", () => {
  it("returns overdue turns of every company, and neither a fresh queued turn nor a running one inside its deadline", async () => {
    const queuedFresh = await accepted(anna);
    const queuedOverdue = await age(await accepted(anna), "16 minutes");
    const runningAhead = await started(
      await age(await accepted(anna), "20 minutes"),
      "ahead",
    );
    const runningPast = await started(
      await age(await accepted(boris), "20 minutes"),
      "passed",
      boris,
    );

    const found = new Set((await everyPage(100)).map(key));

    expect(found.has(key(queuedOverdue))).toBe(true);
    expect(found.has(key(runningPast))).toBe(true);
    expect(found.has(key(foreignOverdue))).toBe(true);
    expect(found.has(key(queuedFresh))).toBe(false);
    expect(found.has(key(runningAhead))).toBe(false);
  });

  it("pages in a stable order: no turn is served twice, none is skipped, and next is null on the last page", async () => {
    const mine = [
      await age(await accepted(anna), "16 minutes"),
      await age(await accepted(anna), "16 minutes"),
      await age(await accepted(boris), "16 minutes"),
    ];

    const oneByOne = await everyPage(1);
    const wholesale = await everyPage(100);

    expect(oneByOne.map(key)).toEqual(wholesale.map(key));
    expect(new Set(oneByOne.map(key)).size).toBe(oneByOne.length);
    for (const turn of mine) {
      expect(oneByOne.filter((seen) => key(seen) === key(turn))).toHaveLength(
        1,
      );
    }
    const sorted = [...wholesale].map(key).sort();
    expect(wholesale.map(key)).toEqual(sorted);
    const last = await listAs({ limit: 100 });
    expect(last.next).toBeNull();
  });

  it("carries only the company and the identity of a turn", async () => {
    const turn = await age(await accepted(anna), "16 minutes");

    const page = await listAs({ limit: 100 });

    const found = page.turns.find((seen) => key(seen) === key(turn));
    expect(found).toEqual({
      companyId: turn.companyId,
      conversationId: turn.conversationId,
      kind: "chat",
      commandId: turn.commandId,
    });
  });

  it("is refused a limit past the batch a tenant sweep accepts, and refused to a tenant-scoped caller", async () => {
    await expect(listAs({ limit: 101 })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(listAs({ limit: 0 })).rejects.toBeInstanceOf(ValidationError);
    await expect(
      listAs({ limit: 10, after: { limit: 1 } }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(listAs({ limit: 10 }, "tenant")).rejects.toBeInstanceOf(
      CoreInvariantError,
    );
    await expect(
      executeAction(kit.pipeline, {
        action: listOverdueTurns,
        input: { limit: 10 },
        request: {
          requestId: randomUUID(),
          correlationId: randomUUID(),
          channel: "ui",
        },
        principal: {
          mode: "staff",
          session: { userId: anna.userId },
          companySelector: anna.companyId,
        },
      }),
    ).rejects.toBeInstanceOf(CoreInvariantError);
  });
});
