import { randomUUID } from "node:crypto";

import { sweepOverdueTurns } from "@showzy/assistant";
import type { ImplementedAction } from "@showzy/core";
import { createCapturingLogger } from "@showzy/core/testing";
import { describe, expect, it } from "vitest";

import {
  sweepOverdueAssistantTurns,
  type AssistantSweepAttempt,
} from "./assistant-overdue-sweep.js";
import type {
  AssistantRecoveredTurn,
  AssistantTurnRecovery,
} from "./assistant-turn-recovery.js";

const logger = createCapturingLogger().logger;

function turnOf(companyId: string) {
  return {
    companyId,
    conversationId: randomUUID(),
    kind: "chat" as const,
    commandId: randomUUID(),
  };
}

function storedHold() {
  return {
    companyReservedMicroUsd: 250_000,
    globalReservedMicroUsd: 125_000,
    kyivDate: "2026-09-16",
  };
}

function endedOf(turn: ReturnType<typeof turnOf>) {
  return {
    conversationId: turn.conversationId,
    kind: turn.kind,
    commandId: turn.commandId,
    placeholderMessageId: randomUUID(),
    from: "queued" as const,
    endReason: "not_started" as const,
    releasedHold: storedHold(),
  };
}

interface Page {
  readonly turns: readonly ReturnType<typeof turnOf>[];
  readonly next: ReturnType<typeof turnOf> | null;
}

function page(
  turns: readonly ReturnType<typeof turnOf>[],
  full: boolean,
): Page {
  const last = turns.at(-1);
  return { turns, next: full && last !== undefined ? last : null };
}

interface Recorded {
  readonly listed: unknown[];
  readonly swept: { companyId: string | undefined; turns: unknown }[];
}

function attemptOf(
  pages: readonly Page[],
  sweep: (
    companyId: string,
    turns: readonly { commandId: string }[],
  ) => unknown,
  signal: AbortSignal = new AbortController().signal,
): { attempt: AssistantSweepAttempt; recorded: Recorded } {
  const recorded: Recorded = { listed: [], swept: [] };
  let served = 0;
  const attempt: AssistantSweepAttempt = {
    envelope: { requestId: "request-1" },
    signal,
    run: (action: ImplementedAction, input: unknown, companyId?: string) => {
      if (action.contract.name === "assistant.listOverdueTurns") {
        recorded.listed.push(input);
        const next = pages[served] ?? { turns: [], next: null };
        served += 1;
        return Promise.resolve(next);
      }
      const { turns } = sweepOverdueTurns.contract.input.parse(input);
      recorded.swept.push({ companyId, turns });
      if (companyId === undefined) {
        throw new Error("a tenant sweep needs a company");
      }
      return Promise.resolve(sweep(companyId, turns));
    },
  };
  return { attempt, recorded };
}

function recoveries(): {
  recover: AssistantTurnRecovery;
  taken: AssistantRecoveredTurn[];
} {
  const taken: AssistantRecoveredTurn[] = [];
  return {
    taken,
    recover: (ended) => {
      taken.push(ended);
      return Promise.resolve();
    },
  };
}

describe("the overdue sweep executor", () => {
  it("drains page after page, keyed on the last identity, and sweeps each company once", async () => {
    const companyA = randomUUID();
    const companyB = randomUUID();
    const companyC = randomUUID();
    const first = [turnOf(companyA), turnOf(companyA), turnOf(companyB)];
    const second = [turnOf(companyC)];
    const { attempt, recorded } = attemptOf(
      [page(first, true), page(second, false)],
      (_companyId, turns) => ({
        ended: turns.map((turn) => ({
          ...endedOf(turnOf(companyA)),
          commandId: turn.commandId,
        })),
      }),
    );
    const { recover, taken } = recoveries();

    const summary = await sweepOverdueAssistantTurns(attempt, {
      recover,
      logger,
      pageSize: 3,
    });

    expect(summary).toEqual({
      pages: 2,
      ended: 4,
      failedCompanies: 0,
      failedTurns: 0,
    });
    expect(recorded.listed).toEqual([
      { limit: 3 },
      { limit: 3, after: first[2] },
    ]);
    expect(recorded.swept.map(({ companyId }) => companyId)).toEqual([
      companyA,
      companyB,
      companyC,
    ]);
    expect(recorded.swept[0]?.turns).toHaveLength(2);
    expect(taken.map((ended) => ended.companyId)).toEqual([
      companyA,
      companyA,
      companyB,
      companyC,
    ]);
    expect(taken[0]?.releasedHold).toEqual({
      companyReservedUsd: 0.25,
      globalReservedUsd: 0.125,
      kyivDate: "2026-09-16",
    });
    expect(taken[0]?.from).toBe("queued");
    expect(taken[0]?.endReason).toBe("not_started");
  });

  it("carries on with the other companies and the next page when one company's sweep fails", async () => {
    const companyA = randomUUID();
    const companyB = randomUUID();
    const companyC = randomUUID();
    const first = [turnOf(companyA), turnOf(companyB)];
    const second = [turnOf(companyC)];
    const { attempt, recorded } = attemptOf(
      [page(first, true), page(second, false)],
      (companyId, turns) => {
        if (companyId === companyA) {
          throw new Error("company a is unreachable");
        }
        return {
          ended: turns.map((turn) => ({
            ...endedOf(turnOf(companyId)),
            commandId: turn.commandId,
          })),
        };
      },
    );
    const { recover, taken } = recoveries();

    const summary = await sweepOverdueAssistantTurns(attempt, {
      recover,
      logger,
      pageSize: 2,
    });

    expect(summary).toEqual({
      pages: 2,
      ended: 2,
      failedCompanies: 1,
      failedTurns: 0,
    });
    expect(recorded.swept.map(({ companyId }) => companyId)).toEqual([
      companyA,
      companyB,
      companyC,
    ]);
    expect(taken.map((ended) => ended.companyId)).toEqual([companyB, companyC]);
  });

  it("counts a turn whose own recovery fails, recovers its siblings and the other companies, and still returns the pass", async () => {
    const companyA = randomUUID();
    const companyB = randomUUID();
    const doomed = turnOf(companyA);
    const sibling = turnOf(companyA);
    const first = [doomed, sibling, turnOf(companyB)];
    const { attempt } = attemptOf([page(first, false)], (companyId, turns) => ({
      ended: turns.map((turn) => ({
        ...endedOf(turnOf(companyId)),
        commandId: turn.commandId,
      })),
    }));
    const taken: string[] = [];

    const summary = await sweepOverdueAssistantTurns(attempt, {
      logger,
      recover: (ended) => {
        if (ended.turn.commandId === doomed.commandId) {
          return Promise.reject(new Error("recovery failed"));
        }
        taken.push(ended.turn.commandId);
        return Promise.resolve();
      },
    });

    expect(summary).toEqual({
      pages: 1,
      ended: 3,
      failedCompanies: 0,
      failedTurns: 1,
    });
    expect(taken).toEqual([sibling.commandId, first[2]?.commandId]);
  });

  it("stops after the page it is in once the attempt is abandoned", async () => {
    const companyA = randomUUID();
    const controller = new AbortController();
    const { attempt, recorded } = attemptOf(
      [
        page([turnOf(companyA)], true),
        page([turnOf(companyA)], true),
        page([turnOf(companyA)], true),
      ],
      (companyId, turns) => {
        controller.abort();
        return {
          ended: turns.map((turn) => ({
            ...endedOf(turnOf(companyId)),
            commandId: turn.commandId,
          })),
        };
      },
      controller.signal,
    );
    const { recover } = recoveries();

    const summary = await sweepOverdueAssistantTurns(attempt, {
      recover,
      logger,
      pageSize: 1,
    });

    expect(summary).toMatchObject({ pages: 1, ended: 1 });
    expect(recorded.listed).toHaveLength(1);
  });
});
