/**
 * SHO-436: exhaustion finalizer glue. Production never `invoke(markFailed)`
 * after a dead delivery — `createOutboxWorker` runs `executeDelivery` then
 * `maybeFinalizeDeadPdfGeneration` → `executeAction(markFailed)` with
 * tenant scope from `PdfGenerationRetryableError` or from validated
 * invocation scope after a pipeline `TimeoutError`.
 */
import { randomUUID } from "node:crypto";

import {
  canonicalJsonSha256,
  DELIVERY_MAX_ATTEMPTS,
  DELIVERY_RETRY_BASE_MS,
  dispatchOutboxBatch,
  executeDelivery,
  implementAction,
} from "@showzy/core";
import { defineActionContract } from "@showzy/core/contract";
import {
  CoreInvariantError,
  NotFoundError,
  TimeoutError,
} from "@showzy/core/errors";
import {
  createTestKit,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import { auditLog, domainEvents, idempotencyKeys } from "@showzy/db";
import { products } from "@showzy/db/schema/catalog";
import { companyLegalInfo } from "@showzy/db/schema/companies";
import { companyCustomers } from "@showzy/db/schema/customers";
import { orderItems, orders } from "@showzy/db/schema/orders";
import { getArtifact } from "@showzy/doc-generation";
import {
  PdfGenerationRetryableError,
  rememberPdfInvocationScope,
  toPdfGenerationRetryableError,
} from "@showzy/doc-generation/pdf-retry";
import {
  PDF_RENDERER_CONSUMER,
  pdfRendererCreated,
} from "@showzy/doc-generation/subscriptions";
import { createFromOrder, documentsCreated } from "@showzy/documents";
import {
  closeFilesObjectStore,
  configureFilesObjectStore,
  mapConfiguredFilesObjectStore,
} from "@showzy/files/storage";
import { and, eq } from "drizzle-orm";
import { pino, type Logger } from "pino";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { z } from "zod";

import * as renderDocument from "../../../packages/modules/doc-generation/src/templates/render-document.js";
import { maybeFinalizeDeadPdfGeneration } from "./pdf-delivery.js";

const silent = pino({ enabled: false });
const sampleIban = "UA123456789012345678901234567";
const signedUrlMessage =
  "injected storage outage https://garage.example/bucket/obj?X-Amz-Signature=secret";

const fixtures = {
  customerA: randomUUID(),
  productA: randomUUID(),
  orderExhaust: randomUUID(),
  itemExhaust: randomUUID(),
  orderReady: randomUUID(),
  itemReady: randomUUID(),
  orderTimeout: randomUUID(),
  itemTimeout: randomUUID(),
  orderTimeoutEarly: randomUUID(),
  itemTimeoutEarly: randomUUID(),
  orderTimeoutRace: randomUUID(),
  itemTimeoutRace: randomUUID(),
};

const emitOrphanCreated = implementAction(
  defineActionContract({
    name: "documents.emitOrphanCreated",
    description:
      "Test-local emitter of documents.created for a missing document id.",
    principal: "staff",
    transport: "internal",
    aiExposure: "internal",
    input: z.object({
      documentId: z.uuid(),
      orderId: z.uuid(),
    }),
    output: z.object({ ok: z.boolean() }),
    permissions: ["documents:create"],
    risk: "write",
    requiresConfirmation: false,
    idempotent: true,
    emits: ["documents.created"],
    atomicCalls: [],
    atomicCallers: [],
    audit: true,
    timeout: 5_000,
  }),
  {
    handler: (input, ctx) => {
      ctx.emit(documentsCreated, {
        aggregate: { type: "document", id: input.documentId },
        payload: {
          documentId: input.documentId,
          orderId: input.orderId,
          type: "payment_invoice",
          documentNumber: "KA-РХ-000000",
        },
      });
      return Promise.resolve({ ok: true });
    },
    auditTarget: (env) => {
      const parsed = z.object({ documentId: z.string() }).safeParse(env.input);
      return {
        type: "document",
        id: parsed.success ? parsed.data.documentId : "unknown",
      };
    },
  },
);

let kit: TestKit;
const seedOrderNumbers = new Map<string, number>();

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

function nextSeedOrderNumber(companyId: string): string {
  const next = (seedOrderNumbers.get(companyId) ?? 0) + 1;
  seedOrderNumbers.set(companyId, next);
  return `T-${String(next)}`;
}

async function insertSeedOrder(values: {
  id: string;
  itemId: string;
  companyId: string;
  customerId: string;
  productId: string;
}): Promise<void> {
  const unit = 250n;
  await kit.db.runtime.db.insert(orders).values({
    id: values.id,
    companyId: values.companyId,
    orderNumber: nextSeedOrderNumber(values.companyId),
    customerId: values.customerId,
    customerNameSnapshot: "Fixture customer",
    status: "new",
    totalNetMinor: unit,
    totalTaxMinor: 0n,
    totalGrossMinor: unit,
    currency: "UAH",
  });
  await kit.db.runtime.db.insert(orderItems).values({
    id: values.itemId,
    companyId: values.companyId,
    orderId: values.id,
    productId: values.productId,
    titleSnapshot: "Seed line",
    quantityMilli: 1000n,
    unitPriceMinor: unit,
    taxTreatment: "exempt",
    netAmountMinor: unit,
    grossAmountMinor: unit,
    priceSource: "base",
    resolverVersion: 1,
  });
}

function installMemoryObjectStore(remainingFailures: {
  count: number;
}): () => void {
  const objects = new Map<string, Uint8Array>();
  return mapConfiguredFilesObjectStore(() => ({
    signPut: () =>
      Promise.resolve({
        url: "http://127.0.0.1/put",
        expiresAt: new Date(Date.now() + 60_000),
      }),
    signGet: () =>
      Promise.resolve({
        url: "http://127.0.0.1/get",
        expiresAt: new Date(Date.now() + 60_000),
      }),
    headObject: (key) => {
      const bytes = objects.get(key);
      if (bytes === undefined) {
        return Promise.resolve("missing");
      }
      return Promise.resolve({ byteSize: bytes.byteLength, etag: "mem" });
    },
    getObject: (key) => {
      const bytes = objects.get(key);
      if (bytes === undefined) {
        return Promise.resolve("missing");
      }
      return Promise.resolve({
        bytes,
        byteSize: bytes.byteLength,
        etag: "mem",
      });
    },
    putObject: (input) => {
      if (remainingFailures.count > 0) {
        remainingFailures.count -= 1;
        return Promise.reject(new CoreInvariantError(signedUrlMessage));
      }
      objects.set(input.key, input.bytes);
      return Promise.resolve();
    },
    copyObject: () => Promise.resolve("copied"),
    deleteObject: (key) => {
      objects.delete(key);
      return Promise.resolve();
    },
    probeBucket: () => Promise.resolve(),
    close: () => undefined,
  }));
}

beforeAll(async () => {
  configureFilesObjectStore({
    endpoint: "http://127.0.0.1:1",
    region: "us-east-1",
    accessKeyId: "test",
    secretAccessKey: "test",
    forcePathStyle: true,
    bucket: "showzy",
  });
  kit = await createTestKit();
  const companyA = kitIdentities.companies.a;
  await kit.db.runtime.db.insert(companyLegalInfo).values({
    companyId: companyA,
    companyType: "tov",
    legalName: "ТОВ Альфа",
    edrpou: "12345678",
    legalAddress: "вул. Хрещатик, 1",
    iban: sampleIban,
    bankName: "ПриватБанк",
    bankMfo: "300001",
    bankEdrpou: "12345678",
    phone: "+380501111111",
    email: "legal@alpha.test",
  });
  await kit.db.runtime.db.insert(companyCustomers).values({
    id: fixtures.customerA,
    companyId: companyA,
    name: "Customer A",
    email: `customer-${fixtures.customerA}@example.com`,
  });
  await kit.db.runtime.db.insert(products).values({
    id: fixtures.productA,
    companyId: companyA,
    name: "Cake",
    basePriceMinor: 250n,
  });
  await insertSeedOrder({
    id: fixtures.orderExhaust,
    itemId: fixtures.itemExhaust,
    companyId: companyA,
    customerId: fixtures.customerA,
    productId: fixtures.productA,
  });
  await insertSeedOrder({
    id: fixtures.orderReady,
    itemId: fixtures.itemReady,
    companyId: companyA,
    customerId: fixtures.customerA,
    productId: fixtures.productA,
  });
  await insertSeedOrder({
    id: fixtures.orderTimeout,
    itemId: fixtures.itemTimeout,
    companyId: companyA,
    customerId: fixtures.customerA,
    productId: fixtures.productA,
  });
  await insertSeedOrder({
    id: fixtures.orderTimeoutEarly,
    itemId: fixtures.itemTimeoutEarly,
    companyId: companyA,
    customerId: fixtures.customerA,
    productId: fixtures.productA,
  });
  await insertSeedOrder({
    id: fixtures.orderTimeoutRace,
    itemId: fixtures.itemTimeoutRace,
    companyId: companyA,
    customerId: fixtures.customerA,
    productId: fixtures.productA,
  });
});

beforeEach(() => {
  installMemoryObjectStore({ count: 0 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await kit.db.close();
  closeFilesObjectStore();
});

async function dispatchPdfDelivery(
  requestId: string,
  claimedBy: string,
): Promise<{
  consumer: string;
  eventId: string;
  eventName: string;
}> {
  const rows = await kit.db.runtime.db
    .select({ id: domainEvents.id, name: domainEvents.name })
    .from(domainEvents)
    .where(eq(domainEvents.requestId, requestId));
  const match = rows.filter((row) => row.name === "documents.created");
  const eventId = match[0]?.id;
  if (match.length !== 1 || eventId === undefined) {
    throw new Error("expected one documents.created outbox row");
  }
  await dispatchOutboxBatch(
    { db: kit.db.runtime.db },
    { subscriptions: [pdfRendererCreated], claimedBy },
  );
  return {
    consumer: PDF_RENDERER_CONSUMER,
    eventId,
    eventName: "documents.created",
  };
}

async function exhaustPdfDelivery(env: {
  readonly eventId: string;
  readonly claimedBy: string;
  readonly remainingFailures: { count: number };
}): Promise<
  Extract<Awaited<ReturnType<typeof executeDelivery>>, { status: "failed" }>
> {
  const restore = installMemoryObjectStore(env.remainingFailures);
  const nowMs = { value: Date.now() };
  const pipeline = { ...kit.pipeline, now: () => nowMs.value };
  let last: Awaited<ReturnType<typeof executeDelivery>> | undefined;
  try {
    for (let attempt = 1; attempt <= DELIVERY_MAX_ATTEMPTS; attempt += 1) {
      const outcome = await executeDelivery(pipeline, {
        subscription: pdfRendererCreated,
        eventId: env.eventId,
        claimedBy: env.claimedBy,
      });
      expect(outcome.status).toBe("failed");
      if (outcome.status !== "failed") {
        throw new Error("expected a failed delivery outcome");
      }
      last = outcome;
      if (attempt < DELIVERY_MAX_ATTEMPTS) {
        const delay = DELIVERY_RETRY_BASE_MS * 2 ** (attempt - 1);
        expect(outcome.retryAt).toBe(
          new Date(nowMs.value + delay).toISOString(),
        );
        nowMs.value += delay;
      } else {
        expect(outcome.retryAt).toBeNull();
      }
    }
  } finally {
    restore();
  }
  if (last === undefined || last.status !== "failed") {
    throw new Error("expected a final failed delivery outcome");
  }
  return last;
}

function capLongJsTimeouts(maxMs: number): () => void {
  const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
  const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
    handler: TimerHandler,
    delay?: number,
    ...args: unknown[]
  ) => {
    const next = typeof delay === "number" && delay >= 5_000 ? maxMs : delay;
    return nativeSetTimeout(handler, next, ...args);
  }) as typeof setTimeout);
  return () => {
    spy.mockRestore();
  };
}

function hangPdfRender(): () => void {
  const spy = vi
    .spyOn(renderDocument, "renderDocumentPdfBytes")
    .mockImplementation(() => new Promise(() => undefined));
  return () => {
    spy.mockRestore();
  };
}

describe("maybeFinalizeDeadPdfGeneration (SHO-436 worker path)", () => {
  it("persists failed through executeAction after five dead deliveries", async () => {
    const requestId = randomUUID();
    const created = await kit.invoke(
      createFromOrder,
      {
        orderId: fixtures.orderExhaust,
        type: "payment_invoice",
      },
      {},
      { request: { requestId, idempotencyKey: randomUUID() } },
    );
    const delivery = await dispatchPdfDelivery(
      requestId,
      "sho-436-exhaust-dispatch",
    );
    const remaining = { count: DELIVERY_MAX_ATTEMPTS };
    const last = await exhaustPdfDelivery({
      eventId: delivery.eventId,
      claimedBy: "sho-436-exhaust",
      remainingFailures: remaining,
    });
    expect(remaining.count).toBe(0);
    expect(last.retryAt).toBeNull();
    expect(last.error).toBeInstanceOf(PdfGenerationRetryableError);
    if (!(last.error instanceof PdfGenerationRetryableError)) {
      throw new Error("expected PdfGenerationRetryableError");
    }
    expect(last.error.pdfDocumentId).toBe(created.documentId);
    expect(last.error.pdfCompanyId).toBe(kitIdentities.companies.a);
    expect(last.error.cause).toBeUndefined();
    expect(last.error.message).not.toContain("https://");
    expect(last.error.message).not.toContain("X-Amz-");
    await expect(
      kit.invoke(getArtifact, { documentId: created.documentId }),
    ).rejects.toBeInstanceOf(NotFoundError);

    await maybeFinalizeDeadPdfGeneration({
      pipeline: kit.pipeline,
      delivery,
      outcome: last,
      logger: silent,
      workerId: "sho-436-exhaust",
    });

    const artifact = await kit.invoke(getArtifact, {
      documentId: created.documentId,
    });
    expect(artifact).toEqual({ status: "failed", fileId: null });

    const markRows = await kit.db.runtime.db
      .select({
        companyId: auditLog.companyId,
        actorType: auditLog.actorType,
        actorId: auditLog.actorId,
        channel: auditLog.channel,
        targetType: auditLog.targetType,
        targetId: auditLog.targetId,
        inputHash: auditLog.inputHash,
        outcome: auditLog.outcome,
      })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "docGeneration.markFailed"),
          eq(auditLog.targetId, created.documentId),
        ),
      );
    expect(markRows).toEqual([
      {
        companyId: last.error.pdfCompanyId,
        actorType: "system",
        actorId: PDF_RENDERER_CONSUMER,
        channel: "system",
        targetType: "document",
        targetId: last.error.pdfDocumentId,
        inputHash: canonicalJsonSha256({
          documentId: last.error.pdfDocumentId,
        }),
        outcome: "ok",
      },
    ]);

    const keys = await kit.db.runtime.db
      .select({
        status: idempotencyKeys.status,
        principalKey: idempotencyKeys.principalKey,
        scopeKey: idempotencyKeys.scopeKey,
        key: idempotencyKeys.key,
        response: idempotencyKeys.response,
      })
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.action, "docGeneration.markFailed"),
          eq(
            idempotencyKeys.key,
            `docGeneration.markFailed:${delivery.eventId}`,
          ),
        ),
      );
    expect(keys).toEqual([
      {
        status: "completed",
        principalKey: `system:${PDF_RENDERER_CONSUMER}`,
        scopeKey: `company:${last.error.pdfCompanyId}`,
        key: `docGeneration.markFailed:${delivery.eventId}`,
        response: {
          status: "failed",
          fileId: null,
          documentId: created.documentId,
        },
      },
    ]);

    await maybeFinalizeDeadPdfGeneration({
      pipeline: kit.pipeline,
      delivery,
      outcome: last,
      logger: silent,
      workerId: "sho-436-exhaust",
    });
    const replayed = await kit.invoke(getArtifact, {
      documentId: created.documentId,
    });
    expect(replayed).toEqual({ status: "failed", fileId: null });
    const markRowsAfterReplay = await kit.db.runtime.db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "docGeneration.markFailed"),
          eq(auditLog.targetId, created.documentId),
        ),
      );
    expect(markRowsAfterReplay).toHaveLength(1);
  });

  it("does not overwrite a ready artifact", async () => {
    const requestId = randomUUID();
    const created = await kit.invoke(
      createFromOrder,
      {
        orderId: fixtures.orderReady,
        type: "payment_invoice",
      },
      {},
      { request: { requestId, idempotencyKey: randomUUID() } },
    );
    const delivery = await dispatchPdfDelivery(
      requestId,
      "sho-436-ready-dispatch",
    );
    const processed = await executeDelivery(kit.pipeline, {
      subscription: pdfRendererCreated,
      eventId: delivery.eventId,
      claimedBy: "sho-436-ready",
    });
    expect(processed).toEqual({ status: "processed" });
    const ready = await kit.invoke(getArtifact, {
      documentId: created.documentId,
    });
    expect(ready.status).toBe("ready");
    expect(ready.fileId).not.toBeNull();

    await maybeFinalizeDeadPdfGeneration({
      pipeline: kit.pipeline,
      delivery: {
        consumer: PDF_RENDERER_CONSUMER,
        eventId: randomUUID(),
        eventName: "documents.created",
      },
      outcome: {
        status: "failed",
        retryAt: null,
        error: toPdfGenerationRetryableError({
          documentId: created.documentId,
          companyId: kitIdentities.companies.a,
          cause: new CoreInvariantError(signedUrlMessage),
        }),
      },
      logger: silent,
      workerId: "sho-436-ready",
    });
    const again = await kit.invoke(getArtifact, {
      documentId: created.documentId,
    });
    expect(again).toEqual(ready);
  });

  it("does not persist failed for unwrapped NotFoundError after exhaustion", async () => {
    const requestId = randomUUID();
    const documentId = randomUUID();
    await kit.invoke(
      emitOrphanCreated,
      {
        documentId,
        orderId: randomUUID(),
      },
      {},
      { request: { requestId, idempotencyKey: randomUUID() } },
    );
    const delivery = await dispatchPdfDelivery(
      requestId,
      "sho-436-orphan-dispatch",
    );
    const nowMs = { value: Date.now() };
    const pipeline = { ...kit.pipeline, now: () => nowMs.value };
    let last: Awaited<ReturnType<typeof executeDelivery>> | undefined;
    for (let attempt = 1; attempt <= DELIVERY_MAX_ATTEMPTS; attempt += 1) {
      const outcome = await executeDelivery(pipeline, {
        subscription: pdfRendererCreated,
        eventId: delivery.eventId,
        claimedBy: "sho-436-orphan",
      });
      expect(outcome.status).toBe("failed");
      if (outcome.status !== "failed") {
        throw new Error("expected a failed delivery outcome");
      }
      last = outcome;
      if (attempt < DELIVERY_MAX_ATTEMPTS) {
        nowMs.value += DELIVERY_RETRY_BASE_MS * 2 ** (attempt - 1);
      }
    }
    if (last === undefined || last.status !== "failed") {
      throw new Error("expected a final failed delivery outcome");
    }
    expect(last.retryAt).toBeNull();
    expect(last.error).toBeInstanceOf(NotFoundError);
    expect(last.error).not.toBeInstanceOf(PdfGenerationRetryableError);

    const captured = captureLogger();
    await maybeFinalizeDeadPdfGeneration({
      pipeline: kit.pipeline,
      delivery,
      outcome: last,
      logger: captured.logger,
      workerId: "sho-436-orphan",
    });
    expect(captured.entries()).toEqual([
      expect.objectContaining({
        msg: "pdf delivery dead-lettered without document scope; replay-dead-deliveries recovers",
        error_code: "NOT_FOUND",
        event_id: delivery.eventId,
      }),
    ]);
    await expect(
      kit.invoke(getArtifact, { documentId }),
    ).rejects.toBeInstanceOf(NotFoundError);
    const markRows = await kit.db.runtime.db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "docGeneration.markFailed"),
          eq(auditLog.targetId, documentId),
        ),
      );
    expect(markRows).toHaveLength(0);
  });

  it("finalizes an actual pipeline TimeoutError after the existing retry budget", async () => {
    const restoreRender = hangPdfRender();
    const restoreTimeouts = capLongJsTimeouts(1_500);
    try {
      const requestId = randomUUID();
      const created = await kit.invoke(
        createFromOrder,
        {
          orderId: fixtures.orderTimeout,
          type: "payment_invoice",
        },
        {},
        { request: { requestId, idempotencyKey: randomUUID() } },
      );
      const delivery = await dispatchPdfDelivery(
        requestId,
        "sho-452-timeout-dispatch",
      );
      const nowMs = { value: Date.now() };
      const pipeline = { ...kit.pipeline, now: () => nowMs.value };
      let last: Awaited<ReturnType<typeof executeDelivery>> | undefined;
      for (let attempt = 1; attempt <= DELIVERY_MAX_ATTEMPTS; attempt += 1) {
        const outcome = await executeDelivery(pipeline, {
          subscription: pdfRendererCreated,
          eventId: delivery.eventId,
          claimedBy: "sho-452-timeout",
        });
        expect(outcome.status).toBe("failed");
        if (outcome.status !== "failed") {
          throw new Error("expected a failed delivery outcome");
        }
        last = outcome;
        expect(last.error).toBeInstanceOf(TimeoutError);
        expect(last.error).not.toBeInstanceOf(PdfGenerationRetryableError);
        if (attempt < DELIVERY_MAX_ATTEMPTS) {
          expect(last.retryAt).not.toBeNull();
          nowMs.value += DELIVERY_RETRY_BASE_MS * 2 ** (attempt - 1);
        } else {
          expect(last.retryAt).toBeNull();
        }
      }
      if (last === undefined || last.status !== "failed") {
        throw new Error("expected a final failed delivery outcome");
      }
      await expect(
        kit.invoke(getArtifact, { documentId: created.documentId }),
      ).rejects.toBeInstanceOf(NotFoundError);

      await maybeFinalizeDeadPdfGeneration({
        pipeline: kit.pipeline,
        delivery,
        outcome: last,
        logger: silent,
        workerId: "sho-452-timeout",
      });
      const artifact = await kit.invoke(getArtifact, {
        documentId: created.documentId,
      });
      expect(artifact).toEqual({ status: "failed", fileId: null });
    } finally {
      restoreTimeouts();
      restoreRender();
    }
  });

  it("does not markFailed on a non-final TimeoutError", async () => {
    const restoreRender = hangPdfRender();
    const restoreTimeouts = capLongJsTimeouts(1_500);
    try {
      const requestId = randomUUID();
      const created = await kit.invoke(
        createFromOrder,
        {
          orderId: fixtures.orderTimeoutEarly,
          type: "payment_invoice",
        },
        {},
        { request: { requestId, idempotencyKey: randomUUID() } },
      );
      const delivery = await dispatchPdfDelivery(
        requestId,
        "sho-452-timeout-early-dispatch",
      );
      const outcome = await executeDelivery(kit.pipeline, {
        subscription: pdfRendererCreated,
        eventId: delivery.eventId,
        claimedBy: "sho-452-timeout-early",
      });
      expect(outcome.status).toBe("failed");
      if (outcome.status !== "failed") {
        throw new Error("expected a failed delivery outcome");
      }
      expect(outcome.error).toBeInstanceOf(TimeoutError);
      expect(outcome.retryAt).not.toBeNull();
      await maybeFinalizeDeadPdfGeneration({
        pipeline: kit.pipeline,
        delivery,
        outcome,
        logger: silent,
        workerId: "sho-452-timeout-early",
      });
      await expect(
        kit.invoke(getArtifact, { documentId: created.documentId }),
      ).rejects.toBeInstanceOf(NotFoundError);
    } finally {
      restoreTimeouts();
      restoreRender();
    }
  });

  it("does not overwrite a ready artifact from a stale TimeoutError finalizer", async () => {
    const requestId = randomUUID();
    const created = await kit.invoke(
      createFromOrder,
      {
        orderId: fixtures.orderTimeoutRace,
        type: "payment_invoice",
      },
      {},
      { request: { requestId, idempotencyKey: randomUUID() } },
    );
    const delivery = await dispatchPdfDelivery(
      requestId,
      "sho-452-timeout-ready-dispatch",
    );
    const processed = await executeDelivery(kit.pipeline, {
      subscription: pdfRendererCreated,
      eventId: delivery.eventId,
      claimedBy: "sho-452-timeout-ready",
    });
    expect(processed).toEqual({ status: "processed" });
    const ready = await kit.invoke(getArtifact, {
      documentId: created.documentId,
    });
    expect(ready.status).toBe("ready");
    rememberPdfInvocationScope({
      eventId: delivery.eventId,
      documentId: created.documentId,
      companyId: kitIdentities.companies.a,
    });
    await maybeFinalizeDeadPdfGeneration({
      pipeline: kit.pipeline,
      delivery,
      outcome: {
        status: "failed",
        retryAt: null,
        error: new TimeoutError(),
      },
      logger: silent,
      workerId: "sho-452-timeout-ready",
    });
    const again = await kit.invoke(getArtifact, {
      documentId: created.documentId,
    });
    expect(again).toEqual(ready);
  });
});
