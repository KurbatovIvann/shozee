import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { implementAction } from "@showzy/core";
import { defineActionContract } from "@showzy/core/contract";
import {
  ConflictError,
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
} from "@showzy/core/errors";
import {
  atomicCallSuite,
  createCapturingLogger,
  createTestKit,
  crossTenantSuite,
  idempotencySuite,
  isolationCase,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import { auditLog, domainEvents } from "@showzy/db";
import { user } from "@showzy/db/schema/auth";
import { products } from "@showzy/db/schema/catalog";
import { companyMembers } from "@showzy/db/schema/companies";
import { companyCustomers } from "@showzy/db/schema/customers";
import { documentGenerationJobs } from "@showzy/db/schema/doc-generation";
import {
  signingRequests,
  signingSignatures,
} from "@showzy/db/schema/doc-signing";
import { documentItems, documents } from "@showzy/db/schema/documents";
import { files } from "@showzy/db/schema/files";
import { orderItems, orders } from "@showzy/db/schema/orders";
import { cancelDocument } from "@showzy/documents";
import {
  ASIC_E_MIMETYPE,
  getSharedNodeAdapter,
  packAsicE,
  sha256Hex,
} from "@showzy/document-signing/node";
import { createSignedAsicE } from "@showzy/document-signing/testing";
import {
  getSigningUploadUrl,
  recordSigningObject,
  requestSigningUpload,
} from "@showzy/files";
import {
  closeFilesObjectStore,
  configureFilesObjectStore,
  getFilesObjectStore,
  mapConfiguredFilesObjectStore,
} from "@showzy/files/storage";
import { waitForObjectVisibility } from "@showzy/files/testing";
import { and, count, eq } from "drizzle-orm";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { SIGN_REQUEST_TTL_MS } from "./start.contract.js";
import { ALREADY_SIGNED_MESSAGE, GRANT_EXPIRED_MESSAGE } from "./start.js";
import {
  completeSigning,
  INVALID_ASIC_MESSAGE,
  PAYLOAD_MISMATCH_MESSAGE,
} from "./complete.js";
import { requireStaffWritable } from "../services/writable.js";

const GARAGE_IMAGE = "dxflrs/garage:v2.3.0";
const GARAGE_BUCKET = "showzy";
const GARAGE_ACCESS_KEY = "showzy-local";
const GARAGE_SECRET_KEY = "showzy-local-secret";
const SIGNING_MIME = "application/vnd.etsi.asic-e+zip" as const;
const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

const jpegBytes = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01,
  0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);

const payloadPdf = {
  name: "document.pdf",
  bytes: new TextEncoder().encode("%PDF-1.4\ncomplete-fixture\n%%EOF\n"),
};

const otherPayloadSha256 = sha256Hex(
  new TextEncoder().encode("%PDF-1.4\nother-payload\n%%EOF\n"),
);

const fixtures = {
  customerA: randomUUID(),
  customerB: randomUUID(),
  productA: randomUUID(),
  productB: randomUUID(),
  asicSigned: randomUUID(),
  signatureSigned: randomUUID(),
};

const clerks = {
  employee: randomUUID(),
};

const ids = {
  isolationA: seedIds(),
  isolationB: seedIds(),
  idempotent: seedIds(),
  idempotentConflict: seedIds(),
  idempotentFresh: seedIds(),
  atomicOk: seedIds(),
  atomicFail: seedIds(),
  happy: seedIds(),
  replay: seedIds(),
  secondSign: seedIds(),
  mismatch: seedIds(),
  invalidAsic: seedIds(),
  wrongMime: seedIds(),
  tooLarge: seedIds(),
  foreignFile: seedIds(),
  cancelled: seedIds(),
  grantExpired: seedIds(),
  deny: seedIds(),
  uniqueRace: seedIds(),
  promoteRetry: seedIds(),
  cancelRace: seedIds(),
  cancelConcurrent: seedIds(),
};

const sellerSnapshot = {
  kind: "seller" as const,
  name: "Konditerska Anna",
  prefix: "KA",
  companyType: "tov" as const,
  legalName: "ТОВ Альфа",
  edrpou: "12345678",
  legalAddress: "вул. Хрещатик, 1",
  iban: "UA123456789012345678901234567",
  bankName: "ПриватБанк",
  bankMfo: "300001",
  bankEdrpou: "12345678",
  phone: "+380501111111",
  email: "legal@alpha.test",
};

const buyerSnapshot = {
  kind: "customer" as const,
  displayName: "Fixture buyer",
};

const isolationOwnInput = { requestId: "", fileId: "" };
const isolationForeignInput = { requestId: "", fileId: "" };
const idempotentInput = { requestId: "", fileId: "" };
const idempotentConflictInput = { requestId: "", fileId: "" };
const idempotentFreshInput = { requestId: "", fileId: "" };

const atomicOkInput = atomicBlank();
const atomicFailInput = atomicBlank();

const contractDefaults = {
  aiExposure: "internal" as const,
  requiresConfirmation: false,
  atomicCalls: [] as const,
  atomicCallers: [] as const,
};

const completeThenMaybeFail = implementAction(
  defineActionContract({
    name: "docSigning.complete",
    description:
      "Test-local complete twin that can fail after recording the ASiC.",
    principal: "staff",
    transport: "client",
    input: z.object({
      fileId: z.uuid(),
      purpose: z.literal("signing"),
      mimeType: z.literal(SIGNING_MIME),
      byteSize: z.number().int().positive(),
      checksumSha256: z.string().regex(/^[0-9a-f]{64}$/),
      documentId: z.uuid(),
      requestId: z.uuid(),
      failAfterCall: z.boolean(),
    }),
    output: z.object({
      documentId: z.uuid(),
      requestId: z.uuid(),
      fileId: z.uuid(),
    }),
    permissions: ["documents:edit"],
    aiExposure: "internal",
    risk: "write",
    requiresConfirmation: false,
    idempotent: true,
    emits: [],
    atomicCalls: ["files.recordSigningObject"],
    atomicCallers: [],
    audit: true,
    timeout: 30_000,
  }),
  {
    handler: async (input, ctx) => {
      const db = requireStaffWritable(ctx.db);
      await db.insert(signingSignatures).values({
        companyId: ctx.companyId,
        documentId: input.documentId,
        signerRole: "supplier",
        fileId: input.fileId,
        signerCn: "twin",
        signerOrg: "",
        signerTaxId: "",
        signatureAlg: "twin",
        signedAt: new Date(),
      });
      const recorded = await ctx.callAtomic(recordSigningObject, {
        fileId: input.fileId,
        purpose: input.purpose,
        mimeType: input.mimeType,
        byteSize: input.byteSize,
        checksumSha256: input.checksumSha256,
      });
      if (input.failAfterCall) {
        throw new ConflictError("Root failed after the atomic call.");
      }
      await db
        .update(signingRequests)
        .set({ status: "completed", updatedAt: new Date() })
        .where(
          and(
            eq(signingRequests.companyId, ctx.companyId),
            eq(signingRequests.id, input.requestId),
          ),
        );
      return {
        documentId: input.documentId,
        requestId: input.requestId,
        fileId: recorded.fileId,
      };
    },
    auditTarget: () => ({ type: "document", id: "complete-atomic-twin" }),
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
let signedAsic: { readonly bytes: Uint8Array; readonly payloadSha256: string };
let unsignedAsic: Uint8Array;
const seedOrderNumbers = new Map<string, number>();

function seedIds(): {
  readonly orderId: string;
  readonly itemId: string;
  readonly documentId: string;
  readonly pdfId: string;
} {
  return {
    orderId: randomUUID(),
    itemId: randomUUID(),
    documentId: randomUUID(),
    pdfId: randomUUID(),
  };
}

function atomicBlank(): {
  fileId: string;
  purpose: "signing";
  mimeType: typeof SIGNING_MIME;
  byteSize: number;
  checksumSha256: string;
  documentId: string;
  requestId: string;
  failAfterCall: boolean;
} {
  return {
    fileId: "",
    purpose: "signing",
    mimeType: SIGNING_MIME,
    byteSize: 1,
    checksumSha256: "a".repeat(64),
    documentId: "",
    requestId: "",
    failAfterCall: false,
  };
}

function requireKit(): TestKit {
  if (kit === undefined) {
    throw new Error("doc-signing complete test kit was not started");
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

function nextSeedOrderNumber(companyId: string): string {
  const next = (seedOrderNumbers.get(companyId) ?? 0) + 1;
  seedOrderNumbers.set(companyId, next);
  return `T-${String(next)}`;
}

async function waitForBucket(): Promise<void> {
  const store = getFilesObjectStore();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await store.probeBucket();
      return;
    } catch {
      await new Promise((resolve) => {
        setTimeout(resolve, 250);
      });
    }
  }
  throw new Error("Garage bucket did not become ready");
}

async function putSigned(
  uploadUrl: string,
  bytes: Uint8Array,
  mimeType: string,
  objectKey: string,
): Promise<void> {
  const response = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": mimeType },
    body: bytes,
  });
  if (!response.ok) {
    throw new Error(`signed PUT failed: ${String(response.status)}`);
  }
  await waitForObjectVisibility(getFilesObjectStore(), objectKey, "present");
}

async function insertDocumentFile(
  id: string,
  companyId: string,
): Promise<void> {
  await requireKit()
    .db.runtime.db.insert(files)
    .values({
      id,
      companyId,
      purpose: "document",
      mimeType: "application/pdf",
      byteSize: 1024n,
      objectKey: `${companyId}/documents/${id}`,
      status: "ready",
      checksumSha256: sha256Hex(payloadPdf.bytes),
      stagingPurgedAt: new Date("2026-08-30T00:00:00.000Z"),
    });
}

async function insertReadyJob(
  documentId: string,
  companyId: string,
  fileId: string,
): Promise<void> {
  await requireKit().db.runtime.db.insert(documentGenerationJobs).values({
    companyId,
    documentId,
    status: "ready",
    fileId,
  });
}

async function handshakePut(
  bytes: Uint8Array,
  actor: { readonly userId?: string; readonly companyId?: string } = {},
): Promise<{
  readonly fileId: string;
  readonly byteSize: number;
  readonly checksumSha256: string;
}> {
  const checksumSha256 = sha256Hex(bytes);
  const requested = await requireKit().invoke(
    requestSigningUpload,
    {
      purpose: "signing",
      mimeType: SIGNING_MIME,
      byteSize: bytes.byteLength,
      checksumSha256,
    },
    actor,
  );
  const signed = await requireKit().invoke(
    getSigningUploadUrl,
    { fileId: requested.fileId },
    actor,
  );
  const companyId = actor.companyId ?? kitIdentities.companies.a;
  await putSigned(
    signed.uploadUrl,
    bytes,
    SIGNING_MIME,
    `${companyId}/uploads/${requested.fileId}`,
  );
  return {
    fileId: requested.fileId,
    byteSize: bytes.byteLength,
    checksumSha256,
  };
}

async function insertPendingRequest(env: {
  readonly documentId: string;
  readonly pdfId: string;
  readonly companyId: string;
  readonly payloadSha256: string;
}): Promise<string> {
  const requestId = randomUUID();
  await requireKit().db.runtime.db.insert(signingRequests).values({
    id: requestId,
    companyId: env.companyId,
    documentId: env.documentId,
    payloadFileId: env.pdfId,
    payloadSha256: env.payloadSha256,
    payloadDigestAlgorithm: "sha256",
    status: "pending",
  });
  return requestId;
}

async function prepareComplete(env: {
  readonly documentId: string;
  readonly pdfId: string;
  readonly companyId: string;
  readonly bytes: Uint8Array;
  readonly payloadSha256: string;
  readonly userId?: string;
}): Promise<{
  readonly requestId: string;
  readonly fileId: string;
  readonly byteSize: number;
  readonly checksumSha256: string;
}> {
  const staged = await handshakePut(
    env.bytes,
    env.userId === undefined
      ? { companyId: env.companyId }
      : { companyId: env.companyId, userId: env.userId },
  );
  const requestId = await insertPendingRequest({
    documentId: env.documentId,
    pdfId: env.pdfId,
    companyId: env.companyId,
    payloadSha256: env.payloadSha256,
  });
  return { requestId, ...staged };
}

async function simulatePostPromoteAbort(env: {
  readonly fileId: string;
  readonly bytes: Uint8Array;
  readonly companyId?: string;
}): Promise<void> {
  const companyId = env.companyId ?? kitIdentities.companies.a;
  const store = getFilesObjectStore();
  const stagingKey = `${companyId}/uploads/${env.fileId}`;
  const durableKey = `${companyId}/signing/${env.fileId}`;
  await store.putObject({
    key: durableKey,
    mimeType: SIGNING_MIME,
    bytes: env.bytes,
  });
  await waitForObjectVisibility(store, durableKey, "present");
  await store.deleteObject(stagingKey);
  await waitForObjectVisibility(store, stagingKey, "missing");
}

async function countCompletedRequests(): Promise<number> {
  const rows = await requireKit()
    .db.runtime.db.select({ value: count() })
    .from(signingRequests)
    .where(
      and(
        eq(signingRequests.companyId, kitIdentities.companies.a),
        eq(signingRequests.status, "completed"),
      ),
    );
  return rows[0]?.value ?? 0;
}

async function countReadySigningFiles(): Promise<number> {
  const rows = await requireKit()
    .db.runtime.db.select({ value: count() })
    .from(files)
    .where(
      and(
        eq(files.companyId, kitIdentities.companies.a),
        eq(files.purpose, "signing"),
        eq(files.status, "ready"),
      ),
    );
  return rows[0]?.value ?? 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForUngrantedLock(): Promise<void> {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const result = await requireKit().db.admin.query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM pg_locks WHERE NOT granted",
    );
    if ((result.rows[0]?.n ?? 0) > 0) {
      return;
    }
    await sleep(20);
  }
  throw new Error(
    "timed out waiting for complete to wait on the document row lock",
  );
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
  const endpoint = `http://127.0.0.1:${String(startedGarage.getMappedPort(3900))}`;
  configureFilesObjectStore({
    endpoint,
    region: "us-east-1",
    accessKeyId: GARAGE_ACCESS_KEY,
    secretAccessKey: GARAGE_SECRET_KEY,
    forcePathStyle: true,
    bucket: GARAGE_BUCKET,
  });
  await waitForBucket();

  const adapter = await getSharedNodeAdapter();
  signedAsic = await createSignedAsicE(payloadPdf, adapter);
  unsignedAsic = packAsicE([
    { name: "mimetype", bytes: new TextEncoder().encode(ASIC_E_MIMETYPE) },
    payloadPdf,
  ]);

  kit = await createTestKit();
  const companyA = kitIdentities.companies.a;
  const companyB = kitIdentities.companies.b;
  const createdAt = new Date("2026-08-30T12:00:00.000Z");
  const grantedAt = new Date();
  const expiredAt = new Date(Date.now() - SIGN_REQUEST_TTL_MS - 60_000);

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

  const rows = [
    {
      ...ids.isolationA,
      companyId: companyA,
      number: "KA-РХ-000960",
      status: "issued" as const,
      grant: grantedAt,
    },
    {
      ...ids.isolationB,
      companyId: companyB,
      number: "MB-РХ-000960",
      status: "issued" as const,
      grant: grantedAt,
    },
    {
      ...ids.idempotent,
      companyId: companyA,
      number: "KA-РХ-000961",
      status: "issued" as const,
      grant: grantedAt,
    },
    {
      ...ids.idempotentConflict,
      companyId: companyA,
      number: "KA-РХ-000962",
      status: "issued" as const,
      grant: grantedAt,
    },
    {
      ...ids.idempotentFresh,
      companyId: companyA,
      number: "KA-РХ-000963",
      status: "issued" as const,
      grant: grantedAt,
    },
    {
      ...ids.atomicOk,
      companyId: companyA,
      number: "KA-РХ-000964",
      status: "issued" as const,
      grant: grantedAt,
    },
    {
      ...ids.atomicFail,
      companyId: companyA,
      number: "KA-РХ-000965",
      status: "issued" as const,
      grant: grantedAt,
    },
    {
      ...ids.happy,
      companyId: companyA,
      number: "KA-РХ-000966",
      status: "issued" as const,
      grant: grantedAt,
    },
    {
      ...ids.replay,
      companyId: companyA,
      number: "KA-РХ-000967",
      status: "issued" as const,
      grant: grantedAt,
    },
    {
      ...ids.secondSign,
      companyId: companyA,
      number: "KA-РХ-000968",
      status: "issued" as const,
      grant: grantedAt,
    },
    {
      ...ids.mismatch,
      companyId: companyA,
      number: "KA-РХ-000969",
      status: "issued" as const,
      grant: grantedAt,
    },
    {
      ...ids.invalidAsic,
      companyId: companyA,
      number: "KA-РХ-000970",
      status: "issued" as const,
      grant: grantedAt,
    },
    {
      ...ids.wrongMime,
      companyId: companyA,
      number: "KA-РХ-000971",
      status: "issued" as const,
      grant: grantedAt,
    },
    {
      ...ids.tooLarge,
      companyId: companyA,
      number: "KA-РХ-000972",
      status: "issued" as const,
      grant: grantedAt,
    },
    {
      ...ids.foreignFile,
      companyId: companyA,
      number: "KA-РХ-000973",
      status: "issued" as const,
      grant: grantedAt,
    },
    {
      ...ids.cancelled,
      companyId: companyA,
      number: "KA-РХ-000974",
      status: "cancelled" as const,
      grant: grantedAt,
    },
    {
      ...ids.grantExpired,
      companyId: companyA,
      number: "KA-РХ-000975",
      status: "issued" as const,
      grant: expiredAt,
    },
    {
      ...ids.deny,
      companyId: companyA,
      number: "KA-РХ-000976",
      status: "issued" as const,
      grant: grantedAt,
    },
    {
      ...ids.uniqueRace,
      companyId: companyA,
      number: "KA-РХ-000977",
      status: "issued" as const,
      grant: grantedAt,
    },
    {
      ...ids.promoteRetry,
      companyId: companyA,
      number: "KA-РХ-000978",
      status: "issued" as const,
      grant: grantedAt,
    },
    {
      ...ids.cancelRace,
      companyId: companyA,
      number: "KA-РХ-000979",
      status: "issued" as const,
      grant: grantedAt,
    },
    {
      ...ids.cancelConcurrent,
      companyId: companyA,
      number: "KA-РХ-000980",
      status: "issued" as const,
      grant: grantedAt,
    },
  ] as const;

  await requireKit()
    .db.runtime.db.insert(orders)
    .values(
      rows.map((row) => ({
        id: row.orderId,
        companyId: row.companyId,
        orderNumber: nextSeedOrderNumber(row.companyId),
        customerId:
          row.companyId === companyA ? fixtures.customerA : fixtures.customerB,
        customerNameSnapshot: "Fixture customer",
        status: "new" as const,
        totalNetMinor: 250n,
        totalTaxMinor: 0n,
        totalGrossMinor: 250n,
        currency: "UAH",
      })),
    );
  await requireKit()
    .db.runtime.db.insert(orderItems)
    .values(
      rows.map((row) => ({
        id: row.itemId,
        companyId: row.companyId,
        orderId: row.orderId,
        productId:
          row.companyId === companyA ? fixtures.productA : fixtures.productB,
        titleSnapshot: "Seed",
        quantityMilli: 1000n,
        unitPriceMinor: 250n,
        taxTreatment: "exempt" as const,
        netAmountMinor: 250n,
        grossAmountMinor: 250n,
        priceSource: "base" as const,
        resolverVersion: 1,
      })),
    );
  await requireKit()
    .db.runtime.db.insert(documents)
    .values(
      rows.map((row) => ({
        id: row.documentId,
        companyId: row.companyId,
        orderId: row.orderId,
        counterpartyId: null,
        type: "payment_invoice",
        status: row.status,
        documentNumber: row.number,
        issuedOn: "2026-08-30",
        supplierDetails: sellerSnapshot,
        buyerDetails: buyerSnapshot,
        totalNetMinor: 250n,
        totalTaxMinor: 0n,
        totalGrossMinor: 250n,
        currency: "UAH",
        templateSource: "system",
        templateName: "payment_invoice",
        signRequestedAt: row.grant,
        createdAt,
        updatedAt: createdAt,
      })),
    );
  await requireKit()
    .db.runtime.db.insert(documentItems)
    .values(
      rows.map((row) => ({
        id: row.itemId,
        companyId: row.companyId,
        documentId: row.documentId,
        productId:
          row.companyId === companyA ? fixtures.productA : fixtures.productB,
        titleSnapshot: "Line",
        quantityMilli: 1000n,
        unitPriceMinor: 250n,
        taxTreatment: "exempt",
        netAmountMinor: 250n,
        grossAmountMinor: 250n,
        currency: "UAH",
        createdAt,
      })),
    );

  for (const row of rows) {
    await insertDocumentFile(row.pdfId, row.companyId);
    await insertReadyJob(row.documentId, row.companyId, row.pdfId);
  }

  await requireKit()
    .db.runtime.db.insert(files)
    .values({
      id: fixtures.asicSigned,
      companyId: companyA,
      uploadedByUserId: kitIdentities.users.anna,
      purpose: "signing",
      mimeType: SIGNING_MIME,
      byteSize: 2048n,
      objectKey: `${companyA}/signing/${fixtures.asicSigned}`,
      status: "ready",
      checksumSha256: "b".repeat(64),
      stagingPurgedAt: new Date("2026-08-30T00:00:00.000Z"),
    });
  await requireKit().db.runtime.db.insert(signingSignatures).values({
    id: fixtures.signatureSigned,
    companyId: companyA,
    documentId: ids.secondSign.documentId,
    signerRole: "supplier",
    fileId: fixtures.asicSigned,
    signerCn: "ФОП Fixture",
    signerOrg: "Fixture Org",
    signerTaxId: "12345678",
    signatureAlg: "DSTU4145",
    signedAt: createdAt,
  });

  await requireKit().db.runtime.db.insert(user).values({
    id: clerks.employee,
    name: "Employee",
    email: "employee@doc-signing-complete-kit.test",
  });
  await requireKit()
    .db.runtime.db.insert(companyMembers)
    .values({
      companyId: companyA,
      userId: clerks.employee,
      role: "employee",
      permissions: { granted: ["documents:view"], denied: [] },
    });

  const own = await prepareComplete({
    ...ids.isolationA,
    companyId: companyA,
    bytes: signedAsic.bytes,
    payloadSha256: signedAsic.payloadSha256,
  });
  isolationOwnInput.requestId = own.requestId;
  isolationOwnInput.fileId = own.fileId;

  const foreign = await prepareComplete({
    ...ids.isolationB,
    companyId: companyB,
    userId: kitIdentities.users.boris,
    bytes: signedAsic.bytes,
    payloadSha256: signedAsic.payloadSha256,
  });
  isolationForeignInput.requestId = foreign.requestId;
  isolationForeignInput.fileId = foreign.fileId;

  const idem = await prepareComplete({
    ...ids.idempotent,
    companyId: companyA,
    bytes: signedAsic.bytes,
    payloadSha256: signedAsic.payloadSha256,
  });
  idempotentInput.requestId = idem.requestId;
  idempotentInput.fileId = idem.fileId;

  const idemConflict = await prepareComplete({
    ...ids.idempotentConflict,
    companyId: companyA,
    bytes: signedAsic.bytes,
    payloadSha256: signedAsic.payloadSha256,
  });
  idempotentConflictInput.requestId = idemConflict.requestId;
  idempotentConflictInput.fileId = idemConflict.fileId;

  const idemFresh = await prepareComplete({
    ...ids.idempotentFresh,
    companyId: companyA,
    bytes: signedAsic.bytes,
    payloadSha256: signedAsic.payloadSha256,
  });
  idempotentFreshInput.requestId = idemFresh.requestId;
  idempotentFreshInput.fileId = idemFresh.fileId;

  const atomicOk = await prepareComplete({
    ...ids.atomicOk,
    companyId: companyA,
    bytes: signedAsic.bytes,
    payloadSha256: signedAsic.payloadSha256,
  });
  atomicOkInput.fileId = atomicOk.fileId;
  atomicOkInput.byteSize = atomicOk.byteSize;
  atomicOkInput.checksumSha256 = atomicOk.checksumSha256;
  atomicOkInput.documentId = ids.atomicOk.documentId;
  atomicOkInput.requestId = atomicOk.requestId;
  atomicOkInput.failAfterCall = false;

  const atomicFail = await prepareComplete({
    ...ids.atomicFail,
    companyId: companyA,
    bytes: signedAsic.bytes,
    payloadSha256: signedAsic.payloadSha256,
  });
  atomicFailInput.fileId = atomicFail.fileId;
  atomicFailInput.byteSize = atomicFail.byteSize;
  atomicFailInput.checksumSha256 = atomicFail.checksumSha256;
  atomicFailInput.documentId = ids.atomicFail.documentId;
  atomicFailInput.requestId = atomicFail.requestId;
  atomicFailInput.failAfterCall = true;
});

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
    completeSigning,
    { input: isolationOwnInput },
    { input: isolationForeignInput },
  ),
]);

idempotencySuite(requireKit, [
  {
    action: completeSigning,
    input: idempotentInput,
    conflictingInput: idempotentConflictInput,
    freshInput: () => ({ ...idempotentFreshInput }),
    readEffect: countCompletedRequests,
  },
]);

atomicCallSuite(requireKit, [
  {
    root: completeThenMaybeFail,
    successInput: atomicOkInput,
    failureInput: atomicFailInput,
    readRootEffect: countCompletedRequests,
    readCalleeEffect: countReadySigningFiles,
    undeclared: { action: confirmUndeclared, input: {} },
    mismatch: { action: confirmMismatch, input: {} },
    nested: { action: confirmNested, input: {} },
  },
]);

describe("docSigning.complete", () => {
  it("verifies a staged ASiC, records the durable object, emits, and audits without bytes", async () => {
    const prepared = await prepareComplete({
      ...ids.happy,
      companyId: kitIdentities.companies.a,
      bytes: signedAsic.bytes,
      payloadSha256: signedAsic.payloadSha256,
    });
    const requestId = randomUUID();
    const capturing = createCapturingLogger();
    const result = await requireKit().invoke(
      completeSigning,
      { requestId: prepared.requestId, fileId: prepared.fileId },
      {},
      {
        request: { requestId },
        deps: { ...requireKit().pipeline, logger: capturing.logger },
      },
    );
    expect(result.documentId).toBe(ids.happy.documentId);
    expect(result.requestId).toBe(prepared.requestId);
    expect(result.fileId).toBe(prepared.fileId);
    expect(result.signerRole).toBe("supplier");
    expect(result.signerCn.length).toBeGreaterThan(0);
    expect(result.signatureAlg.length).toBeGreaterThan(0);
    expect(result.signedAt).toEqual(expect.stringMatching(/^\d{4}-/));

    const stored = await requireKit()
      .db.runtime.db.select({
        status: signingRequests.status,
      })
      .from(signingRequests)
      .where(eq(signingRequests.id, prepared.requestId));
    expect(stored).toEqual([{ status: "completed" }]);

    const [file] = await requireKit()
      .db.runtime.db.select()
      .from(files)
      .where(eq(files.id, prepared.fileId));
    expect(file?.purpose).toBe("signing");
    expect(file?.status).toBe("ready");
    expect(file?.objectKey).toBe(
      `${kitIdentities.companies.a}/signing/${prepared.fileId}`,
    );
    expect(file?.uploadedByUserId).toBe(kitIdentities.users.anna);
    expect(file?.objectKey).not.toContain("/uploads/");

    const events = await requireKit()
      .db.runtime.db.select({
        name: domainEvents.name,
        payload: domainEvents.payload,
        aggregateType: domainEvents.aggregateType,
        aggregateId: domainEvents.aggregateId,
      })
      .from(domainEvents)
      .where(eq(domainEvents.requestId, requestId));
    const recorded = events.filter((row) => row.name === "docSigning.recorded");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.aggregateType).toBe("document");
    expect(recorded[0]?.aggregateId).toBe(ids.happy.documentId);
    expect(recorded[0]?.payload).toMatchObject({
      documentId: ids.happy.documentId,
      signerRole: "supplier",
      fileId: prepared.fileId,
    });

    const audits = await requireKit()
      .db.runtime.db.select()
      .from(auditLog)
      .where(eq(auditLog.requestId, requestId));
    expect(audits.map((row) => row.action).toSorted()).toEqual([
      "docSigning.complete",
      "files.recordSigningObject",
    ]);
    const completeAudit = audits.find(
      (row) => row.action === "docSigning.complete",
    );
    expect(completeAudit).toMatchObject({
      action: "docSigning.complete",
      companyId: kitIdentities.companies.a,
      actorType: "user",
      actorId: kitIdentities.users.anna,
      targetType: "document",
      targetId: ids.happy.documentId,
      outcome: "ok",
    });
    const snapshot = completeAudit?.inputSnapshot;
    expect(snapshot).toMatchObject({
      signerCn: result.signerCn,
      signerRole: "supplier",
      fileId: prepared.fileId,
      documentId: ids.happy.documentId,
    });
    const blob = JSON.stringify([result, capturing.entries(), audits]);
    expect(blob).not.toMatch(/base64/i);
    expect(blob).not.toContain("payloadDownloadUrl");
    expect(blob).not.toMatch(/[A-Za-z0-9+/]{80,}/);
    expect(JSON.stringify(snapshot)).not.toContain("bytes");
  });

  it("replays the same successful file and conflicts on a second supplier file", async () => {
    const prepared = await prepareComplete({
      ...ids.replay,
      companyId: kitIdentities.companies.a,
      bytes: signedAsic.bytes,
      payloadSha256: signedAsic.payloadSha256,
    });
    const first = await requireKit().invoke(completeSigning, {
      requestId: prepared.requestId,
      fileId: prepared.fileId,
    });
    const second = await requireKit().invoke(completeSigning, {
      requestId: prepared.requestId,
      fileId: prepared.fileId,
    });
    expect(second).toEqual(first);

    const other = await handshakePut(signedAsic.bytes);
    const conflict = await requireKit()
      .invoke(completeSigning, {
        requestId: prepared.requestId,
        fileId: other.fileId,
      })
      .catch((error: unknown) => error);
    expect(conflict).toBeInstanceOf(ConflictError);
    if (conflict instanceof ConflictError) {
      expect(conflict.clientMessage).toBe(ALREADY_SIGNED_MESSAGE);
    }
    const otherStaging = `${kitIdentities.companies.a}/uploads/${other.fileId}`;
    await waitForObjectVisibility(
      getFilesObjectStore(),
      otherStaging,
      "present",
    );
    expect(await getFilesObjectStore().headObject(otherStaging)).not.toBe(
      "missing",
    );
  });

  it("rejects a second supplier signature on a document that is already signed", async () => {
    const requestId = await insertPendingRequest({
      documentId: ids.secondSign.documentId,
      pdfId: ids.secondSign.pdfId,
      companyId: kitIdentities.companies.a,
      payloadSha256: signedAsic.payloadSha256,
    });
    const staged = await handshakePut(signedAsic.bytes);
    const conflict = await requireKit()
      .invoke(completeSigning, { requestId, fileId: staged.fileId })
      .catch((error: unknown) => error);
    expect(conflict).toBeInstanceOf(ConflictError);
    if (conflict instanceof ConflictError) {
      expect(conflict.clientMessage).toBe(ALREADY_SIGNED_MESSAGE);
    }
  });

  it("rejects a payload digest that does not match the freeze from start", async () => {
    const prepared = await prepareComplete({
      ...ids.mismatch,
      companyId: kitIdentities.companies.a,
      bytes: signedAsic.bytes,
      payloadSha256: otherPayloadSha256,
    });
    const mismatch = await requireKit()
      .invoke(completeSigning, {
        requestId: prepared.requestId,
        fileId: prepared.fileId,
      })
      .catch((error: unknown) => error);
    expect(mismatch).toBeInstanceOf(ValidationError);
    if (mismatch instanceof ValidationError) {
      expect(mismatch.clientMessage).toBe(PAYLOAD_MISMATCH_MESSAGE);
    }
  });

  it("rejects an unsigned ZIP and a JPEG staged as signing MIME", async () => {
    const invalid = await prepareComplete({
      ...ids.invalidAsic,
      companyId: kitIdentities.companies.a,
      bytes: unsignedAsic,
      payloadSha256: signedAsic.payloadSha256,
    });
    const invalidError = await requireKit()
      .invoke(completeSigning, {
        requestId: invalid.requestId,
        fileId: invalid.fileId,
      })
      .catch((error: unknown) => error);
    expect(invalidError).toBeInstanceOf(ValidationError);
    if (invalidError instanceof ValidationError) {
      expect(invalidError.clientMessage).toBe(INVALID_ASIC_MESSAGE);
    }

    const jpeg = await prepareComplete({
      ...ids.wrongMime,
      companyId: kitIdentities.companies.a,
      bytes: jpegBytes,
      payloadSha256: signedAsic.payloadSha256,
    });
    const mimeError = await requireKit()
      .invoke(completeSigning, {
        requestId: jpeg.requestId,
        fileId: jpeg.fileId,
      })
      .catch((error: unknown) => error);
    expect(mimeError).toBeInstanceOf(ValidationError);
    if (mimeError instanceof ValidationError) {
      expect(mimeError.clientMessage).toBe(INVALID_ASIC_MESSAGE);
    }
  });

  it("rejects an oversize staging object", async () => {
    const prepared = await prepareComplete({
      ...ids.tooLarge,
      companyId: kitIdentities.companies.a,
      bytes: signedAsic.bytes,
      payloadSha256: signedAsic.payloadSha256,
    });
    const stagingKey = `${kitIdentities.companies.a}/uploads/${prepared.fileId}`;
    const restore = mapConfiguredFilesObjectStore((inner) => ({
      ...inner,
      async headObject(key) {
        const head = await inner.headObject(key);
        if (key === stagingKey && head !== "missing") {
          return { byteSize: MAX_DOCUMENT_BYTES + 1, etag: head.etag };
        }
        return head;
      },
    }));
    try {
      await expect(
        requireKit().invoke(completeSigning, {
          requestId: prepared.requestId,
          fileId: prepared.fileId,
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    } finally {
      restore();
    }
  });

  it("returns the same not-found for a missing request, a foreign file, and a foreign request", async () => {
    const prepared = await prepareComplete({
      ...ids.foreignFile,
      companyId: kitIdentities.companies.a,
      bytes: signedAsic.bytes,
      payloadSha256: signedAsic.payloadSha256,
    });
    const foreignFile = await handshakePut(signedAsic.bytes, {
      userId: kitIdentities.users.boris,
      companyId: kitIdentities.companies.b,
    });
    const missing = await requireKit()
      .invoke(completeSigning, {
        requestId: randomUUID(),
        fileId: prepared.fileId,
      })
      .catch((error: unknown) => error);
    const foreignFileError = await requireKit()
      .invoke(completeSigning, {
        requestId: prepared.requestId,
        fileId: foreignFile.fileId,
      })
      .catch((error: unknown) => error);
    const foreignRequest = await requireKit()
      .invoke(completeSigning, {
        requestId: isolationForeignInput.requestId,
        fileId: isolationForeignInput.fileId,
      })
      .catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(NotFoundError);
    expect(foreignFileError).toBeInstanceOf(NotFoundError);
    expect(foreignRequest).toBeInstanceOf(NotFoundError);
  });

  it("rejects cancelled documents and expired grants", async () => {
    const cancelled = await prepareComplete({
      ...ids.cancelled,
      companyId: kitIdentities.companies.a,
      bytes: signedAsic.bytes,
      payloadSha256: signedAsic.payloadSha256,
    });
    await expect(
      requireKit().invoke(completeSigning, {
        requestId: cancelled.requestId,
        fileId: cancelled.fileId,
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    const expired = await prepareComplete({
      ...ids.grantExpired,
      companyId: kitIdentities.companies.a,
      bytes: signedAsic.bytes,
      payloadSha256: signedAsic.payloadSha256,
    });
    const expiredError = await requireKit()
      .invoke(completeSigning, {
        requestId: expired.requestId,
        fileId: expired.fileId,
      })
      .catch((error: unknown) => error);
    expect(expiredError).toBeInstanceOf(ValidationError);
    if (expiredError instanceof ValidationError) {
      expect(expiredError.clientMessage).toBe(GRANT_EXPIRED_MESSAGE);
    }
  });

  it("does not record a signature when cancel commits while complete waits on the re-lock after verify", async () => {
    const prepared = await prepareComplete({
      ...ids.cancelRace,
      companyId: kitIdentities.companies.a,
      bytes: signedAsic.bytes,
      payloadSha256: signedAsic.payloadSha256,
    });
    let completePromise: Promise<unknown> | undefined;
    await requireKit().db.runtime.db.transaction(async (tx) => {
      const locked = await tx
        .select({ id: documents.id })
        .from(documents)
        .where(
          and(
            eq(documents.companyId, kitIdentities.companies.a),
            eq(documents.id, ids.cancelRace.documentId),
          ),
        )
        .limit(1)
        .for("update");
      expect(locked).toHaveLength(1);

      completePromise = requireKit()
        .invoke(completeSigning, {
          requestId: prepared.requestId,
          fileId: prepared.fileId,
        })
        .catch((error: unknown) => error);
      await waitForUngrantedLock();

      await tx
        .update(documents)
        .set({ status: "cancelled", signRequestedAt: null })
        .where(
          and(
            eq(documents.companyId, kitIdentities.companies.a),
            eq(documents.id, ids.cancelRace.documentId),
          ),
        );
    });

    if (completePromise === undefined) {
      throw new Error("complete was not invoked under the held document lock");
    }
    const completed = await completePromise;
    expect(completed).toBeInstanceOf(ConflictError);
    const signatures = await requireKit()
      .db.runtime.db.select({ id: signingSignatures.id })
      .from(signingSignatures)
      .where(eq(signingSignatures.documentId, ids.cancelRace.documentId));
    expect(signatures).toHaveLength(0);
    const [header] = await requireKit()
      .db.runtime.db.select({
        status: documents.status,
        signRequestedAt: documents.signRequestedAt,
      })
      .from(documents)
      .where(eq(documents.id, ids.cancelRace.documentId));
    expect(header).toEqual({ status: "cancelled", signRequestedAt: null });
  });

  it("serializes concurrent complete and cancel so a cancelled document has no supplier signature", async () => {
    const prepared = await prepareComplete({
      ...ids.cancelConcurrent,
      companyId: kitIdentities.companies.a,
      bytes: signedAsic.bytes,
      payloadSha256: signedAsic.payloadSha256,
    });
    await Promise.allSettled([
      requireKit().invoke(completeSigning, {
        requestId: prepared.requestId,
        fileId: prepared.fileId,
      }),
      requireKit().invoke(cancelDocument, {
        documentId: ids.cancelConcurrent.documentId,
      }),
    ]);
    const [header] = await requireKit()
      .db.runtime.db.select({
        status: documents.status,
        signRequestedAt: documents.signRequestedAt,
      })
      .from(documents)
      .where(eq(documents.id, ids.cancelConcurrent.documentId));
    const signatures = await requireKit()
      .db.runtime.db.select({ id: signingSignatures.id })
      .from(signingSignatures)
      .where(eq(signingSignatures.documentId, ids.cancelConcurrent.documentId));
    if (header?.status === "cancelled") {
      expect(signatures).toHaveLength(0);
      expect(header.signRequestedAt).toBeNull();
    } else {
      expect(header?.status).toBe("issued");
      expect(signatures).toHaveLength(1);
    }
  });

  it("denies documents:edit and an employee with documents:view only", async () => {
    const prepared = await prepareComplete({
      ...ids.deny,
      companyId: kitIdentities.companies.a,
      bytes: signedAsic.bytes,
      payloadSha256: signedAsic.payloadSha256,
    });
    await expect(
      requireKit().invoke(
        completeSigning,
        { requestId: prepared.requestId, fileId: prepared.fileId },
        {
          userId: clerks.employee,
          companyId: kitIdentities.companies.a,
        },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("does not delete the loser's staging on a unique supplier race with a different fileId", async () => {
    const prepared = await prepareComplete({
      ...ids.uniqueRace,
      companyId: kitIdentities.companies.a,
      bytes: signedAsic.bytes,
      payloadSha256: signedAsic.payloadSha256,
    });
    const other = await handshakePut(signedAsic.bytes);
    const outcomes = await Promise.allSettled([
      requireKit().invoke(completeSigning, {
        requestId: prepared.requestId,
        fileId: prepared.fileId,
      }),
      requireKit().invoke(completeSigning, {
        requestId: prepared.requestId,
        fileId: other.fileId,
      }),
    ]);
    const fulfilled = outcomes.filter((row) => row.status === "fulfilled");
    const rejected = outcomes.filter((row) => row.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const winner =
      fulfilled[0]?.status === "fulfilled" ? fulfilled[0].value : undefined;
    expect(winner).toBeDefined();
    const loserError: unknown =
      rejected[0]?.status === "rejected" ? rejected[0].reason : undefined;
    expect(loserError).toBeInstanceOf(ConflictError);
    if (loserError instanceof ConflictError) {
      expect(loserError.clientMessage).toBe(ALREADY_SIGNED_MESSAGE);
    }
    const winnerFileId = winner?.fileId;
    expect(
      winnerFileId === prepared.fileId || winnerFileId === other.fileId,
    ).toBe(true);
    const loserFileId =
      winnerFileId === prepared.fileId ? other.fileId : prepared.fileId;
    const store = getFilesObjectStore();
    const loserStaging = `${kitIdentities.companies.a}/uploads/${loserFileId}`;
    await waitForObjectVisibility(store, loserStaging, "present");
    expect(await store.headObject(loserStaging)).not.toBe("missing");
    const [loserFile] = await requireKit()
      .db.runtime.db.select({ status: files.status })
      .from(files)
      .where(eq(files.id, loserFileId));
    expect(loserFile?.status).toBe("pending");
    const signatures = await requireKit()
      .db.runtime.db.select({ fileId: signingSignatures.fileId })
      .from(signingSignatures)
      .where(eq(signingSignatures.documentId, ids.uniqueRace.documentId));
    expect(signatures).toEqual([{ fileId: winnerFileId }]);
  });

  it("retries complete after a post-promote TX abort when durable exists and staging is gone", async () => {
    const prepared = await prepareComplete({
      ...ids.promoteRetry,
      companyId: kitIdentities.companies.a,
      bytes: signedAsic.bytes,
      payloadSha256: signedAsic.payloadSha256,
    });
    await simulatePostPromoteAbort({
      fileId: prepared.fileId,
      bytes: signedAsic.bytes,
    });
    const [pendingFile] = await requireKit()
      .db.runtime.db.select({ status: files.status })
      .from(files)
      .where(eq(files.id, prepared.fileId));
    expect(pendingFile?.status).toBe("pending");
    const result = await requireKit().invoke(completeSigning, {
      requestId: prepared.requestId,
      fileId: prepared.fileId,
    });
    expect(result.fileId).toBe(prepared.fileId);
    const [readyFile] = await requireKit()
      .db.runtime.db.select({
        status: files.status,
        objectKey: files.objectKey,
      })
      .from(files)
      .where(eq(files.id, prepared.fileId));
    expect(readyFile?.status).toBe("ready");
    expect(readyFile?.objectKey).toBe(
      `${kitIdentities.companies.a}/signing/${prepared.fileId}`,
    );
    const store = getFilesObjectStore();
    await waitForObjectVisibility(
      store,
      `${kitIdentities.companies.a}/uploads/${prepared.fileId}`,
      "missing",
    );
    const durable = await store.getObject(
      `${kitIdentities.companies.a}/signing/${prepared.fileId}`,
    );
    expect(durable).not.toBe("missing");
  });

  it("rejects companyId on input", async () => {
    await expect(
      requireKit().invoke(completeSigning, {
        requestId: isolationOwnInput.requestId,
        fileId: isolationOwnInput.fileId,
        companyId: kitIdentities.companies.a,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
