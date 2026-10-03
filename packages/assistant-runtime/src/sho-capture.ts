import type { ShoResult } from "@showzy/sho-protocol";

export const SHO_RETRAINING_MESSAGE =
  "Шо retraining data kept for a dev or test company";

export interface ShoRetrainingTurn {
  readonly companyId: string;
  readonly conversationId: string;
  readonly commandId: string;
  readonly requestId: string;
  readonly text: string;
  readonly result: ShoResult | null;
  readonly fallbackReason: string | null;
}

export interface ShoRetrainingRecord {
  readonly sho_retraining: true;
  readonly company_id: string;
  readonly conversation_id: string;
  readonly command_id: string;
  readonly request_id: string;
  readonly transcript: string;
  readonly result: ShoResult;
  readonly fallback_reason: string | null;
}

export interface ShoRetrainingLog {
  info(record: ShoRetrainingRecord, message: string): void;
}

export function shoRetrainingRecord(
  turn: ShoRetrainingTurn,
): ShoRetrainingRecord | null {
  if (turn.result === null) {
    return null;
  }
  return {
    sho_retraining: true,
    company_id: turn.companyId,
    conversation_id: turn.conversationId,
    command_id: turn.commandId,
    request_id: turn.requestId,
    transcript: turn.text,
    result: turn.result,
    fallback_reason: turn.fallbackReason,
  };
}

export function captureShoRetraining(
  log: ShoRetrainingLog,
  companies: readonly string[],
  turn: ShoRetrainingTurn,
): ShoRetrainingRecord | null {
  if (!companies.includes(turn.companyId)) {
    return null;
  }
  const record = shoRetrainingRecord(turn);
  if (record !== null) {
    log.info(record, SHO_RETRAINING_MESSAGE);
  }
  return record;
}
