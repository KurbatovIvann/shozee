import {
  ASSISTANT_TURN_FINAL_STATUSES,
  ASSISTANT_TURN_KINDS,
  ASSISTANT_TURN_STATUSES,
} from "@showzy/db/schema/assistant";
import { ASSISTANT_TURN_RESERVATION_MAX_MICRO_USD } from "@showzy/validation/assistant-budget";
import { describe, expect, it } from "vitest";

import {
  acceptTurnContract,
  acceptTurnInputSchema,
} from "./accept-turn.contract.js";
import { STAFF_CONVERSATION_AUTHOR_INVARIANT } from "./conversation-view.contract.js";
import {
  finishTurnContract,
  finishTurnInputSchema,
  finishTurnOutputSchema,
} from "./finish-turn.contract.js";
import {
  interruptTurnContract,
  interruptTurnInputSchema,
  interruptTurnOutputSchema,
} from "./interrupt-turn.contract.js";
import {
  listStaleTurnsContract,
  listStaleTurnsInputSchema,
} from "./list-stale-turns.contract.js";
import {
  readTurnForJobContract,
  readTurnForJobInputSchema,
} from "./read-turn-for-job.contract.js";
import {
  startTurnContract,
  startTurnInputSchema,
} from "./start-turn.contract.js";
import {
  assistantTurnFinalStatusSchema,
  assistantTurnKindSchema,
  assistantTurnStatusSchema,
} from "./turn-record.contract.js";

const CONVERSATION = "11111111-1111-4111-8111-111111111111";
const COMMAND = "22222222-2222-4222-8222-222222222222";
const USER_MESSAGE = "33333333-3333-4333-8333-333333333333";
const PLACEHOLDER = "44444444-4444-4444-8444-444444444444";

function chatAccept(overrides: Record<string, unknown> = {}) {
  return {
    conversationId: CONVERSATION,
    kind: "chat",
    commandId: COMMAND,
    sessionId: "session-1",
    userMessage: { messageId: USER_MESSAGE, bind: "owner", message: {} },
    placeholder: { messageId: PLACEHOLDER, bind: "owner", message: {} },
    budgetHold: {
      companyReservedMicroUsd: 100_000,
      globalReservedMicroUsd: 100_000,
      kyivDate: "2026-09-11",
    },
    ...overrides,
  };
}

describe("the turn contracts", () => {
  /**
   * A model able to accept, start or finish its own turn could run itself, so
   * none of these is a tool and none is on `/rpc`.
   */
  it("are staff internal writes under assistant:use, audited and not replay-keyed", () => {
    for (const contract of [
      acceptTurnContract,
      startTurnContract,
      finishTurnContract,
    ]) {
      expect(contract.principal, contract.name).toBe("staff");
      expect(contract.transport, contract.name).toBe("internal");
      expect(contract.aiExposure, contract.name).toBe("internal");
      expect(contract.permissions, contract.name).toEqual(["assistant:use"]);
      expect(contract.risk, contract.name).toBe("write");
      expect(contract.audit, contract.name).toBe(true);
      expect(contract.idempotent, contract.name).toBe(false);
      expect(contract.emits, contract.name).toEqual([]);
      expect(contract.description, contract.name).toContain(
        STAFF_CONVERSATION_AUTHOR_INVARIANT,
      );
    }
    expect(acceptTurnContract.errors).toContain("CONFLICT");
  });

  it("read stale turns only as a global system job nobody else can reach", () => {
    expect(listStaleTurnsContract.principal).toBe("system");
    expect(listStaleTurnsContract.systemScope).toBe("global");
    expect(listStaleTurnsContract.transport).toBe("internal");
    expect(listStaleTurnsContract.aiExposure).toBe("internal");
    expect(listStaleTurnsContract.risk).toBe("read");
    expect(listStaleTurnsContract.permissions).toEqual([]);
    expect(listStaleTurnsContract.audit).toBe(false);
  });

  it("read the turn a job names only as a global system job nobody else can reach", () => {
    expect(readTurnForJobContract.principal).toBe("system");
    expect(readTurnForJobContract.systemScope).toBe("global");
    expect(readTurnForJobContract.transport).toBe("internal");
    expect(readTurnForJobContract.aiExposure).toBe("internal");
    expect(readTurnForJobContract.risk).toBe("read");
    expect(readTurnForJobContract.permissions).toEqual([]);
    expect(readTurnForJobContract.audit).toBe(false);
  });

  /**
   * Replaying an interrupt would hand its hold to a retry, so the compare-and-
   * set is its idempotency, not a replay key.
   */
  it("interrupt a turn only as an audited tenant system write, not replay-keyed", () => {
    expect(interruptTurnContract.principal).toBe("system");
    expect(interruptTurnContract.systemScope).toBe("tenant");
    expect(interruptTurnContract.transport).toBe("internal");
    expect(interruptTurnContract.aiExposure).toBe("internal");
    expect(interruptTurnContract.risk).toBe("write");
    expect(interruptTurnContract.permissions).toEqual([]);
    expect(interruptTurnContract.audit).toBe(true);
    expect(interruptTurnContract.idempotent).toBe(false);
    expect(interruptTurnContract.emits).toEqual([]);
    expect(interruptTurnContract.errors).toContain("NOT_FOUND");
  });

  it("hand back a hold only with the call that ended the turn", () => {
    const hold = {
      companyReservedMicroUsd: 100_000,
      globalReservedMicroUsd: 100_000,
      kyivDate: "2026-09-11",
    };
    expect(
      finishTurnOutputSchema.safeParse({
        outcome: "finished",
        conversationId: CONVERSATION,
        status: "done",
      }).success,
    ).toBe(false);
    expect(
      finishTurnOutputSchema.safeParse({
        outcome: "already_finished",
        conversationId: CONVERSATION,
        status: "done",
        releasedHold: hold,
      }).success,
    ).toBe(false);
    expect(
      interruptTurnOutputSchema.safeParse({
        outcome: "interrupted",
        conversationId: CONVERSATION,
        releasedHold: hold,
      }).success,
    ).toBe(true);
    expect(
      interruptTurnOutputSchema.safeParse({
        outcome: "already_finished",
        conversationId: CONVERSATION,
        status: "interrupted",
        releasedHold: hold,
      }).success,
    ).toBe(false);
  });

  it("never take a company id", () => {
    const companyId = "55555555-5555-4555-8555-555555555555";
    const ref = {
      conversationId: CONVERSATION,
      kind: "chat",
      commandId: COMMAND,
    };

    expect(
      acceptTurnInputSchema.safeParse(chatAccept({ companyId })).success,
    ).toBe(false);
    expect(
      startTurnInputSchema.safeParse({ ...ref, timeoutMs: 180_000, companyId })
        .success,
    ).toBe(false);
    expect(
      finishTurnInputSchema.safeParse({ ...ref, status: "done", companyId })
        .success,
    ).toBe(false);
    expect(
      listStaleTurnsInputSchema.safeParse({
        queuedStaleAfterMs: 60_000,
        limit: 10,
        companyId,
      }).success,
    ).toBe(false);
    expect(
      readTurnForJobInputSchema.safeParse({ ...ref, companyId }).success,
    ).toBe(false);
    expect(
      interruptTurnInputSchema.safeParse({ ...ref, companyId }).success,
    ).toBe(false);
  });

  it("store the person's message for a chat accept and none for an answer", () => {
    expect(acceptTurnInputSchema.safeParse(chatAccept()).success).toBe(true);
    expect(
      acceptTurnInputSchema.safeParse(chatAccept({ userMessage: undefined }))
        .success,
    ).toBe(false);
    expect(
      acceptTurnInputSchema.safeParse(
        chatAccept({ kind: "answer", userMessage: undefined }),
      ).success,
    ).toBe(true);
    expect(
      acceptTurnInputSchema.safeParse(chatAccept({ kind: "answer" })).success,
    ).toBe(false);
  });

  it("refuse a placeholder sharing the person's message id in any casing, and a turn continuing itself", () => {
    expect(
      acceptTurnInputSchema.safeParse(
        chatAccept({
          placeholder: {
            messageId: USER_MESSAGE.toUpperCase(),
            bind: "owner",
            message: {},
          },
        }),
      ).success,
    ).toBe(false);
    expect(
      acceptTurnInputSchema.safeParse(
        chatAccept({ continuesCommandId: COMMAND.toUpperCase() }),
      ).success,
    ).toBe(false);
  });

  it("refuse a negative budget hold and a date that is not a day", () => {
    const hold = (budgetHold: Record<string, unknown>) =>
      acceptTurnInputSchema.safeParse(chatAccept({ budgetHold })).success;

    expect(
      hold({
        companyReservedMicroUsd: -1,
        globalReservedMicroUsd: 0,
        kyivDate: "2026-09-11",
      }),
    ).toBe(false);
    expect(
      hold({
        companyReservedMicroUsd: 1,
        globalReservedMicroUsd: 1,
        kyivDate: "11.09.2026",
      }),
    ).toBe(false);
  });

  /**
   * A release subtracts whatever the row holds, so a hold above one turn's
   * reservation would lower the company and global counters below what was
   * reserved.
   */
  it("refuse a hold above one turn's reservation", () => {
    const hold = (
      companyReservedMicroUsd: number,
      globalReservedMicroUsd: number,
    ) =>
      acceptTurnInputSchema.safeParse(
        chatAccept({
          budgetHold: {
            companyReservedMicroUsd,
            globalReservedMicroUsd,
            kyivDate: "2026-09-11",
          },
        }),
      ).success;
    const max = ASSISTANT_TURN_RESERVATION_MAX_MICRO_USD;

    expect(hold(max, max)).toBe(true);
    expect(hold(max + 1, 0)).toBe(false);
    expect(hold(0, max + 1)).toBe(false);
  });

  it("finish only as a final status", () => {
    const ref = {
      conversationId: CONVERSATION,
      kind: "chat",
      commandId: COMMAND,
    };
    for (const status of ["done", "failed", "interrupted"]) {
      expect(finishTurnInputSchema.safeParse({ ...ref, status }).success).toBe(
        true,
      );
    }
    for (const status of ["queued", "running"]) {
      expect(finishTurnInputSchema.safeParse({ ...ref, status }).success).toBe(
        false,
      );
    }
  });

  /**
   * A contract may not import the schema, so the lists are spelled twice. The
   * table's CHECK is what the database enforces; these must not drift from it.
   */
  it("spell the kinds and statuses exactly as the turn table does", () => {
    expect(assistantTurnKindSchema.options).toEqual([...ASSISTANT_TURN_KINDS]);
    expect(assistantTurnStatusSchema.options).toEqual([
      ...ASSISTANT_TURN_STATUSES,
    ]);
    expect(assistantTurnFinalStatusSchema.options).toEqual([
      ...ASSISTANT_TURN_FINAL_STATUSES,
    ]);
  });
});
