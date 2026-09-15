import { listOverdueTurns, sweepOverdueTurns } from "@showzy/assistant";
import type { ImplementedAction } from "@showzy/core";
import type { Logger } from "pino";
import type { z } from "zod";

import { assistantBudgetHoldFromStored } from "./stores/assistant-turn-store.js";
import type { AssistantTurnRecovery } from "./assistant-turn-recovery.js";

export interface AssistantSweepAttempt {
  readonly envelope: { readonly requestId: string };
  readonly signal: AbortSignal;
  run<TInput extends z.ZodType, TOutput extends z.ZodType, TTarget>(
    action: ImplementedAction<TInput, TOutput, TTarget>,
    input: unknown,
    fanOutCompanyId?: string,
  ): Promise<z.output<TOutput>>;
}

export interface AssistantSweepSummary {
  readonly ended: number;
  readonly failedCompanies: number;
}

type OverdueTurn = z.output<
  typeof listOverdueTurns.contract.output
>["turns"][number];

function byCompany(turns: readonly OverdueTurn[]): Map<string, OverdueTurn[]> {
  const grouped = new Map<string, OverdueTurn[]>();
  for (const turn of turns) {
    grouped.set(turn.companyId, [...(grouped.get(turn.companyId) ?? []), turn]);
  }
  return grouped;
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
  const limit =
    deps.pageSize ?? listOverdueTurns.contract.input.shape.limit.maxValue ?? 1;
  let ended = 0;
  let failedCompanies = 0;
  let after: OverdueTurn | null = null;
  do {
    const page: z.output<typeof listOverdueTurns.contract.output> =
      await attempt.run(listOverdueTurns, {
        limit,
        ...(after === null ? {} : { after }),
      });
    for (const [companyId, turns] of byCompany(page.turns)) {
      try {
        const swept = await attempt.run(
          sweepOverdueTurns,
          {
            turns: turns.map(({ conversationId, kind, commandId }) => ({
              conversationId,
              kind,
              commandId,
            })),
          },
          companyId,
        );
        for (const turn of swept.ended) {
          ended += 1;
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
  return { ended, failedCompanies };
}
