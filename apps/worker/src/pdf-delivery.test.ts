import { randomUUID } from "node:crypto";

import type { ActionPipelineDeps, ClaimableDelivery } from "@showzy/core";
import { CoreInvariantError, NotFoundError, TimeoutError } from "@showzy/core/errors";
import {
  rememberPdfInvocationScope,
  toPdfGenerationRetryableError,
} from "@showzy/doc-generation/pdf-retry";
import { PDF_RENDERER_CONSUMER } from "@showzy/doc-generation/subscriptions";
import { pino, type Logger } from "pino";
import { describe, expect, it } from "vitest";

import { maybeFinalizeDeadPdfGeneration } from "./pdf-delivery.js";

const documentId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const signedUrlError = new Error(
  "put failed https://garage.example/bucket/obj?X-Amz-Signature=secret",
);

function captureLogger(): {
  logger: Logger;
  entries: () => Record<string, unknown>[];
} {
  const lines: string[] = [];
  const logger = pino(
    { base: null },
    {
      write(chunk: string) {
        lines.push(chunk);
      },
    },
  );
  return {
    logger,
    entries: () =>
      lines
        .flatMap((chunk) => chunk.split("\n"))
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

function unusedPipeline(logger: Logger): ActionPipelineDeps {
  return {
    get db(): ActionPipelineDeps["db"] {
      throw new Error("pipeline db should not be used");
    },
    logger,
  };
}

function pdfDelivery(
  consumer = PDF_RENDERER_CONSUMER,
  eventId = randomUUID(),
): ClaimableDelivery {
  return {
    consumer,
    eventId,
    eventName: "documents.created",
  };
}

function assertNoSignedUrl(payload: string): void {
  expect(payload).not.toContain("https://");
  expect(payload).not.toContain("X-Amz-");
  expect(payload).not.toContain("garage.example");
}

describe("maybeFinalizeDeadPdfGeneration", () => {
  it("skips non-pdf consumers and in-budget retries", async () => {
    const captured = captureLogger();
    const pipeline = unusedPipeline(captured.logger);
    await maybeFinalizeDeadPdfGeneration({
      pipeline,
      delivery: pdfDelivery("chat.order-card-updater"),
      outcome: {
        status: "failed",
        error: new CoreInvariantError("other consumer"),
        retryAt: null,
      },
      logger: captured.logger,
      workerId: "w1",
    });
    await maybeFinalizeDeadPdfGeneration({
      pipeline,
      delivery: pdfDelivery(),
      outcome: {
        status: "failed",
        error: toPdfGenerationRetryableError({
          documentId,
          companyId,
          cause: signedUrlError,
        }),
        retryAt: new Date().toISOString(),
      },
      logger: captured.logger,
      workerId: "w1",
    });
    expect(captured.entries()).toEqual([]);
  });

  it("logs a defined recovery path when dead-lettered without document scope", async () => {
    const captured = captureLogger();
    await maybeFinalizeDeadPdfGeneration({
      pipeline: unusedPipeline(captured.logger),
      delivery: pdfDelivery(),
      outcome: {
        status: "failed",
        error: new CoreInvariantError("claim failed"),
        retryAt: null,
      },
      logger: captured.logger,
      workerId: "w1",
    });
    expect(captured.entries()).toEqual([
      expect.objectContaining({
        msg: "pdf delivery dead-lettered without document scope; replay-dead-deliveries recovers",
        consumer: PDF_RENDERER_CONSUMER,
        error_code: "INTERNAL",
      }),
    ]);
  });

  it("does not persist failed for unwrapped NotFoundError after exhaustion", async () => {
    const captured = captureLogger();
    await maybeFinalizeDeadPdfGeneration({
      pipeline: unusedPipeline(captured.logger),
      delivery: pdfDelivery(),
      outcome: {
        status: "failed",
        error: new NotFoundError(),
        retryAt: null,
      },
      logger: captured.logger,
      workerId: "w1",
    });
    expect(captured.entries()).toEqual([
      expect.objectContaining({
        msg: "pdf delivery dead-lettered without document scope; replay-dead-deliveries recovers",
        error_code: "NOT_FOUND",
      }),
    ]);
  });

  it("logs bookkeeping failure without signed URLs when markFailed cannot run", async () => {
    const captured = captureLogger();
    const delivery = pdfDelivery();
    const retryable = toPdfGenerationRetryableError({
      documentId,
      companyId,
      cause: signedUrlError,
    });
    expect(retryable.cause).toBeUndefined();
    await maybeFinalizeDeadPdfGeneration({
      pipeline: unusedPipeline(captured.logger),
      delivery,
      outcome: {
        status: "failed",
        error: retryable,
        retryAt: null,
      },
      logger: captured.logger,
      workerId: "w1",
    });
    const entries = captured.entries();
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          msg: "pdf failure bookkeeping failed; replay-dead-deliveries recovers",
          document_id: documentId,
          event_id: delivery.eventId,
        }),
      ]),
    );
    assertNoSignedUrl(JSON.stringify(entries));
  });

  it("does not finalize a pipeline TimeoutError without invocation context", async () => {
    const captured = captureLogger();
    await maybeFinalizeDeadPdfGeneration({
      pipeline: unusedPipeline(captured.logger),
      delivery: pdfDelivery(),
      outcome: {
        status: "failed",
        error: new TimeoutError(),
        retryAt: null,
      },
      logger: captured.logger,
      workerId: "w1",
    });
    expect(captured.entries()).toEqual([
      expect.objectContaining({
        msg: "pdf delivery dead-lettered without document scope; replay-dead-deliveries recovers",
        error_code: "TIMEOUT",
      }),
    ]);
  });

  it("does not finalize a TimeoutError while retries remain", async () => {
    const captured = captureLogger();
    const delivery = pdfDelivery();
    rememberPdfInvocationScope({
      eventId: delivery.eventId,
      documentId,
      companyId,
    });
    await maybeFinalizeDeadPdfGeneration({
      pipeline: unusedPipeline(captured.logger),
      delivery,
      outcome: {
        status: "failed",
        error: new TimeoutError(),
        retryAt: new Date().toISOString(),
      },
      logger: captured.logger,
      workerId: "w1",
    });
    expect(captured.entries()).toEqual([]);
  });

  it("uses invocation scope to attempt markFailed for an exhausted TimeoutError", async () => {
    const captured = captureLogger();
    const delivery = pdfDelivery();
    rememberPdfInvocationScope({
      eventId: delivery.eventId,
      documentId,
      companyId,
    });
    await maybeFinalizeDeadPdfGeneration({
      pipeline: unusedPipeline(captured.logger),
      delivery,
      outcome: {
        status: "failed",
        error: new TimeoutError(),
        retryAt: null,
      },
      logger: captured.logger,
      workerId: "w1",
    });
    const entries = captured.entries();
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          msg: "pdf failure bookkeeping failed; replay-dead-deliveries recovers",
          document_id: documentId,
          event_id: delivery.eventId,
        }),
      ]),
    );
    expect(JSON.stringify(entries)).not.toContain(
      "pdf delivery dead-lettered without document scope",
    );
  });
});
