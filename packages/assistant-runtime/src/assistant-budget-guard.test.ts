import { randomUUID } from "node:crypto";

import { createInMemoryRateLimitStore } from "@showzy/core";
import { RateLimitError } from "@showzy/core/errors";
import { createCapturingLogger } from "@showzy/core/testing";
import { describe, expect, it } from "vitest";

import {
  AI_BUDGET_TTL_SEC,
  aiChatTurnLimitKey,
  aiCompanyBudgetKey,
  aiGlobalBudgetKey,
  createMemoryAiBudgetStore,
  type AiBudgetStore,
} from "./stores/budget.js";
import {
  DEFAULT_STAFF_ASSISTANT_BUDGET_LIMITS,
  emptyStaffAssistantBudgetHold,
  enforceStaffAssistantBudget,
  logStaffAssistantBudgetDenial,
  releaseStaffAssistantBudgetHold,
  type StaffAssistantTurnIdentity,
} from "./assistant-budget-guard.js";

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const USER_A = "22222222-2222-4222-8222-222222222222";
const CONVERSATION = "55555555-5555-4555-8555-555555555555";
const NOW = new Date("2026-09-02T12:00:00.000Z");
const KYIV_DATE = "2026-09-02";
const NEXT_KYIV_DATE = "2026-09-03";
const JUST_BEFORE_KYIV_MIDNIGHT = new Date("2026-09-02T20:59:59.600Z");
const JUST_AFTER_KYIV_MIDNIGHT = new Date("2026-09-02T21:00:00.100Z");
const EMPTY_HOLD = emptyStaffAssistantBudgetHold(KYIV_DATE);

/**
 * Which turn a reservation is for. A fresh command unless one is given: two
 * reservations under one command are deliberately *one* reservation now, so a
 * test that reused a command by accident would read as a ceiling holding when
 * nothing had been charged.
 */
function turnFor(commandId = randomUUID()): StaffAssistantTurnIdentity {
  return { kind: "chat", conversationId: CONVERSATION, commandId };
}

/** A store with the hold primitives stubbed out, for the failure paths. */
function storeWith(overrides: Partial<AiBudgetStore>): AiBudgetStore {
  return {
    read: () => Promise.resolve(0),
    add: () => Promise.resolve(0),
    tryAdd: () => Promise.resolve({ allowed: true, spent: 0 }),
    claimHold: (_key, value) => Promise.resolve({ created: true, value }),
    dropHold: () => Promise.resolve(true),
    ...overrides,
  };
}

describe("logStaffAssistantBudgetDenial", () => {
  it("logs reason and companyId without message text", () => {
    const capturing = createCapturingLogger();
    logStaffAssistantBudgetDenial({
      logger: capturing.logger,
      requestId: "req-budget-1",
      companyId: COMPANY_A,
      reason: "turn_limit",
    });
    const entry = capturing.entries().find((row) => {
      return row["msg"] === "staff assistant budget denied";
    });
    expect(entry?.["reason"]).toBe("turn_limit");
    expect(entry?.["company_id"]).toBe(COMPANY_A);
    expect(entry?.["request_id"]).toBe("req-budget-1");
    expect(entry).not.toHaveProperty("text");
    expect(entry).not.toHaveProperty("body");
    expect(JSON.stringify(entry)).not.toContain("SHOW_ME_THE_ORDERS");
  });

  it("logs company_id in lowercase even when the selector is mixed-case", () => {
    const capturing = createCapturingLogger();
    logStaffAssistantBudgetDenial({
      logger: capturing.logger,
      requestId: "req-budget-case",
      companyId: COMPANY_A.toUpperCase(),
      reason: "company_budget",
    });
    const entry = capturing.entries().find((row) => {
      return row["msg"] === "staff assistant budget denied";
    });
    expect(entry?.["company_id"]).toBe(COMPANY_A.toLowerCase());
  });
});

describe("enforceStaffAssistantBudget", () => {
  it("rejects the 21st consume in a minute and leaves another user untouched", async () => {
    const store = createInMemoryRateLimitStore();
    const request = {
      logger: createCapturingLogger().logger,
      requestId: "req-turns",
      companyId: COMPANY_A,
      skipTurnLimit: false,
      now: NOW,
      rateLimitStore: store,
      limits: DEFAULT_STAFF_ASSISTANT_BUDGET_LIMITS,
    };
    for (let i = 0; i < 20; i += 1) {
      await enforceStaffAssistantBudget({
        ...request,
        userId: USER_A,
        turn: turnFor(),
      });
    }
    await expect(
      enforceStaffAssistantBudget({
        ...request,
        userId: USER_A,
        turn: turnFor(),
      }),
    ).rejects.toBeInstanceOf(RateLimitError);
    const other = await enforceStaffAssistantBudget({
      ...request,
      userId: "33333333-3333-4333-8333-333333333333",
      turn: turnFor(),
    });
    expect(other.hold).toEqual(EMPTY_HOLD);
  });

  it("treats 0 as disable for turn and budget checks", async () => {
    const rateLimitStore = createInMemoryRateLimitStore();
    const budgetStore = createMemoryAiBudgetStore();
    await budgetStore.add(
      aiCompanyBudgetKey(COMPANY_A, KYIV_DATE),
      99,
      AI_BUDGET_TTL_SEC,
    );
    await budgetStore.add(aiGlobalBudgetKey(KYIV_DATE), 99, AI_BUDGET_TTL_SEC);
    for (let i = 0; i < 5; i += 1) {
      await rateLimitStore.consume({
        key: aiChatTurnLimitKey(USER_A),
        limit: 1,
        windowSec: 60,
      });
    }
    const reservation = await enforceStaffAssistantBudget({
      logger: createCapturingLogger().logger,
      requestId: "req-zero",
      userId: USER_A,
      companyId: COMPANY_A,
      turn: turnFor(),
      skipTurnLimit: false,
      now: NOW,
      rateLimitStore,
      budgetStore,
      limits: {
        chatTurnsPerMinutePerUser: 0,
        dailyBudgetUsdPerCompany: 0,
        dailyBudgetUsdGlobal: 0,
        unknownModelTurnUsd: 0.1,
      },
    });
    expect(reservation.hold).toEqual(EMPTY_HOLD);
  });

  it("skips the turn bucket on confirmation resume", async () => {
    const rateLimitStore = createInMemoryRateLimitStore();
    await rateLimitStore.consume({
      key: aiChatTurnLimitKey(USER_A),
      limit: 1,
      windowSec: 60,
    });
    const resumed = await enforceStaffAssistantBudget({
      logger: createCapturingLogger().logger,
      requestId: "req-resume",
      userId: USER_A,
      companyId: COMPANY_A,
      turn: turnFor(),
      skipTurnLimit: true,
      now: NOW,
      rateLimitStore,
      limits: {
        ...DEFAULT_STAFF_ASSISTANT_BUDGET_LIMITS,
        chatTurnsPerMinutePerUser: 1,
      },
    });
    expect(resumed.hold).toEqual(EMPTY_HOLD);
    await expect(
      enforceStaffAssistantBudget({
        logger: createCapturingLogger().logger,
        requestId: "req-resume-2",
        userId: USER_A,
        companyId: COMPANY_A,
        turn: turnFor(),
        skipTurnLimit: false,
        now: NOW,
        rateLimitStore,
        limits: {
          ...DEFAULT_STAFF_ASSISTANT_BUDGET_LIMITS,
          chatTurnsPerMinutePerUser: 1,
        },
      }),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it("denies a company at its Kyiv-day USD limit and leaves another company open", async () => {
    const budgetStore = createMemoryAiBudgetStore();
    await budgetStore.add(
      aiCompanyBudgetKey(COMPANY_A, KYIV_DATE),
      5,
      AI_BUDGET_TTL_SEC,
    );
    await expect(
      enforceStaffAssistantBudget({
        logger: createCapturingLogger().logger,
        requestId: "req-company",
        userId: USER_A,
        companyId: COMPANY_A,
        turn: turnFor(),
        skipTurnLimit: true,
        now: NOW,
        budgetStore,
        limits: DEFAULT_STAFF_ASSISTANT_BUDGET_LIMITS,
      }),
    ).rejects.toBeInstanceOf(RateLimitError);
    const open = await enforceStaffAssistantBudget({
      logger: createCapturingLogger().logger,
      requestId: "req-company-b",
      userId: USER_A,
      companyId: "44444444-4444-4444-8444-444444444444",
      turn: turnFor(),
      skipTurnLimit: true,
      now: NOW,
      budgetStore,
      limits: DEFAULT_STAFF_ASSISTANT_BUDGET_LIMITS,
    });
    expect(open.hold).toEqual({
      companyReservedUsd: 0.1,
      globalReservedUsd: 0.1,
      kyivDate: KYIV_DATE,
    });
  });

  it("denies mixed-case companyId against the lowercase Redis key", async () => {
    const budgetStore = createMemoryAiBudgetStore();
    await budgetStore.add(
      aiCompanyBudgetKey(COMPANY_A.toLowerCase(), KYIV_DATE),
      5,
      AI_BUDGET_TTL_SEC,
    );
    const capturing = createCapturingLogger();
    await expect(
      enforceStaffAssistantBudget({
        logger: capturing.logger,
        requestId: "req-company-case",
        userId: USER_A,
        companyId: COMPANY_A.toUpperCase(),
        turn: turnFor(),
        skipTurnLimit: true,
        now: NOW,
        budgetStore,
        limits: DEFAULT_STAFF_ASSISTANT_BUDGET_LIMITS,
      }),
    ).rejects.toBeInstanceOf(RateLimitError);
    const denial = capturing.entries().find((row) => {
      return row["msg"] === "staff assistant budget denied";
    });
    expect(denial?.["reason"]).toBe("company_budget");
    expect(denial?.["company_id"]).toBe(COMPANY_A.toLowerCase());
  });

  it("denies every company when the global Kyiv-day USD limit is reached", async () => {
    const budgetStore = createMemoryAiBudgetStore();
    await budgetStore.add(aiGlobalBudgetKey(KYIV_DATE), 100, AI_BUDGET_TTL_SEC);
    await expect(
      enforceStaffAssistantBudget({
        logger: createCapturingLogger().logger,
        requestId: "req-global",
        userId: USER_A,
        companyId: COMPANY_A,
        turn: turnFor(),
        skipTurnLimit: true,
        now: NOW,
        budgetStore,
        limits: DEFAULT_STAFF_ASSISTANT_BUDGET_LIMITS,
      }),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it("does not consume a turn slot when the request is denied for budget", async () => {
    const rateLimitStore = createInMemoryRateLimitStore();
    const budgetStore = createMemoryAiBudgetStore();
    await budgetStore.add(
      aiCompanyBudgetKey(COMPANY_A, KYIV_DATE),
      0.1,
      AI_BUDGET_TTL_SEC,
    );
    const request = {
      logger: createCapturingLogger().logger,
      requestId: "req-budget-then-turn",
      userId: USER_A,
      companyId: COMPANY_A,
      skipTurnLimit: false,
      now: NOW,
      rateLimitStore,
      budgetStore,
    };
    await expect(
      enforceStaffAssistantBudget({
        ...request,
        turn: turnFor(),
        limits: {
          chatTurnsPerMinutePerUser: 1,
          dailyBudgetUsdPerCompany: 0.1,
          dailyBudgetUsdGlobal: 0,
          unknownModelTurnUsd: 0.1,
        },
      }),
    ).rejects.toBeInstanceOf(RateLimitError);
    const admitted = await enforceStaffAssistantBudget({
      ...request,
      requestId: "req-budget-then-turn-2",
      turn: turnFor(),
      limits: {
        chatTurnsPerMinutePerUser: 1,
        dailyBudgetUsdPerCompany: 0,
        dailyBudgetUsdGlobal: 0,
        unknownModelTurnUsd: 0.1,
      },
    });
    expect(admitted.hold).toMatchObject({
      companyReservedUsd: 0,
      globalReservedUsd: 0,
    });
  });

  it("lets only one overlapping reservation proceed when remaining budget fits one turn", async () => {
    const budgetStore = createMemoryAiBudgetStore();
    const request = {
      logger: createCapturingLogger().logger,
      userId: USER_A,
      companyId: COMPANY_A,
      skipTurnLimit: true,
      now: NOW,
      budgetStore,
      limits: {
        chatTurnsPerMinutePerUser: 0,
        dailyBudgetUsdPerCompany: 0.1,
        dailyBudgetUsdGlobal: 0,
        unknownModelTurnUsd: 0.1,
      },
    };
    const [first, second] = await Promise.allSettled([
      enforceStaffAssistantBudget({
        ...request,
        requestId: "req-overlap-a",
        turn: turnFor(),
      }),
      enforceStaffAssistantBudget({
        ...request,
        requestId: "req-overlap-b",
        turn: turnFor(),
      }),
    ]);
    const fulfilled = [first, second].filter(
      (result) => result.status === "fulfilled",
    );
    const rejected = [first, second].filter(
      (result) => result.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(
      rejected[0]?.status === "rejected" ? rejected[0].reason : undefined,
    ).toBeInstanceOf(RateLimitError);
    expect(
      await budgetStore.read(aiCompanyBudgetKey(COMPANY_A, KYIV_DATE)),
    ).toBeCloseTo(0.1);
  });

  it("fails closed when tryAdd throws", async () => {
    await expect(
      enforceStaffAssistantBudget({
        logger: createCapturingLogger().logger,
        requestId: "req-tryadd-throw",
        userId: USER_A,
        companyId: COMPANY_A,
        turn: turnFor(),
        skipTurnLimit: true,
        now: NOW,
        budgetStore: storeWith({
          tryAdd: () => Promise.reject(new Error("store down")),
        }),
        limits: DEFAULT_STAFF_ASSISTANT_BUDGET_LIMITS,
      }),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  /**
   * A store that cannot say whether this turn already holds a reservation
   * cannot be reserved against: admitting would risk a second hold for one
   * turn, which is the thing this key exists to prevent.
   */
  it("fails closed when the hold record cannot be written, and takes nothing", async () => {
    const memory = createMemoryAiBudgetStore();
    await expect(
      enforceStaffAssistantBudget({
        logger: createCapturingLogger().logger,
        requestId: "req-claim-throw",
        userId: USER_A,
        companyId: COMPANY_A,
        turn: turnFor(),
        skipTurnLimit: true,
        now: NOW,
        budgetStore: {
          ...memory,
          claimHold: () => Promise.reject(new Error("store down")),
        },
        limits: DEFAULT_STAFF_ASSISTANT_BUDGET_LIMITS,
      }),
    ).rejects.toBeInstanceOf(RateLimitError);
    // Refused, and the counters are back where they started.
    expect(await memory.read(aiCompanyBudgetKey(COMPANY_A, KYIV_DATE))).toBe(0);
    expect(await memory.read(aiGlobalBudgetKey(KYIV_DATE))).toBe(0);
  });

  it("admits through the atomic reservation and never reads first", async () => {
    const memory = createMemoryAiBudgetStore();
    const budgetStore = {
      ...memory,
      read: () => Promise.reject(new Error("admission must not read")),
    };
    const reservation = await enforceStaffAssistantBudget({
      logger: createCapturingLogger().logger,
      requestId: "req-no-read-then-check",
      userId: USER_A,
      companyId: COMPANY_A,
      turn: turnFor(),
      skipTurnLimit: true,
      now: NOW,
      budgetStore,
      limits: DEFAULT_STAFF_ASSISTANT_BUDGET_LIMITS,
    });
    expect(reservation.hold.companyReservedUsd).toBeCloseTo(0.1);
    expect(reservation.hold.globalReservedUsd).toBeCloseTo(0.1);
    expect(reservation.created).toBe(true);
    expect(
      await memory.read(aiCompanyBudgetKey(COMPANY_A, KYIV_DATE)),
    ).toBeCloseTo(0.1);
    expect(await memory.read(aiGlobalBudgetKey(KYIV_DATE))).toBeCloseTo(0.1);
  });
});

/**
 * One turn, one reservation, however many times the phone asks for it
 * (SHO-572).
 *
 * Since the switch a retry under the same command is the expected path — the
 * chat route gives its command back on any failed accept — so without this a
 * run of failed accepts during a database incident would reserve again per
 * attempt and spend a company's whole Kyiv day.
 */
describe("a reservation keyed by the turn", () => {
  const request = {
    logger: createCapturingLogger().logger,
    userId: USER_A,
    companyId: COMPANY_A,
    skipTurnLimit: true,
    now: NOW,
    limits: DEFAULT_STAFF_ASSISTANT_BUDGET_LIMITS,
  };

  it("charges a run of same-command retries once", async () => {
    const budgetStore = createMemoryAiBudgetStore();
    const turn = turnFor();

    const reservations = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      reservations.push(
        await enforceStaffAssistantBudget({
          ...request,
          requestId: `req-retry-${String(attempt)}`,
          turn,
          budgetStore,
        }),
      );
    }

    expect(
      await budgetStore.read(aiCompanyBudgetKey(COMPANY_A, KYIV_DATE)),
    ).toBeCloseTo(0.1);
    expect(await budgetStore.read(aiGlobalBudgetKey(KYIV_DATE))).toBeCloseTo(
      0.1,
    );
    // Only the first attempt took it, so only the first may give it back.
    expect(reservations.map((each) => each.created)).toEqual([
      true,
      false,
      false,
      false,
      false,
    ]);
    // Every attempt is told the same reservation, so whichever one finally
    // accepts puts the right amount on the turn row.
    for (const reservation of reservations) {
      expect(reservation.hold).toEqual(reservations[0]?.hold);
    }
  });

  it("gives overlapping retries of one command a single reservation", async () => {
    const budgetStore = createMemoryAiBudgetStore();
    const turn = turnFor();

    const reservations = await Promise.all(
      Array.from({ length: 4 }, (_unused, attempt) =>
        enforceStaffAssistantBudget({
          ...request,
          requestId: `req-overlap-retry-${String(attempt)}`,
          turn,
          budgetStore,
        }),
      ),
    );

    expect(reservations.filter((each) => each.created)).toHaveLength(1);
    expect(
      await budgetStore.read(aiCompanyBudgetKey(COMPANY_A, KYIV_DATE)),
    ).toBeCloseTo(0.1);
  });

  it("reserves separately for different commands, and still stops at the cap", async () => {
    const budgetStore = createMemoryAiBudgetStore();
    const limits = {
      ...DEFAULT_STAFF_ASSISTANT_BUDGET_LIMITS,
      dailyBudgetUsdPerCompany: 0.2,
    };

    const first = await enforceStaffAssistantBudget({
      ...request,
      requestId: "req-cmd-1",
      turn: turnFor(),
      budgetStore,
      limits,
    });
    const second = await enforceStaffAssistantBudget({
      ...request,
      requestId: "req-cmd-2",
      turn: turnFor(),
      budgetStore,
      limits,
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(
      await budgetStore.read(aiCompanyBudgetKey(COMPANY_A, KYIV_DATE)),
    ).toBeCloseTo(0.2);

    // The per-turn cap still bites: keying by the command bounds re-reservation,
    // it does not raise the day's ceiling.
    await expect(
      enforceStaffAssistantBudget({
        ...request,
        requestId: "req-cmd-3",
        turn: turnFor(),
        budgetStore,
        limits,
      }),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it("keeps one conversation's reservation out of another's", async () => {
    const budgetStore = createMemoryAiBudgetStore();
    const commandId = randomUUID();

    await enforceStaffAssistantBudget({
      ...request,
      requestId: "req-conv-a",
      turn: { kind: "chat", conversationId: CONVERSATION, commandId },
      budgetStore,
    });
    // The same command token against a different conversation is a different
    // turn, and a turn that runs is a turn that is charged.
    const other = await enforceStaffAssistantBudget({
      ...request,
      requestId: "req-conv-b",
      turn: {
        kind: "chat",
        conversationId: "66666666-6666-4666-8666-666666666666",
        commandId,
      },
      budgetStore,
    });

    expect(other.created).toBe(true);
    expect(
      await budgetStore.read(aiCompanyBudgetKey(COMPANY_A, KYIV_DATE)),
    ).toBeCloseTo(0.2);
  });

  it("reads a retry's reservation in whatever casing the retry spells it", async () => {
    const budgetStore = createMemoryAiBudgetStore();
    const commandId = randomUUID();

    const first = await enforceStaffAssistantBudget({
      ...request,
      requestId: "req-case-1",
      turn: { kind: "chat", conversationId: CONVERSATION, commandId },
      budgetStore,
    });
    const retry = await enforceStaffAssistantBudget({
      ...request,
      requestId: "req-case-2",
      turn: {
        kind: "chat",
        conversationId: CONVERSATION.toUpperCase(),
        commandId: commandId.toUpperCase(),
      },
      budgetStore,
    });

    expect(first.created).toBe(true);
    expect(retry.created).toBe(false);
    expect(
      await budgetStore.read(aiCompanyBudgetKey(COMPANY_A, KYIV_DATE)),
    ).toBeCloseTo(0.1);
  });
});

describe("releaseStaffAssistantBudgetHold", () => {
  it("restores company and global counters to the pre-reserve value", async () => {
    const budgetStore = createMemoryAiBudgetStore();
    const logger = createCapturingLogger().logger;
    const turn = turnFor();
    await budgetStore.add(
      aiCompanyBudgetKey(COMPANY_A, KYIV_DATE),
      1,
      AI_BUDGET_TTL_SEC,
    );
    await budgetStore.add(aiGlobalBudgetKey(KYIV_DATE), 2, AI_BUDGET_TTL_SEC);
    const reservation = await enforceStaffAssistantBudget({
      logger,
      requestId: "req-release",
      userId: USER_A,
      companyId: COMPANY_A,
      turn,
      skipTurnLimit: true,
      now: NOW,
      budgetStore,
      limits: DEFAULT_STAFF_ASSISTANT_BUDGET_LIMITS,
    });
    expect(
      await budgetStore.read(aiCompanyBudgetKey(COMPANY_A, KYIV_DATE)),
    ).toBeCloseTo(1.1);
    expect(await budgetStore.read(aiGlobalBudgetKey(KYIV_DATE))).toBeCloseTo(
      2.1,
    );
    await releaseStaffAssistantBudgetHold({
      logger,
      requestId: "req-release",
      // Mixed case, as a selector may arrive: the record and the counters are
      // both reached through the canonical spelling.
      ref: { ...turn, companyId: COMPANY_A.toUpperCase() },
      hold: reservation.hold,
      budgetStore,
    });
    expect(
      await budgetStore.read(aiCompanyBudgetKey(COMPANY_A, KYIV_DATE)),
    ).toBeCloseTo(1);
    expect(await budgetStore.read(aiGlobalBudgetKey(KYIV_DATE))).toBeCloseTo(2);
  });

  /**
   * The property that ends the defect class this slice was opened for: the
   * request that reserved and the turn row's finisher can both release one
   * hold, and the counter still moves once. Before it, a hold released twice
   * drove the day's counter below real spend and lifted the cap.
   */
  it("moves the counters once however many parties release one hold", async () => {
    const budgetStore = createMemoryAiBudgetStore();
    const logger = createCapturingLogger().logger;
    const turn = turnFor();
    await budgetStore.add(
      aiCompanyBudgetKey(COMPANY_A, KYIV_DATE),
      1,
      AI_BUDGET_TTL_SEC,
    );
    const reservation = await enforceStaffAssistantBudget({
      logger,
      requestId: "req-release-once",
      userId: USER_A,
      companyId: COMPANY_A,
      turn,
      skipTurnLimit: true,
      now: NOW,
      budgetStore,
      limits: DEFAULT_STAFF_ASSISTANT_BUDGET_LIMITS,
    });
    const release = () =>
      releaseStaffAssistantBudgetHold({
        logger,
        requestId: "req-release-once",
        ref: { ...turn, companyId: COMPANY_A },
        hold: reservation.hold,
        budgetStore,
      });

    await release();
    await release();
    await Promise.all([release(), release()]);

    expect(
      await budgetStore.read(aiCompanyBudgetKey(COMPANY_A, KYIV_DATE)),
    ).toBeCloseTo(1);
  });

  it("releases the reserve-day keys when wall clock is after Kyiv midnight", async () => {
    const budgetStore = createMemoryAiBudgetStore();
    const logger = createCapturingLogger().logger;
    const turn = turnFor();
    await budgetStore.add(
      aiCompanyBudgetKey(COMPANY_A, KYIV_DATE),
      1,
      AI_BUDGET_TTL_SEC,
    );
    await budgetStore.add(aiGlobalBudgetKey(KYIV_DATE), 2, AI_BUDGET_TTL_SEC);
    const reservation = await enforceStaffAssistantBudget({
      logger,
      requestId: "req-release-midnight",
      userId: USER_A,
      companyId: COMPANY_A,
      turn,
      skipTurnLimit: true,
      now: JUST_BEFORE_KYIV_MIDNIGHT,
      budgetStore,
      limits: DEFAULT_STAFF_ASSISTANT_BUDGET_LIMITS,
    });
    expect(reservation.hold.kyivDate).toBe(KYIV_DATE);
    expect(
      await budgetStore.read(aiCompanyBudgetKey(COMPANY_A, KYIV_DATE)),
    ).toBeCloseTo(1.1);
    expect(await budgetStore.read(aiGlobalBudgetKey(KYIV_DATE))).toBeCloseTo(
      2.1,
    );
    // The turn crossed midnight; the hold names the day it was taken on, and
    // both the record and the counters are on that day.
    await releaseStaffAssistantBudgetHold({
      logger,
      requestId: "req-release-midnight",
      ref: { ...turn, companyId: COMPANY_A },
      hold: reservation.hold,
      budgetStore,
    });
    expect(
      await budgetStore.read(aiCompanyBudgetKey(COMPANY_A, KYIV_DATE)),
    ).toBeCloseTo(1);
    expect(await budgetStore.read(aiGlobalBudgetKey(KYIV_DATE))).toBeCloseTo(2);
    expect(
      await budgetStore.read(aiCompanyBudgetKey(COMPANY_A, NEXT_KYIV_DATE)),
    ).toBe(0);
    expect(await budgetStore.read(aiGlobalBudgetKey(NEXT_KYIV_DATE))).toBe(0);
    expect(JUST_AFTER_KYIV_MIDNIGHT.getTime()).toBeGreaterThan(
      JUST_BEFORE_KYIV_MIDNIGHT.getTime(),
    );
  });
});
