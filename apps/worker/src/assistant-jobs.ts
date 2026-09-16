import {
  assertAssistantSweepRecovered,
  assistantBudgetHoldFromStored,
  assistantSweepOverdueTurnsJob,
  assistantTurnJob,
  createAssistantCallerKits,
  createAssistantRuntime,
  createAssistantTurnProcessor,
  createAssistantTurnRecovery,
  createRedisAiBudgetStore,
  createRedisAssistantEventPublisher,
  interruptAssistantTurn,
  logStaffAssistantMount,
  staffAssistantMount,
  sweepOverdueAssistantTurns,
  type StaffAssistantAiConfig,
} from "@showzy/assistant-runtime";
import type { ActionPipelineDeps } from "@showzy/core";
import { ConflictError } from "@showzy/core/errors";
import type { JobHandler } from "@showzy/jobs";
import type { Redis } from "ioredis";
import type { Logger } from "pino";

import { createWorkerActionRegistry } from "./maintenance.js";

export interface ComposeAssistantJobsOptions {
  readonly ai: StaffAssistantAiConfig;
  readonly pipeline: ActionPipelineDeps;
  readonly sharedRedis: Redis;
  readonly logger: Logger;
}

function turnOf(payload: Readonly<Record<string, unknown>>) {
  const { conversationId, kind, commandId } =
    assistantTurnJob.payload.parse(payload);
  return { conversationId, kind, commandId };
}

export function composeAssistantJobs(
  options: ComposeAssistantJobsOptions,
): readonly JobHandler[] {
  const { logger, pipeline, sharedRedis } = options;
  const mount = staffAssistantMount(options.ai);
  logStaffAssistantMount(logger, mount, [
    `job ${assistantTurnJob.name}`,
    `job ${assistantSweepOverdueTurnsJob.name}`,
  ]);
  const registry = createWorkerActionRegistry();
  registry.assertPaired();
  const publisher = createRedisAssistantEventPublisher(sharedRedis);
  const budgetStore = createRedisAiBudgetStore(sharedRedis, { logger });
  const recover = createAssistantTurnRecovery({
    pipeline,
    logger,
    forCaller: createAssistantCallerKits({ pipeline, redis: sharedRedis }),
    publisher,
    budgetStore,
  });
  const process =
    mount.model === undefined
      ? undefined
      : createAssistantTurnProcessor({
          runtime: createAssistantRuntime({
            registry,
            pipeline,
            model: mount.model,
            provider: mount.provider,
            redis: sharedRedis,
          }),
          pipeline,
          publisher,
          budgetStore,
        });
  return [
    {
      job: assistantTurnJob,
      onExhausted: interruptAssistantTurn,
      async afterExhausted({ envelope, output }) {
        const ended = interruptAssistantTurn.contract.output.parse(output);
        if (ended.outcome !== "interrupted" || envelope.companyId === null) {
          return;
        }
        await recover(
          {
            companyId: envelope.companyId,
            turn: turnOf(envelope.payload),
            from: ended.from,
            endReason: ended.endReason,
            releasedHold: assistantBudgetHoldFromStored(ended.releasedHold),
          },
          envelope.requestId,
        );
      },
      async handle(attempt) {
        const companyId = attempt.envelope.companyId;
        if (process === undefined || companyId === null) {
          throw new ConflictError(
            "This worker starts no assistant turn for this job.",
          );
        }
        const outcome = await process({
          companyId,
          turn: turnOf(attempt.envelope.payload),
          requestId: attempt.envelope.requestId,
          signal: attempt.signal,
        });
        logger.info(
          { job: assistantTurnJob.name, outcome: outcome.kind },
          "assistant turn job processed",
        );
      },
    },
    {
      job: assistantSweepOverdueTurnsJob,
      async handle(attempt) {
        const summary = await sweepOverdueAssistantTurns(attempt, {
          recover,
          logger,
        });
        logger.info(
          { job: assistantSweepOverdueTurnsJob.name, ...summary },
          "assistant overdue turns swept",
        );
        assertAssistantSweepRecovered(summary);
      },
    },
  ];
}
