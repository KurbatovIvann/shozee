import { createActionRegistry, registeredJobs } from "@showzy/api/registry";
import {
  cleanupExpiredIdempotencyKeys,
  defineJob,
  implementAction,
  jobField,
  jobPayload,
  type ActionRegistry,
  type ImplementedAction,
  type Job,
} from "@showzy/core";
import { defineActionContract } from "@showzy/core/contract";
import { CoreInvariantError } from "@showzy/core/errors";
import type { ReadTx, Tx } from "@showzy/db";
import {
  backfillCatalogRenditions,
  backfillCatalogRenditionsJob,
  sweepAbandonedUploads,
  sweepAbandonedUploadsJob,
} from "@showzy/files";
import type { JobHandler } from "@showzy/jobs";
import type { Logger } from "pino";

function writable(db: ReadTx | Tx): Tx {
  if (!("delete" in db)) {
    throw new CoreInvariantError(
      "worker.cleanupIdempotencyKeys runs in a write transaction",
    );
  }
  return db;
}

export const cleanupIdempotencyKeys = implementAction(
  defineActionContract({
    name: "worker.cleanupIdempotencyKeys",
    description: "Deletes idempotency keys past their retention.",
    principal: "system",
    systemScope: "global",
    transport: "internal",
    aiExposure: "internal",
    permissions: [],
    risk: "write",
    requiresConfirmation: false,
    atomicCalls: [],
    atomicCallers: [],
    idempotent: false,
    audit: true,
    emits: [],
    errors: [],
    timeout: 30_000,
    input: jobPayload({}),
    output: jobPayload({ removed: jobField.integer({ min: 0 }) }),
  }),
  {
    handler: async (_input, ctx) => ({
      removed: await cleanupExpiredIdempotencyKeys(writable(ctx.db)),
    }),
    auditTarget: () => ({ type: "idempotencyKeys", id: "expired" }),
  },
);

export const cleanupIdempotencyKeysJob = defineJob({
  name: "worker.cleanupIdempotencyKeys",
  scope: "global",
  payload: jobPayload({}),
  discriminator: [],
  lifecycle: "periodic",
  cron: "0 * * * *",
  retries: 0,
  attemptTimeoutMs: 60_000,
});

export const workerOwnedJobs: readonly Job[] = [cleanupIdempotencyKeysJob];

export const workerOwnedActions: readonly ImplementedAction[] = [
  cleanupIdempotencyKeys,
];

export function mergeJobDeclarations(
  ...sources: readonly (readonly Job[])[]
): readonly Job[] {
  const names = new Set<string>();
  for (const { name } of sources.flat()) {
    if (names.has(name)) {
      throw new CoreInvariantError(
        `job "${name}" is declared by more than one source`,
      );
    }
    names.add(name);
  }
  return sources.flat();
}

export const workerJobs = mergeJobDeclarations(registeredJobs, workerOwnedJobs);

export function createWorkerActionRegistry(): ActionRegistry {
  const registry = createActionRegistry();
  for (const action of workerOwnedActions) {
    registry.registerContract(action.contract);
    registry.registerImplementation(action);
  }
  return registry;
}

export function maintenanceHandler(
  job: Job,
  action: ImplementedAction,
  logger: Logger,
): JobHandler {
  return {
    job,
    async handle(attempt) {
      const counts = await attempt.run(action, attempt.envelope.payload);
      logger.info(
        { job: job.name, job_id: attempt.envelope.id, counts },
        "maintenance job ran",
      );
    },
  };
}

export function maintenanceHandlers(logger: Logger): readonly JobHandler[] {
  return [
    maintenanceHandler(sweepAbandonedUploadsJob, sweepAbandonedUploads, logger),
    maintenanceHandler(
      backfillCatalogRenditionsJob,
      backfillCatalogRenditions,
      logger,
    ),
    maintenanceHandler(
      cleanupIdempotencyKeysJob,
      cleanupIdempotencyKeys,
      logger,
    ),
  ];
}
