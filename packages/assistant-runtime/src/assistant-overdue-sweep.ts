import { listOverdueTurns, sweepOverdueTurns } from "@showzy/assistant";
import type { ImplementedAction } from "@showzy/core";
import { CoreInvariantError } from "@showzy/core/errors";
import type { Logger } from "pino";
import type { z } from "zod";

import type { AssistantTurnRecovery } from "./assistant-turn-recovery.js";
import { assistantBudgetHoldFromStored } from "./stores/assistant-turn-store.js";

export interface AssistantSweepAttempt {
  readonly envelope: { readonly requestId: string };
  readonly signal: AbortSignal;
  run(
    action: ImplementedAction,
    input: unknown,
    fanOutCompanyId?: string,
  ): Promise<unknown>;
}

export interface AssistantSweepSummary {
  readonly pages: number;
  readonly ended: number;
  readonly failedCompanies: number;
  readonly failedTurns: number;
}

const overduePage = listOverdueTurns.contract.output;
const sweptTurns = sweepOverdueTurns.contract.output;

type OverdueTurn = z.output<typeof overduePage>["turns"][number];

function contractPageSize(): number {
  const bound = listOverdueTurns.contract.input.shape.limit.maxValue;
  if (typeof bound !== "number") {
    throw new CoreInvariantError(
      "assistant.listOverdueTurns no longer bounds its page size",
    );
  }
  return bound;
}

export const ASSISTANT_OVERDUE_SWEEP_PAGE = contractPageSize();

function byCompany(
  turns: readonly OverdueTurn[],
): ReadonlyMap<string, readonly OverdueTurn[]> {
  const grouped = new Map<string, OverdueTurn[]>();
  for (const turn of turns) {
    const held = grouped.get(turn.companyId);
    if (held === undefined) {
      grouped.set(turn.companyId, [turn]);
    } else {
      held.push(turn);
    }
  }
  return grouped;
}

export function assertAssistantSweepRecovered(
  summary: AssistantSweepSummary,
): void {
  if (summary.failedCompanies > 0 || summary.failedTurns > 0) {
    throw new CoreInvariantError(
      `assistant overdue sweep left ${String(summary.failedCompanies)} company page(s) unswept and ${String(summary.failedTurns)} ended turn(s) unrecovered: their holds and placeholders are no longer overdue and no later pass would find them`,
    );
  }
}

export async function sweepOverdueAssistantTurns(
  attempt: AssistantSweepAttempt,
  deps: {
    readonly recover: AssistantTurnRecovery;
    readonly logger: Logger;
    readonly pageSize?: number;
  },
): Promise<AssistantSweepSummary> {
  const requestId = attempt.envelope.requestId;
  const limit = deps.pageSize ?? ASSISTANT_OVERDUE_SWEEP_PAGE;
  let pages = 0;
  let ended = 0;
  let failedCompanies = 0;
  let failedTurns = 0;
  let after: OverdueTurn | null = null;
  do {
    const page = overduePage.parse(
      await attempt.run(listOverdueTurns, {
        limit,
        ...(after === null ? {} : { after }),
      }),
    );
    pages += 1;
    for (const [companyId, turns] of byCompany(page.turns)) {
      try {
        const swept = sweptTurns.parse(
          await attempt.run(
            sweepOverdueTurns,
            {
              turns: turns.map(({ conversationId, kind, commandId }) => ({
                conversationId,
                kind,
                commandId,
              })),
            },
            companyId,
          ),
        );
        for (const turn of swept.ended) {
          ended += 1;
          try {
            await deps.recover(
              {
                companyId,
                turn: {
                  conversationId: turn.conversationId,
                  kind: turn.kind,
                  commandId: turn.commandId,
                },
                from: turn.from,
                endReason: turn.endReason,
                releasedHold: assistantBudgetHoldFromStored(turn.releasedHold),
              },
              requestId,
            );
          } catch (error) {
            failedTurns += 1;
            deps.logger.error(
              {
                request_id: requestId,
                company_id: companyId,
                conversation_id: turn.conversationId,
                err: error,
              },
              "an ended assistant turn was not recovered",
            );
          }
        }
      } catch (error) {
        failedCompanies += 1;
        deps.logger.error(
          { request_id: requestId, company_id: companyId, err: error },
          "assistant overdue turns of a company were not swept",
        );
      }
    }
    after = page.next;
  } while (after !== null && !attempt.signal.aborted);
  return { pages, ended, failedCompanies, failedTurns };
}
