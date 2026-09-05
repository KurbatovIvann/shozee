/**
 * Narrow outbox integration for SHO-436 / SHO-452: when
 * `docGeneration.pdf-renderer` exhausts the existing delivery retry budget,
 * persist a durable failed job via `docGeneration.markFailed` in a
 * **separate** executeAction so the mark cannot roll back with the thrown
 * render. Production PDF retry is this outbox path (five attempts,
 * 1s/2s/4s/8s). The BullMQ `pdf` processor does not enqueue durable one-shot
 * work (db.md §6).
 *
 * Scope comes from `PdfGenerationRetryableError` or from validated
 * event-bound invocation context captured after `getForGeneration`, so a
 * pipeline `TimeoutError` can still finalize. Unwrapped `NotFoundError` /
 * `PermissionDeniedError` never use that capture: this logs
 * `replay-dead-deliveries` and does not persist failed, so a foreign id
 * cannot become a same-tenant `CONFLICT` mark. `retryAt === null` alone
 * is not enough — claim/discovery failures have no invocation context.
 */
import { randomUUID } from "node:crypto";

import {
  executeAction,
  type ActionPipelineDeps,
  type ClaimableDelivery,
  type DeliveryOutcome,
} from "@showzy/core";
import { type CoreError, TimeoutError } from "@showzy/core/errors";
import { markFailed } from "@showzy/doc-generation";
import {
  forgetPdfInvocationScope,
  readPdfInvocationScope,
  readPdfRetryScope,
  type PdfInvocationScope,
} from "@showzy/doc-generation/pdf-retry";
import { PDF_RENDERER_CONSUMER } from "@showzy/doc-generation/subscriptions";

type FinalizeLogger = {
  error(binding: Record<string, unknown>, msg: string): void;
};

export async function maybeFinalizeDeadPdfGeneration(env: {
  readonly pipeline: ActionPipelineDeps;
  readonly delivery: ClaimableDelivery;
  readonly outcome: DeliveryOutcome;
  readonly logger: FinalizeLogger;
  readonly workerId: string;
}): Promise<void> {
  if (env.delivery.consumer !== PDF_RENDERER_CONSUMER) {
    return;
  }
  if (env.outcome.status !== "failed" || env.outcome.retryAt !== null) {
    return;
  }
  const scope = resolveExhaustedPdfScope(
    env.outcome.error,
    env.delivery.eventId,
  );
  if (scope === undefined) {
    env.logger.error(
      {
        worker_id: env.workerId,
        consumer: env.delivery.consumer,
        event_id: env.delivery.eventId,
        error_code: env.outcome.error.code,
      },
      "pdf delivery dead-lettered without document scope; replay-dead-deliveries recovers",
    );
    return;
  }
  try {
    await executeAction(env.pipeline, {
      action: markFailed,
      input: { documentId: scope.documentId },
      request: {
        requestId: randomUUID(),
        correlationId: randomUUID(),
        channel: "system",
        idempotencyKey: `docGeneration.markFailed:${env.delivery.eventId}`,
      },
      principal: {
        mode: "system",
        serviceName: PDF_RENDERER_CONSUMER,
        scope: { scope: "tenant", companyId: scope.companyId },
      },
    });
    forgetPdfInvocationScope(env.delivery.eventId);
  } catch (error) {
    env.logger.error(
      {
        worker_id: env.workerId,
        consumer: env.delivery.consumer,
        event_id: env.delivery.eventId,
        document_id: scope.documentId,
        err: error,
      },
      "pdf failure bookkeeping failed; replay-dead-deliveries recovers",
    );
  }
}

/**
 * Retryable renderer errors carry tenant document ids. Pipeline
 * TimeoutError does not: use the invocation scope recorded after a
 * validated same-tenant getForGeneration. Missing/foreign denials and
 * claim failures never look like an execution timeout with that scope.
 */
function resolveExhaustedPdfScope(
  error: CoreError,
  eventId: string,
): PdfInvocationScope | undefined {
  const fromRetryable = readPdfRetryScope(error);
  if (fromRetryable !== undefined) {
    return fromRetryable;
  }
  if (!(error instanceof TimeoutError)) {
    return undefined;
  }
  return readPdfInvocationScope(eventId);
}
