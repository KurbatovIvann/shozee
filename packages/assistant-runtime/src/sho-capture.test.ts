import type { ShoResult } from "@showzy/sho-protocol";
import { describe, expect, it, vi } from "vitest";

import {
  captureShoRetraining,
  SHO_RETRAINING_MESSAGE,
  type ShoRetrainingLog,
  type ShoRetrainingRecord,
  type ShoRetrainingTurn,
} from "./sho-capture.js";

const DEV_COMPANY = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY = "99999999-9999-4999-8999-999999999999";

const RESULT = { text: "створи замовлення Каті на торт" } as ShoResult;

function logOf(): {
  readonly log: ShoRetrainingLog;
  readonly written: ShoRetrainingRecord[];
  readonly messages: string[];
} {
  const written: ShoRetrainingRecord[] = [];
  const messages: string[] = [];
  return {
    log: {
      info: (record, message) => {
        written.push(record);
        messages.push(message);
      },
    },
    written,
    messages,
  };
}

function turnOf(overrides: Partial<ShoRetrainingTurn> = {}): ShoRetrainingTurn {
  return {
    companyId: DEV_COMPANY,
    conversationId: "22222222-2222-4222-8222-222222222222",
    commandId: "33333333-3333-4333-8333-333333333333",
    requestId: "44444444-4444-4444-8444-444444444444",
    text: "створи замовлення Каті на торт",
    result: RESULT,
    fallbackReason: null,
    ...overrides,
  };
}

describe("captureShoRetraining", () => {
  it("keeps the transcript and the parse result for a listed company", () => {
    const { log, written, messages } = logOf();

    const record = captureShoRetraining(log, [DEV_COMPANY], turnOf());

    expect(record).not.toBeNull();
    expect(written).toEqual([record]);
    expect(messages).toEqual([SHO_RETRAINING_MESSAGE]);
    expect(record?.transcript).toBe("створи замовлення Каті на торт");
    expect(record?.result).toBe(RESULT);
    expect(record?.company_id).toBe(DEV_COMPANY);
  });

  it("stores nothing for a company the list does not name", () => {
    const { log, written } = logOf();

    expect(
      captureShoRetraining(
        log,
        [DEV_COMPANY],
        turnOf({ companyId: OTHER_COMPANY }),
      ),
    ).toBeNull();
    expect(written).toEqual([]);
  });

  it("stores nothing at all while no company is listed", () => {
    const { log, written } = logOf();

    expect(captureShoRetraining(log, [], turnOf())).toBeNull();
    expect(written).toEqual([]);
  });

  it("records only the company the turn was verified in", () => {
    const { log, written } = logOf();

    captureShoRetraining(log, [DEV_COMPANY, OTHER_COMPANY], turnOf());
    captureShoRetraining(
      log,
      [DEV_COMPANY, OTHER_COMPANY],
      turnOf({ companyId: OTHER_COMPANY, text: "інша компанія" }),
    );

    expect(
      written.filter((record) => record.company_id === DEV_COMPANY),
    ).toHaveLength(1);
    expect(
      written
        .filter((record) => record.company_id === DEV_COMPANY)
        .map((record) => record.transcript),
    ).toEqual(["створи замовлення Каті на торт"]);
  });

  it("stores the transcript and the result and nothing else — never audio", () => {
    const { log, written } = logOf();

    captureShoRetraining(log, [DEV_COMPANY], turnOf());

    expect(Object.keys(written[0] ?? {}).sort()).toEqual([
      "command_id",
      "company_id",
      "conversation_id",
      "fallback_reason",
      "request_id",
      "result",
      "sho_retraining",
      "transcript",
    ]);
  });

  it("stores nothing when Шо produced no result to learn from", () => {
    const { log, written } = logOf();

    expect(
      captureShoRetraining(
        log,
        [DEV_COMPANY],
        turnOf({ result: null, fallbackReason: "timeout" }),
      ),
    ).toBeNull();
    expect(written).toEqual([]);
  });

  it("keeps the reason a parsed command still fell through to the model", () => {
    const { log } = logOf();

    const record = captureShoRetraining(
      log,
      [DEV_COMPANY],
      turnOf({ fallbackReason: "action_not_planned" }),
    );

    expect(record?.fallback_reason).toBe("action_not_planned");
  });

  it("writes one record per turn", () => {
    const info = vi.fn();

    captureShoRetraining({ info }, [DEV_COMPANY], turnOf());

    expect(info).toHaveBeenCalledTimes(1);
  });
});
