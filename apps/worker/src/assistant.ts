/**
 * The assistant turn processor this worker runs, composed from validated config
 * (ADR-0039, SHO-569).
 *
 * Mounted on the API's rule (`staffAssistantMount`): a worker runs turns only
 * when an API would accept them. The registry is the API's, through the one
 * approved `@showzy/api/registry` subpath, so a turn's tools are exactly the
 * actions the contract check walks. The provider and model are built here from
 * this process's own config, never through the API.
 *
 * Everything a turn keeps on Redis — pauses, budget counters, published events —
 * is on the shared Redis given here, never on the queue Redis the job host's
 * BullMQ connection uses.
 */
import { createActionRegistry } from "@showzy/api/registry";
import {
  ASSISTANT_QUEUE_NAME,
  createAssistantRuntime,
  createAssistantTurnProcessor,
  createRedisAiBudgetStore,
  createRedisAssistantEventPublisher,
  logStaffAssistantMount,
  staffAssistantMount,
  type AssistantTurnJob,
  type AssistantTurnJobOutcome,
  type StaffAssistantAiConfig,
} from "@showzy/assistant-runtime";
import type { ActionPipelineDeps } from "@showzy/core";
import type { Redis } from "ioredis";
import type { Logger } from "pino";

/** The registry builder the worker runs turns against: the API's, not a copy. */
export const workerActionRegistry = createActionRegistry;

/** What the mount log names for this process. */
export const ASSISTANT_WORKER_PATHS: readonly string[] = [
  `queue ${ASSISTANT_QUEUE_NAME}`,
];

export function composeAssistantTurns(options: {
  readonly ai: StaffAssistantAiConfig;
  readonly pipeline: ActionPipelineDeps;
  /** The shared, non-persistent Redis (`config.redis.url`). */
  readonly sharedRedis: Redis;
  readonly logger: Logger;
}): ((job: AssistantTurnJob) => Promise<AssistantTurnJobOutcome>) | undefined {
  const mount = staffAssistantMount(options.ai);
  logStaffAssistantMount(options.logger, mount, ASSISTANT_WORKER_PATHS);
  if (mount.model === undefined) {
    return undefined;
  }
  const registry = workerActionRegistry();
  registry.assertPaired();
  const runtime = createAssistantRuntime({
    registry,
    pipeline: options.pipeline,
    model: mount.model,
    provider: mount.provider,
    redis: options.sharedRedis,
  });
  return createAssistantTurnProcessor({
    runtime,
    pipeline: options.pipeline,
    publisher: createRedisAssistantEventPublisher(options.sharedRedis),
    budgetStore: createRedisAiBudgetStore(options.sharedRedis, {
      logger: options.logger,
    }),
  });
}
