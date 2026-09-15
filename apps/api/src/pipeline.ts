/**
 * Compose the execution pipeline the HTTP transport hands every action
 * (core.md §4). Apps fill every protocol slot; an absent hook would mean
 * the protocol has not landed, not "skip it".
 */
import {
  createAuditHook,
  createConfirmationHook,
  createIdempotencyHook,
  createRateLimitHook,
  type ActionPipelineDeps,
  type ActionTelemetry,
  type ConfirmationStore,
  type JobPort,
  type RateLimitStore,
} from "@showzy/core";
import type { Database } from "@showzy/db";
import type { Logger } from "pino";

export interface CreateActionPipelineOptions {
  readonly db: Database;
  readonly logger: Logger;
  readonly jobs: JobPort;
  readonly telemetry?: ActionTelemetry;
  readonly rateLimitStore: RateLimitStore;
  readonly confirmationStore: ConfirmationStore;
  readonly ipHmacSecret: string;
  readonly now?: () => number;
}

export function createActionPipeline(
  options: CreateActionPipelineOptions,
): ActionPipelineDeps {
  const clock = options.now !== undefined ? { now: options.now } : {};
  return {
    db: options.db,
    logger: options.logger,
    ...(options.telemetry !== undefined
      ? { telemetry: options.telemetry }
      : {}),
    hooks: {
      rateLimit: createRateLimitHook({
        store: options.rateLimitStore,
        ipHmacSecret: options.ipHmacSecret,
        logger: options.logger,
        ...clock,
      }),
      confirmation: createConfirmationHook({
        store: options.confirmationStore,
        ...clock,
      }),
      idempotency: createIdempotencyHook({
        db: options.db,
        ...clock,
      }),
      audit: createAuditHook({ db: options.db, logger: options.logger }),
      jobs: options.jobs,
    },
    ...clock,
  };
}
