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
} from "../stores/budget.js";
import {
  DEFAULT_STAFF_ASSISTANT_BUDGET_LIMITS,
  enforceStaffAssistantBudget,
  logStaffAssistantBudgetDenial,
  staffAssistantBudgetSpendUsd,
} from "./assistant-budget-guard.js";

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const USER_A = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-09-02T12:00:00.000Z");

describe("staffAssistantBudgetSpendUsd", () => {
  it("uses the unknown-model ceiling when the estimate is null", () => {
    expect(staffAssistantBudgetSpendUsd(0.42, 0.1)).toBe(0.42);
    expect(staffAssistantBudgetSpendUsd(null, 0.1)).toBe(0.1);
  });
});

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
      await enforceStaffAssistantBudget({ ...request, userId: USER_A });
    }
    await expect(
      enforceStaffAssistantBudget({ ...request, userId: USER_A }),
    ).rejects.toBeInstanceOf(RateLimitError);
    await expect(
      enforceStaffAssistantBudget({
        ...request,
        userId: "33333333-3333-4333-8333-333333333333",
      }),
    ).resolves.toBeUndefined();
  });

  it("treats 0 as disable for turn and budget checks", async () => {
    const rateLimitStore = createInMemoryRateLimitStore();
    const budgetStore = createMemoryAiBudgetStore();
    await budgetStore.add(
      aiCompanyBudgetKey(COMPANY_A, "2026-09-02"),
      99,
      AI_BUDGET_TTL_SEC,
    );
    await budgetStore.add(
      aiGlobalBudgetKey("2026-09-02"),
      99,
      AI_BUDGET_TTL_SEC,
    );
    for (let i = 0; i < 5; i += 1) {
      await rateLimitStore.consume({
        key: aiChatTurnLimitKey(USER_A),
        limit: 1,
        windowSec: 60,
      });
    }
    await expect(
      enforceStaffAssistantBudget({
        logger: createCapturingLogger().logger,
        requestId: "req-zero",
        userId: USER_A,
        companyId: COMPANY_A,
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
      }),
    ).resolves.toBeUndefined();
  });

  it("skips the turn bucket on confirmation resume", async () => {
    const rateLimitStore = createInMemoryRateLimitStore();
    await rateLimitStore.consume({
      key: aiChatTurnLimitKey(USER_A),
      limit: 1,
      windowSec: 60,
    });
    await expect(
      enforceStaffAssistantBudget({
        logger: createCapturingLogger().logger,
        requestId: "req-resume",
        userId: USER_A,
        companyId: COMPANY_A,
        skipTurnLimit: true,
        now: NOW,
        rateLimitStore,
        limits: {
          ...DEFAULT_STAFF_ASSISTANT_BUDGET_LIMITS,
          chatTurnsPerMinutePerUser: 1,
        },
      }),
    ).resolves.toBeUndefined();
    await expect(
      enforceStaffAssistantBudget({
        logger: createCapturingLogger().logger,
        requestId: "req-resume-2",
        userId: USER_A,
        companyId: COMPANY_A,
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
      aiCompanyBudgetKey(COMPANY_A, "2026-09-02"),
      5,
      AI_BUDGET_TTL_SEC,
    );
    await expect(
      enforceStaffAssistantBudget({
        logger: createCapturingLogger().logger,
        requestId: "req-company",
        userId: USER_A,
        companyId: COMPANY_A,
        skipTurnLimit: true,
        now: NOW,
        budgetStore,
        limits: DEFAULT_STAFF_ASSISTANT_BUDGET_LIMITS,
      }),
    ).rejects.toBeInstanceOf(RateLimitError);
    await expect(
      enforceStaffAssistantBudget({
        logger: createCapturingLogger().logger,
        requestId: "req-company-b",
        userId: USER_A,
        companyId: "44444444-4444-4444-8444-444444444444",
        skipTurnLimit: true,
        now: NOW,
        budgetStore,
        limits: DEFAULT_STAFF_ASSISTANT_BUDGET_LIMITS,
      }),
    ).resolves.toBeUndefined();
  });

  it("denies every company when the global Kyiv-day USD limit is reached", async () => {
    const budgetStore = createMemoryAiBudgetStore();
    await budgetStore.add(
      aiGlobalBudgetKey("2026-09-02"),
      100,
      AI_BUDGET_TTL_SEC,
    );
    await expect(
      enforceStaffAssistantBudget({
        logger: createCapturingLogger().logger,
        requestId: "req-global",
        userId: USER_A,
        companyId: COMPANY_A,
        skipTurnLimit: true,
        now: NOW,
        budgetStore,
        limits: DEFAULT_STAFF_ASSISTANT_BUDGET_LIMITS,
      }),
    ).rejects.toBeInstanceOf(RateLimitError);
  });
});
