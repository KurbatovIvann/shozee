import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineActionContract } from "@showzy/core/contract";
import {
  DELIVERY_MAX_ATTEMPTS,
  DELIVERY_RETRY_BASE_MS,
  canonicalJsonSha256,
  dispatchOutboxBatch,
  executeAction,
  executeDelivery,
  findClaimableDeliveries,
  implementAction,
} from "@showzy/core";
import {
  ConflictError,
  CoreInvariantError,
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
} from "@showzy/core/errors";
import {
  atomicCallSuite,
  createCapturingLogger,
  createTestKit,
  crossTenantSuite,
  eventSuite,
  idempotencySuite,
  isolationCase,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import { auditLog, domainEvents } from "@showzy/db";
import { user } from "@showzy/db/schema/auth";
import { products } from "@showzy/db/schema/catalog";
import { companyLegalInfo, companyMembers } from "@showzy/db/schema/companies";
import { companyCustomers } from "@showzy/db/schema/customers";
import { documentGenerationJobs } from "@showzy/db/schema/doc-generation";
import {
  documentItems,
  documents,
  documentShareTokens,
} from "@showzy/db/schema/documents";
import { files } from "@showzy/db/schema/files";
import { orderItems, orders } from "@showzy/db/schema/orders";
import {
  createFromOrder,
  documentsCreated,
  getDocument,
  shareDocument,
} from "@showzy/documents";
import { configureDocumentShareOrigin } from "@showzy/documents/share-origin";
import { recordGeneratedObject } from "@showzy/files";
import {
  closeFilesObjectStore,
  configureFilesObjectStore,
  getFilesObjectStore,
  mapConfiguredFilesObjectStore,
} from "@showzy/files/storage";
import { sha256Hex } from "@showzy/module-kit/sha256";
import { and, count, eq, isNull } from "drizzle-orm";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { getArtifact } from "./get-artifact.js";
import { markFailed } from "./mark-failed.js";
import { renderPdf } from "./render-pdf.js";
import type { renderPdfInputSchema } from "./render-pdf.contract.js";
import { pdfRendererCreated } from "../events/pdf-renderer.js";
import { artifactFileId } from "../services/artifact-file-id.js";
import { PdfGenerationRetryableError } from "../services/pdf-retry.js";
import { putGeneratedPdf } from "../services/put-generated-pdf.js";
import { markJobFailed } from "../services/render-pdf.js";
import { requireWritable } from "../services/writable.js";
import { maybeFinalizeDeadPdfGeneration } from "../../../../../apps/worker/src/pdf-delivery.js";

const GARAGE_IMAGE = "dxflrs/garage:v2.3.0";
const GARAGE_BUCKET = "showzy";
const GARAGE_ACCESS_KEY = "showzy-local";
const GARAGE_SECRET_KEY = "showzy-local-secret";
const TEST_ORIGIN = "https://documents.test";
const sampleIban = "UA123456789012345678901234567";
const dummyPdf = new TextEncoder().encode("%PDF-1.4\n%%EOF\n");
const dummyChecksum = sha256Hex(dummyPdf);

type CreatedEnvelope = z.input<typeof renderPdfInputSchema>;

const fixtures = {
  customerA: randomUUID(),
  customerB: randomUUID(),
  productA: randomUUID(),
  productB: randomUUID(),
  orderEvent: randomUUID(),
  itemEvent: randomUUID(),
  isolationA: randomUUID(),
  isolationB: randomUUID(),
  invoice: randomUUID(),
  note: randomUUID(),
  fail: randomUUID(),
  pendingShare: randomUUID(),
  atomicFail: randomUUID(),
  atomicOk: randomUUID(),
  usd: randomUUID(),
  markIdempotent: randomUUID(),
  markConflict: randomUUID(),
  markFresh: randomUUID(),
  orderRetry: randomUUID(),
  itemRetry: randomUUID(),
  orderExhaust: randomUUID(),
  itemExhaust: randomUUID(),
};

const clerks = {
  employee: randomUUID(),
  noView: randomUUID(),
};

const sellerSnapshot = {
  kind: "seller" as const,
  name: "Konditerska Anna",
  prefix: "KA",
  companyType: "tov" as const,
  legalName: "ТОВ Альфа",
  edrpou: "12345678",
  legalAddress: "вул. Хрещатик, 1",
  iban: sampleIban,
  bankName: "ПриватБанк",
  bankMfo: "300001",
  bankEdrpou: "12345678",
  phone: "+380501111111",
  email: "legal@alpha.test",
};

const customerBuyerSnapshot = {
  kind: "customer" as const,
  displayName: "Customer A",
};

const counterpartyBuyerSnapshot = {
  kind: "counterparty" as const,
  name: "ТОВ Покупець",
  edrpou: "11223344",
  legalAddress: "вул. Покупця, 2",
  iban: "UA111111111111111111111111111",
  bankName: "Ощадбанк",
  bankMfo: "300335",
  phone: "+380502222222",
  email: "buyer@example.com",
  notes: "Linked buyer",
};

const contractDefaults = {
  aiExposure: "internal" as const,
  requiresConfirmation: false,
  atomicCalls: [] as const,
  atomicCallers: [] as const,
};

const emitCreatedThenFail = implementAction(
  defineActionContract({
    name: "documents.emitCreatedThenFailPdf",
    description:
      "Test-local emitter that fails after buffering documents.created.",
    principal: "staff",
    transport: "internal",
    input: z.object({ documentId: z.uuid() }),
    output: z.object({ documentId: z.uuid() }),
    permissions: ["documents:create"],
    aiExposure: "internal",
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
          orderId: fixtures.orderEvent,
          type: "payment_invoice",
          documentNumber: "KA-РХ-000000",
        },
      });
      throw new ConflictError("Injected emit-then-fail.");
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

const recordThenMaybeFail = implementAction(
  defineActionContract({
    name: "docGeneration.renderPdf",
    description:
      "Test-local renderPdf twin that can fail after recording the PDF.",
    principal: "system",
    systemScope: "tenant",
    transport: "internal",
    input: z.object({
      fileId: z.uuid(),
      purpose: z.literal("document"),
      mimeType: z.literal("application/pdf"),
      byteSize: z.number().int().positive(),
      checksumSha256: z.string().regex(/^[0-9a-f]{64}$/),
      documentId: z.uuid(),
      failAfterCall: z.boolean(),
    }),
    output: z.object({
      status: z.literal("ready"),
      fileId: z.uuid(),
      documentId: z.uuid(),
    }),
    permissions: [],
    aiExposure: "internal",
    risk: "write",
    requiresConfirmation: false,
    idempotent: true,
    emits: [],
    atomicCalls: ["files.recordGeneratedObject"],
    atomicCallers: [],
    audit: true,
    timeout: 15_000,
  }),
  {
    handler: async (input, ctx) => {
      if (ctx.scope !== "tenant") {
        throw new CoreInvariantError(
          "docGeneration.renderPdf twin expects tenant system",
        );
      }
      const recorded = await ctx.callAtomic(recordGeneratedObject, {
        fileId: input.fileId,
        purpose: input.purpose,
        mimeType: input.mimeType,
        byteSize: input.byteSize,
        checksumSha256: input.checksumSha256,
      });
      if (input.failAfterCall) {
        throw new ConflictError("Root failed after the atomic call.");
      }
      const db = requireWritable(ctx.db);
      await db.insert(documentGenerationJobs).values({
        companyId: ctx.companyId,
        documentId: input.documentId,
        status: "ready",
        fileId: recorded.fileId,
      });
      return {
        status: "ready" as const,
        fileId: recorded.fileId,
        documentId: input.documentId,
      };
    },
    auditTarget: () => ({ type: "document", id: "render-pdf-atomic-twin" }),
  },
);

const undeclaredTouch = implementAction(
  defineActionContract({
    ...contractDefaults,
    name: "kitCatalog.undeclaredTouch",
    description: "Write callee that is not on any atomic edge.",
    principal: "staff",
    transport: "internal",
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    permissions: ["kitCatalog:manageStock"],
    risk: "write",
    idempotent: false,
    emits: [],
    audit: true,
    timeout: 5_000,
  }),
  {
    handler: () => Promise.resolve({ ok: true }),
    auditTarget: () => ({ type: "stock", id: "undeclared" }),
  },
);

const confirmUndeclared = implementAction(
  defineActionContract({
    ...contractDefaults,
    name: "kitOrders.confirmUndeclared",
    description: "Root whose handler calls an undeclared atomic callee.",
    principal: "staff",
    transport: "client",
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    permissions: ["kitOrders:confirm"],
    risk: "write",
    idempotent: true,
    emits: [],
    atomicCalls: ["customers.applyInviteCrm"],
    audit: true,
    timeout: 5_000,
  }),
  {
    handler: async (_input, ctx) => {
      await ctx.callAtomic(undeclaredTouch, {});
      return { ok: true };
    },
    auditTarget: () => ({ type: "order", id: "undeclared" }),
  },
);

const mismatchStock = implementAction(
  defineActionContract({
    ...contractDefaults,
    name: "kitCatalog.mismatchStock",
    description: "Staff callee declared for a system atomic root (bug).",
    principal: "staff",
    transport: "internal",
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    permissions: ["kitCatalog:manageStock"],
    risk: "write",
    idempotent: false,
    emits: [],
    atomicCallers: ["kitOrders.confirmMismatch"],
    audit: true,
    timeout: 5_000,
  }),
  {
    handler: () => Promise.resolve({ ok: true }),
    auditTarget: () => ({ type: "stock", id: "mismatch" }),
  },
);

const confirmMismatch = implementAction(
  defineActionContract({
    ...contractDefaults,
    name: "kitOrders.confirmMismatch",
    description: "System root reaching a staff atomic callee (a bug).",
    principal: "system",
    systemScope: "tenant",
    transport: "internal",
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    permissions: [],
    risk: "write",
    idempotent: true,
    emits: [],
    atomicCalls: ["kitCatalog.mismatchStock"],
    audit: true,
    timeout: 5_000,
  }),
  {
    handler: async (_input, ctx) => {
      await ctx.callAtomic(mismatchStock, {});
      return { ok: true };
    },
    auditTarget: () => ({ type: "order", id: "mismatch" }),
  },
);

const nestedCallee = implementAction(
  defineActionContract({
    ...contractDefaults,
    name: "kitCatalog.nestedStock",
    description: "Declared callee that illegally nests another atomic call.",
    principal: "staff",
    transport: "internal",
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    permissions: ["kitCatalog:manageStock"],
    risk: "write",
    idempotent: false,
    emits: [],
    atomicCallers: ["kitOrders.confirmNested"],
    audit: true,
    timeout: 5_000,
  }),
  {
    handler: async (_input, ctx) => {
      await ctx.callAtomic(undeclaredTouch, {});
      return { ok: true };
    },
    auditTarget: () => ({ type: "stock", id: "nested" }),
  },
);

const confirmNested = implementAction(
  defineActionContract({
    ...contractDefaults,
    name: "kitOrders.confirmNested",
    description: "Root of a declared edge whose callee nests atomically.",
    principal: "staff",
    transport: "client",
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    permissions: ["kitOrders:confirm"],
    risk: "write",
    idempotent: true,
    emits: [],
    atomicCalls: ["kitCatalog.nestedStock"],
    audit: true,
    timeout: 5_000,
  }),
  {
    handler: async (_input, ctx) => {
      await ctx.callAtomic(nestedCallee, {});
      return { ok: true };
    },
    auditTarget: () => ({ type: "order", id: "nested" }),
  },
);

let kit: TestKit | undefined;
let garage: StartedTestContainer | undefined;
let garageEndpoint: string | undefined;
const seedOrderNumbers = new Map<string, number>();

function requireKit(): TestKit {
  if (kit === undefined) {
    throw new Error("doc-generation test kit was not started");
  }
  return kit;
}

function repoRoot(): string {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  while (!existsSync(path.join(directory, "pnpm-workspace.yaml"))) {
    const parent = path.dirname(directory);
    if (parent === directory) {
      throw new Error("repository root not found");
    }
    directory = parent;
  }
  return directory;
}

function garageS3Config(): {
  readonly endpoint: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly forcePathStyle: boolean;
  readonly bucket: string;
} {
  if (garageEndpoint === undefined) {
    throw new Error("garage endpoint is not configured");
  }
  return {
    endpoint: garageEndpoint,
    region: "us-east-1",
    accessKeyId: GARAGE_ACCESS_KEY,
    secretAccessKey: GARAGE_SECRET_KEY,
    forcePathStyle: true,
    bucket: GARAGE_BUCKET,
  };
}

async function waitForBucket(): Promise<void> {
  const store = getFilesObjectStore();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await store.probeBucket();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error("Garage bucket did not become ready");
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
  await requireKit()
    .db.runtime.db.insert(orders)
    .values({
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
  await requireKit().db.runtime.db.insert(orderItems).values({
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

async function insertSeedDocument(values: {
  id: string;
  companyId: string;
  customerId: string;
  productId: string;
  documentNumber: string;
  type?: "payment_invoice" | "delivery_note";
  buyer?: typeof customerBuyerSnapshot | typeof counterpartyBuyerSnapshot;
  currency?: "UAH" | "USD";
}): Promise<void> {
  const orderId = randomUUID();
  const orderItemId = randomUUID();
  const itemId = randomUUID();
  const type = values.type ?? "payment_invoice";
  const currency = values.currency ?? "UAH";
  await insertSeedOrder({
    id: orderId,
    itemId: orderItemId,
    companyId: values.companyId,
    customerId: values.customerId,
    productId: values.productId,
  });
  await requireKit()
    .db.runtime.db.insert(documents)
    .values({
      id: values.id,
      companyId: values.companyId,
      orderId,
      counterpartyId: null,
      type,
      status: "issued",
      documentNumber: values.documentNumber,
      issuedOn: "2026-03-15",
      supplierDetails: sellerSnapshot,
      buyerDetails: values.buyer ?? customerBuyerSnapshot,
      totalNetMinor: 250n,
      totalTaxMinor: 0n,
      totalGrossMinor: 250n,
      currency,
      templateSource: "system",
      templateName: type,
    });
  await requireKit().db.runtime.db.insert(documentItems).values({
    id: itemId,
    companyId: values.companyId,
    documentId: values.id,
    productId: values.productId,
    titleSnapshot: "Invoice line",
    quantityMilli: 1000n,
    unitPriceMinor: 250n,
    taxTreatment: "exempt",
    netAmountMinor: 250n,
    grossAmountMinor: 250n,
    currency,
  });
}

function createdEnvelope(values: {
  readonly documentId: string;
  readonly type: "payment_invoice" | "delivery_note";
  readonly documentNumber: string;
}): CreatedEnvelope {
  const eventId = randomUUID();
  return {
    eventId,
    name: "documents.created",
    version: 1,
    occurredAt: new Date().toISOString(),
    companyId: kitIdentities.companies.a,
    aggregate: { type: "document", id: values.documentId, sequence: "1" },
    actor: { type: "user", id: kitIdentities.users.anna, channel: "ui" },
    requestId: randomUUID(),
    correlationId: randomUUID(),
    causationId: eventId,
    payload: {
      documentId: values.documentId,
      orderId: fixtures.orderEvent,
      type: values.type,
      documentNumber: values.documentNumber,
    },
  };
}

async function countReadyJobs(): Promise<number> {
  const rows = await requireKit()
    .db.runtime.db.select({ value: count() })
    .from(documentGenerationJobs)
    .where(
      and(
        eq(documentGenerationJobs.companyId, kitIdentities.companies.a),
        eq(documentGenerationJobs.status, "ready"),
      ),
    );
  return rows[0]?.value ?? 0;
}

async function countDocumentFiles(): Promise<number> {
  const rows = await requireKit()
    .db.runtime.db.select({ value: count() })
    .from(files)
    .where(
      and(
        eq(files.companyId, kitIdentities.companies.a),
        eq(files.purpose, "document"),
      ),
    );
  return rows[0]?.value ?? 0;
}

function recordInput(documentId: string): {
  readonly fileId: string;
  readonly purpose: "document";
  readonly mimeType: "application/pdf";
  readonly byteSize: number;
  readonly checksumSha256: string;
  readonly documentId: string;
  readonly failAfterCall: boolean;
} {
  return {
    fileId: artifactFileId(documentId),
    purpose: "document",
    mimeType: "application/pdf",
    byteSize: dummyPdf.byteLength,
    checksumSha256: dummyChecksum,
    documentId,
    failAfterCall: false,
  };
}

function withPutObjectFailures(remaining: { count: number }): () => void {
  return mapConfiguredFilesObjectStore((store) => ({
    signPut: (input) => store.signPut(input),
    signGet: (input) => store.signGet(input),
    headObject: (key) => store.headObject(key),
    getObject: (key) => store.getObject(key),
    putObject: async (input) => {
      if (remaining.count > 0) {
        remaining.count -= 1;
        throw new CoreInvariantError(
          `injected storage outage https://garage.example/${input.key}?X-Amz-Signature=test-secret`,
        );
      }
      return store.putObject(input);
    },
    copyObject: (input) => store.copyObject(input),
    deleteObject: (key) => store.deleteObject(key),
    probeBucket: () => store.probeBucket(),
    close: () => {
      store.close();
    },
  }));
}

async function dispatchPdfCreated(requestId: string): Promise<string> {
  const rows = await requireKit()
    .db.runtime.db.select({ id: domainEvents.id, name: domainEvents.name })
    .from(domainEvents)
    .where(eq(domainEvents.requestId, requestId));
  const match = rows.filter((row) => row.name === "documents.created");
  const eventId = match[0]?.id;
  if (match.length !== 1 || eventId === undefined) {
    throw new Error("expected one documents.created outbox row");
  }
  await dispatchOutboxBatch(
    { db: requireKit().db.runtime.db },
    { subscriptions: [pdfRendererCreated], claimedBy: "sho-436-dispatch" },
  );
  return eventId;
}

async function countFailedJobs(): Promise<number> {
  const rows = await requireKit()
    .db.runtime.db.select({ value: count() })
    .from(documentGenerationJobs)
    .where(
      and(
        eq(documentGenerationJobs.companyId, kitIdentities.companies.a),
        eq(documentGenerationJobs.status, "failed"),
      ),
    );
  return rows[0]?.value ?? 0;
}

beforeAll(async () => {
  const garageToml = readFileSync(
    path.join(repoRoot(), "docker/garage/garage.toml"),
    "utf8",
  ).replaceAll("\r\n", "\n");
  const startedGarage = await new GenericContainer(GARAGE_IMAGE)
    .withCommand(["/garage", "server", "--single-node", "--default-bucket"])
    .withEnvironment({
      GARAGE_ALLOW_WORLD_READABLE_SECRETS: "true",
      GARAGE_DEFAULT_ACCESS_KEY: GARAGE_ACCESS_KEY,
      GARAGE_DEFAULT_SECRET_KEY: GARAGE_SECRET_KEY,
      GARAGE_DEFAULT_BUCKET: GARAGE_BUCKET,
    })
    .withCopyContentToContainer([
      {
        content: garageToml,
        target: "/etc/garage.toml",
      },
    ])
    .withTmpFs({
      "/var/lib/garage/meta": "rw,noexec,nosuid,size=64m",
      "/var/lib/garage/data": "rw,noexec,nosuid,size=256m",
    })
    .withExposedPorts(3900)
    .withWaitStrategy(Wait.forLogMessage(/S3 API server listening/))
    .withStartupTimeout(120_000)
    .start();
  garage = startedGarage;
  garageEndpoint = `http://127.0.0.1:${String(startedGarage.getMappedPort(3900))}`;
  configureFilesObjectStore(garageS3Config());
  await waitForBucket();

  configureDocumentShareOrigin(TEST_ORIGIN);
  kit = await createTestKit();
  const companyA = kitIdentities.companies.a;
  const companyB = kitIdentities.companies.b;

  await requireKit()
    .db.runtime.db.insert(companyLegalInfo)
    .values([
      {
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
      },
      {
        companyId: companyB,
        companyType: "fop",
        legalName: "ФОП Борис",
        edrpou: "87654321",
      },
    ]);

  await requireKit()
    .db.runtime.db.insert(companyCustomers)
    .values([
      {
        id: fixtures.customerA,
        companyId: companyA,
        name: "Customer A",
        email: `customer-${fixtures.customerA}@example.com`,
      },
      {
        id: fixtures.customerB,
        companyId: companyB,
        name: "Customer B",
        email: `customer-${fixtures.customerB}@example.com`,
      },
    ]);
  await requireKit()
    .db.runtime.db.insert(products)
    .values([
      {
        id: fixtures.productA,
        companyId: companyA,
        name: "Cake",
        basePriceMinor: 250n,
      },
      {
        id: fixtures.productB,
        companyId: companyB,
        name: "Foreign cake",
        basePriceMinor: 100n,
      },
    ]);

  await insertSeedOrder({
    id: fixtures.orderEvent,
    itemId: fixtures.itemEvent,
    companyId: companyA,
    customerId: fixtures.customerA,
    productId: fixtures.productA,
  });
  await insertSeedDocument({
    id: fixtures.isolationA,
    companyId: companyA,
    customerId: fixtures.customerA,
    productId: fixtures.productA,
    documentNumber: "KA-РХ-000901",
  });
  await insertSeedDocument({
    id: fixtures.isolationB,
    companyId: companyB,
    customerId: fixtures.customerB,
    productId: fixtures.productB,
    documentNumber: "MB-РХ-000901",
  });
  await insertSeedDocument({
    id: fixtures.invoice,
    companyId: companyA,
    customerId: fixtures.customerA,
    productId: fixtures.productA,
    documentNumber: "KA-РХ-000902",
  });
  await insertSeedDocument({
    id: fixtures.note,
    companyId: companyA,
    customerId: fixtures.customerA,
    productId: fixtures.productA,
    documentNumber: "KA-ВН-000902",
    type: "delivery_note",
    buyer: counterpartyBuyerSnapshot,
  });
  await insertSeedDocument({
    id: fixtures.fail,
    companyId: companyA,
    customerId: fixtures.customerA,
    productId: fixtures.productA,
    documentNumber: "KA-РХ-000903",
  });
  await insertSeedDocument({
    id: fixtures.pendingShare,
    companyId: companyA,
    customerId: fixtures.customerA,
    productId: fixtures.productA,
    documentNumber: "KA-РХ-000906",
  });
  await insertSeedDocument({
    id: fixtures.atomicFail,
    companyId: companyA,
    customerId: fixtures.customerA,
    productId: fixtures.productA,
    documentNumber: "KA-РХ-000904",
  });
  await insertSeedDocument({
    id: fixtures.atomicOk,
    companyId: companyA,
    customerId: fixtures.customerA,
    productId: fixtures.productA,
    documentNumber: "KA-РХ-000905",
  });
  await insertSeedDocument({
    id: fixtures.usd,
    companyId: companyA,
    customerId: fixtures.customerA,
    productId: fixtures.productA,
    documentNumber: "KA-РХ-000907",
    currency: "USD",
  });
  await insertSeedDocument({
    id: fixtures.markIdempotent,
    companyId: companyA,
    customerId: fixtures.customerA,
    productId: fixtures.productA,
    documentNumber: "KA-РХ-000908",
  });
  await insertSeedDocument({
    id: fixtures.markConflict,
    companyId: companyA,
    customerId: fixtures.customerA,
    productId: fixtures.productA,
    documentNumber: "KA-РХ-000909",
  });
  await insertSeedDocument({
    id: fixtures.markFresh,
    companyId: companyA,
    customerId: fixtures.customerA,
    productId: fixtures.productA,
    documentNumber: "KA-РХ-000910",
  });
  await insertSeedOrder({
    id: fixtures.orderRetry,
    itemId: fixtures.itemRetry,
    companyId: companyA,
    customerId: fixtures.customerA,
    productId: fixtures.productA,
  });
  await insertSeedOrder({
    id: fixtures.orderExhaust,
    itemId: fixtures.itemExhaust,
    companyId: companyA,
    customerId: fixtures.customerA,
    productId: fixtures.productA,
  });

  await putGeneratedPdf({
    companyId: companyA,
    fileId: artifactFileId(fixtures.atomicFail),
    bytes: dummyPdf,
  });
  await putGeneratedPdf({
    companyId: companyA,
    fileId: artifactFileId(fixtures.atomicOk),
    bytes: dummyPdf,
  });

  await requireKit()
    .db.runtime.db.insert(user)
    .values([
      {
        id: clerks.employee,
        name: "Employee view",
        email: "employee-view@doc-gen-kit.test",
      },
      {
        id: clerks.noView,
        name: "No documents view",
        email: "noview@doc-gen-kit.test",
      },
    ]);
  await requireKit()
    .db.runtime.db.insert(companyMembers)
    .values([
      {
        companyId: companyA,
        userId: clerks.employee,
        role: "employee",
        permissions: { granted: ["documents:view"], denied: [] },
      },
      {
        companyId: companyA,
        userId: clerks.noView,
        role: "employee",
        permissions: { granted: [], denied: ["documents:view"] },
      },
    ]);
}, 180_000);

afterAll(async () => {
  if (kit !== undefined) {
    await requireKit().db.close();
  }
  closeFilesObjectStore();
  if (garage !== undefined) {
    await garage.stop();
  }
});

crossTenantSuite(requireKit, [
  isolationCase(
    renderPdf,
    {
      input: createdEnvelope({
        documentId: fixtures.isolationA,
        type: "payment_invoice",
        documentNumber: "KA-РХ-000901",
      }),
    },
    {
      input: createdEnvelope({
        documentId: fixtures.isolationB,
        type: "payment_invoice",
        documentNumber: "MB-РХ-000901",
      }),
    },
  ),
  isolationCase(
    markFailed,
    { input: { documentId: fixtures.isolationA } },
    { input: { documentId: fixtures.isolationB } },
  ),
]);

eventSuite(requireKit, {
  module: "docGeneration",
  emitAction: createFromOrder,
  emitInput: { orderId: fixtures.orderEvent, type: "payment_invoice" },
  failingEmitAction: emitCreatedThenFail,
  failingEmitInput: { documentId: randomUUID() },
  eventName: "documents.created",
  subscription: pdfRendererCreated,
  readProjection: countReadyJobs,
});

idempotencySuite(requireKit, [
  {
    action: markFailed,
    input: { documentId: fixtures.markIdempotent },
    conflictingInput: { documentId: fixtures.markConflict },
    freshInput: () => ({ documentId: fixtures.markFresh }),
    readEffect: countFailedJobs,
  },
]);

atomicCallSuite(requireKit, [
  {
    root: recordThenMaybeFail,
    successInput: recordInput(fixtures.atomicOk),
    failureInput: {
      ...recordInput(fixtures.atomicFail),
      failAfterCall: true,
    },
    readRootEffect: countReadyJobs,
    readCalleeEffect: countDocumentFiles,
    undeclared: { action: confirmUndeclared, input: {} },
    mismatch: { action: confirmMismatch, input: {} },
    nested: { action: confirmNested, input: {} },
  },
]);

describe("docGeneration.renderPdf garage", () => {
  it("renders invoice and delivery note to purpose=document files", async () => {
    const invoice = await requireKit().invoke(
      renderPdf,
      createdEnvelope({
        documentId: fixtures.invoice,
        type: "payment_invoice",
        documentNumber: "KA-РХ-000902",
      }),
    );
    const note = await requireKit().invoke(
      renderPdf,
      createdEnvelope({
        documentId: fixtures.note,
        type: "delivery_note",
        documentNumber: "KA-ВН-000902",
      }),
    );
    expect(invoice.status).toBe("ready");
    expect(note.status).toBe("ready");
    expect(invoice.fileId).toBe(artifactFileId(fixtures.invoice));
    expect(note.fileId).toBe(artifactFileId(fixtures.note));
    if (invoice.fileId === null || note.fileId === null) {
      throw new Error("expected ready file ids");
    }

    const [invoiceFile] = await requireKit()
      .db.runtime.db.select()
      .from(files)
      .where(eq(files.id, invoice.fileId));
    const [noteFile] = await requireKit()
      .db.runtime.db.select()
      .from(files)
      .where(eq(files.id, note.fileId));
    expect(invoiceFile?.purpose).toBe("document");
    expect(noteFile?.purpose).toBe("document");
    expect(invoiceFile?.mimeType).toBe("application/pdf");
    expect(invoiceFile?.uploadedByUserId).toBeNull();
    expect(invoiceFile?.objectKey).toBe(
      `${kitIdentities.companies.a}/documents/${invoice.fileId}`,
    );
    expect(noteFile?.objectKey).toBe(
      `${kitIdentities.companies.a}/documents/${note.fileId}`,
    );
  });

  it("retries the same document without a second files row", async () => {
    const first = await requireKit().invoke(
      renderPdf,
      createdEnvelope({
        documentId: fixtures.invoice,
        type: "payment_invoice",
        documentNumber: "KA-РХ-000902",
      }),
    );
    const second = await requireKit().invoke(
      renderPdf,
      createdEnvelope({
        documentId: fixtures.invoice,
        type: "payment_invoice",
        documentNumber: "KA-РХ-000902",
      }),
    );
    expect(first.fileId).toBe(second.fileId);
    if (first.fileId === null) {
      throw new Error("expected a ready file id");
    }
    const rows = await requireKit()
      .db.runtime.db.select({ id: files.id })
      .from(files)
      .where(eq(files.id, first.fileId));
    expect(rows).toHaveLength(1);
  });

  it("issues a panel PDF URL for documents:view without files:view", async () => {
    const panel = await requireKit().invoke(
      getDocument,
      { documentId: fixtures.invoice },
      {
        userId: clerks.employee,
        companyId: kitIdentities.companies.a,
      },
    );
    expect(panel.generation.status).toBe("ready");
    expect(panel.generation.fileId).toBe(artifactFileId(fixtures.invoice));
    expect(panel.pdfDownloadUrl).toMatch(/^https?:\/\//);

    await expect(
      requireKit().invoke(
        getArtifact,
        { documentId: fixtures.invoice },
        {
          userId: clerks.noView,
          companyId: kitIdentities.companies.a,
        },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("share mints when the artifact is ready and stays null when it is not", async () => {
    const readyShare = await requireKit().invoke(shareDocument, {
      documentId: fixtures.invoice,
    });
    expect(readyShare.url).toMatch(/^https:\/\/documents\.test\/d\//);

    const [readyToken] = await requireKit()
      .db.runtime.db.select()
      .from(documentShareTokens)
      .where(
        and(
          eq(documentShareTokens.documentId, fixtures.invoice),
          isNull(documentShareTokens.revokedAt),
        ),
      );
    expect(readyToken?.pdfDownloadUrl).toMatch(/^https?:\/\//);

    const pendingShare = await requireKit().invoke(shareDocument, {
      documentId: fixtures.pendingShare,
    });
    expect(pendingShare.url).toMatch(/^https:\/\/documents\.test\/d\//);
    const [pendingToken] = await requireKit()
      .db.runtime.db.select()
      .from(documentShareTokens)
      .where(
        and(
          eq(documentShareTokens.documentId, fixtures.pendingShare),
          isNull(documentShareTokens.revokedAt),
        ),
      );
    expect(pendingToken?.pdfDownloadUrl).toBeNull();
  });

  it("one storage failure throws and does not persist a failed job", async () => {
    const captured = createCapturingLogger();
    const restore = withPutObjectFailures({ count: 1 });
    try {
      await expect(
        requireKit().invoke(
          renderPdf,
          createdEnvelope({
            documentId: fixtures.fail,
            type: "payment_invoice",
            documentNumber: "KA-РХ-000903",
          }),
          {},
          { deps: { ...requireKit().pipeline, logger: captured.logger } },
        ),
      ).rejects.toBeInstanceOf(PdfGenerationRetryableError);
      await expect(
        requireKit().invoke(getArtifact, { documentId: fixtures.fail }),
      ).rejects.toBeInstanceOf(NotFoundError);
      const leftover = await requireKit()
        .db.runtime.db.select()
        .from(files)
        .where(eq(files.id, artifactFileId(fixtures.fail)));
      expect(leftover).toHaveLength(0);
      const payload = JSON.stringify(captured.entries());
      expect(payload).toContain("docGeneration.renderPdf failed");
      expect(payload).toContain("retryable");
      expect(payload).toContain(fixtures.fail);
      expect(payload).not.toContain("https://");
      expect(payload).not.toContain("X-Amz-");
      expect(payload).not.toContain("garage.example");
      expect(payload).not.toContain("test-secret");
      expect(payload).not.toContain(GARAGE_SECRET_KEY);
    } finally {
      restore();
    }
  });

  it("retries after a successful PUT when metadata recording fails", async () => {
    const remaining = { count: 1 };
    const restore = mapConfiguredFilesObjectStore((store) => ({
      signPut: (input) => store.signPut(input),
      signGet: (input) => store.signGet(input),
      headObject: (key) => store.headObject(key),
      getObject: async (key) => {
        if (remaining.count > 0) {
          remaining.count -= 1;
          throw new CoreInvariantError("injected getObject outage");
        }
        return store.getObject(key);
      },
      putObject: (input) => store.putObject(input),
      copyObject: (input) => store.copyObject(input),
      deleteObject: (key) => store.deleteObject(key),
      probeBucket: () => store.probeBucket(),
      close: () => {
        store.close();
      },
    }));
    try {
      await expect(
        requireKit().invoke(
          renderPdf,
          createdEnvelope({
            documentId: fixtures.fail,
            type: "payment_invoice",
            documentNumber: "KA-РХ-000903",
          }),
        ),
      ).rejects.toBeInstanceOf(PdfGenerationRetryableError);
      expect(remaining.count).toBe(0);
      const first = await requireKit().invoke(
        renderPdf,
        createdEnvelope({
          documentId: fixtures.fail,
          type: "payment_invoice",
          documentNumber: "KA-РХ-000903",
        }),
      );
      expect(first.status).toBe("ready");
      expect(first.fileId).toBe(artifactFileId(fixtures.fail));
      const second = await requireKit().invoke(
        renderPdf,
        createdEnvelope({
          documentId: fixtures.fail,
          type: "payment_invoice",
          documentNumber: "KA-РХ-000903",
        }),
      );
      expect(second.fileId).toBe(first.fileId);
      const rows = await requireKit()
        .db.runtime.db.select({ id: files.id })
        .from(files)
        .where(eq(files.id, artifactFileId(fixtures.fail)));
      expect(rows).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it("terminal snapshot errors persist failed without retrying", async () => {
    const result = await requireKit().invoke(
      renderPdf,
      createdEnvelope({
        documentId: fixtures.usd,
        type: "payment_invoice",
        documentNumber: "KA-РХ-000907",
      }),
    );
    expect(result).toEqual({
      status: "failed",
      fileId: null,
      documentId: fixtures.usd,
    });
    const artifact = await requireKit().invoke(getArtifact, {
      documentId: fixtures.usd,
    });
    expect(artifact).toEqual({ status: "failed", fileId: null });
  });

  it("does not overwrite a ready artifact with markFailed", async () => {
    const ready = await requireKit().invoke(getArtifact, {
      documentId: fixtures.invoice,
    });
    expect(ready.status).toBe("ready");
    const finalized = await requireKit().invoke(markFailed, {
      documentId: fixtures.invoice,
    });
    expect(finalized.status).toBe("ready");
    expect(finalized.fileId).toBe(ready.fileId);
    const again = await requireKit().invoke(getArtifact, {
      documentId: fixtures.invoice,
    });
    expect(again).toEqual(ready);
  });

  it("terminal markJobFailed returns a concurrent ready row", async () => {
    const ready = await requireKit().invoke(getArtifact, {
      documentId: fixtures.invoice,
    });
    expect(ready.status).toBe("ready");
    expect(ready.fileId).not.toBeNull();
    const ctx = await requireKit().buildTestContext("system");
    if (ctx.principal !== "system" || ctx.scope !== "tenant") {
      throw new Error("expected tenant system context");
    }
    const outcome = await markJobFailed(ctx, fixtures.invoice);
    expect(outcome).toEqual({
      status: "ready",
      fileId: ready.fileId,
      documentId: fixtures.invoice,
    });
    const again = await requireKit().invoke(getArtifact, {
      documentId: fixtures.invoice,
    });
    expect(again).toEqual(ready);
  });

  it("rejects staff callers and invalid markFailed input", async () => {
    await expect(
      executeAction(requireKit().pipeline, {
        action: markFailed,
        input: { documentId: fixtures.markIdempotent },
        request: {
          requestId: randomUUID(),
          correlationId: randomUUID(),
          channel: "ui",
        },
        principal: {
          mode: "staff",
          session: { userId: kitIdentities.users.anna },
          companySelector: kitIdentities.companies.a,
        },
      }),
    ).rejects.toBeInstanceOf(CoreInvariantError);
    await expect(
      requireKit().invoke(markFailed, { documentId: "not-a-uuid" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("docGeneration.renderPdf delivery retry (SHO-436)", () => {
  it("does not ACK a transient storage failure; a scheduled retry becomes ready", async () => {
    const requestId = randomUUID();
    const created = await requireKit().invoke(
      createFromOrder,
      { orderId: fixtures.orderRetry, type: "payment_invoice" },
      {},
      { request: { requestId, idempotencyKey: randomUUID() } },
    );
    const eventId = await dispatchPdfCreated(requestId);
    const nowMs = { value: Date.now() };
    const pipeline = { ...requireKit().pipeline, now: () => nowMs.value };
    const restore = withPutObjectFailures({ count: 1 });
    let first: Awaited<ReturnType<typeof executeDelivery>>;
    try {
      first = await executeDelivery(pipeline, {
        subscription: pdfRendererCreated,
        eventId,
        claimedBy: "sho-436-retry",
      });
    } finally {
      restore();
    }
    expect(first.status).toBe("failed");
    if (first.status !== "failed") {
      throw new Error("expected a failed delivery outcome");
    }
    expect(first.retryAt).toBe(
      new Date(nowMs.value + DELIVERY_RETRY_BASE_MS).toISOString(),
    );
    expect(first.error).toBeInstanceOf(PdfGenerationRetryableError);
    await expect(
      requireKit().invoke(getArtifact, { documentId: created.documentId }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(
      await findClaimableDeliveries(
        { db: requireKit().db.runtime.db },
        { subscriptions: [pdfRendererCreated], now: () => nowMs.value },
      ),
    ).not.toContainEqual({
      consumer: pdfRendererCreated.consumer,
      eventId,
      eventName: "documents.created",
    });
    nowMs.value += DELIVERY_RETRY_BASE_MS;
    const second = await executeDelivery(pipeline, {
      subscription: pdfRendererCreated,
      eventId,
      claimedBy: "sho-436-retry",
    });
    expect(second).toEqual({ status: "processed" });
    const artifact = await requireKit().invoke(getArtifact, {
      documentId: created.documentId,
    });
    expect(artifact.status).toBe("ready");
    expect(artifact.fileId).toBe(artifactFileId(created.documentId));
    const replay = await executeDelivery(pipeline, {
      subscription: pdfRendererCreated,
      eventId,
      claimedBy: "sho-436-retry",
    });
    expect(replay.status).toBe("alreadyProcessed");
    const filesRows = await requireKit()
      .db.runtime.db.select({ id: files.id })
      .from(files)
      .where(eq(files.id, artifactFileId(created.documentId)));
    expect(filesRows).toHaveLength(1);
  });

  it("exhausts the delivery budget and persists failed through the worker finalizer", async () => {
    const requestId = randomUUID();
    const created = await requireKit().invoke(
      createFromOrder,
      { orderId: fixtures.orderExhaust, type: "payment_invoice" },
      {},
      { request: { requestId, idempotencyKey: randomUUID() } },
    );
    const eventId = await dispatchPdfCreated(requestId);
    const nowMs = { value: Date.now() };
    const pipeline = { ...requireKit().pipeline, now: () => nowMs.value };
    const remaining = { count: DELIVERY_MAX_ATTEMPTS };
    const restore = withPutObjectFailures(remaining);
    let last: Awaited<ReturnType<typeof executeDelivery>> | undefined;
    try {
      for (let attempt = 1; attempt <= DELIVERY_MAX_ATTEMPTS; attempt += 1) {
        const outcome = await executeDelivery(pipeline, {
          subscription: pdfRendererCreated,
          eventId,
          claimedBy: "sho-436-exhaust",
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
    expect(remaining.count).toBe(0);
    if (last === undefined || last.status !== "failed") {
      throw new Error("expected a final failed delivery outcome");
    }
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
      requireKit().invoke(getArtifact, { documentId: created.documentId }),
    ).rejects.toBeInstanceOf(NotFoundError);

    const delivery = {
      consumer: pdfRendererCreated.consumer,
      eventId,
      eventName: "documents.created" as const,
    };
    await maybeFinalizeDeadPdfGeneration({
      pipeline: requireKit().pipeline,
      delivery,
      outcome: last,
      logger: requireKit().pipeline.logger,
      workerId: "sho-436-exhaust",
    });
    const artifact = await requireKit().invoke(getArtifact, {
      documentId: created.documentId,
    });
    expect(artifact).toEqual({ status: "failed", fileId: null });

    const markRows = await requireKit()
      .db.runtime.db.select({
        companyId: auditLog.companyId,
        actorId: auditLog.actorId,
        channel: auditLog.channel,
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
        actorId: pdfRendererCreated.consumer,
        channel: "system",
        targetId: last.error.pdfDocumentId,
        inputHash: canonicalJsonSha256({
          documentId: last.error.pdfDocumentId,
        }),
        outcome: "ok",
      },
    ]);

    await maybeFinalizeDeadPdfGeneration({
      pipeline: requireKit().pipeline,
      delivery,
      outcome: last,
      logger: requireKit().pipeline.logger,
      workerId: "sho-436-exhaust",
    });
    const replayed = await requireKit().invoke(getArtifact, {
      documentId: created.documentId,
    });
    expect(replayed).toEqual({ status: "failed", fileId: null });

    const ready = await requireKit().invoke(getArtifact, {
      documentId: fixtures.invoice,
    });
    expect(ready.status).toBe("ready");
    await maybeFinalizeDeadPdfGeneration({
      pipeline: requireKit().pipeline,
      delivery: {
        consumer: pdfRendererCreated.consumer,
        eventId: randomUUID(),
        eventName: "documents.created",
      },
      outcome: {
        status: "failed",
        retryAt: null,
        error: new PdfGenerationRetryableError({
          documentId: fixtures.invoice,
          companyId: kitIdentities.companies.a,
          reason: "Error: stale finalizer",
        }),
      },
      logger: requireKit().pipeline.logger,
      workerId: "sho-436-exhaust",
    });
    const invoiceAgain = await requireKit().invoke(getArtifact, {
      documentId: fixtures.invoice,
    });
    expect(invoiceAgain).toEqual(ready);

    expect(
      await findClaimableDeliveries(
        { db: requireKit().db.runtime.db },
        { subscriptions: [pdfRendererCreated], now: () => nowMs.value },
      ),
    ).not.toContainEqual({
      consumer: pdfRendererCreated.consumer,
      eventId,
      eventName: "documents.created",
    });
  });
});
