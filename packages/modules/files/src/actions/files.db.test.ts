import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { executeAction, executeJobAction } from "@showzy/core";
import {
  ConflictError,
  CoreInvariantError,
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
} from "@showzy/core/errors";
import {
  buildJobEnvelope,
  createCapturingLogger,
  createTestKit,
  crossTenantSuite,
  idempotencySuite,
  isolationCase,
  jobIsolationCase,
  jobIsolationSuite,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import { auditLog, idempotencyKeys } from "@showzy/db";
import { user } from "@showzy/db/schema/auth";
import { companyMembers } from "@showzy/db/schema/companies";
import { files } from "@showzy/db/schema/files";
import { sha256Hex } from "@showzy/module-kit/sha256";
import { and, count, eq, inArray, isNull } from "drizzle-orm";
import sharp from "sharp";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { BACKFILL_BATCH_LIMIT } from "./backfill-catalog-renditions.contract.js";
import { backfillCatalogRenditions } from "./backfill-catalog-renditions.js";
import { finalizeUpload } from "./finalize-upload.js";
import { ATTACHMENT_FACTS_MAX_IDS } from "./get-attachment-facts.contract.js";
import { getDownloadUrl } from "./get-download-url.js";
import { getDownloadUrls } from "./get-download-urls.js";
import { getSigningUploadUrl } from "./get-signing-upload-url.js";
import { getUploadUrl } from "./get-upload-url.js";
import { issueDocumentDownloadUrl } from "./issue-document-download-url.js";
import { issueShareDownloadUrl } from "./issue-share-download-url.js";
import { issueShareSigningDownloadUrl } from "./issue-share-signing-download-url.js";
import { issueSigningDownloadUrl } from "./issue-signing-download-url.js";
import { issueSystemSigningDownloadUrl } from "./issue-system-signing-download-url.js";
import { recordGeneratedObject } from "./record-generated-object.js";
import { recordSigningObject } from "./record-signing-object.js";
import { readPendingSigningObject } from "./read-pending-signing-object.js";
import { requestSigningUpload } from "./request-signing-upload.js";
import { requestUpload } from "./request-upload.js";
import {
  backfillCatalogRenditionsJob,
  sweepAbandonedUploadsJob,
} from "../jobs/maintenance-jobs.js";
import { sweepAbandonedUploads } from "./sweep-abandoned-uploads.js";
import { ABANDONED_PENDING_TTL_MS } from "./sweep-abandoned-uploads.contract.js";
import {
  BACKFILL_CATALOG_RENDITIONS_INTERVAL_MS,
  runCatalogRenditionBackfill,
  setCatalogRenditionBackfillNowMsForTest,
} from "../services/backfill-catalog-renditions.js";
import type { FileReadyView } from "../services/file-view.js";
import {
  catalogObjectKey,
  catalogRenditionObjectKey,
  documentObjectKey,
  signingObjectKey,
  stagingObjectKey,
} from "../services/object-key.js";
import { SIGNED_PUT_SKEW_MARGIN_MS } from "../services/pending-abandon.js";
import {
  closeFilesObjectStore,
  configureFilesObjectStore,
  createFilesObjectStore,
  getFilesObjectStore,
  mapConfiguredFilesObjectStore,
  SIGNED_URL_TTL_SEC,
} from "../services/s3-port.js";
import { waitForObjectVisibility } from "../testing/object-visibility.js";
import { pngWithIhdrDimensions } from "../testing/png-with-ihdr-dimensions.js";
import {
  CATALOG_RENDITIONS,
  MAX_DOCUMENT_BYTES,
  MAX_UPLOAD_BYTES,
  SIGNING_MIME_TYPE,
  type FileMimeType,
  type StoredObjectMimeType,
} from "../wire.contract.js";

/** Same pin as docker-compose.yml (ADR-0027). */
const GARAGE_IMAGE = "dxflrs/garage:v2.3.0";
const GARAGE_BUCKET = "showzy";
const GARAGE_ACCESS_KEY = "showzy-local";
const GARAGE_SECRET_KEY = "showzy-local-secret";

const jpegBytes = new Uint8Array(
  await sharp({
    create: {
      width: 8,
      height: 8,
      channels: 3,
      background: { r: 220, g: 40, b: 40 },
    },
  })
    .jpeg({ quality: 80 })
    .toBuffer(),
);
const pngBytes = new Uint8Array(
  await sharp({
    create: {
      width: 8,
      height: 8,
      channels: 3,
      background: { r: 40, g: 80, b: 200 },
    },
  })
    .png()
    .toBuffer(),
);
const exeBytes = Uint8Array.from([
  0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00,
]);
const zipBytes = Uint8Array.from([
  0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00,
]);
const heicBytes = Uint8Array.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0x00,
  0x00, 0x00, 0x00, 0x6d, 0x69, 0x66, 0x31,
]);

const jpegChecksum = sha256Hex(jpegBytes);
const pngChecksum = sha256Hex(pngBytes);
const pdfBytes = new TextEncoder().encode("%PDF-1.4\n%%EOF\n");
const pdfChecksum = sha256Hex(pdfBytes);

function sameSizeMutatedJpeg(source: Uint8Array = jpegBytes): Uint8Array {
  const leftoverBytes = Uint8Array.from(source);
  const flipIndex = leftoverBytes.byteLength - 3;
  const originalByte = leftoverBytes.at(flipIndex);
  if (originalByte === undefined) {
    throw new Error("jpeg fixture is too short to mutate");
  }
  leftoverBytes[flipIndex] = originalByte ^ 0xff;
  return leftoverBytes;
}

function sameSizeMutatedZip(source: Uint8Array = zipBytes): Uint8Array {
  const leftoverBytes = Uint8Array.from(source);
  const flipIndex = leftoverBytes.byteLength - 1;
  const originalByte = leftoverBytes.at(flipIndex);
  if (originalByte === undefined) {
    throw new Error("zip fixture is too short to mutate");
  }
  leftoverBytes[flipIndex] = originalByte ^ 0xff;
  return leftoverBytes;
}

const exeChecksum = sha256Hex(exeBytes);
const zipChecksum = sha256Hex(zipBytes);
const heicAsJpegChecksum = sha256Hex(heicBytes);

const jpegInput = {
  purpose: "catalog" as const,
  mimeType: "image/jpeg" as const,
  byteSize: jpegBytes.byteLength,
  checksumSha256: jpegChecksum,
};

const signingInput = {
  purpose: "signing" as const,
  mimeType: SIGNING_MIME_TYPE,
  byteSize: zipBytes.byteLength,
  checksumSha256: zipChecksum,
};

const clerks = {
  noUpload: randomUUID(),
  noView: randomUUID(),
  employee: randomUUID(),
  noDocumentsView: randomUUID(),
  uploadNoDocumentsEdit: randomUUID(),
  documentsEditNoUpload: randomUUID(),
};

const finalizeOwnInput = { fileId: "" };
const finalizeForeignInput = { fileId: "" };
const downloadOwnInput = { fileId: "" };
const downloadForeignInput = { fileId: "" };
const downloadUrlsOwnInput = { fileIds: [""] };
const downloadUrlsForeignInput = { fileIds: [""] };
const uploadOwnInput = { fileId: "" };
const uploadForeignInput = { fileId: "" };
const finalizeIdempotentInput = { fileId: "" };
const finalizeIdempotentFreshInput = { fileId: "" };
const recordOwnInput = {
  fileId: "",
  purpose: "document" as const,
  mimeType: "application/pdf" as const,
  byteSize: pdfBytes.byteLength,
  checksumSha256: pdfChecksum,
};
const recordForeignInput = {
  fileId: "",
  purpose: "document" as const,
  mimeType: "application/pdf" as const,
  byteSize: pdfBytes.byteLength,
  checksumSha256: pdfChecksum,
};
const recordIdempotentInput = {
  fileId: "",
  purpose: "document" as const,
  mimeType: "application/pdf" as const,
  byteSize: pdfBytes.byteLength,
  checksumSha256: pdfChecksum,
};
const recordIdempotentFreshInput = {
  fileId: "",
  purpose: "document" as const,
  mimeType: "application/pdf" as const,
  byteSize: pdfBytes.byteLength,
  checksumSha256: pdfChecksum,
};
const recordIdempotentConflictInput = {
  fileId: "",
  purpose: "document" as const,
  mimeType: "application/pdf" as const,
  byteSize: pdfBytes.byteLength,
  checksumSha256: pdfChecksum,
};
const docDownloadOwnInput = { fileId: "" };
const docDownloadForeignInput = { fileId: "" };
const signingUploadOwnInput = { fileId: "" };
const signingUploadForeignInput = { fileId: "" };
const signingRecordOwnInput = {
  fileId: "",
  purpose: "signing" as const,
  mimeType: SIGNING_MIME_TYPE,
  byteSize: zipBytes.byteLength,
  checksumSha256: zipChecksum,
};
const signingRecordForeignInput = {
  fileId: "",
  purpose: "signing" as const,
  mimeType: SIGNING_MIME_TYPE,
  byteSize: zipBytes.byteLength,
  checksumSha256: zipChecksum,
};
const signingRecordIdempotentInput = {
  fileId: "",
  purpose: "signing" as const,
  mimeType: SIGNING_MIME_TYPE,
  byteSize: zipBytes.byteLength,
  checksumSha256: zipChecksum,
};
const signingRecordIdempotentFreshInput = {
  fileId: "",
  purpose: "signing" as const,
  mimeType: SIGNING_MIME_TYPE,
  byteSize: zipBytes.byteLength,
  checksumSha256: zipChecksum,
};
const signingRecordIdempotentConflictInput = {
  fileId: "",
  purpose: "signing" as const,
  mimeType: SIGNING_MIME_TYPE,
  byteSize: zipBytes.byteLength,
  checksumSha256: zipChecksum,
};
const signingDownloadOwnInput = { fileId: "" };
const signingDownloadForeignInput = { fileId: "" };
const signingReadOwnInput = { fileId: "" };
const signingReadForeignInput = { fileId: "" };

let kit: TestKit | undefined;
let garage: StartedTestContainer | undefined;
let garageEndpoint: string | undefined;

function requireKit(): TestKit {
  if (kit === undefined) {
    throw new Error("files test kit was not started");
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

async function countCompanyFiles(companyId: string): Promise<number> {
  const rows = await requireKit()
    .db.runtime.db.select({ value: count() })
    .from(files)
    .where(eq(files.companyId, companyId));
  return rows[0]?.value ?? 0;
}

async function countSweepAudits(): Promise<number> {
  const rows = await requireKit()
    .db.runtime.db.select({ value: count() })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, "files.sweepAbandonedUploads"),
        eq(auditLog.outcome, "ok"),
      ),
    );
  return rows[0]?.value ?? 0;
}

async function countBackfillAudits(): Promise<number> {
  const rows = await requireKit()
    .db.runtime.db.select({ value: count() })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, "files.backfillCatalogRenditions"),
        eq(auditLog.outcome, "ok"),
      ),
    );
  return rows[0]?.value ?? 0;
}

async function countReadyFiles(companyId: string): Promise<number> {
  const rows = await requireKit()
    .db.runtime.db.select({ value: count() })
    .from(files)
    .where(and(eq(files.companyId, companyId), eq(files.status, "ready")));
  return rows[0]?.value ?? 0;
}

async function countPendingFiles(companyId: string): Promise<number> {
  const rows = await requireKit()
    .db.runtime.db.select({ value: count() })
    .from(files)
    .where(and(eq(files.companyId, companyId), eq(files.status, "pending")));
  return rows[0]?.value ?? 0;
}

async function countDocumentFiles(companyId: string): Promise<number> {
  const rows = await requireKit()
    .db.runtime.db.select({ value: count() })
    .from(files)
    .where(and(eq(files.companyId, companyId), eq(files.purpose, "document")));
  return rows[0]?.value ?? 0;
}

async function countSigningFiles(companyId: string): Promise<number> {
  const rows = await requireKit()
    .db.runtime.db.select({ value: count() })
    .from(files)
    .where(and(eq(files.companyId, companyId), eq(files.purpose, "signing")));
  return rows[0]?.value ?? 0;
}

async function countReadySigningFiles(companyId: string): Promise<number> {
  const rows = await requireKit()
    .db.runtime.db.select({ value: count() })
    .from(files)
    .where(
      and(
        eq(files.companyId, companyId),
        eq(files.purpose, "signing"),
        eq(files.status, "ready"),
      ),
    );
  return rows[0]?.value ?? 0;
}

async function mintPut(
  fileId: string,
  actor: { readonly userId?: string; readonly companyId?: string } = {},
): Promise<{
  readonly fileId: string;
  readonly uploadUrl: string;
  readonly expiresAt: string;
}> {
  return requireKit().invoke(getUploadUrl, { fileId }, actor);
}

async function requestPutFinalize(
  bytes: Uint8Array,
  mimeType: "image/jpeg" | "image/png" | "image/webp",
  actor: { readonly userId?: string; readonly companyId?: string } = {},
): Promise<{ readonly fileId: string; readonly checksumSha256: string }> {
  const requested = await requireKit().invoke(
    requestUpload,
    {
      purpose: "catalog",
      mimeType,
      byteSize: bytes.byteLength,
      checksumSha256: sha256Hex(bytes),
    },
    actor,
  );
  const signed = await mintPut(requested.fileId, actor);
  await putSigned(
    signed.uploadUrl,
    bytes,
    mimeType,
    stagingObjectKey(
      actor.companyId ?? kitIdentities.companies.a,
      requested.fileId,
    ),
  );
  const ready = await requireKit().invoke(
    finalizeUpload,
    { fileId: requested.fileId },
    actor,
  );
  return {
    fileId: ready.fileId,
    checksumSha256: ready.checksumSha256,
  };
}

async function requestAndPut(
  bytes: Uint8Array,
  mimeType: "image/jpeg" | "image/png" | "image/webp",
  actor: { readonly userId?: string; readonly companyId?: string } = {},
): Promise<string> {
  const requested = await requireKit().invoke(
    requestUpload,
    {
      purpose: "catalog",
      mimeType,
      byteSize: bytes.byteLength,
      checksumSha256: sha256Hex(bytes),
    },
    actor,
  );
  const signed = await mintPut(requested.fileId, actor);
  await putSigned(
    signed.uploadUrl,
    bytes,
    mimeType,
    stagingObjectKey(
      actor.companyId ?? kitIdentities.companies.a,
      requested.fileId,
    ),
  );
  return requested.fileId;
}

async function insertFileRow(values: {
  readonly id: string;
  readonly companyId: string;
  readonly uploadedByUserId: string;
  readonly status: "pending" | "ready";
  readonly mimeType?: FileMimeType;
  readonly bytes?: Uint8Array;
  readonly checksumSha256?: string;
  readonly createdAt?: Date;
  readonly updatedAt?: Date;
}): Promise<void> {
  const mimeType = values.mimeType ?? "image/jpeg";
  const bytes = values.bytes ?? jpegBytes;
  await requireKit()
    .db.runtime.db.insert(files)
    .values({
      id: values.id,
      companyId: values.companyId,
      uploadedByUserId: values.uploadedByUserId,
      purpose: "catalog",
      objectKey: catalogObjectKey(values.companyId, values.id),
      mimeType,
      byteSize: BigInt(bytes.byteLength),
      checksumSha256: values.checksumSha256 ?? sha256Hex(bytes),
      status: values.status,
      ...(values.createdAt !== undefined
        ? { createdAt: values.createdAt }
        : {}),
      ...(values.updatedAt !== undefined
        ? { updatedAt: values.updatedAt }
        : {}),
    });
}

async function insertSigningFileRow(values: {
  readonly id: string;
  readonly companyId: string;
  readonly uploadedByUserId: string;
  readonly status: "pending" | "ready";
  readonly createdAt?: Date;
}): Promise<void> {
  await requireKit()
    .db.runtime.db.insert(files)
    .values({
      id: values.id,
      companyId: values.companyId,
      uploadedByUserId: values.uploadedByUserId,
      purpose: "signing",
      objectKey: signingObjectKey(values.companyId, values.id),
      mimeType: SIGNING_MIME_TYPE,
      byteSize: BigInt(zipBytes.byteLength),
      checksumSha256: zipChecksum,
      status: values.status,
      ...(values.createdAt !== undefined
        ? { createdAt: values.createdAt }
        : {}),
    });
}

async function putStoreObject(
  key: string,
  bytes: Uint8Array = jpegBytes,
  mimeType: StoredObjectMimeType = "image/jpeg",
): Promise<void> {
  const store = getFilesObjectStore();
  await store.putObject({
    key,
    mimeType,
    bytes,
  });
  await waitForObjectVisibility(store, key, "present");
}

async function expectCatalogRenditions(
  companyId: string,
  fileId: string,
  expected: "present" | "missing",
): Promise<void> {
  const store = getFilesObjectStore();
  for (const rendition of CATALOG_RENDITIONS) {
    const key = catalogRenditionObjectKey(companyId, fileId, rendition);
    if (expected === "present") {
      await waitForObjectVisibility(store, key, "present");
    } else {
      await waitForObjectVisibility(store, key, "missing");
      expect(await store.headObject(key)).toBe("missing");
    }
  }
}

async function putCatalogRenditionObjects(
  companyId: string,
  fileId: string,
): Promise<void> {
  for (const rendition of CATALOG_RENDITIONS) {
    await putStoreObject(
      catalogRenditionObjectKey(companyId, fileId, rendition),
    );
  }
}

async function putGeneratedPdf(
  companyId: string,
  fileId: string,
): Promise<void> {
  await putStoreObject(
    documentObjectKey(companyId, fileId),
    pdfBytes,
    "application/pdf",
  );
}

function generatedRecordInput(fileId: string): typeof recordOwnInput {
  return {
    fileId,
    purpose: "document",
    mimeType: "application/pdf",
    byteSize: pdfBytes.byteLength,
    checksumSha256: pdfChecksum,
  };
}

function signingRecordInput(fileId: string): typeof signingRecordOwnInput {
  return {
    fileId,
    purpose: "signing",
    mimeType: SIGNING_MIME_TYPE,
    byteSize: zipBytes.byteLength,
    checksumSha256: zipChecksum,
  };
}

async function requestSigningPut(
  actor: { readonly userId?: string; readonly companyId?: string } = {},
): Promise<{ readonly fileId: string }> {
  const requested = await requireKit().invoke(
    requestSigningUpload,
    signingInput,
    actor,
  );
  const signed = await requireKit().invoke(
    getSigningUploadUrl,
    { fileId: requested.fileId },
    actor,
  );
  await putSigned(
    signed.uploadUrl,
    zipBytes,
    SIGNING_MIME_TYPE,
    stagingObjectKey(
      actor.companyId ?? kitIdentities.companies.a,
      requested.fileId,
    ),
  );
  return { fileId: requested.fileId };
}

async function requestSigningPutRecord(
  actor: { readonly userId?: string; readonly companyId?: string } = {},
): Promise<{ readonly fileId: string }> {
  const pending = await requestSigningPut(actor);
  await requireKit().invoke(
    recordSigningObject,
    signingRecordInput(pending.fileId),
    actor,
  );
  return pending;
}

const sweepEpoch = new Date(0);

beforeAll(async () => {
  const garageToml = readFileSync(
    path.join(repoRoot(), "docker/garage/garage.toml"),
    "utf8",
  ).replaceAll("\r\n", "\n");
  // dxflrs/garage is distroless (no /bin/sh), so HostPortWaitStrategy never
  // sees the S3 port. Wait on the listen log and keep metadata on tmpfs.
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
  garageEndpoint = endpoint;
  configureFilesObjectStore({
    endpoint,
    region: "us-east-1",
    accessKeyId: GARAGE_ACCESS_KEY,
    secretAccessKey: GARAGE_SECRET_KEY,
    forcePathStyle: true,
    bucket: GARAGE_BUCKET,
  });
  await waitForBucket();

  kit = await createTestKit();

  await requireKit()
    .db.runtime.db.insert(user)
    .values([
      {
        id: clerks.noUpload,
        name: "No upload",
        email: "noupload@files-kit.test",
      },
      {
        id: clerks.noView,
        name: "No view",
        email: "noview@files-kit.test",
      },
      {
        id: clerks.employee,
        name: "Employee",
        email: "employee@files-kit.test",
      },
      {
        id: clerks.noDocumentsView,
        name: "No documents view",
        email: "nodocuments@files-kit.test",
      },
      {
        id: clerks.uploadNoDocumentsEdit,
        name: "Upload no documents edit",
        email: "upload-no-doc-edit@files-kit.test",
      },
      {
        id: clerks.documentsEditNoUpload,
        name: "Documents edit no upload",
        email: "doc-edit-no-upload@files-kit.test",
      },
    ]);
  await requireKit()
    .db.runtime.db.insert(companyMembers)
    .values([
      {
        companyId: kitIdentities.companies.a,
        userId: clerks.noUpload,
        role: "employee",
        permissions: { granted: [], denied: ["files:upload"] },
      },
      {
        companyId: kitIdentities.companies.a,
        userId: clerks.noView,
        role: "employee",
        permissions: { granted: [], denied: ["files:view"] },
      },
      {
        companyId: kitIdentities.companies.a,
        userId: clerks.employee,
        role: "employee",
        permissions: { granted: ["documents:view"], denied: [] },
      },
      {
        companyId: kitIdentities.companies.a,
        userId: clerks.noDocumentsView,
        role: "employee",
        permissions: { granted: [], denied: ["documents:view"] },
      },
      {
        companyId: kitIdentities.companies.a,
        userId: clerks.uploadNoDocumentsEdit,
        role: "employee",
        permissions: {
          granted: ["files:upload"],
          denied: ["documents:edit"],
        },
      },
      {
        companyId: kitIdentities.companies.a,
        userId: clerks.documentsEditNoUpload,
        role: "employee",
        permissions: {
          granted: ["documents:edit"],
          denied: ["files:upload"],
        },
      },
    ]);

  const companyB = {
    userId: kitIdentities.users.boris,
    companyId: kitIdentities.companies.b,
  };
  finalizeOwnInput.fileId = await requestAndPut(jpegBytes, "image/jpeg");
  finalizeForeignInput.fileId = await requestAndPut(
    jpegBytes,
    "image/jpeg",
    companyB,
  );
  downloadOwnInput.fileId = (
    await requestPutFinalize(jpegBytes, "image/jpeg")
  ).fileId;
  downloadForeignInput.fileId = (
    await requestPutFinalize(jpegBytes, "image/jpeg", companyB)
  ).fileId;
  downloadUrlsOwnInput.fileIds = [downloadOwnInput.fileId];
  downloadUrlsForeignInput.fileIds = [downloadForeignInput.fileId];
  uploadOwnInput.fileId = (
    await requireKit().invoke(requestUpload, jpegInput)
  ).fileId;
  uploadForeignInput.fileId = (
    await requireKit().invoke(requestUpload, jpegInput, companyB)
  ).fileId;
  finalizeIdempotentInput.fileId = await requestAndPut(jpegBytes, "image/jpeg");
  finalizeIdempotentFreshInput.fileId = await requestAndPut(
    jpegBytes,
    "image/jpeg",
  );

  recordOwnInput.fileId = randomUUID();
  await putGeneratedPdf(kitIdentities.companies.a, recordOwnInput.fileId);
  recordForeignInput.fileId = randomUUID();
  await putGeneratedPdf(kitIdentities.companies.b, recordForeignInput.fileId);
  recordIdempotentInput.fileId = randomUUID();
  await putGeneratedPdf(
    kitIdentities.companies.a,
    recordIdempotentInput.fileId,
  );
  recordIdempotentConflictInput.fileId = randomUUID();
  await putGeneratedPdf(
    kitIdentities.companies.a,
    recordIdempotentConflictInput.fileId,
  );
  recordIdempotentFreshInput.fileId = randomUUID();
  await putGeneratedPdf(
    kitIdentities.companies.a,
    recordIdempotentFreshInput.fileId,
  );

  docDownloadOwnInput.fileId = randomUUID();
  await putGeneratedPdf(kitIdentities.companies.a, docDownloadOwnInput.fileId);
  await requireKit().invoke(
    recordGeneratedObject,
    generatedRecordInput(docDownloadOwnInput.fileId),
  );
  docDownloadForeignInput.fileId = randomUUID();
  await putGeneratedPdf(
    kitIdentities.companies.b,
    docDownloadForeignInput.fileId,
  );
  await requireKit().invoke(
    recordGeneratedObject,
    generatedRecordInput(docDownloadForeignInput.fileId),
    { companyId: kitIdentities.companies.b },
  );

  signingUploadOwnInput.fileId = (
    await requireKit().invoke(requestSigningUpload, signingInput)
  ).fileId;
  signingUploadForeignInput.fileId = (
    await requireKit().invoke(requestSigningUpload, signingInput, companyB)
  ).fileId;
  signingRecordOwnInput.fileId = (await requestSigningPut()).fileId;
  signingRecordForeignInput.fileId = (await requestSigningPut(companyB)).fileId;
  signingRecordIdempotentInput.fileId = (await requestSigningPut()).fileId;
  signingRecordIdempotentConflictInput.fileId = (
    await requestSigningPut()
  ).fileId;
  signingRecordIdempotentFreshInput.fileId = (await requestSigningPut()).fileId;
  signingDownloadOwnInput.fileId = (await requestSigningPutRecord()).fileId;
  signingDownloadForeignInput.fileId = (
    await requestSigningPutRecord(companyB)
  ).fileId;
  signingReadOwnInput.fileId = (await requestSigningPut()).fileId;
  signingReadForeignInput.fileId = (await requestSigningPut(companyB)).fileId;
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

describe("files object store probe", () => {
  it("fails HeadBucket on a missing bucket without echoing credentials", async () => {
    if (garageEndpoint === undefined) {
      throw new Error("Garage endpoint was not captured");
    }
    const store = createFilesObjectStore({
      endpoint: garageEndpoint,
      region: "us-east-1",
      accessKeyId: GARAGE_ACCESS_KEY,
      secretAccessKey: GARAGE_SECRET_KEY,
      forcePathStyle: true,
      bucket: "missing-bucket-sho-119",
    });
    try {
      let thrown: unknown;
      try {
        await store.probeBucket();
      } catch (error) {
        thrown = error;
      }
      if (!(thrown instanceof CoreInvariantError)) {
        throw new Error("expected CoreInvariantError from missing bucket");
      }
      const serialized = JSON.stringify({
        message: thrown.message,
        cause: thrown.cause,
        stack: thrown.stack,
      });
      expect(thrown.message).toContain("HeadBucket");
      if (
        typeof thrown.cause !== "object" ||
        thrown.cause === null ||
        !("code" in thrown.cause) ||
        typeof thrown.cause.code !== "string"
      ) {
        throw new Error("expected sanitized object-store cause");
      }
      expect(thrown.cause.code.length).toBeGreaterThan(0);
      expect(thrown.cause).not.toHaveProperty("message");
      expect(serialized).not.toContain(GARAGE_SECRET_KEY);
      expect(serialized).not.toContain("X-Amz-Signature");
    } finally {
      store.close();
    }
  });
});

describe("files object store copyObject", () => {
  it("copies with CopySourceIfMatch and treats a stale ETag as precondition-failed", async () => {
    const store = getFilesObjectStore();
    const sourceKey = stagingObjectKey(kitIdentities.companies.a, randomUUID());
    const destinationKey = signingObjectKey(
      kitIdentities.companies.a,
      randomUUID(),
    );
    await putStoreObject(sourceKey, zipBytes, SIGNING_MIME_TYPE);
    const source = await store.getObject(sourceKey);
    expect(source).not.toBe("missing");
    if (source === "missing") {
      throw new Error("expected staging object before copy");
    }

    const copied = await store.copyObject({
      sourceKey,
      destinationKey,
      sourceEtag: source.etag,
    });
    expect(copied).toBe("copied");
    await waitForObjectVisibility(store, destinationKey, "present");
    const destination = await store.getObject(destinationKey);
    expect(destination).not.toBe("missing");
    if (destination === "missing") {
      throw new Error("expected durable object after copy");
    }
    expect(sha256Hex(destination.bytes)).toBe(zipChecksum);

    const stale = await store.copyObject({
      sourceKey,
      destinationKey,
      sourceEtag: "deadbeefstaleetag",
    });
    expect(stale).toBe("precondition-failed");
    const afterStale = await store.getObject(destinationKey);
    expect(afterStale).not.toBe("missing");
    if (afterStale === "missing") {
      throw new Error("stale If-Match must not replace the durable object");
    }
    expect(sha256Hex(afterStale.bytes)).toBe(zipChecksum);
  });
});

crossTenantSuite(requireKit, [
  isolationCase(
    requestUpload,
    { input: jpegInput },
    { input: jpegInput, companyId: kitIdentities.companies.b },
  ),
  isolationCase(
    finalizeUpload,
    { input: finalizeOwnInput },
    { input: finalizeForeignInput },
  ),
  isolationCase(
    getDownloadUrl,
    { input: downloadOwnInput },
    { input: downloadForeignInput },
  ),
  isolationCase(
    getDownloadUrls,
    { input: downloadUrlsOwnInput },
    { input: downloadUrlsForeignInput },
  ),
  isolationCase(
    getUploadUrl,
    { input: uploadOwnInput },
    { input: uploadForeignInput },
  ),
  isolationCase(sweepAbandonedUploads, { input: {} }, { input: {} }),
  isolationCase(backfillCatalogRenditions, { input: {} }, { input: {} }),
  isolationCase(
    recordGeneratedObject,
    { input: recordOwnInput },
    { input: recordForeignInput },
  ),
  isolationCase(
    issueDocumentDownloadUrl,
    { input: docDownloadOwnInput },
    { input: docDownloadForeignInput },
  ),
  isolationCase(
    issueShareDownloadUrl,
    { input: docDownloadOwnInput },
    { input: docDownloadForeignInput },
  ),
  isolationCase(
    requestSigningUpload,
    { input: signingInput },
    { input: signingInput, companyId: kitIdentities.companies.b },
  ),
  isolationCase(
    getSigningUploadUrl,
    { input: signingUploadOwnInput },
    { input: signingUploadForeignInput },
  ),
  isolationCase(
    recordSigningObject,
    { input: signingRecordOwnInput },
    { input: signingRecordForeignInput },
  ),
  isolationCase(
    readPendingSigningObject,
    { input: signingReadOwnInput },
    { input: signingReadForeignInput },
  ),
  isolationCase(
    issueSigningDownloadUrl,
    { input: signingDownloadOwnInput },
    { input: signingDownloadForeignInput },
  ),
  isolationCase(
    issueShareSigningDownloadUrl,
    { input: signingDownloadOwnInput },
    { input: signingDownloadForeignInput },
  ),
  isolationCase(
    issueSystemSigningDownloadUrl,
    { input: signingDownloadOwnInput },
    { input: signingDownloadForeignInput },
  ),
]);

idempotencySuite(requireKit, [
  {
    action: requestUpload,
    input: jpegInput,
    conflictingInput: {
      ...jpegInput,
      mimeType: "image/png",
      byteSize: pngBytes.byteLength,
      checksumSha256: pngChecksum,
    },
    readEffect: () => countCompanyFiles(kitIdentities.companies.a),
  },
  {
    action: finalizeUpload,
    input: finalizeIdempotentInput,
    conflictingInput: finalizeForeignInput,
    freshInput: () => finalizeIdempotentFreshInput,
    readEffect: () => countReadyFiles(kitIdentities.companies.a),
  },
  {
    action: sweepAbandonedUploads,
    input: {},
    conflictingInput: { limit: 1 },
    readEffect: () => countSweepAudits(),
  },
  {
    action: backfillCatalogRenditions,
    input: {},
    conflictingInput: { limit: 1 },
    readEffect: () => countBackfillAudits(),
  },
  {
    action: recordGeneratedObject,
    input: recordIdempotentInput,
    conflictingInput: recordIdempotentConflictInput,
    freshInput: () => recordIdempotentFreshInput,
    readEffect: () => countDocumentFiles(kitIdentities.companies.a),
  },
  {
    action: requestSigningUpload,
    input: signingInput,
    conflictingInput: {
      ...signingInput,
      byteSize: zipBytes.byteLength + 1,
      checksumSha256: "d".repeat(64),
    },
    readEffect: () => countSigningFiles(kitIdentities.companies.a),
  },
  {
    action: recordSigningObject,
    input: signingRecordIdempotentInput,
    conflictingInput: signingRecordIdempotentConflictInput,
    freshInput: () => signingRecordIdempotentFreshInput,
    readEffect: () => countReadySigningFiles(kitIdentities.companies.a),
  },
]);

describe("files signed upload slice", () => {
  it("uploads through a signed PUT, finalizes, and downloads the same bytes", async () => {
    const capturing = createCapturingLogger();
    const sneaky: unknown = {
      ...jpegInput,
      objectKey: "client-supplied/catalog/evil",
      companyId: kitIdentities.companies.b,
    };
    const requested = await requireKit().invoke(
      requestUpload,
      sneaky,
      {},
      { deps: { ...requireKit().pipeline, logger: capturing.logger } },
    );
    expect(requested).toEqual({ fileId: requested.fileId });
    expect(requested).not.toHaveProperty("uploadUrl");

    const rows = await requireKit()
      .db.runtime.db.select()
      .from(files)
      .where(eq(files.id, requested.fileId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("pending");
    expect(rows[0]?.objectKey).toBe(
      catalogObjectKey(kitIdentities.companies.a, requested.fileId),
    );
    expect(rows[0]?.objectKey).toBe(
      `${kitIdentities.companies.a}/catalog/${requested.fileId}`,
    );

    const signed = await requireKit().invoke(
      getUploadUrl,
      { fileId: requested.fileId },
      {},
      { deps: { ...requireKit().pipeline, logger: capturing.logger } },
    );
    expect(signed.fileId).toBe(requested.fileId);
    expect(signed.uploadUrl.startsWith("http")).toBe(true);
    expect(signed.uploadUrl).toContain("/uploads/");
    expect(signed.uploadUrl).not.toContain("/catalog/");
    expect(signed.expiresAt).toEqual(expect.any(String));

    await putSigned(
      signed.uploadUrl,
      jpegBytes,
      "image/jpeg",
      stagingObjectKey(kitIdentities.companies.a, requested.fileId),
    );
    const store = getFilesObjectStore();
    expect(
      await store.getObject(
        catalogObjectKey(kitIdentities.companies.a, requested.fileId),
      ),
    ).toBe("missing");
    const staged = await store.getObject(
      stagingObjectKey(kitIdentities.companies.a, requested.fileId),
    );
    expect(staged).not.toBe("missing");
    if (staged === "missing") {
      throw new Error("expected staging object after signed PUT");
    }
    expect(sha256Hex(staged.bytes)).toBe(jpegChecksum);

    const ready = await requireKit().invoke(
      finalizeUpload,
      { fileId: requested.fileId },
      {},
      { deps: { ...requireKit().pipeline, logger: capturing.logger } },
    );
    expect(ready).toEqual({
      fileId: requested.fileId,
      status: "ready",
      purpose: "catalog",
      mimeType: "image/jpeg",
      byteSize: jpegBytes.byteLength,
      checksumSha256: jpegChecksum,
    });

    const again = await requireKit().invoke(finalizeUpload, {
      fileId: requested.fileId,
    });
    expect(again).toEqual(ready);

    const catalogHead = await getFilesObjectStore().headObject(
      catalogObjectKey(kitIdentities.companies.a, requested.fileId),
    );
    expect(catalogHead).not.toBe("missing");
    await expectCatalogRenditions(
      kitIdentities.companies.a,
      requested.fileId,
      "present",
    );

    const download = await requireKit().invoke(getDownloadUrl, {
      fileId: requested.fileId,
    });
    const fetched = await fetch(download.downloadUrl);
    expect(fetched.ok).toBe(true);
    const body = new Uint8Array(await fetched.arrayBuffer());
    expect(sha256Hex(body)).toBe(jpegChecksum);
    expect(fetched.headers.get("content-type")).toMatch(/^image\/jpeg/i);
    expect(fetched.headers.get("content-disposition")).toContain("inline");

    const logs = JSON.stringify(capturing.entries());
    expect(logs).not.toContain(signed.uploadUrl);
    expect(logs).not.toContain(rows[0]?.objectKey ?? "missing-key");
    expect(logs).not.toMatch(/\/catalog\//);
    expect(logs).not.toMatch(/\/uploads\//);
  });

  it("does not let a leftover signed PUT overwrite a ready catalog object", async () => {
    const requested = await requireKit().invoke(requestUpload, jpegInput);
    const signed = await mintPut(requested.fileId);
    await putSigned(
      signed.uploadUrl,
      jpegBytes,
      "image/jpeg",
      stagingObjectKey(kitIdentities.companies.a, requested.fileId),
    );
    const ready = await requireKit().invoke(finalizeUpload, {
      fileId: requested.fileId,
    });
    expect(ready.checksumSha256).toBe(jpegChecksum);

    const leftoverBytes = sameSizeMutatedJpeg();
    expect(leftoverBytes.byteLength).toBe(jpegBytes.byteLength);
    const leftoverChecksum = sha256Hex(leftoverBytes);
    expect(leftoverChecksum).not.toBe(jpegChecksum);

    await putSigned(
      signed.uploadUrl,
      leftoverBytes,
      "image/jpeg",
      stagingObjectKey(kitIdentities.companies.a, requested.fileId),
    );

    const store = getFilesObjectStore();
    const catalog = await store.getObject(
      catalogObjectKey(kitIdentities.companies.a, requested.fileId),
    );
    expect(catalog).not.toBe("missing");
    if (catalog === "missing") {
      throw new Error("expected catalog object after finalize");
    }
    expect(sha256Hex(catalog.bytes)).toBe(jpegChecksum);

    const staging = await store.getObject(
      stagingObjectKey(kitIdentities.companies.a, requested.fileId),
    );
    expect(staging).not.toBe("missing");
    if (staging === "missing") {
      throw new Error("expected staging object after leftover PUT");
    }
    expect(sha256Hex(staging.bytes)).toBe(leftoverChecksum);

    const again = await requireKit().invoke(finalizeUpload, {
      fileId: requested.fileId,
    });
    expect(again.checksumSha256).toBe(jpegChecksum);
    expect(again).toEqual(ready);

    const catalogAfterReplay = await store.getObject(
      catalogObjectKey(kitIdentities.companies.a, requested.fileId),
    );
    expect(catalogAfterReplay).not.toBe("missing");
    if (catalogAfterReplay === "missing") {
      throw new Error("expected catalog object after second finalize");
    }
    expect(sha256Hex(catalogAfterReplay.bytes)).toBe(jpegChecksum);

    const download = await requireKit().invoke(getDownloadUrl, {
      fileId: requested.fileId,
    });
    const fetched = await fetch(download.downloadUrl);
    expect(fetched.ok).toBe(true);
    const body = new Uint8Array(await fetched.arrayBuffer());
    expect(sha256Hex(body)).toBe(jpegChecksum);

    const rows = await requireKit()
      .db.runtime.db.select()
      .from(files)
      .where(eq(files.id, requested.fileId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("ready");
    expect(rows[0]?.checksumSha256).toBe(jpegChecksum);
    expect(rows[0]?.objectKey).toBe(
      catalogObjectKey(kitIdentities.companies.a, requested.fileId),
    );
    expect(rows[0]?.objectKey).not.toContain("/uploads/");
  });

  it("lets one concurrent finalize win with identical ready bytes", async () => {
    const fileId = await requestAndPut(jpegBytes, "image/jpeg");
    const results = await Promise.allSettled([
      requireKit().invoke(finalizeUpload, { fileId }),
      requireKit().invoke(finalizeUpload, { fileId }),
    ]);
    const fulfilled = results.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    expect(fulfilled).toHaveLength(2);
    const winner: FileReadyView | undefined = fulfilled[0];
    if (winner === undefined) {
      throw new Error("expected at least one successful finalize");
    }
    for (const view of fulfilled) {
      expect(view).toEqual(winner);
    }
    expect(winner.status).toBe("ready");
    expect(winner.checksumSha256).toBe(jpegChecksum);

    const rows = await requireKit()
      .db.runtime.db.select()
      .from(files)
      .where(eq(files.id, fileId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("ready");
    expect(rows[0]?.checksumSha256).toBe(jpegChecksum);

    const catalog = await getFilesObjectStore().getObject(
      catalogObjectKey(kitIdentities.companies.a, fileId),
    );
    expect(catalog).not.toBe("missing");
    if (catalog === "missing") {
      throw new Error("expected catalog object after concurrent finalize");
    }
    expect(sha256Hex(catalog.bytes)).toBe(jpegChecksum);
    expect(sha256Hex(catalog.bytes)).toBe(rows[0]?.checksumSha256);
  });

  it("fails closed when staging changes after the unlocked GET", async () => {
    const fileId = await requestAndPut(jpegBytes, "image/jpeg");
    const leftoverBytes = sameSizeMutatedJpeg();
    const leftoverChecksum = sha256Hex(leftoverBytes);
    expect(leftoverChecksum).not.toBe(jpegChecksum);
    const stagingKey = stagingObjectKey(kitIdentities.companies.a, fileId);
    const catalogKey = catalogObjectKey(kitIdentities.companies.a, fileId);

    const restore = mapConfiguredFilesObjectStore((inner) => ({
      ...inner,
      async getObject(key) {
        const object = await inner.getObject(key);
        if (key === stagingKey && object !== "missing") {
          await inner.putObject({
            key,
            mimeType: "image/jpeg",
            bytes: leftoverBytes,
          });
        }
        return object;
      },
    }));
    try {
      await expect(
        requireKit().invoke(finalizeUpload, { fileId }),
      ).rejects.toBeInstanceOf(ValidationError);
    } finally {
      restore();
    }

    const rows = await requireKit()
      .db.runtime.db.select()
      .from(files)
      .where(eq(files.id, fileId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("pending");
    expect(rows[0]?.checksumSha256).toBe(jpegChecksum);

    const store = getFilesObjectStore();
    expect(await store.getObject(catalogKey)).toBe("missing");
    const staging = await store.getObject(stagingKey);
    expect(staging).not.toBe("missing");
    if (staging === "missing") {
      throw new Error("expected leftover staging after TOCTOU finalize");
    }
    expect(sha256Hex(staging.bytes)).toBe(leftoverChecksum);

    const capturing = createCapturingLogger();
    await expect(
      requireKit().invoke(
        finalizeUpload,
        { fileId },
        {},
        { deps: { ...requireKit().pipeline, logger: capturing.logger } },
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await store.getObject(catalogKey)).toBe("missing");
    const logs = JSON.stringify(capturing.entries());
    expect(logs).not.toContain(catalogKey);
    expect(logs).not.toContain(stagingKey);
    expect(logs).not.toMatch(/\/catalog\//);
    expect(logs).not.toMatch(/\/uploads\//);
  });

  it("denies staff without files:upload or files:view", async () => {
    const actorCompany = { companyId: kitIdentities.companies.a };
    await expect(
      requireKit().invoke(requestUpload, jpegInput, {
        ...actorCompany,
        userId: clerks.noUpload,
      }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      requireKit().invoke(
        finalizeUpload,
        { fileId: downloadOwnInput.fileId },
        { ...actorCompany, userId: clerks.noUpload },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      requireKit().invoke(
        getDownloadUrl,
        { fileId: downloadOwnInput.fileId },
        { ...actorCompany, userId: clerks.noView },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      requireKit().invoke(
        getDownloadUrl,
        { fileId: downloadOwnInput.fileId, rendition: "thumb" },
        { ...actorCompany, userId: clerks.noView },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      requireKit().invoke(
        getDownloadUrls,
        { fileIds: [downloadOwnInput.fileId], rendition: "card" },
        { ...actorCompany, userId: clerks.noView },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      requireKit().invoke(
        getUploadUrl,
        { fileId: uploadOwnInput.fileId },
        { ...actorCompany, userId: clerks.noUpload },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("rejects oversize, wrong MIME, HEIC, executables, and archives", async () => {
    await expect(
      requireKit().invoke(requestUpload, {
        ...jpegInput,
        byteSize: MAX_UPLOAD_BYTES + 1,
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    await expect(
      requireKit().invoke(requestUpload, {
        ...jpegInput,
        mimeType: "image/heic",
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    await expect(
      requireKit().invoke(requestUpload, {
        ...jpegInput,
        purpose: "documents",
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    await expect(
      requireKit().invoke(requestUpload, {
        ...jpegInput,
        purpose: "document",
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    await expect(
      requireKit().invoke(requestUpload, {
        ...jpegInput,
        purpose: "signing",
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    await expect(
      requireKit().invoke(requestUpload, {
        ...jpegInput,
        mimeType: SIGNING_MIME_TYPE,
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    const exe = await requireKit().invoke(requestUpload, {
      purpose: "catalog",
      mimeType: "image/jpeg",
      byteSize: exeBytes.byteLength,
      checksumSha256: exeChecksum,
    });
    await putSigned(
      (await mintPut(exe.fileId)).uploadUrl,
      exeBytes,
      "image/jpeg",
      stagingObjectKey(kitIdentities.companies.a, exe.fileId),
    );
    await expect(
      requireKit().invoke(finalizeUpload, { fileId: exe.fileId }),
    ).rejects.toBeInstanceOf(ValidationError);

    const zip = await requireKit().invoke(requestUpload, {
      purpose: "catalog",
      mimeType: "image/png",
      byteSize: zipBytes.byteLength,
      checksumSha256: zipChecksum,
    });
    await putSigned(
      (await mintPut(zip.fileId)).uploadUrl,
      zipBytes,
      "image/png",
      stagingObjectKey(kitIdentities.companies.a, zip.fileId),
    );
    await expect(
      requireKit().invoke(finalizeUpload, { fileId: zip.fileId }),
    ).rejects.toBeInstanceOf(ValidationError);

    const heic = await requireKit().invoke(requestUpload, {
      purpose: "catalog",
      mimeType: "image/jpeg",
      byteSize: heicBytes.byteLength,
      checksumSha256: heicAsJpegChecksum,
    });
    await putSigned(
      (await mintPut(heic.fileId)).uploadUrl,
      heicBytes,
      "image/jpeg",
      stagingObjectKey(kitIdentities.companies.a, heic.fileId),
    );
    await expect(
      requireKit().invoke(finalizeUpload, { fileId: heic.fileId }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("treats foreign, missing, and ready fileIds as not-found on getUploadUrl", async () => {
    const missing = randomUUID();
    await expect(
      requireKit().invoke(finalizeUpload, { fileId: missing }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      requireKit().invoke(getDownloadUrl, { fileId: missing }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      requireKit().invoke(getUploadUrl, { fileId: missing }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      requireKit().invoke(finalizeUpload, {
        fileId: finalizeForeignInput.fileId,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      requireKit().invoke(getDownloadUrl, {
        fileId: finalizeForeignInput.fileId,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      requireKit().invoke(getDownloadUrl, {
        fileId: downloadForeignInput.fileId,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      requireKit().invoke(getUploadUrl, {
        fileId: uploadForeignInput.fileId,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      requireKit().invoke(getUploadUrl, {
        fileId: downloadOwnInput.fileId,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      requireKit().invoke(getUploadUrl, {
        fileId: signingUploadOwnInput.fileId,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      requireKit().invoke(finalizeUpload, {
        fileId: signingUploadOwnInput.fileId,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      requireKit().invoke(getDownloadUrl, {
        fileId: signingDownloadOwnInput.fileId,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    const pending = await requireKit().invoke(requestUpload, jpegInput);
    await expect(
      requireKit().invoke(getDownloadUrl, { fileId: pending.fileId }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      requireKit().invoke(finalizeUpload, { fileId: pending.fileId }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("replays requestUpload as the same fileId without a second pending row or a stored URL", async () => {
    const key = randomUUID();
    const first = await requireKit().invoke(
      requestUpload,
      jpegInput,
      {},
      {
        request: { idempotencyKey: key },
      },
    );
    const replay = await requireKit().invoke(
      requestUpload,
      jpegInput,
      {},
      {
        request: { idempotencyKey: key },
      },
    );
    expect(first).toEqual({ fileId: first.fileId });
    expect(replay).toEqual(first);

    const fileRows = await requireKit()
      .db.runtime.db.select()
      .from(files)
      .where(eq(files.id, first.fileId));
    expect(fileRows).toHaveLength(1);
    expect(fileRows[0]?.status).toBe("pending");

    const reservations = await requireKit()
      .db.runtime.db.select()
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.action, "files.requestUpload"),
          eq(idempotencyKeys.key, key),
        ),
      );
    expect(reservations).toHaveLength(1);
    expect(reservations[0]?.response).toEqual({ fileId: first.fileId });
    const snapshot = JSON.stringify(reservations[0]?.response);
    expect(snapshot).not.toContain("uploadUrl");
    expect(snapshot).not.toContain("/catalog/");
    expect(snapshot).not.toContain("/uploads/");
    expect(snapshot).not.toContain("objectKey");
    expect(snapshot).not.toContain("http");
  });

  it("mints a live PUT again without a new pending row", async () => {
    const requested = await requireKit().invoke(requestUpload, jpegInput);
    const pendingBefore = await countPendingFiles(kitIdentities.companies.a);
    const first = await mintPut(requested.fileId);
    const second = await mintPut(requested.fileId);
    expect(second.fileId).toBe(requested.fileId);
    expect(first.uploadUrl.startsWith("http")).toBe(true);
    expect(second.uploadUrl.startsWith("http")).toBe(true);
    expect(second.uploadUrl).toContain("/uploads/");
    expect(await countPendingFiles(kitIdentities.companies.a)).toBe(
      pendingBefore,
    );

    const fileRows = await requireKit()
      .db.runtime.db.select()
      .from(files)
      .where(eq(files.id, requested.fileId));
    expect(fileRows).toHaveLength(1);
    expect(fileRows[0]?.status).toBe("pending");

    await putSigned(
      second.uploadUrl,
      jpegBytes,
      "image/jpeg",
      stagingObjectKey(kitIdentities.companies.a, requested.fileId),
    );
    const ready = await requireKit().invoke(finalizeUpload, {
      fileId: requested.fileId,
    });
    expect(ready.checksumSha256).toBe(jpegChecksum);

    const reservations = await requireKit()
      .db.runtime.db.select()
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.action, "files.getUploadUrl"));
    expect(reservations).toHaveLength(0);
  });

  it("mints a PUT for a pending file younger than the remint cutoff without logging the URL", async () => {
    const fileId = randomUUID();
    const createdAt = new Date(Date.now() - 20 * 60 * 1000);
    await insertFileRow({
      id: fileId,
      companyId: kitIdentities.companies.a,
      uploadedByUserId: kitIdentities.users.anna,
      status: "pending",
      createdAt,
    });

    const capturing = createCapturingLogger();
    const signed = await requireKit().invoke(
      getUploadUrl,
      { fileId },
      {},
      { deps: { ...requireKit().pipeline, logger: capturing.logger } },
    );
    expect(signed.fileId).toBe(fileId);
    expect(signed.uploadUrl.startsWith("http")).toBe(true);
    expect(signed.uploadUrl).toContain("/uploads/");
    const logs = JSON.stringify(capturing.entries());
    expect(logs).not.toContain(signed.uploadUrl);
    expect(logs).not.toContain(
      catalogObjectKey(kitIdentities.companies.a, fileId),
    );
    expect(logs).not.toMatch(/\/catalog\//);
    expect(logs).not.toMatch(/\/uploads\//);
  });

  it("refuses getUploadUrl when the PUT would outlive the pending row", async () => {
    const fileId = randomUUID();
    const remainingMs =
      SIGNED_URL_TTL_SEC * 1000 - SIGNED_PUT_SKEW_MARGIN_MS - 1_000;
    const createdAt = new Date(
      Date.now() - (ABANDONED_PENDING_TTL_MS - remainingMs),
    );
    await insertFileRow({
      id: fileId,
      companyId: kitIdentities.companies.a,
      uploadedByUserId: kitIdentities.users.anna,
      status: "pending",
      createdAt,
    });
    await putStoreObject(stagingObjectKey(kitIdentities.companies.a, fileId));

    const capturing = createCapturingLogger();
    await expect(
      requireKit().invoke(
        getUploadUrl,
        { fileId },
        {},
        { deps: { ...requireKit().pipeline, logger: capturing.logger } },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      requireKit().invoke(
        getUploadUrl,
        { fileId },
        {
          userId: kitIdentities.users.boris,
          companyId: kitIdentities.companies.b,
        },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);

    const logs = JSON.stringify(capturing.entries());
    expect(logs).not.toMatch(/\/catalog\//);
    expect(logs).not.toMatch(/\/uploads\//);

    await requireKit().invoke(sweepAbandonedUploads, {});
    const stillPending = await requireKit()
      .db.runtime.db.select({ id: files.id, status: files.status })
      .from(files)
      .where(eq(files.id, fileId));
    expect(stillPending).toEqual([{ id: fileId, status: "pending" }]);
    expect(
      await getFilesObjectStore().headObject(
        stagingObjectKey(kitIdentities.companies.a, fileId),
      ),
    ).not.toBe("missing");

    await requireKit()
      .db.runtime.db.update(files)
      .set({
        createdAt: new Date(Date.now() - ABANDONED_PENDING_TTL_MS - 1_000),
      })
      .where(eq(files.id, fileId));

    const swept = await requireKit().invoke(sweepAbandonedUploads, {});
    expect(swept.abandonedPendingDeleted).toBeGreaterThanOrEqual(1);
    const gone = await requireKit()
      .db.runtime.db.select({ id: files.id })
      .from(files)
      .where(eq(files.id, fileId));
    expect(gone).toHaveLength(0);
    const stagingKey = stagingObjectKey(kitIdentities.companies.a, fileId);
    const store = getFilesObjectStore();
    await waitForObjectVisibility(store, stagingKey, "missing");
    expect(await store.headObject(stagingKey)).toBe("missing");
  });

  it("writes audit rows for the writes without URLs or object keys", async () => {
    const requested = await requireKit().invoke(requestUpload, jpegInput);
    const signed = await mintPut(requested.fileId);
    await putSigned(
      signed.uploadUrl,
      jpegBytes,
      "image/jpeg",
      stagingObjectKey(kitIdentities.companies.a, requested.fileId),
    );
    await requireKit().invoke(finalizeUpload, { fileId: requested.fileId });

    const createAudit = await requireKit()
      .db.runtime.db.select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "files.requestUpload"),
          eq(auditLog.targetId, requested.fileId),
        ),
      );
    expect(createAudit.length).toBeGreaterThanOrEqual(1);
    expect(createAudit[0]?.inputSnapshot).toBeNull();
    expect(createAudit[0]?.targetType).toBe("file");

    const finalizeAudit = await requireKit()
      .db.runtime.db.select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "files.finalizeUpload"),
          eq(auditLog.targetId, requested.fileId),
        ),
      );
    expect(finalizeAudit.length).toBeGreaterThanOrEqual(1);
    expect(finalizeAudit[0]?.inputSnapshot).toBeNull();

    const uploadAudit = await requireKit()
      .db.runtime.db.select()
      .from(auditLog)
      .where(eq(auditLog.action, "files.getUploadUrl"));
    expect(uploadAudit).toHaveLength(0);

    const blob = JSON.stringify([createAudit[0], finalizeAudit[0]]);
    expect(blob).not.toContain(signed.uploadUrl);
    expect(blob).not.toContain("/catalog/");
    expect(blob).not.toContain("/uploads/");
    expect(blob).not.toContain("objectKey");
    expect(blob).not.toContain("object_key");
  });
});

describe("files.getDownloadUrls", () => {
  it("returns signed GETs for a batch of ready files in first-seen unique order", async () => {
    const capturing = createCapturingLogger();
    const second = await requestPutFinalize(pngBytes, "image/png");
    const result = await requireKit().invoke(
      getDownloadUrls,
      {
        fileIds: [
          second.fileId,
          downloadOwnInput.fileId,
          second.fileId,
          downloadOwnInput.fileId,
        ],
      },
      {},
      { deps: { ...requireKit().pipeline, logger: capturing.logger } },
    );

    expect(result.files.map((file) => file.fileId)).toEqual([
      second.fileId,
      downloadOwnInput.fileId,
    ]);
    expect(result.files).toHaveLength(2);

    const fetchedPng = await fetch(result.files[0]?.downloadUrl ?? "");
    expect(fetchedPng.ok).toBe(true);
    expect(sha256Hex(new Uint8Array(await fetchedPng.arrayBuffer()))).toBe(
      pngChecksum,
    );
    expect(fetchedPng.headers.get("content-type")).toMatch(/^image\/png/i);
    expect(fetchedPng.headers.get("content-disposition")).toContain("inline");

    const fetchedJpeg = await fetch(result.files[1]?.downloadUrl ?? "");
    expect(fetchedJpeg.ok).toBe(true);
    expect(sha256Hex(new Uint8Array(await fetchedJpeg.arrayBuffer()))).toBe(
      jpegChecksum,
    );
    expect(fetchedJpeg.headers.get("content-type")).toMatch(/^image\/jpeg/i);
    expect(fetchedJpeg.headers.get("content-disposition")).toContain("inline");

    const logs = JSON.stringify(capturing.entries());
    for (const file of result.files) {
      expect(file.downloadUrl.startsWith("http")).toBe(true);
      expect(logs).not.toContain(file.downloadUrl);
    }
    expect(logs).not.toMatch(/\/catalog\//);
    expect(logs).not.toMatch(/\/uploads\//);
    expect(logs).not.toMatch(/X-Amz-Signature/);
  });

  it("denies staff without files:view", async () => {
    await expect(
      requireKit().invoke(
        getDownloadUrls,
        { fileIds: [downloadOwnInput.fileId] },
        { companyId: kitIdentities.companies.a, userId: clerks.noView },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("rejects an empty batch, oversized batch, and malformed ids", async () => {
    await expect(
      requireKit().invoke(getDownloadUrls, { fileIds: [] }),
    ).rejects.toBeInstanceOf(ValidationError);

    const oversized = Array.from({ length: ATTACHMENT_FACTS_MAX_IDS + 1 }, () =>
      randomUUID(),
    );
    await expect(
      requireKit().invoke(getDownloadUrls, { fileIds: oversized }),
    ).rejects.toBeInstanceOf(ValidationError);

    await expect(
      requireKit().invoke(getDownloadUrls, { fileIds: ["not-a-uuid"] }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("fails the whole batch for a missing, pending, or foreign file with the same not-found", async () => {
    const missingId = randomUUID();
    const pending = await requireKit().invoke(requestUpload, jpegInput);

    const missingError = await requireKit()
      .invoke(getDownloadUrls, { fileIds: [missingId] })
      .then(
        () => {
          throw new Error("expected NotFoundError for a missing file");
        },
        (error: unknown) => error,
      );
    const pendingError = await requireKit()
      .invoke(getDownloadUrls, { fileIds: [pending.fileId] })
      .then(
        () => {
          throw new Error("expected NotFoundError for a pending file");
        },
        (error: unknown) => error,
      );
    const foreignError = await requireKit()
      .invoke(getDownloadUrls, { fileIds: [downloadForeignInput.fileId] })
      .then(
        () => {
          throw new Error("expected NotFoundError for a foreign file");
        },
        (error: unknown) => error,
      );

    expect(missingError).toBeInstanceOf(NotFoundError);
    expect(pendingError).toBeInstanceOf(NotFoundError);
    expect(foreignError).toBeInstanceOf(NotFoundError);
    if (
      missingError instanceof NotFoundError &&
      pendingError instanceof NotFoundError &&
      foreignError instanceof NotFoundError
    ) {
      expect(missingError.clientMessage).toBe(pendingError.clientMessage);
      expect(pendingError.clientMessage).toBe(foreignError.clientMessage);
    }

    await expect(
      requireKit().invoke(getDownloadUrls, {
        fileIds: [downloadOwnInput.fileId, missingId],
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      requireKit().invoke(getDownloadUrls, {
        fileIds: [downloadOwnInput.fileId, pending.fileId],
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      requireKit().invoke(getDownloadUrls, {
        fileIds: [downloadOwnInput.fileId, downloadForeignInput.fileId],
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    const stillOwn = await requireKit().invoke(getDownloadUrls, {
      fileIds: [downloadOwnInput.fileId],
    });
    expect(stillOwn.files).toHaveLength(1);
    expect(stillOwn.files[0]?.fileId).toBe(downloadOwnInput.fileId);
  });
});

describe("files catalog renditions", () => {
  async function solidJpeg(input: {
    readonly width: number;
    readonly height: number;
    readonly orientation?: number;
  }): Promise<Uint8Array> {
    let pipeline = sharp({
      create: {
        width: input.width,
        height: input.height,
        channels: 3,
        background: { r: 40, g: 120, b: 200 },
      },
    }).jpeg({ quality: 80 });
    if (input.orientation !== undefined) {
      pipeline = pipeline.withMetadata({ orientation: input.orientation });
    }
    return new Uint8Array(await pipeline.toBuffer());
  }

  it("downloads each named rendition as inline WebP and omits rendition as the original", async () => {
    const capturing = createCapturingLogger();
    const fileId = (await requestPutFinalize(jpegBytes, "image/jpeg")).fileId;
    await expectCatalogRenditions(kitIdentities.companies.a, fileId, "present");

    const original = await requireKit().invoke(
      getDownloadUrl,
      { fileId },
      {},
      { deps: { ...requireKit().pipeline, logger: capturing.logger } },
    );
    const fetchedOriginal = await fetch(original.downloadUrl);
    expect(fetchedOriginal.ok).toBe(true);
    expect(sha256Hex(new Uint8Array(await fetchedOriginal.arrayBuffer()))).toBe(
      jpegChecksum,
    );
    expect(fetchedOriginal.headers.get("content-type")).toMatch(
      /^image\/jpeg/i,
    );

    for (const rendition of CATALOG_RENDITIONS) {
      const signed = await requireKit().invoke(
        getDownloadUrl,
        { fileId, rendition },
        {},
        { deps: { ...requireKit().pipeline, logger: capturing.logger } },
      );
      const fetched = await fetch(signed.downloadUrl);
      expect(fetched.ok).toBe(true);
      expect(fetched.headers.get("content-type")).toMatch(/^image\/webp/i);
      expect(fetched.headers.get("content-disposition")).toContain("inline");
      const body = new Uint8Array(await fetched.arrayBuffer());
      const meta = await sharp(body).metadata();
      expect(meta.format).toBe("webp");
      expect(meta.exif).toBeUndefined();
      expect(signed.downloadUrl).not.toBe(original.downloadUrl);
    }

    const logs = JSON.stringify(capturing.entries());
    expect(logs).not.toContain(original.downloadUrl);
    expect(logs).not.toMatch(/X-Amz-Signature/);
    expect(logs).not.toMatch(/\/catalog\//);
  });

  it("fails the batch when any rendition object is missing and does not fall back", async () => {
    const first = await requestPutFinalize(jpegBytes, "image/jpeg");
    const second = await requestPutFinalize(pngBytes, "image/png");
    const store = getFilesObjectStore();
    const missingKey = catalogRenditionObjectKey(
      kitIdentities.companies.a,
      second.fileId,
      "thumb",
    );
    await store.deleteObject(missingKey);
    await waitForObjectVisibility(store, missingKey, "missing");

    await expect(
      requireKit().invoke(getDownloadUrl, {
        fileId: second.fileId,
        rendition: "thumb",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    const omitted = await requireKit().invoke(getDownloadUrl, {
      fileId: second.fileId,
    });
    const fetchedOriginal = await fetch(omitted.downloadUrl);
    expect(fetchedOriginal.ok).toBe(true);
    expect(sha256Hex(new Uint8Array(await fetchedOriginal.arrayBuffer()))).toBe(
      pngChecksum,
    );

    await expect(
      requireKit().invoke(getDownloadUrls, {
        fileIds: [first.fileId, second.fileId],
        rendition: "thumb",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    const thumbs = await requireKit().invoke(getDownloadUrls, {
      fileIds: [first.fileId],
      rendition: "thumb",
    });
    expect(thumbs.files).toHaveLength(1);
    const fetchedThumb = await fetch(thumbs.files[0]?.downloadUrl ?? "");
    expect(fetchedThumb.ok).toBe(true);
    expect(fetchedThumb.headers.get("content-type")).toMatch(/^image\/webp/i);
  });

  it("treats pending, missing, and foreign rendition downloads as not-found", async () => {
    const pending = await requireKit().invoke(requestUpload, jpegInput);
    await expect(
      requireKit().invoke(getDownloadUrl, {
        fileId: pending.fileId,
        rendition: "hero",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      requireKit().invoke(getDownloadUrl, {
        fileId: randomUUID(),
        rendition: "full",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      requireKit().invoke(getDownloadUrl, {
        fileId: downloadForeignInput.fileId,
        rendition: "card",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      requireKit().invoke(getDownloadUrls, {
        fileIds: [downloadOwnInput.fileId, downloadForeignInput.fileId],
        rendition: "thumb",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("fills missing rendition keys on a second finalize without rewriting the original", async () => {
    const ready = await requestPutFinalize(jpegBytes, "image/jpeg");
    const store = getFilesObjectStore();
    const catalogKey = catalogObjectKey(
      kitIdentities.companies.a,
      ready.fileId,
    );
    const thumbKey = catalogRenditionObjectKey(
      kitIdentities.companies.a,
      ready.fileId,
      "thumb",
    );
    await store.deleteObject(thumbKey);
    await waitForObjectVisibility(store, thumbKey, "missing");

    const again = await requireKit().invoke(finalizeUpload, {
      fileId: ready.fileId,
    });
    expect(again.checksumSha256).toBe(jpegChecksum);
    expect(again.byteSize).toBe(jpegBytes.byteLength);

    const catalog = await store.getObject(catalogKey);
    expect(catalog).not.toBe("missing");
    if (catalog === "missing") {
      throw new Error("expected original catalog object after second finalize");
    }
    expect(sha256Hex(catalog.bytes)).toBe(jpegChecksum);
    await expectCatalogRenditions(
      kitIdentities.companies.a,
      ready.fileId,
      "present",
    );
  });

  it("keeps an oversized-pixel catalog upload pending", async () => {
    const over = 8001;
    const bomb = pngWithIhdrDimensions(over, over);
    const fileId = await requestAndPut(bomb, "image/png");
    await expect(
      requireKit().invoke(finalizeUpload, { fileId }),
    ).rejects.toBeInstanceOf(ValidationError);

    const rows = await requireKit()
      .db.runtime.db.select()
      .from(files)
      .where(eq(files.id, fileId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("pending");
    expect(
      await getFilesObjectStore().headObject(
        catalogObjectKey(kitIdentities.companies.a, fileId),
      ),
    ).toBe("missing");
    await expectCatalogRenditions(kitIdentities.companies.a, fileId, "missing");
  });

  it("bakes EXIF orientation into metadata-free WebP renditions", async () => {
    const source = await solidJpeg({
      width: 100,
      height: 40,
      orientation: 6,
    });
    const fileId = (await requestPutFinalize(source, "image/jpeg")).fileId;
    const signed = await requireKit().invoke(getDownloadUrl, {
      fileId,
      rendition: "full",
    });
    const fetched = await fetch(signed.downloadUrl);
    expect(fetched.ok).toBe(true);
    const body = new Uint8Array(await fetched.arrayBuffer());
    const meta = await sharp(body).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(40);
    expect(meta.height).toBe(100);
    expect(meta.exif).toBeUndefined();
    expect(meta.icc).toBeUndefined();
    expect(meta.iptc).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
  });

  it("does not upscale a 720px original and still writes all four renditions", async () => {
    const source = await solidJpeg({ width: 720, height: 400 });
    const fileId = (await requestPutFinalize(source, "image/jpeg")).fileId;
    await expectCatalogRenditions(kitIdentities.companies.a, fileId, "present");

    const longEdge = async (rendition: (typeof CATALOG_RENDITIONS)[number]) => {
      const signed = await requireKit().invoke(getDownloadUrl, {
        fileId,
        rendition,
      });
      const fetched = await fetch(signed.downloadUrl);
      const body = new Uint8Array(await fetched.arrayBuffer());
      const meta = await sharp(body).metadata();
      return Math.max(meta.width, meta.height);
    };

    expect(await longEdge("thumb")).toBe(256);
    expect(await longEdge("card")).toBe(640);
    expect(await longEdge("hero")).toBe(720);
    expect(await longEdge("full")).toBe(720);
  });
});

describe("files.sweepAbandonedUploads", () => {
  async function ageReadyRows(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      await requireKit()
        .db.runtime.db.update(files)
        .set({ updatedAt: sweepEpoch })
        .where(eq(files.id, id));
    }
  }

  async function drainAbandonedPending(): Promise<void> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const result = await requireKit().invoke(sweepAbandonedUploads, {});
      if (result.abandonedPendingDeleted === 0) {
        return;
      }
    }
    throw new Error("abandoned pending drain did not empty the batch");
  }

  async function countUnpurgedReady(): Promise<number> {
    const rows = await requireKit()
      .db.runtime.db.select({ value: count() })
      .from(files)
      .where(and(eq(files.status, "ready"), isNull(files.stagingPurgedAt)));
    return rows[0]?.value ?? 0;
  }

  async function drainUnpurgedReady(): Promise<void> {
    await drainAbandonedPending();
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if ((await countUnpurgedReady()) === 0) {
        return;
      }
      await requireKit().invoke(sweepAbandonedUploads, {});
    }
    throw new Error("ready leftover drain did not empty the batch");
  }

  async function fileCursor(id: string): Promise<{
    readonly stagingPurgedAt: Date | null;
    readonly updatedAt: Date;
  }> {
    const rows = await requireKit()
      .db.runtime.db.select({
        stagingPurgedAt: files.stagingPurgedAt,
        updatedAt: files.updatedAt,
      })
      .from(files)
      .where(eq(files.id, id));
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`expected file row ${id}`);
    }
    return row;
  }

  it("leaves in-flight pending objects and the row in place", async () => {
    const fileId = await requestAndPut(jpegBytes, "image/jpeg");
    await putStoreObject(catalogObjectKey(kitIdentities.companies.a, fileId));

    await requireKit().invoke(sweepAbandonedUploads, {});

    const store = getFilesObjectStore();
    expect(
      await store.headObject(
        stagingObjectKey(kitIdentities.companies.a, fileId),
      ),
    ).not.toBe("missing");
    expect(
      await store.headObject(
        catalogObjectKey(kitIdentities.companies.a, fileId),
      ),
    ).not.toBe("missing");
    const rows = await requireKit()
      .db.runtime.db.select({ status: files.status })
      .from(files)
      .where(eq(files.id, fileId));
    expect(rows[0]?.status).toBe("pending");
  });

  it("discovers leftover staging on ready files in both companies without touching catalog bytes", async () => {
    await drainUnpurgedReady();
    const requestedA = await requireKit().invoke(requestUpload, jpegInput);
    const signedA = await mintPut(requestedA.fileId);
    await putSigned(
      signedA.uploadUrl,
      jpegBytes,
      "image/jpeg",
      stagingObjectKey(kitIdentities.companies.a, requestedA.fileId),
    );
    const readyA = await requireKit().invoke(finalizeUpload, {
      fileId: requestedA.fileId,
    });
    const leftoverA = Uint8Array.from(jpegBytes);
    leftoverA[leftoverA.byteLength - 3] =
      (leftoverA.at(leftoverA.byteLength - 3) ?? 0) ^ 0xff;
    await putSigned(
      signedA.uploadUrl,
      leftoverA,
      "image/jpeg",
      stagingObjectKey(kitIdentities.companies.a, requestedA.fileId),
    );

    const readyB = await requestPutFinalize(pngBytes, "image/png", {
      userId: kitIdentities.users.boris,
      companyId: kitIdentities.companies.b,
    });
    await putStoreObject(
      stagingObjectKey(kitIdentities.companies.b, readyB.fileId),
      pngBytes,
      "image/png",
    );
    await ageReadyRows([readyA.fileId, readyB.fileId]);

    const capturing = createCapturingLogger();
    const result = await requireKit().invoke(
      sweepAbandonedUploads,
      {},
      {},
      { deps: { ...requireKit().pipeline, logger: capturing.logger } },
    );
    expect(result.leftoverStagingDeleted).toBe(2);

    const store = getFilesObjectStore();
    const leftoverAKey = stagingObjectKey(
      kitIdentities.companies.a,
      readyA.fileId,
    );
    const leftoverBKey = stagingObjectKey(
      kitIdentities.companies.b,
      readyB.fileId,
    );
    await waitForObjectVisibility(store, leftoverAKey, "missing");
    await waitForObjectVisibility(store, leftoverBKey, "missing");
    expect(await store.headObject(leftoverAKey)).toBe("missing");
    expect(await store.headObject(leftoverBKey)).toBe("missing");
    const catalogA = await store.getObject(
      catalogObjectKey(kitIdentities.companies.a, readyA.fileId),
    );
    const catalogB = await store.getObject(
      catalogObjectKey(kitIdentities.companies.b, readyB.fileId),
    );
    expect(catalogA).not.toBe("missing");
    expect(catalogB).not.toBe("missing");
    if (catalogA === "missing" || catalogB === "missing") {
      throw new Error("expected catalog objects after staging sweep");
    }
    expect(sha256Hex(catalogA.bytes)).toBe(jpegChecksum);
    expect(sha256Hex(catalogB.bytes)).toBe(pngChecksum);
    await expectCatalogRenditions(
      kitIdentities.companies.a,
      readyA.fileId,
      "present",
    );
    await expectCatalogRenditions(
      kitIdentities.companies.b,
      readyB.fileId,
      "present",
    );
    expect((await fileCursor(readyA.fileId)).stagingPurgedAt).not.toBeNull();
    expect((await fileCursor(readyB.fileId)).stagingPurgedAt).not.toBeNull();

    const download = await requireKit().invoke(getDownloadUrl, {
      fileId: readyA.fileId,
    });
    const fetched = await fetch(download.downloadUrl);
    expect(fetched.ok).toBe(true);
    expect(sha256Hex(new Uint8Array(await fetched.arrayBuffer()))).toBe(
      jpegChecksum,
    );

    const logs = JSON.stringify(capturing.entries());
    expect(logs).not.toContain(signedA.uploadUrl);
    expect(logs).not.toMatch(/\/catalog\//);
    expect(logs).not.toMatch(/\/uploads\//);
  });

  it("discovers abandoned pending in both companies and deletes staging, catalog, and the row", async () => {
    await drainAbandonedPending();
    const fileId = randomUUID();
    const foreignId = randomUUID();
    const abandonedAt = new Date(Date.now() - ABANDONED_PENDING_TTL_MS - 1_000);
    await insertFileRow({
      id: fileId,
      companyId: kitIdentities.companies.a,
      uploadedByUserId: kitIdentities.users.anna,
      status: "pending",
      createdAt: abandonedAt,
    });
    await insertFileRow({
      id: foreignId,
      companyId: kitIdentities.companies.b,
      uploadedByUserId: kitIdentities.users.boris,
      status: "pending",
      createdAt: abandonedAt,
    });
    await putStoreObject(stagingObjectKey(kitIdentities.companies.a, fileId));
    await putStoreObject(catalogObjectKey(kitIdentities.companies.a, fileId));
    await putStoreObject(
      stagingObjectKey(kitIdentities.companies.b, foreignId),
    );
    await putStoreObject(
      catalogObjectKey(kitIdentities.companies.b, foreignId),
    );

    const capturing = createCapturingLogger();
    const requestId = randomUUID();
    const result = await requireKit().invoke(
      sweepAbandonedUploads,
      {},
      {},
      {
        deps: { ...requireKit().pipeline, logger: capturing.logger },
        request: { requestId },
      },
    );
    expect(result.abandonedPendingDeleted).toBeGreaterThanOrEqual(2);

    const store = getFilesObjectStore();
    const companyAStaging = stagingObjectKey(kitIdentities.companies.a, fileId);
    const companyACatalog = catalogObjectKey(kitIdentities.companies.a, fileId);
    const companyBStaging = stagingObjectKey(
      kitIdentities.companies.b,
      foreignId,
    );
    const companyBCatalog = catalogObjectKey(
      kitIdentities.companies.b,
      foreignId,
    );
    await waitForObjectVisibility(store, companyAStaging, "missing");
    await waitForObjectVisibility(store, companyACatalog, "missing");
    await waitForObjectVisibility(store, companyBStaging, "missing");
    await waitForObjectVisibility(store, companyBCatalog, "missing");
    expect(await store.headObject(companyAStaging)).toBe("missing");
    expect(await store.headObject(companyACatalog)).toBe("missing");
    expect(await store.headObject(companyBStaging)).toBe("missing");
    expect(await store.headObject(companyBCatalog)).toBe("missing");

    const remaining = await requireKit()
      .db.runtime.db.select({ id: files.id })
      .from(files)
      .where(eq(files.id, fileId));
    expect(remaining).toHaveLength(0);
    const foreign = await requireKit()
      .db.runtime.db.select({ id: files.id })
      .from(files)
      .where(eq(files.id, foreignId));
    expect(foreign).toHaveLength(0);

    const audit = await requireKit()
      .db.runtime.db.select()
      .from(auditLog)
      .where(eq(auditLog.requestId, requestId));
    expect(audit).toHaveLength(1);
    expect(audit[0]?.companyId).toBeNull();
    expect(audit[0]?.targetType).toBe("files_sweep");
    expect(audit[0]?.targetId).toBe(requestId);
    const blob = JSON.stringify([result, capturing.entries(), audit[0]]);
    expect(blob).not.toMatch(/\/catalog\//);
    expect(blob).not.toMatch(/\/uploads\//);
    expect(blob).not.toContain("objectKey");
  });

  it("deletes leftover catalog renditions with an abandoned pending row", async () => {
    await drainAbandonedPending();
    const fileId = randomUUID();
    const abandonedAt = new Date(Date.now() - ABANDONED_PENDING_TTL_MS - 1_000);
    await insertFileRow({
      id: fileId,
      companyId: kitIdentities.companies.a,
      uploadedByUserId: kitIdentities.users.anna,
      status: "pending",
      createdAt: abandonedAt,
    });
    await putStoreObject(stagingObjectKey(kitIdentities.companies.a, fileId));
    await putStoreObject(catalogObjectKey(kitIdentities.companies.a, fileId));
    await putCatalogRenditionObjects(kitIdentities.companies.a, fileId);

    const result = await requireKit().invoke(sweepAbandonedUploads, {});
    expect(result.abandonedPendingDeleted).toBeGreaterThanOrEqual(1);

    const store = getFilesObjectStore();
    const originalKey = catalogObjectKey(kitIdentities.companies.a, fileId);
    await waitForObjectVisibility(store, originalKey, "missing");
    expect(await store.headObject(originalKey)).toBe("missing");
    await expectCatalogRenditions(kitIdentities.companies.a, fileId, "missing");

    const remaining = await requireKit()
      .db.runtime.db.select({ id: files.id })
      .from(files)
      .where(eq(files.id, fileId));
    expect(remaining).toHaveLength(0);
  });

  it("keeps a ready catalog intact when the same tick deletes another tenant's abandoned objects", async () => {
    await drainAbandonedPending();
    const readyId = randomUUID();
    const abandonedId = randomUUID();
    const abandonedAt = new Date(Date.now() - ABANDONED_PENDING_TTL_MS - 1_000);
    await insertFileRow({
      id: readyId,
      companyId: kitIdentities.companies.b,
      uploadedByUserId: kitIdentities.users.boris,
      status: "ready",
      mimeType: "image/png",
      bytes: pngBytes,
      updatedAt: sweepEpoch,
    });
    await putStoreObject(
      catalogObjectKey(kitIdentities.companies.b, readyId),
      pngBytes,
      "image/png",
    );
    await insertFileRow({
      id: abandonedId,
      companyId: kitIdentities.companies.a,
      uploadedByUserId: kitIdentities.users.anna,
      status: "pending",
      createdAt: abandonedAt,
    });
    await putStoreObject(
      stagingObjectKey(kitIdentities.companies.a, abandonedId),
    );
    await putStoreObject(
      catalogObjectKey(kitIdentities.companies.a, abandonedId),
    );

    await requireKit().invoke(sweepAbandonedUploads, {});

    await waitForObjectVisibility(
      getFilesObjectStore(),
      stagingObjectKey(kitIdentities.companies.a, abandonedId),
      "missing",
    );
    await waitForObjectVisibility(
      getFilesObjectStore(),
      catalogObjectKey(kitIdentities.companies.a, abandonedId),
      "missing",
    );
    const catalog = await getFilesObjectStore().getObject(
      catalogObjectKey(kitIdentities.companies.b, readyId),
    );
    expect(catalog).not.toBe("missing");
    if (catalog === "missing") {
      throw new Error("expected company B catalog to survive company A GC");
    }
    expect(sha256Hex(catalog.bytes)).toBe(pngChecksum);
    const abandoned = await requireKit()
      .db.runtime.db.select({ id: files.id })
      .from(files)
      .where(eq(files.id, abandonedId));
    expect(abandoned).toHaveLength(0);
  });

  it("bounds the batch and a later tick finishes the remainder", async () => {
    await drainAbandonedPending();
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    const wanted = new Set<string>(ids);
    const abandonedAt = new Date(Date.now() - ABANDONED_PENDING_TTL_MS - 1_000);
    for (const id of ids) {
      await insertFileRow({
        id,
        companyId: kitIdentities.companies.a,
        uploadedByUserId: kitIdentities.users.anna,
        status: "pending",
        createdAt: abandonedAt,
      });
    }

    const first = await requireKit().invoke(sweepAbandonedUploads, {
      limit: 1,
    });
    expect(first).toEqual({
      leftoverStagingDeleted: 0,
      abandonedPendingDeleted: 1,
    });
    const afterFirst = await requireKit()
      .db.runtime.db.select({ id: files.id })
      .from(files)
      .where(eq(files.status, "pending"));
    const remainingIds = afterFirst
      .map((row) => row.id)
      .filter((id) => wanted.has(id));
    expect(remainingIds).toHaveLength(2);

    const second = await requireKit().invoke(sweepAbandonedUploads, {
      limit: 2,
    });
    expect(second.abandonedPendingDeleted).toBeGreaterThanOrEqual(2);
    const afterSecond = await requireKit()
      .db.runtime.db.select({ id: files.id })
      .from(files)
      .where(eq(files.status, "pending"));
    expect(
      afterSecond.map((row) => row.id).filter((id) => wanted.has(id)),
    ).toHaveLength(0);
  });

  it("marks a ready leftover so a later tick skips the row", async () => {
    await drainUnpurgedReady();
    const cleanedId = randomUUID();
    const leftoverId = randomUUID();
    await insertFileRow({
      id: cleanedId,
      companyId: kitIdentities.companies.a,
      uploadedByUserId: kitIdentities.users.anna,
      status: "ready",
      updatedAt: sweepEpoch,
    });
    await putStoreObject(
      catalogObjectKey(kitIdentities.companies.a, cleanedId),
    );

    const capturing = createCapturingLogger();
    const first = await requireKit().invoke(
      sweepAbandonedUploads,
      { limit: 1 },
      {},
      { deps: { ...requireKit().pipeline, logger: capturing.logger } },
    );
    expect(first.leftoverStagingDeleted).toBe(1);
    const afterFirst = await fileCursor(cleanedId);
    expect(afterFirst.stagingPurgedAt).not.toBeNull();
    expect(
      await getFilesObjectStore().headObject(
        catalogObjectKey(kitIdentities.companies.a, cleanedId),
      ),
    ).not.toBe("missing");
    const logs = JSON.stringify(capturing.entries());
    expect(logs).not.toMatch(/\/catalog\//);
    expect(logs).not.toMatch(/\/uploads\//);

    await insertFileRow({
      id: leftoverId,
      companyId: kitIdentities.companies.a,
      uploadedByUserId: kitIdentities.users.anna,
      status: "ready",
      updatedAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    await putStoreObject(
      catalogObjectKey(kitIdentities.companies.a, leftoverId),
    );
    await putStoreObject(
      stagingObjectKey(kitIdentities.companies.a, leftoverId),
    );

    const second = await requireKit().invoke(sweepAbandonedUploads, {
      limit: 1,
    });
    expect(second.leftoverStagingDeleted).toBe(1);
    const afterSecond = await fileCursor(cleanedId);
    expect(afterSecond.stagingPurgedAt?.getTime()).toBe(
      afterFirst.stagingPurgedAt?.getTime(),
    );
    expect(afterSecond.updatedAt.getTime()).toBe(
      afterFirst.updatedAt.getTime(),
    );
    const leftoverStaging = stagingObjectKey(
      kitIdentities.companies.a,
      leftoverId,
    );
    await waitForObjectVisibility(
      getFilesObjectStore(),
      leftoverStaging,
      "missing",
    );
    expect(await getFilesObjectStore().headObject(leftoverStaging)).toBe(
      "missing",
    );
    expect(
      await getFilesObjectStore().headObject(
        catalogObjectKey(kitIdentities.companies.a, leftoverId),
      ),
    ).not.toBe("missing");
    expect((await fileCursor(leftoverId)).stagingPurgedAt).not.toBeNull();
  });

  it("deletes leftover staging without a prior HeadObject", async () => {
    await drainUnpurgedReady();
    const leftoverId = randomUUID();
    await insertFileRow({
      id: leftoverId,
      companyId: kitIdentities.companies.a,
      uploadedByUserId: kitIdentities.users.anna,
      status: "ready",
      updatedAt: sweepEpoch,
    });
    await putStoreObject(
      catalogObjectKey(kitIdentities.companies.a, leftoverId),
    );
    await putStoreObject(
      stagingObjectKey(kitIdentities.companies.a, leftoverId),
    );

    const stagingKey = stagingObjectKey(kitIdentities.companies.a, leftoverId);
    const restore = mapConfiguredFilesObjectStore((inner) => ({
      ...inner,
      headObject(key) {
        if (key === stagingKey) {
          throw new Error(
            "sweep must DeleteObject leftover staging without HeadObject",
          );
        }
        return inner.headObject(key);
      },
    }));
    try {
      const result = await requireKit().invoke(sweepAbandonedUploads, {
        limit: 1,
      });
      expect(result.leftoverStagingDeleted).toBe(1);
      expect((await fileCursor(leftoverId)).stagingPurgedAt).not.toBeNull();
    } finally {
      restore();
    }

    await waitForObjectVisibility(getFilesObjectStore(), stagingKey, "missing");
    expect(await getFilesObjectStore().headObject(stagingKey)).toBe("missing");
    expect(
      await getFilesObjectStore().headObject(
        catalogObjectKey(kitIdentities.companies.a, leftoverId),
      ),
    ).not.toBe("missing");
  });

  it("replays the same idempotency key after deleting an abandoned row", async () => {
    await drainAbandonedPending();
    const id = randomUUID();
    await insertFileRow({
      id,
      companyId: kitIdentities.companies.a,
      uploadedByUserId: kitIdentities.users.anna,
      status: "pending",
      createdAt: new Date(Date.now() - ABANDONED_PENDING_TTL_MS - 1_000),
    });
    await putStoreObject(stagingObjectKey(kitIdentities.companies.a, id));

    const key = randomUUID();
    const first = await requireKit().invoke(
      sweepAbandonedUploads,
      { limit: 1 },
      {},
      { request: { idempotencyKey: key } },
    );
    expect(first).toEqual({
      leftoverStagingDeleted: 0,
      abandonedPendingDeleted: 1,
    });
    await waitForObjectVisibility(
      getFilesObjectStore(),
      stagingObjectKey(kitIdentities.companies.a, id),
      "missing",
    );
    const replay = await requireKit().invoke(
      sweepAbandonedUploads,
      { limit: 1 },
      {},
      { request: { idempotencyKey: key } },
    );
    expect(replay).toEqual(first);
    const gone = await requireKit()
      .db.runtime.db.select({ id: files.id })
      .from(files)
      .where(eq(files.id, id));
    expect(gone).toHaveLength(0);

    await requireKit().invoke(sweepAbandonedUploads, { limit: 1 });
    const stillGone = await requireKit()
      .db.runtime.db.select({ id: files.id })
      .from(files)
      .where(eq(files.id, id));
    expect(stillGone).toHaveLength(0);
  });

  it("rejects an out-of-range batch limit", async () => {
    await expect(
      requireKit().invoke(sweepAbandonedUploads, { limit: 0 }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      requireKit().invoke(sweepAbandonedUploads, { limit: 21 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  describe("files.sweepAbandonedUploads periodic job", () => {
    let dueId = "";
    let youngId = "";

    beforeEach(async () => {
      await drainAbandonedPending();
      dueId = randomUUID();
      youngId = randomUUID();
      await insertFileRow({
        id: dueId,
        companyId: kitIdentities.companies.a,
        uploadedByUserId: kitIdentities.users.anna,
        status: "pending",
        createdAt: new Date(Date.now() - ABANDONED_PENDING_TTL_MS - 1_000),
      });
      await insertFileRow({
        id: youngId,
        companyId: kitIdentities.companies.a,
        uploadedByUserId: kitIdentities.users.anna,
        status: "pending",
      });
      await putStoreObject(stagingObjectKey(kitIdentities.companies.a, dueId));
      await putStoreObject(
        stagingObjectKey(kitIdentities.companies.a, youngId),
      );
    });

    async function expectOnlyDueRowSwept(): Promise<void> {
      const remaining = await requireKit()
        .db.runtime.db.select({ id: files.id })
        .from(files)
        .where(inArray(files.id, [dueId, youngId]));
      expect(remaining).toEqual([{ id: youngId }]);
      const store = getFilesObjectStore();
      await waitForObjectVisibility(
        store,
        stagingObjectKey(kitIdentities.companies.a, dueId),
        "missing",
      );
      expect(
        await store.headObject(
          stagingObjectKey(kitIdentities.companies.a, youngId),
        ),
      ).not.toBe("missing");
    }

    jobIsolationSuite(requireKit, [
      jobIsolationCase(
        sweepAbandonedUploadsJob,
        sweepAbandonedUploads,
        { payload: {} },
        undefined,
        expectOnlyDueRowSwept,
      ),
    ]);

    it("two overlapping runs delete the due row once and keep the young row", async () => {
      const run = () =>
        executeJobAction(requireKit().pipeline, {
          job: sweepAbandonedUploadsJob,
          envelope: buildJobEnvelope(sweepAbandonedUploadsJob, {
            companyId: null,
            payload: {},
          }),
          action: sweepAbandonedUploads,
          input: {},
        });

      const [first, second] = await Promise.all([run(), run()]);

      expect(
        first.abandonedPendingDeleted + second.abandonedPendingDeleted,
      ).toBe(1);
      await expectOnlyDueRowSwept();
    });
  });
});

describe("files.backfillCatalogRenditions", () => {
  beforeEach(() => {
    setCatalogRenditionBackfillNowMsForTest(0);
  });
  afterEach(() => {
    setCatalogRenditionBackfillNowMsForTest(undefined);
  });

  async function catalogRow(id: string): Promise<{
    readonly status: string;
    readonly byteSize: bigint;
    readonly checksumSha256: string | null;
    readonly objectKey: string;
  }> {
    const rows = await requireKit()
      .db.runtime.db.select({
        status: files.status,
        byteSize: files.byteSize,
        checksumSha256: files.checksumSha256,
        objectKey: files.objectKey,
      })
      .from(files)
      .where(eq(files.id, id));
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`expected file row ${id}`);
    }
    return row;
  }

  // Each call is 1s older than the last so a newly seeded row sorts into
  // the OFFSET-0 inspect page ahead of leftover ready catalog files.
  let inspectFrontSeq = 0;
  function createdAtAtInspectFront(): Date {
    inspectFrontSeq += 1;
    return new Date(Date.UTC(1900, 0, 1) - inspectFrontSeq * 1000);
  }

  async function drainInspectPage(): Promise<void> {
    await requireKit().invoke(backfillCatalogRenditions, {});
  }

  async function runBackfillAt(nowMs: number) {
    const ctx = await requireKit().buildTestContext("system", {
      systemScope: { scope: "global" },
      request: {
        action: "files.backfillCatalogRenditions",
        channel: "system",
      },
    });
    if (ctx.principal !== "system" || ctx.scope !== "global") {
      throw new Error("expected global system context");
    }
    return runCatalogRenditionBackfill({ ctx, input: {}, nowMs });
  }

  async function seedCompleteFrontPageThenLaterOriginal(): Promise<string> {
    const laterCreatedAt = createdAtAtInspectFront();
    const completeCreatedAt = Array.from(
      { length: BACKFILL_BATCH_LIMIT + 1 },
      () => createdAtAtInspectFront(),
    );
    await Promise.all(
      completeCreatedAt.map(async (createdAt) => {
        const fileId = randomUUID();
        await insertFileRow({
          id: fileId,
          companyId: kitIdentities.companies.a,
          uploadedByUserId: kitIdentities.users.anna,
          status: "ready",
          createdAt,
        });
        await putCatalogRenditionObjects(kitIdentities.companies.a, fileId);
      }),
    );
    return seedReadyCatalogOriginal({
      companyId: kitIdentities.companies.a,
      uploadedByUserId: kitIdentities.users.anna,
      createdAt: laterCreatedAt,
    });
  }

  async function seedReadyCatalogOriginal(input: {
    readonly companyId: string;
    readonly uploadedByUserId: string;
    readonly bytes?: Uint8Array;
    readonly mimeType?: FileMimeType;
    readonly createdAt?: Date;
  }): Promise<string> {
    const id = randomUUID();
    const bytes = input.bytes ?? jpegBytes;
    const mimeType = input.mimeType ?? "image/jpeg";
    await insertFileRow({
      id,
      companyId: input.companyId,
      uploadedByUserId: input.uploadedByUserId,
      status: "ready",
      mimeType,
      bytes,
      checksumSha256: sha256Hex(bytes),
      createdAt: input.createdAt ?? createdAtAtInspectFront(),
    });
    await putStoreObject(
      catalogObjectKey(input.companyId, id),
      bytes,
      mimeType,
    );
    return id;
  }

  async function renditionBytes(
    companyId: string,
    fileId: string,
    rendition: (typeof CATALOG_RENDITIONS)[number],
  ): Promise<Uint8Array> {
    const object = await getFilesObjectStore().getObject(
      catalogRenditionObjectKey(companyId, fileId, rendition),
    );
    if (object === "missing") {
      throw new Error(`expected ${rendition} rendition for ${fileId}`);
    }
    return object.bytes;
  }

  it("fills four renditions for a ready catalog file and leaves the original unchanged", async () => {
    await drainInspectPage();
    const fileId = await seedReadyCatalogOriginal({
      companyId: kitIdentities.companies.a,
      uploadedByUserId: kitIdentities.users.anna,
    });
    const before = await catalogRow(fileId);
    const capturing = createCapturingLogger();
    const result = await requireKit().invoke(
      backfillCatalogRenditions,
      {},
      {},
      { deps: { ...requireKit().pipeline, logger: capturing.logger } },
    );
    expect(result.filled).toBe(1);
    expect(result.skippedMissingOriginal).toBe(0);
    expect(result.skippedUndecodable).toBe(0);
    expect(Object.keys(result).toSorted()).toEqual([
      "alreadyComplete",
      "filled",
      "skippedMissingOriginal",
      "skippedUndecodable",
    ]);

    await expectCatalogRenditions(kitIdentities.companies.a, fileId, "present");
    const original = await getFilesObjectStore().getObject(
      catalogObjectKey(kitIdentities.companies.a, fileId),
    );
    expect(original).not.toBe("missing");
    if (original === "missing") {
      throw new Error("expected original after backfill");
    }
    expect(sha256Hex(original.bytes)).toBe(jpegChecksum);
    expect(await catalogRow(fileId)).toEqual(before);

    const logs = JSON.stringify(capturing.entries());
    expect(logs).not.toMatch(/\/catalog\//);
    expect(logs).not.toMatch(/\/uploads\//);
    expect(logs).not.toContain("http");
    expect(logs).not.toContain(fileId);
    expect(logs).not.toContain(before.objectKey);
  });

  it("is a no-op when all four keys already exist and does not rewrite bytes", async () => {
    await drainInspectPage();
    const fileId = await seedReadyCatalogOriginal({
      companyId: kitIdentities.companies.a,
      uploadedByUserId: kitIdentities.users.anna,
    });
    await putCatalogRenditionObjects(kitIdentities.companies.a, fileId);
    const originalBefore = await getFilesObjectStore().getObject(
      catalogObjectKey(kitIdentities.companies.a, fileId),
    );
    if (originalBefore === "missing") {
      throw new Error("expected original before no-op backfill");
    }
    const renditionHashes = {
      thumb: sha256Hex(
        await renditionBytes(kitIdentities.companies.a, fileId, "thumb"),
      ),
      card: sha256Hex(
        await renditionBytes(kitIdentities.companies.a, fileId, "card"),
      ),
      hero: sha256Hex(
        await renditionBytes(kitIdentities.companies.a, fileId, "hero"),
      ),
      full: sha256Hex(
        await renditionBytes(kitIdentities.companies.a, fileId, "full"),
      ),
    };
    const rowBefore = await catalogRow(fileId);

    const result = await requireKit().invoke(backfillCatalogRenditions, {});
    expect(result.filled).toBe(0);

    const originalAfter = await getFilesObjectStore().getObject(
      catalogObjectKey(kitIdentities.companies.a, fileId),
    );
    if (originalAfter === "missing") {
      throw new Error("expected original after no-op backfill");
    }
    expect(sha256Hex(originalAfter.bytes)).toBe(
      sha256Hex(originalBefore.bytes),
    );
    expect(
      sha256Hex(
        await renditionBytes(kitIdentities.companies.a, fileId, "thumb"),
      ),
    ).toBe(renditionHashes.thumb);
    expect(
      sha256Hex(
        await renditionBytes(kitIdentities.companies.a, fileId, "card"),
      ),
    ).toBe(renditionHashes.card);
    expect(
      sha256Hex(
        await renditionBytes(kitIdentities.companies.a, fileId, "hero"),
      ),
    ).toBe(renditionHashes.hero);
    expect(
      sha256Hex(
        await renditionBytes(kitIdentities.companies.a, fileId, "full"),
      ),
    ).toBe(renditionHashes.full);
    expect(await catalogRow(fileId)).toEqual(rowBefore);
  });

  it("fills missing renditions on a partial set without rewriting thumb or original", async () => {
    await drainInspectPage();
    const fileId = await seedReadyCatalogOriginal({
      companyId: kitIdentities.companies.a,
      uploadedByUserId: kitIdentities.users.anna,
    });
    const thumbKey = catalogRenditionObjectKey(
      kitIdentities.companies.a,
      fileId,
      "thumb",
    );
    const marker = sameSizeMutatedJpeg();
    await putStoreObject(thumbKey, marker, "image/jpeg");
    const originalBefore = await catalogRow(fileId);

    const result = await requireKit().invoke(backfillCatalogRenditions, {});
    expect(result.filled).toBe(1);

    const thumb = await getFilesObjectStore().getObject(thumbKey);
    if (thumb === "missing") {
      throw new Error("expected preserved thumb");
    }
    expect(sha256Hex(thumb.bytes)).toBe(sha256Hex(marker));
    await expectCatalogRenditions(kitIdentities.companies.a, fileId, "present");
    const original = await getFilesObjectStore().getObject(
      catalogObjectKey(kitIdentities.companies.a, fileId),
    );
    if (original === "missing") {
      throw new Error("expected original after partial backfill");
    }
    expect(sha256Hex(original.bytes)).toBe(jpegChecksum);
    expect(await catalogRow(fileId)).toEqual(originalBefore);
  });

  it("skips document-purpose files and does not write catalog or document renditions", async () => {
    const fileId = randomUUID();
    await requireKit()
      .db.runtime.db.insert(files)
      .values({
        id: fileId,
        companyId: kitIdentities.companies.a,
        uploadedByUserId: kitIdentities.users.anna,
        purpose: "document",
        objectKey: documentObjectKey(kitIdentities.companies.a, fileId),
        mimeType: "application/pdf",
        byteSize: BigInt(pdfBytes.byteLength),
        checksumSha256: pdfChecksum,
        status: "ready",
        stagingPurgedAt: new Date(0),
      });
    await putGeneratedPdf(kitIdentities.companies.a, fileId);

    await requireKit().invoke(backfillCatalogRenditions, {});

    await expectCatalogRenditions(kitIdentities.companies.a, fileId, "missing");
    const store = getFilesObjectStore();
    for (const rendition of CATALOG_RENDITIONS) {
      expect(
        await store.headObject(
          `${kitIdentities.companies.a}/documents/${fileId}/${rendition}`,
        ),
      ).toBe("missing");
    }
    expect(
      await store.headObject(
        documentObjectKey(kitIdentities.companies.a, fileId),
      ),
    ).not.toBe("missing");
  });

  it("writes rendition keys under each row company prefix, never into the other tenant", async () => {
    await drainInspectPage();
    const fileA = await seedReadyCatalogOriginal({
      companyId: kitIdentities.companies.a,
      uploadedByUserId: kitIdentities.users.anna,
    });
    const fileB = await seedReadyCatalogOriginal({
      companyId: kitIdentities.companies.b,
      uploadedByUserId: kitIdentities.users.boris,
    });

    const result = await requireKit().invoke(backfillCatalogRenditions, {});
    expect(result.filled).toBe(2);

    await expectCatalogRenditions(kitIdentities.companies.a, fileA, "present");
    await expectCatalogRenditions(kitIdentities.companies.b, fileB, "present");
    const store = getFilesObjectStore();
    for (const rendition of CATALOG_RENDITIONS) {
      expect(
        await store.headObject(
          catalogRenditionObjectKey(
            kitIdentities.companies.b,
            fileA,
            rendition,
          ),
        ),
      ).toBe("missing");
      expect(
        await store.headObject(
          catalogRenditionObjectKey(
            kitIdentities.companies.a,
            fileB,
            rendition,
          ),
        ),
      ).toBe("missing");
    }
    const originalA = await store.getObject(
      catalogObjectKey(kitIdentities.companies.a, fileA),
    );
    if (originalA === "missing") {
      throw new Error("expected company A original");
    }
    expect(sha256Hex(originalA.bytes)).toBe(jpegChecksum);
  });

  it("replays the same idempotency key without rewriting objects", async () => {
    await drainInspectPage();
    const fileId = await seedReadyCatalogOriginal({
      companyId: kitIdentities.companies.a,
      uploadedByUserId: kitIdentities.users.anna,
    });
    const key = randomUUID();
    const first = await requireKit().invoke(
      backfillCatalogRenditions,
      {},
      {},
      { request: { idempotencyKey: key } },
    );
    expect(first.filled).toBe(1);
    const thumbHash = sha256Hex(
      await renditionBytes(kitIdentities.companies.a, fileId, "thumb"),
    );
    const replay = await requireKit().invoke(
      backfillCatalogRenditions,
      {},
      {},
      { request: { idempotencyKey: key } },
    );
    expect(replay).toEqual(first);
    expect(
      sha256Hex(
        await renditionBytes(kitIdentities.companies.a, fileId, "thumb"),
      ),
    ).toBe(thumbHash);
    const original = await getFilesObjectStore().getObject(
      catalogObjectKey(kitIdentities.companies.a, fileId),
    );
    expect(original).not.toBe("missing");
    if (original === "missing") {
      throw new Error("expected original after idempotent replay");
    }
    expect(sha256Hex(original.bytes)).toBe(jpegChecksum);
  });

  it("rejects an out-of-range batch limit", async () => {
    await expect(
      requireKit().invoke(backfillCatalogRenditions, { limit: 0 }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      requireKit().invoke(backfillCatalogRenditions, {
        limit: BACKFILL_BATCH_LIMIT + 1,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("fills one file per fill budget and continues on the next tick", async () => {
    await drainInspectPage();
    const newerCreatedAt = createdAtAtInspectFront();
    const olderCreatedAt = createdAtAtInspectFront();
    const older = await seedReadyCatalogOriginal({
      companyId: kitIdentities.companies.a,
      uploadedByUserId: kitIdentities.users.anna,
      createdAt: olderCreatedAt,
    });
    const newer = await seedReadyCatalogOriginal({
      companyId: kitIdentities.companies.a,
      uploadedByUserId: kitIdentities.users.anna,
      createdAt: newerCreatedAt,
    });

    const first = await requireKit().invoke(backfillCatalogRenditions, {
      limit: 1,
    });
    expect(first.filled).toBe(1);
    await expectCatalogRenditions(kitIdentities.companies.a, older, "present");
    await expectCatalogRenditions(kitIdentities.companies.a, newer, "missing");

    const second = await requireKit().invoke(backfillCatalogRenditions, {
      limit: 1,
    });
    expect(second.filled).toBe(1);
    await expectCatalogRenditions(kitIdentities.companies.a, newer, "present");
  });

  it("does not inspect past the first SQL page in one tick", async () => {
    await drainInspectPage();
    const laterId = await seedCompleteFrontPageThenLaterOriginal();

    const result = await requireKit().invoke(backfillCatalogRenditions, {});
    expect(result.filled).toBe(0);
    expect(result.alreadyComplete).toBe(BACKFILL_BATCH_LIMIT);
    await expectCatalogRenditions(
      kitIdentities.companies.a,
      laterId,
      "missing",
    );
  });

  it("fills the later file on the next inspect slot without rewriting the original", async () => {
    await drainInspectPage();
    const laterId = await seedCompleteFrontPageThenLaterOriginal();

    const result = await runBackfillAt(BACKFILL_CATALOG_RENDITIONS_INTERVAL_MS);
    expect(result.filled).toBeGreaterThanOrEqual(1);
    await expectCatalogRenditions(
      kitIdentities.companies.a,
      laterId,
      "present",
    );
    const original = await getFilesObjectStore().getObject(
      catalogObjectKey(kitIdentities.companies.a, laterId),
    );
    if (original === "missing") {
      throw new Error("expected original after second-slot backfill");
    }
    expect(sha256Hex(original.bytes)).toBe(jpegChecksum);
    const row = await catalogRow(laterId);
    expect(row.status).toBe("ready");
    expect(row.checksumSha256).toBe(jpegChecksum);
  });

  it("skips an undecodable original and still fills the rest of the page", async () => {
    await drainInspectPage();
    const over = 8001;
    const bomb = pngWithIhdrDimensions(over, over);
    const badId = await seedReadyCatalogOriginal({
      companyId: kitIdentities.companies.a,
      uploadedByUserId: kitIdentities.users.anna,
      bytes: bomb,
      mimeType: "image/png",
    });
    const goodId = await seedReadyCatalogOriginal({
      companyId: kitIdentities.companies.a,
      uploadedByUserId: kitIdentities.users.anna,
    });
    const capturing = createCapturingLogger();
    const result = await requireKit().invoke(
      backfillCatalogRenditions,
      {},
      {},
      { deps: { ...requireKit().pipeline, logger: capturing.logger } },
    );
    expect(result.filled).toBe(1);
    expect(result.skippedUndecodable).toBe(1);
    await expectCatalogRenditions(kitIdentities.companies.a, goodId, "present");
    await expectCatalogRenditions(kitIdentities.companies.a, badId, "missing");
    expect(await catalogRow(badId)).toMatchObject({
      status: "ready",
      checksumSha256: sha256Hex(bomb),
    });
    const logs = JSON.stringify(capturing.entries());
    expect(logs).toContain("undecodable");
    expect(logs).toContain("files.backfillCatalogRenditions skipped file");
    expect(logs).not.toContain(badId);
    expect(logs).not.toMatch(/\/catalog\//);
  });

  it("skips a missing original without writing a half-complete rendition set", async () => {
    await drainInspectPage();
    const fileId = randomUUID();
    await insertFileRow({
      id: fileId,
      companyId: kitIdentities.companies.a,
      uploadedByUserId: kitIdentities.users.anna,
      status: "ready",
      createdAt: createdAtAtInspectFront(),
    });
    const goodId = await seedReadyCatalogOriginal({
      companyId: kitIdentities.companies.a,
      uploadedByUserId: kitIdentities.users.anna,
    });
    const capturing = createCapturingLogger();
    const result = await requireKit().invoke(
      backfillCatalogRenditions,
      {},
      {},
      { deps: { ...requireKit().pipeline, logger: capturing.logger } },
    );
    expect(result.filled).toBe(1);
    expect(result.skippedMissingOriginal).toBe(1);
    await expectCatalogRenditions(kitIdentities.companies.a, fileId, "missing");
    await expectCatalogRenditions(kitIdentities.companies.a, goodId, "present");
    expect(await catalogRow(fileId)).toMatchObject({ status: "ready" });
    const logs = JSON.stringify(capturing.entries());
    expect(logs).toContain("missing_original");
    expect(logs).not.toContain(fileId);
    expect(logs).not.toMatch(/\/catalog\//);
  });

  it("denies a non-system principal and a tenant-scoped system enqueue", async () => {
    const request = {
      requestId: randomUUID(),
      correlationId: randomUUID(),
      channel: "ui" as const,
    };
    await expect(
      executeAction(requireKit().pipeline, {
        action: backfillCatalogRenditions,
        input: {},
        request,
        principal: {
          mode: "staff",
          session: { userId: kitIdentities.users.anna },
          companySelector: kitIdentities.companies.a,
        },
      }),
    ).rejects.toBeInstanceOf(CoreInvariantError);
    await expect(
      executeAction(requireKit().pipeline, {
        action: backfillCatalogRenditions,
        input: {},
        request: {
          requestId: randomUUID(),
          correlationId: randomUUID(),
          channel: "system",
        },
        principal: {
          mode: "system",
          serviceName: "test.backfill",
          scope: {
            scope: "tenant",
            companyId: kitIdentities.companies.a,
          },
        },
      }),
    ).rejects.toBeInstanceOf(CoreInvariantError);
  });

  describe("files.backfillCatalogRenditions periodic job", () => {
    let readyId = "";
    let pendingId = "";

    beforeEach(async () => {
      await drainInspectPage();
      readyId = await seedReadyCatalogOriginal({
        companyId: kitIdentities.companies.a,
        uploadedByUserId: kitIdentities.users.anna,
      });
      pendingId = randomUUID();
      await insertFileRow({
        id: pendingId,
        companyId: kitIdentities.companies.a,
        uploadedByUserId: kitIdentities.users.anna,
        status: "pending",
      });
      await putStoreObject(
        catalogObjectKey(kitIdentities.companies.a, pendingId),
      );
    });

    async function expectOnlyReadyFileFilled(): Promise<void> {
      await expectCatalogRenditions(
        kitIdentities.companies.a,
        readyId,
        "present",
      );
      await expectCatalogRenditions(
        kitIdentities.companies.a,
        pendingId,
        "missing",
      );
      expect((await catalogRow(readyId)).status).toBe("ready");
      expect((await catalogRow(pendingId)).status).toBe("pending");
    }

    jobIsolationSuite(requireKit, [
      jobIsolationCase(
        backfillCatalogRenditionsJob,
        backfillCatalogRenditions,
        { payload: {} },
        undefined,
        expectOnlyReadyFileFilled,
      ),
    ]);

    it("two overlapping runs both finish, fill the ready file and lose no row", async () => {
      const run = () =>
        executeJobAction(requireKit().pipeline, {
          job: backfillCatalogRenditionsJob,
          envelope: buildJobEnvelope(backfillCatalogRenditionsJob, {
            companyId: null,
            payload: {},
          }),
          action: backfillCatalogRenditions,
          input: {},
        });

      const outcomes = await Promise.all([run(), run()]);

      expect(outcomes).toHaveLength(2);
      expect(outcomes.some(({ filled }) => filled >= 1)).toBe(true);
      await expectOnlyReadyFileFilled();
    });
  });
});

describe("files.recordGeneratedObject", () => {
  const actorCompany = { companyId: kitIdentities.companies.a };

  it("records a worker-PUT PDF as a ready document with a null uploader", async () => {
    const capturing = createCapturingLogger();
    const fileId = randomUUID();
    await putGeneratedPdf(kitIdentities.companies.a, fileId);
    const sneaky: unknown = {
      ...generatedRecordInput(fileId),
      companyId: kitIdentities.companies.b,
      objectKey: "client-supplied/documents/evil",
    };
    const ready = await requireKit().invoke(
      recordGeneratedObject,
      sneaky,
      {},
      { deps: { ...requireKit().pipeline, logger: capturing.logger } },
    );
    expect(ready).toEqual({
      fileId,
      status: "ready",
      purpose: "document",
      mimeType: "application/pdf",
      byteSize: pdfBytes.byteLength,
      checksumSha256: pdfChecksum,
    });

    const rows = await requireKit()
      .db.runtime.db.select()
      .from(files)
      .where(eq(files.id, fileId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.uploadedByUserId).toBeNull();
    expect(rows[0]?.purpose).toBe("document");
    expect(rows[0]?.objectKey).toBe(
      documentObjectKey(kitIdentities.companies.a, fileId),
    );
    expect(rows[0]?.stagingPurgedAt).not.toBeNull();

    const replay = await requireKit().invoke(
      recordGeneratedObject,
      generatedRecordInput(fileId),
      {},
      { deps: { ...requireKit().pipeline, logger: capturing.logger } },
    );
    expect(replay).toEqual(ready);
    expect(
      await requireKit()
        .db.runtime.db.select({ id: files.id })
        .from(files)
        .where(eq(files.id, fileId)),
    ).toHaveLength(1);

    const blob = JSON.stringify([ready, capturing.entries()]);
    expect(blob).not.toContain("downloadUrl");
    expect(blob).not.toContain("objectKey");
    expect(blob).not.toMatch(/\/documents\//);
    expect(blob).not.toContain("http");

    await expectCatalogRenditions(kitIdentities.companies.a, fileId, "missing");
    const store = getFilesObjectStore();
    for (const rendition of CATALOG_RENDITIONS) {
      expect(
        await store.headObject(
          `${kitIdentities.companies.a}/documents/${fileId}/${rendition}`,
        ),
      ).toBe("missing");
    }
  });

  it("rejects an oversize generated object without buffering it", async () => {
    const fileId = randomUUID();
    const objectKey = documentObjectKey(kitIdentities.companies.a, fileId);
    await putGeneratedPdf(kitIdentities.companies.a, fileId);

    let getCalls = 0;
    const restore = mapConfiguredFilesObjectStore((inner) => ({
      ...inner,
      async headObject(key) {
        const head = await inner.headObject(key);
        if (key === objectKey && head !== "missing") {
          return { byteSize: MAX_DOCUMENT_BYTES + 1, etag: head.etag };
        }
        return head;
      },
      async getObject(key) {
        if (key === objectKey) {
          getCalls += 1;
        }
        return inner.getObject(key);
      },
    }));
    try {
      await expect(
        requireKit().invoke(
          recordGeneratedObject,
          generatedRecordInput(fileId),
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    } finally {
      restore();
    }

    expect(getCalls).toBe(0);
    expect(
      await requireKit()
        .db.runtime.db.select({ id: files.id })
        .from(files)
        .where(eq(files.id, fileId)),
    ).toHaveLength(0);
  });

  it("rejects catalog purpose, missing objects, and a catalog fileId", async () => {
    await expect(
      requireKit().invoke(recordGeneratedObject, {
        ...generatedRecordInput(randomUUID()),
        purpose: "catalog",
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    await expect(
      requireKit().invoke(
        recordGeneratedObject,
        generatedRecordInput(randomUUID()),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);

    await expect(
      requireKit().invoke(
        recordGeneratedObject,
        generatedRecordInput(downloadOwnInput.fileId),
      ),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("does not let company B's object satisfy company A's record", async () => {
    const fileId = randomUUID();
    await putGeneratedPdf(kitIdentities.companies.b, fileId);
    await expect(
      requireKit().invoke(
        recordGeneratedObject,
        generatedRecordInput(fileId),
        actorCompany,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(
      await requireKit()
        .db.runtime.db.select({ id: files.id })
        .from(files)
        .where(eq(files.id, fileId)),
    ).toHaveLength(0);
  });

  it("writes an audit row without object keys or URLs", async () => {
    const fileId = randomUUID();
    await putGeneratedPdf(kitIdentities.companies.a, fileId);
    await requireKit().invoke(
      recordGeneratedObject,
      generatedRecordInput(fileId),
    );
    const audit = await requireKit()
      .db.runtime.db.select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "files.recordGeneratedObject"),
          eq(auditLog.targetId, fileId),
        ),
      );
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect(audit[0]?.targetType).toBe("file");
    expect(audit[0]?.companyId).toBe(kitIdentities.companies.a);
    const blob = JSON.stringify(audit[0]);
    expect(blob).not.toContain("objectKey");
    expect(blob).not.toContain("object_key");
    expect(blob).not.toMatch(/\/documents\//);
    expect(blob).not.toContain("http");
  });
});

describe("files.issueDocumentDownloadUrl", () => {
  const actorCompany = { companyId: kitIdentities.companies.a };

  it("lets an employee with documents:view fetch the PDF without files:view", async () => {
    const capturing = createCapturingLogger();
    const signed = await requireKit().invoke(
      issueDocumentDownloadUrl,
      { fileId: docDownloadOwnInput.fileId },
      { ...actorCompany, userId: clerks.employee },
      { deps: { ...requireKit().pipeline, logger: capturing.logger } },
    );
    expect(signed.fileId).toBe(docDownloadOwnInput.fileId);
    expect(signed.checksumSha256).toBe(pdfChecksum);
    expect(signed.downloadUrl.startsWith("http")).toBe(true);
    expect(signed.expiresAt).toEqual(expect.any(String));

    const fetched = await fetch(signed.downloadUrl);
    expect(fetched.ok).toBe(true);
    const body = new Uint8Array(await fetched.arrayBuffer());
    expect(sha256Hex(body)).toBe(pdfChecksum);
    expect(fetched.headers.get("content-type")).toMatch(/^application\/pdf/i);
    expect(fetched.headers.get("content-disposition")).toContain("inline");
    expect(fetched.headers.get("content-disposition")).toContain(
      "document.pdf",
    );

    const rows = await requireKit()
      .db.runtime.db.select({
        id: files.id,
        objectKey: files.objectKey,
        purpose: files.purpose,
      })
      .from(files)
      .where(eq(files.id, docDownloadOwnInput.fileId));
    expect(JSON.stringify(rows[0])).not.toContain("http");
    expect(JSON.stringify(rows[0])).not.toContain(signed.downloadUrl);

    const logs = JSON.stringify(capturing.entries());
    expect(logs).not.toContain(signed.downloadUrl);
    expect(logs).not.toMatch(/\/documents\//);
    expect(logs).not.toMatch(/X-Amz-Signature/);
  });

  it("denies staff without documents:view", async () => {
    await expect(
      requireKit().invoke(
        issueDocumentDownloadUrl,
        { fileId: docDownloadOwnInput.fileId },
        { ...actorCompany, userId: clerks.noDocumentsView },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("treats pending, foreign, catalog, and missing files as the same not-found", async () => {
    const pendingId = randomUUID();
    await requireKit()
      .db.runtime.db.insert(files)
      .values({
        id: pendingId,
        companyId: kitIdentities.companies.a,
        uploadedByUserId: null,
        purpose: "document",
        objectKey: documentObjectKey(kitIdentities.companies.a, pendingId),
        mimeType: "application/pdf",
        byteSize: BigInt(pdfBytes.byteLength),
        checksumSha256: pdfChecksum,
        status: "pending",
      });

    const missing = randomUUID();
    const pendingError = await requireKit()
      .invoke(issueDocumentDownloadUrl, { fileId: pendingId })
      .then(
        () => {
          throw new Error("expected NotFoundError for a pending document");
        },
        (error: unknown) => error,
      );
    const foreignError = await requireKit()
      .invoke(issueDocumentDownloadUrl, {
        fileId: docDownloadForeignInput.fileId,
      })
      .then(
        () => {
          throw new Error("expected NotFoundError for a foreign document");
        },
        (error: unknown) => error,
      );
    const catalogError = await requireKit()
      .invoke(issueDocumentDownloadUrl, { fileId: downloadOwnInput.fileId })
      .then(
        () => {
          throw new Error("expected NotFoundError for a catalog file");
        },
        (error: unknown) => error,
      );
    const missingError = await requireKit()
      .invoke(issueDocumentDownloadUrl, { fileId: missing })
      .then(
        () => {
          throw new Error("expected NotFoundError for a missing file");
        },
        (error: unknown) => error,
      );

    expect(pendingError).toBeInstanceOf(NotFoundError);
    expect(foreignError).toBeInstanceOf(NotFoundError);
    expect(catalogError).toBeInstanceOf(NotFoundError);
    expect(missingError).toBeInstanceOf(NotFoundError);
    if (
      pendingError instanceof NotFoundError &&
      foreignError instanceof NotFoundError &&
      catalogError instanceof NotFoundError &&
      missingError instanceof NotFoundError
    ) {
      expect(pendingError.clientMessage).toBe(foreignError.clientMessage);
      expect(foreignError.clientMessage).toBe(catalogError.clientMessage);
      expect(catalogError.clientMessage).toBe(missingError.clientMessage);
    }

    await expect(
      requireKit().invoke(getDownloadUrl, {
        fileId: docDownloadOwnInput.fileId,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("files.issueShareDownloadUrl", () => {
  const actorCompany = { companyId: kitIdentities.companies.a };

  it("returns the same PDF bytes as the panel issuer", async () => {
    const capturing = createCapturingLogger();
    const signed = await requireKit().invoke(
      issueShareDownloadUrl,
      { fileId: docDownloadOwnInput.fileId },
      {},
      { deps: { ...requireKit().pipeline, logger: capturing.logger } },
    );
    expect(signed.fileId).toBe(docDownloadOwnInput.fileId);
    expect(signed).not.toHaveProperty("checksumSha256");
    const fetched = await fetch(signed.downloadUrl);
    expect(fetched.ok).toBe(true);
    expect(sha256Hex(new Uint8Array(await fetched.arrayBuffer()))).toBe(
      pdfChecksum,
    );
    expect(fetched.headers.get("content-disposition")).toContain(
      "document.pdf",
    );

    const rows = await requireKit()
      .db.runtime.db.select({
        id: files.id,
        objectKey: files.objectKey,
        purpose: files.purpose,
      })
      .from(files)
      .where(eq(files.id, docDownloadOwnInput.fileId));
    expect(JSON.stringify(rows[0])).not.toContain(signed.downloadUrl);

    const logs = JSON.stringify(capturing.entries());
    expect(logs).not.toContain(signed.downloadUrl);
    expect(logs).not.toMatch(/\/documents\//);
    expect(logs).not.toMatch(/X-Amz-Signature/);
  });

  it("denies staff without files:view, including an employee with documents:view", async () => {
    await expect(
      requireKit().invoke(
        issueShareDownloadUrl,
        { fileId: docDownloadOwnInput.fileId },
        { ...actorCompany, userId: clerks.noView },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      requireKit().invoke(
        issueShareDownloadUrl,
        { fileId: docDownloadOwnInput.fileId },
        { ...actorCompany, userId: clerks.employee },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("treats pending, foreign, catalog, and missing files as the same not-found", async () => {
    const pending = await requireKit().invoke(requestUpload, jpegInput);
    const missing = randomUUID();
    await expect(
      requireKit().invoke(issueShareDownloadUrl, { fileId: pending.fileId }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      requireKit().invoke(issueShareDownloadUrl, {
        fileId: docDownloadForeignInput.fileId,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      requireKit().invoke(issueShareDownloadUrl, {
        fileId: downloadOwnInput.fileId,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      requireKit().invoke(issueShareDownloadUrl, { fileId: missing }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("does not sweep a generated document when catalog leftover GC runs", async () => {
    const before = await countDocumentFiles(kitIdentities.companies.a);
    await requireKit().invoke(sweepAbandonedUploads, {});
    expect(await countDocumentFiles(kitIdentities.companies.a)).toBe(before);
    const rows = await requireKit()
      .db.runtime.db.select({
        id: files.id,
        purpose: files.purpose,
        objectKey: files.objectKey,
      })
      .from(files)
      .where(eq(files.id, docDownloadOwnInput.fileId));
    expect(rows).toEqual([
      {
        id: docDownloadOwnInput.fileId,
        purpose: "document",
        objectKey: documentObjectKey(
          kitIdentities.companies.a,
          docDownloadOwnInput.fileId,
        ),
      },
    ]);
  });
});

describe("files.requestSigningUpload / files.getSigningUploadUrl", () => {
  const actorCompany = { companyId: kitIdentities.companies.a };

  it("creates a pending signing row, mints a staging PUT, and never stores the staging key", async () => {
    const capturing = createCapturingLogger();
    const sneaky: unknown = {
      ...signingInput,
      objectKey: "client-supplied/signing/evil",
      companyId: kitIdentities.companies.b,
    };
    const requested = await requireKit().invoke(
      requestSigningUpload,
      sneaky,
      {},
      { deps: { ...requireKit().pipeline, logger: capturing.logger } },
    );
    expect(requested).toEqual({ fileId: requested.fileId });
    expect(requested).not.toHaveProperty("uploadUrl");

    const rows = await requireKit()
      .db.runtime.db.select()
      .from(files)
      .where(eq(files.id, requested.fileId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("pending");
    expect(rows[0]?.purpose).toBe("signing");
    expect(rows[0]?.mimeType).toBe(SIGNING_MIME_TYPE);
    expect(rows[0]?.uploadedByUserId).toBe(kitIdentities.users.anna);
    expect(rows[0]?.objectKey).toBe(
      signingObjectKey(kitIdentities.companies.a, requested.fileId),
    );
    expect(rows[0]?.objectKey).not.toContain("/uploads/");

    const signed = await requireKit().invoke(
      getSigningUploadUrl,
      { fileId: requested.fileId },
      {},
      { deps: { ...requireKit().pipeline, logger: capturing.logger } },
    );
    expect(signed.fileId).toBe(requested.fileId);
    expect(signed.uploadUrl.startsWith("http")).toBe(true);
    expect(signed.uploadUrl).toContain("/uploads/");
    expect(signed.uploadUrl).not.toContain("/signing/");
    expect(signed.uploadUrl).not.toContain("/catalog/");
    expect(signed.expiresAt).toEqual(expect.any(String));

    await putSigned(
      signed.uploadUrl,
      zipBytes,
      SIGNING_MIME_TYPE,
      stagingObjectKey(kitIdentities.companies.a, requested.fileId),
    );

    const store = getFilesObjectStore();
    expect(
      await store.getObject(
        signingObjectKey(kitIdentities.companies.a, requested.fileId),
      ),
    ).toBe("missing");
    const staged = await store.getObject(
      stagingObjectKey(kitIdentities.companies.a, requested.fileId),
    );
    expect(staged).not.toBe("missing");
    if (staged === "missing") {
      throw new Error("expected staging object after signing PUT");
    }
    expect(sha256Hex(staged.bytes)).toBe(zipChecksum);

    const afterPut = await requireKit()
      .db.runtime.db.select()
      .from(files)
      .where(eq(files.id, requested.fileId));
    expect(afterPut[0]?.status).toBe("pending");
    expect(afterPut[0]?.objectKey).toBe(
      signingObjectKey(kitIdentities.companies.a, requested.fileId),
    );
    expect(afterPut[0]?.objectKey).not.toContain("/uploads/");

    await expect(
      requireKit().invoke(finalizeUpload, { fileId: requested.fileId }),
    ).rejects.toBeInstanceOf(NotFoundError);
    const stillPending = await requireKit()
      .db.runtime.db.select({
        id: files.id,
        status: files.status,
        purpose: files.purpose,
      })
      .from(files)
      .where(eq(files.id, requested.fileId));
    expect(stillPending).toEqual([
      {
        id: requested.fileId,
        status: "pending",
        purpose: "signing",
      },
    ]);

    const logs = JSON.stringify(capturing.entries());
    expect(logs).not.toContain(signed.uploadUrl);
    expect(logs).not.toContain(rows[0]?.objectKey ?? "missing-key");
    expect(logs).not.toMatch(/\/signing\//);
    expect(logs).not.toMatch(/\/uploads\//);
  });

  it("requires documents:edit and does not use files:upload", async () => {
    await expect(
      requireKit().invoke(requestSigningUpload, signingInput, {
        ...actorCompany,
        userId: clerks.uploadNoDocumentsEdit,
      }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      requireKit().invoke(requestSigningUpload, signingInput, {
        ...actorCompany,
        userId: clerks.employee,
      }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      requireKit().invoke(
        getSigningUploadUrl,
        { fileId: signingUploadOwnInput.fileId },
        { ...actorCompany, userId: clerks.uploadNoDocumentsEdit },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      requireKit().invoke(
        getSigningUploadUrl,
        { fileId: signingUploadOwnInput.fileId },
        { ...actorCompany, userId: clerks.employee },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);

    const allowed = await requireKit().invoke(
      requestSigningUpload,
      signingInput,
      { ...actorCompany, userId: clerks.documentsEditNoUpload },
    );
    const signed = await requireKit().invoke(
      getSigningUploadUrl,
      { fileId: allowed.fileId },
      { ...actorCompany, userId: clerks.documentsEditNoUpload },
    );
    expect(signed.fileId).toBe(allowed.fileId);
    expect(signed.uploadUrl).toContain("/uploads/");
  });

  it("rejects oversize, catalog purpose, and non-ASiC MIME at the handshake", async () => {
    await expect(
      requireKit().invoke(requestSigningUpload, {
        ...signingInput,
        byteSize: MAX_DOCUMENT_BYTES + 1,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      requireKit().invoke(requestSigningUpload, {
        ...signingInput,
        purpose: "catalog",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      requireKit().invoke(requestSigningUpload, {
        ...signingInput,
        mimeType: "application/pdf",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      requireKit().invoke(requestSigningUpload, {
        ...signingInput,
        mimeType: "image/jpeg",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("treats ready, catalog, document, foreign, and missing fileIds as not-found", async () => {
    const missing = randomUUID();
    await expect(
      requireKit().invoke(getSigningUploadUrl, {
        fileId: signingDownloadOwnInput.fileId,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      requireKit().invoke(getSigningUploadUrl, {
        fileId: uploadOwnInput.fileId,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      requireKit().invoke(getSigningUploadUrl, {
        fileId: docDownloadOwnInput.fileId,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      requireKit().invoke(getSigningUploadUrl, {
        fileId: signingUploadForeignInput.fileId,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      requireKit().invoke(getSigningUploadUrl, { fileId: missing }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("writes an audit row for requestSigningUpload without URLs or keys", async () => {
    const requested = await requireKit().invoke(
      requestSigningUpload,
      signingInput,
    );
    const createAudit = await requireKit()
      .db.runtime.db.select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "files.requestSigningUpload"),
          eq(auditLog.targetId, requested.fileId),
        ),
      );
    expect(createAudit.length).toBeGreaterThanOrEqual(1);
    expect(createAudit[0]?.inputSnapshot).toBeNull();
    expect(createAudit[0]?.targetType).toBe("file");
    expect(createAudit[0]?.companyId).toBe(kitIdentities.companies.a);
    const mintAudit = await requireKit()
      .db.runtime.db.select()
      .from(auditLog)
      .where(eq(auditLog.action, "files.getSigningUploadUrl"));
    expect(mintAudit).toHaveLength(0);
    const blob = JSON.stringify(createAudit[0]);
    expect(blob).not.toContain("objectKey");
    expect(blob).not.toContain("/signing/");
    expect(blob).not.toContain("/uploads/");
    expect(blob).not.toContain("http");
  });

  it("mints a PUT for a pending signing file younger than the remint cutoff without logging the URL", async () => {
    const fileId = randomUUID();
    const createdAt = new Date(Date.now() - 20 * 60 * 1000);
    await insertSigningFileRow({
      id: fileId,
      companyId: kitIdentities.companies.a,
      uploadedByUserId: kitIdentities.users.anna,
      status: "pending",
      createdAt,
    });

    const capturing = createCapturingLogger();
    const signed = await requireKit().invoke(
      getSigningUploadUrl,
      { fileId },
      {},
      { deps: { ...requireKit().pipeline, logger: capturing.logger } },
    );
    expect(signed.fileId).toBe(fileId);
    expect(signed.uploadUrl.startsWith("http")).toBe(true);
    expect(signed.uploadUrl).toContain("/uploads/");
    expect(signed.uploadUrl).not.toContain("/signing/");
    const logs = JSON.stringify(capturing.entries());
    expect(logs).not.toContain(signed.uploadUrl);
    expect(logs).not.toContain(
      signingObjectKey(kitIdentities.companies.a, fileId),
    );
    expect(logs).not.toMatch(/\/signing\//);
    expect(logs).not.toMatch(/\/uploads\//);
  });

  it("refuses getSigningUploadUrl when the PUT would outlive the pending row", async () => {
    const fileId = randomUUID();
    const remainingMs =
      SIGNED_URL_TTL_SEC * 1000 - SIGNED_PUT_SKEW_MARGIN_MS - 1_000;
    const createdAt = new Date(
      Date.now() - (ABANDONED_PENDING_TTL_MS - remainingMs),
    );
    await insertSigningFileRow({
      id: fileId,
      companyId: kitIdentities.companies.a,
      uploadedByUserId: kitIdentities.users.anna,
      status: "pending",
      createdAt,
    });
    await putStoreObject(
      stagingObjectKey(kitIdentities.companies.a, fileId),
      zipBytes,
      SIGNING_MIME_TYPE,
    );

    const capturing = createCapturingLogger();
    await expect(
      requireKit().invoke(
        getSigningUploadUrl,
        { fileId },
        {},
        { deps: { ...requireKit().pipeline, logger: capturing.logger } },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      requireKit().invoke(
        getSigningUploadUrl,
        { fileId },
        {
          userId: kitIdentities.users.boris,
          companyId: kitIdentities.companies.b,
        },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);

    const logs = JSON.stringify(capturing.entries());
    expect(logs).not.toMatch(/\/signing\//);
    expect(logs).not.toMatch(/\/uploads\//);

    await requireKit().invoke(sweepAbandonedUploads, {});
    const stillPending = await requireKit()
      .db.runtime.db.select({
        id: files.id,
        status: files.status,
        purpose: files.purpose,
      })
      .from(files)
      .where(eq(files.id, fileId));
    expect(stillPending).toEqual([
      { id: fileId, status: "pending", purpose: "signing" },
    ]);
    expect(
      await getFilesObjectStore().headObject(
        stagingObjectKey(kitIdentities.companies.a, fileId),
      ),
    ).not.toBe("missing");

    await requireKit()
      .db.runtime.db.update(files)
      .set({
        createdAt: new Date(Date.now() - ABANDONED_PENDING_TTL_MS - 1_000),
      })
      .where(eq(files.id, fileId));

    const swept = await requireKit().invoke(sweepAbandonedUploads, {});
    expect(swept.abandonedPendingDeleted).toBeGreaterThanOrEqual(1);
    const gone = await requireKit()
      .db.runtime.db.select({ id: files.id })
      .from(files)
      .where(eq(files.id, fileId));
    expect(gone).toHaveLength(0);
    const stagingKey = stagingObjectKey(kitIdentities.companies.a, fileId);
    const store = getFilesObjectStore();
    await waitForObjectVisibility(store, stagingKey, "missing");
    expect(await store.headObject(stagingKey)).toBe("missing");
  });
});

describe("files.recordSigningObject", () => {
  const actorCompany = { companyId: kitIdentities.companies.a };

  it("copies staging onto the signing prefix as ready with the signing staff uploader", async () => {
    const capturing = createCapturingLogger();
    const pending = await requestSigningPut({
      ...actorCompany,
      userId: clerks.documentsEditNoUpload,
    });
    const sneaky: unknown = {
      ...signingRecordInput(pending.fileId),
      companyId: kitIdentities.companies.b,
      objectKey: "client-supplied/signing/evil",
    };
    const ready = await requireKit().invoke(
      recordSigningObject,
      sneaky,
      { ...actorCompany, userId: clerks.documentsEditNoUpload },
      { deps: { ...requireKit().pipeline, logger: capturing.logger } },
    );
    expect(ready).toEqual({
      fileId: pending.fileId,
      status: "ready",
      purpose: "signing",
      mimeType: SIGNING_MIME_TYPE,
      byteSize: zipBytes.byteLength,
      checksumSha256: zipChecksum,
    });
    expect(ready).not.toHaveProperty("downloadUrl");
    expect(ready).not.toHaveProperty("objectKey");

    const rows = await requireKit()
      .db.runtime.db.select()
      .from(files)
      .where(eq(files.id, pending.fileId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("ready");
    expect(rows[0]?.purpose).toBe("signing");
    expect(rows[0]?.uploadedByUserId).toBe(clerks.documentsEditNoUpload);
    expect(rows[0]?.uploadedByUserId).not.toBeNull();
    expect(rows[0]?.objectKey).toBe(
      signingObjectKey(kitIdentities.companies.a, pending.fileId),
    );
    expect(rows[0]?.objectKey).not.toContain("/uploads/");
    expect(rows[0]?.stagingPurgedAt).not.toBeNull();

    const durable = await getFilesObjectStore().getObject(
      signingObjectKey(kitIdentities.companies.a, pending.fileId),
    );
    expect(durable).not.toBe("missing");
    if (durable === "missing") {
      throw new Error("expected durable signing object after record");
    }
    expect(sha256Hex(durable.bytes)).toBe(zipChecksum);

    const stagingKey = stagingObjectKey(
      kitIdentities.companies.a,
      pending.fileId,
    );
    await waitForObjectVisibility(getFilesObjectStore(), stagingKey, "missing");
    expect(await getFilesObjectStore().headObject(stagingKey)).toBe("missing");

    const replay = await requireKit().invoke(
      recordSigningObject,
      signingRecordInput(pending.fileId),
      { ...actorCompany, userId: clerks.documentsEditNoUpload },
      { deps: { ...requireKit().pipeline, logger: capturing.logger } },
    );
    expect(replay).toEqual(ready);
    expect(
      await requireKit()
        .db.runtime.db.select({ id: files.id })
        .from(files)
        .where(eq(files.id, pending.fileId)),
    ).toHaveLength(1);

    const blob = JSON.stringify([ready, capturing.entries()]);
    expect(blob).not.toContain("downloadUrl");
    expect(blob).not.toContain("objectKey");
    expect(blob).not.toMatch(/\/signing\//);
    expect(blob).not.toMatch(/\/uploads\//);
    expect(blob).not.toContain("http");
  });

  it("copies staging onto the signing prefix without PutObject of the GET bytes", async () => {
    const pending = await requestSigningPut();
    const companyId = kitIdentities.companies.a;
    const stagingKey = stagingObjectKey(companyId, pending.fileId);
    const durableKey = signingObjectKey(companyId, pending.fileId);
    let copies = 0;
    const restore = mapConfiguredFilesObjectStore((inner) => ({
      ...inner,
      async putObject(input) {
        if (input.key === durableKey) {
          throw new Error(
            "recordSigningObject must CopyObject, not PutObject, onto the signing prefix",
          );
        }
        return inner.putObject(input);
      },
      async copyObject(input) {
        expect(input.sourceKey).toBe(stagingKey);
        expect(input.destinationKey).toBe(durableKey);
        expect(input.sourceEtag.length).toBeGreaterThan(0);
        copies += 1;
        return inner.copyObject(input);
      },
    }));
    try {
      const ready = await requireKit().invoke(
        recordSigningObject,
        signingRecordInput(pending.fileId),
      );
      expect(ready.checksumSha256).toBe(zipChecksum);
      expect(copies).toBe(1);
    } finally {
      restore();
    }

    const durable = await getFilesObjectStore().getObject(durableKey);
    expect(durable).not.toBe("missing");
    if (durable === "missing") {
      throw new Error("expected durable signing object after copy");
    }
    expect(sha256Hex(durable.bytes)).toBe(zipChecksum);
  });

  it("rejects record when staging changes after GetObject (CopyObject If-Match)", async () => {
    const pending = await requestSigningPut();
    const companyId = kitIdentities.companies.a;
    const stagingKey = stagingObjectKey(companyId, pending.fileId);
    const durableKey = signingObjectKey(companyId, pending.fileId);
    const leftoverBytes = sameSizeMutatedZip();
    expect(sha256Hex(leftoverBytes)).not.toBe(zipChecksum);

    const restore = mapConfiguredFilesObjectStore((inner) => ({
      ...inner,
      async getObject(key) {
        const object = await inner.getObject(key);
        if (key === stagingKey && object !== "missing") {
          await inner.putObject({
            key,
            mimeType: SIGNING_MIME_TYPE,
            bytes: leftoverBytes,
          });
          const started = Date.now();
          for (;;) {
            const head = await inner.headObject(key);
            if (head !== "missing" && head.etag !== object.etag) {
              break;
            }
            if (Date.now() - started > 10_000) {
              throw new Error("mutated staging ETag did not become visible");
            }
            await new Promise<void>((resolve) => {
              setTimeout(resolve, 25);
            });
          }
        }
        return object;
      },
    }));
    try {
      await expect(
        requireKit().invoke(
          recordSigningObject,
          signingRecordInput(pending.fileId),
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    } finally {
      restore();
    }

    const rows = await requireKit()
      .db.runtime.db.select({
        status: files.status,
        purpose: files.purpose,
      })
      .from(files)
      .where(eq(files.id, pending.fileId));
    expect(rows).toEqual([{ status: "pending", purpose: "signing" }]);
    expect(await getFilesObjectStore().getObject(durableKey)).toBe("missing");
  });

  it("does not let a leftover signed PUT overwrite a ready signing object", async () => {
    const requested = await requireKit().invoke(
      requestSigningUpload,
      signingInput,
    );
    const signed = await requireKit().invoke(getSigningUploadUrl, {
      fileId: requested.fileId,
    });
    await putSigned(
      signed.uploadUrl,
      zipBytes,
      SIGNING_MIME_TYPE,
      stagingObjectKey(kitIdentities.companies.a, requested.fileId),
    );
    const ready = await requireKit().invoke(
      recordSigningObject,
      signingRecordInput(requested.fileId),
    );
    expect(ready.checksumSha256).toBe(zipChecksum);

    const store = getFilesObjectStore();
    const stagingKey = stagingObjectKey(
      kitIdentities.companies.a,
      requested.fileId,
    );
    const durableKey = signingObjectKey(
      kitIdentities.companies.a,
      requested.fileId,
    );
    await waitForObjectVisibility(store, stagingKey, "missing");
    expect(await store.headObject(stagingKey)).toBe("missing");

    const leftoverBytes = sameSizeMutatedZip();
    expect(leftoverBytes.byteLength).toBe(zipBytes.byteLength);
    const leftoverChecksum = sha256Hex(leftoverBytes);
    expect(leftoverChecksum).not.toBe(zipChecksum);

    await putSigned(
      signed.uploadUrl,
      leftoverBytes,
      SIGNING_MIME_TYPE,
      stagingKey,
    );

    const durable = await store.getObject(durableKey);
    expect(durable).not.toBe("missing");
    if (durable === "missing") {
      throw new Error("expected durable signing object after leftover PUT");
    }
    expect(sha256Hex(durable.bytes)).toBe(zipChecksum);

    const staging = await store.getObject(stagingKey);
    expect(staging).not.toBe("missing");
    if (staging === "missing") {
      throw new Error("expected staging object after leftover PUT");
    }
    expect(sha256Hex(staging.bytes)).toBe(leftoverChecksum);

    const again = await requireKit().invoke(
      recordSigningObject,
      signingRecordInput(requested.fileId),
    );
    expect(again.checksumSha256).toBe(zipChecksum);
    expect(again).toEqual(ready);

    const durableAfterReplay = await store.getObject(durableKey);
    expect(durableAfterReplay).not.toBe("missing");
    if (durableAfterReplay === "missing") {
      throw new Error("expected durable signing object after second record");
    }
    expect(sha256Hex(durableAfterReplay.bytes)).toBe(zipChecksum);

    const rows = await requireKit()
      .db.runtime.db.select()
      .from(files)
      .where(eq(files.id, requested.fileId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("ready");
    expect(rows[0]?.checksumSha256).toBe(zipChecksum);
    expect(rows[0]?.objectKey).toBe(durableKey);
    expect(rows[0]?.objectKey).not.toContain("/uploads/");
  });

  it("rejects a second staff recorder while the row stays pending with the original uploader", async () => {
    const pending = await requestSigningPut({
      ...actorCompany,
      userId: clerks.documentsEditNoUpload,
    });
    await expect(
      requireKit().invoke(
        recordSigningObject,
        signingRecordInput(pending.fileId),
        { ...actorCompany, userId: kitIdentities.users.anna },
      ),
    ).rejects.toBeInstanceOf(ConflictError);

    const rows = await requireKit()
      .db.runtime.db.select({
        status: files.status,
        purpose: files.purpose,
        uploadedByUserId: files.uploadedByUserId,
      })
      .from(files)
      .where(eq(files.id, pending.fileId));
    expect(rows).toEqual([
      {
        status: "pending",
        purpose: "signing",
        uploadedByUserId: clerks.documentsEditNoUpload,
      },
    ]);
    expect(
      await getFilesObjectStore().getObject(
        signingObjectKey(kitIdentities.companies.a, pending.fileId),
      ),
    ).toBe("missing");
  });

  it("denies files:upload-only staff and employees with documents:view", async () => {
    await expect(
      requireKit().invoke(
        recordSigningObject,
        signingRecordInput(signingRecordOwnInput.fileId),
        { ...actorCompany, userId: clerks.uploadNoDocumentsEdit },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      requireKit().invoke(
        recordSigningObject,
        signingRecordInput(signingRecordOwnInput.fileId),
        { ...actorCompany, userId: clerks.employee },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("treats missing staging, catalog, document, and foreign fileIds as not-found", async () => {
    const missingStaging = await requireKit().invoke(
      requestSigningUpload,
      signingInput,
    );
    await expect(
      requireKit().invoke(
        recordSigningObject,
        signingRecordInput(missingStaging.fileId),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);

    await expect(
      requireKit().invoke(
        recordSigningObject,
        signingRecordInput(downloadOwnInput.fileId),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      requireKit().invoke(
        recordSigningObject,
        signingRecordInput(docDownloadOwnInput.fileId),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      requireKit().invoke(
        recordSigningObject,
        signingRecordInput(signingRecordForeignInput.fileId),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      requireKit().invoke(
        recordSigningObject,
        signingRecordInput(randomUUID()),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);

    const catalogPurpose: unknown = {
      ...signingRecordInput(signingRecordOwnInput.fileId),
      purpose: "catalog",
    };
    await expect(
      requireKit().invoke(recordSigningObject, catalogPurpose),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects a non-ZIP staging object without marking the row ready", async () => {
    const requested = await requireKit().invoke(requestSigningUpload, {
      purpose: "signing",
      mimeType: SIGNING_MIME_TYPE,
      byteSize: jpegBytes.byteLength,
      checksumSha256: jpegChecksum,
    });
    const signed = await requireKit().invoke(getSigningUploadUrl, {
      fileId: requested.fileId,
    });
    await putSigned(
      signed.uploadUrl,
      jpegBytes,
      SIGNING_MIME_TYPE,
      stagingObjectKey(kitIdentities.companies.a, requested.fileId),
    );
    await expect(
      requireKit().invoke(recordSigningObject, {
        fileId: requested.fileId,
        purpose: "signing",
        mimeType: SIGNING_MIME_TYPE,
        byteSize: jpegBytes.byteLength,
        checksumSha256: jpegChecksum,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    const rows = await requireKit()
      .db.runtime.db.select({
        status: files.status,
        purpose: files.purpose,
      })
      .from(files)
      .where(eq(files.id, requested.fileId));
    expect(rows).toEqual([{ status: "pending", purpose: "signing" }]);
    expect(
      await getFilesObjectStore().getObject(
        signingObjectKey(kitIdentities.companies.a, requested.fileId),
      ),
    ).toBe("missing");
  });

  it("does not let company B's staging satisfy company A's record", async () => {
    const pending = await requestSigningPut({
      userId: kitIdentities.users.boris,
      companyId: kitIdentities.companies.b,
    });
    await expect(
      requireKit().invoke(
        recordSigningObject,
        signingRecordInput(pending.fileId),
        actorCompany,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    const rows = await requireKit()
      .db.runtime.db.select({
        status: files.status,
        companyId: files.companyId,
      })
      .from(files)
      .where(eq(files.id, pending.fileId));
    expect(rows).toEqual([
      { status: "pending", companyId: kitIdentities.companies.b },
    ]);
  });

  it("writes an audit row without object keys or URLs", async () => {
    const pending = await requestSigningPut();
    await requireKit().invoke(
      recordSigningObject,
      signingRecordInput(pending.fileId),
    );
    const audit = await requireKit()
      .db.runtime.db.select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "files.recordSigningObject"),
          eq(auditLog.targetId, pending.fileId),
        ),
      );
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect(audit[0]?.targetType).toBe("file");
    expect(audit[0]?.companyId).toBe(kitIdentities.companies.a);
    const blob = JSON.stringify(audit[0]);
    expect(blob).not.toContain("objectKey");
    expect(blob).not.toContain("object_key");
    expect(blob).not.toMatch(/\/signing\//);
    expect(blob).not.toContain("http");
  });

  it("records a pending row when staging is gone and the durable object matches", async () => {
    const pending = await requestSigningPut();
    const companyId = kitIdentities.companies.a;
    const store = getFilesObjectStore();
    const stagingKey = stagingObjectKey(companyId, pending.fileId);
    const durableKey = signingObjectKey(companyId, pending.fileId);
    await putStoreObject(durableKey, zipBytes, SIGNING_MIME_TYPE);
    await store.deleteObject(stagingKey);
    await waitForObjectVisibility(store, stagingKey, "missing");

    const ready = await requireKit().invoke(
      recordSigningObject,
      signingRecordInput(pending.fileId),
    );
    expect(ready).toEqual({
      fileId: pending.fileId,
      status: "ready",
      purpose: "signing",
      mimeType: SIGNING_MIME_TYPE,
      byteSize: zipBytes.byteLength,
      checksumSha256: zipChecksum,
    });
    const rows = await requireKit()
      .db.runtime.db.select({
        status: files.status,
        objectKey: files.objectKey,
      })
      .from(files)
      .where(eq(files.id, pending.fileId));
    expect(rows).toEqual([{ status: "ready", objectKey: durableKey }]);
    expect(await store.headObject(stagingKey)).toBe("missing");
    const durable = await store.getObject(durableKey);
    expect(durable).not.toBe("missing");
    if (durable === "missing") {
      throw new Error(
        "expected durable signing object after idempotent promote",
      );
    }
    expect(sha256Hex(durable.bytes)).toBe(zipChecksum);
  });
});

describe("files.readPendingSigningObject", () => {
  const actorCompany = { companyId: kitIdentities.companies.a };

  it("returns staging bytes for a pending purpose=signing PUT", async () => {
    const pending = await requestSigningPut();
    const read = await requireKit().invoke(readPendingSigningObject, {
      fileId: pending.fileId,
    });
    expect(read.fileId).toBe(pending.fileId);
    expect(read.mimeType).toBe(SIGNING_MIME_TYPE);
    expect(read.byteSize).toBe(zipBytes.byteLength);
    expect(read.checksumSha256).toBe(zipChecksum);
    expect(read.bytes).toBeInstanceOf(Uint8Array);
    expect(sha256Hex(read.bytes)).toBe(zipChecksum);
    expect(read).not.toHaveProperty("objectKey");
    expect(read).not.toHaveProperty("uploadUrl");
  });

  it("returns durable bytes when staging is gone and the row is still pending", async () => {
    const pending = await requestSigningPut();
    const companyId = kitIdentities.companies.a;
    const store = getFilesObjectStore();
    const stagingKey = stagingObjectKey(companyId, pending.fileId);
    const durableKey = signingObjectKey(companyId, pending.fileId);
    await putStoreObject(durableKey, zipBytes, SIGNING_MIME_TYPE);
    await store.deleteObject(stagingKey);
    await waitForObjectVisibility(store, stagingKey, "missing");

    const read = await requireKit().invoke(readPendingSigningObject, {
      fileId: pending.fileId,
    });
    expect(read.fileId).toBe(pending.fileId);
    expect(read.checksumSha256).toBe(zipChecksum);
    expect(sha256Hex(read.bytes)).toBe(zipChecksum);
    const rows = await requireKit()
      .db.runtime.db.select({ status: files.status })
      .from(files)
      .where(eq(files.id, pending.fileId));
    expect(rows).toEqual([{ status: "pending" }]);
  });

  it("denies employees with documents:view only and treats ready, catalog, and foreign ids as not-found", async () => {
    await expect(
      requireKit().invoke(
        readPendingSigningObject,
        { fileId: signingReadOwnInput.fileId },
        { ...actorCompany, userId: clerks.employee },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      requireKit().invoke(readPendingSigningObject, {
        fileId: signingDownloadOwnInput.fileId,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      requireKit().invoke(readPendingSigningObject, {
        fileId: downloadOwnInput.fileId,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      requireKit().invoke(readPendingSigningObject, {
        fileId: signingReadForeignInput.fileId,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      requireKit().invoke(readPendingSigningObject, { fileId: randomUUID() }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects an oversize staging object without treating it as not-found", async () => {
    const pending = await requestSigningPut();
    const stagingKey = stagingObjectKey(
      kitIdentities.companies.a,
      pending.fileId,
    );
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
        requireKit().invoke(readPendingSigningObject, {
          fileId: pending.fileId,
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    } finally {
      restore();
    }
  });
});

describe("files.issueSigningDownloadUrl", () => {
  const actorCompany = { companyId: kitIdentities.companies.a };

  it("lets an employee with documents:view fetch the ASiC as attachment document.asice", async () => {
    const capturing = createCapturingLogger();
    const signed = await requireKit().invoke(
      issueSigningDownloadUrl,
      { fileId: signingDownloadOwnInput.fileId },
      { ...actorCompany, userId: clerks.employee },
      { deps: { ...requireKit().pipeline, logger: capturing.logger } },
    );
    expect(signed.fileId).toBe(signingDownloadOwnInput.fileId);
    expect(signed.downloadUrl.startsWith("http")).toBe(true);
    expect(signed.expiresAt).toEqual(expect.any(String));

    const fetched = await fetch(signed.downloadUrl);
    expect(fetched.ok).toBe(true);
    const body = new Uint8Array(await fetched.arrayBuffer());
    expect(sha256Hex(body)).toBe(zipChecksum);
    expect(fetched.headers.get("content-type")).toMatch(
      /application\/vnd\.etsi\.asic-e\+zip/i,
    );
    expect(fetched.headers.get("content-disposition")).toContain("attachment");
    expect(fetched.headers.get("content-disposition")).toContain(
      "document.asice",
    );
    expect(fetched.headers.get("content-disposition")).not.toContain("inline");

    const rows = await requireKit()
      .db.runtime.db.select({
        id: files.id,
        objectKey: files.objectKey,
        purpose: files.purpose,
      })
      .from(files)
      .where(eq(files.id, signingDownloadOwnInput.fileId));
    expect(JSON.stringify(rows[0])).not.toContain("http");
    expect(JSON.stringify(rows[0])).not.toContain(signed.downloadUrl);

    const logs = JSON.stringify(capturing.entries());
    expect(logs).not.toContain(signed.downloadUrl);
    expect(logs).not.toMatch(/\/signing\//);
    expect(logs).not.toMatch(/X-Amz-Signature/);
  });

  it("denies staff without documents:view", async () => {
    await expect(
      requireKit().invoke(
        issueSigningDownloadUrl,
        { fileId: signingDownloadOwnInput.fileId },
        { ...actorCompany, userId: clerks.noDocumentsView },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("treats pending, foreign, catalog, document, and missing files as the same not-found", async () => {
    const pending = await requireKit().invoke(
      requestSigningUpload,
      signingInput,
    );
    const missing = randomUUID();
    const pendingError = await requireKit()
      .invoke(issueSigningDownloadUrl, { fileId: pending.fileId })
      .then(
        () => {
          throw new Error("expected NotFoundError for a pending signing file");
        },
        (error: unknown) => error,
      );
    const foreignError = await requireKit()
      .invoke(issueSigningDownloadUrl, {
        fileId: signingDownloadForeignInput.fileId,
      })
      .then(
        () => {
          throw new Error("expected NotFoundError for a foreign signing file");
        },
        (error: unknown) => error,
      );
    const catalogError = await requireKit()
      .invoke(issueSigningDownloadUrl, { fileId: downloadOwnInput.fileId })
      .then(
        () => {
          throw new Error("expected NotFoundError for a catalog file");
        },
        (error: unknown) => error,
      );
    const documentError = await requireKit()
      .invoke(issueSigningDownloadUrl, {
        fileId: docDownloadOwnInput.fileId,
      })
      .then(
        () => {
          throw new Error("expected NotFoundError for a document file");
        },
        (error: unknown) => error,
      );
    const missingError = await requireKit()
      .invoke(issueSigningDownloadUrl, { fileId: missing })
      .then(
        () => {
          throw new Error("expected NotFoundError for a missing file");
        },
        (error: unknown) => error,
      );

    expect(pendingError).toBeInstanceOf(NotFoundError);
    expect(foreignError).toBeInstanceOf(NotFoundError);
    expect(catalogError).toBeInstanceOf(NotFoundError);
    expect(documentError).toBeInstanceOf(NotFoundError);
    expect(missingError).toBeInstanceOf(NotFoundError);
    if (
      pendingError instanceof NotFoundError &&
      foreignError instanceof NotFoundError &&
      catalogError instanceof NotFoundError &&
      documentError instanceof NotFoundError &&
      missingError instanceof NotFoundError
    ) {
      expect(pendingError.clientMessage).toBe(foreignError.clientMessage);
      expect(foreignError.clientMessage).toBe(catalogError.clientMessage);
      expect(catalogError.clientMessage).toBe(documentError.clientMessage);
      expect(documentError.clientMessage).toBe(missingError.clientMessage);
    }

    await expect(
      requireKit().invoke(issueDocumentDownloadUrl, {
        fileId: signingDownloadOwnInput.fileId,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("files.issueShareSigningDownloadUrl", () => {
  const actorCompany = { companyId: kitIdentities.companies.a };

  it("returns the same ASiC bytes as the panel issuer with attachment disposition", async () => {
    const capturing = createCapturingLogger();
    const signed = await requireKit().invoke(
      issueShareSigningDownloadUrl,
      { fileId: signingDownloadOwnInput.fileId },
      {},
      { deps: { ...requireKit().pipeline, logger: capturing.logger } },
    );
    expect(signed.fileId).toBe(signingDownloadOwnInput.fileId);
    const fetched = await fetch(signed.downloadUrl);
    expect(fetched.ok).toBe(true);
    expect(sha256Hex(new Uint8Array(await fetched.arrayBuffer()))).toBe(
      zipChecksum,
    );
    expect(fetched.headers.get("content-disposition")).toContain("attachment");
    expect(fetched.headers.get("content-disposition")).toContain(
      "document.asice",
    );

    const rows = await requireKit()
      .db.runtime.db.select({
        id: files.id,
        objectKey: files.objectKey,
        purpose: files.purpose,
      })
      .from(files)
      .where(eq(files.id, signingDownloadOwnInput.fileId));
    expect(JSON.stringify(rows[0])).not.toContain(signed.downloadUrl);

    const logs = JSON.stringify(capturing.entries());
    expect(logs).not.toContain(signed.downloadUrl);
    expect(logs).not.toMatch(/\/signing\//);
    expect(logs).not.toMatch(/X-Amz-Signature/);
  });

  it("denies staff without files:view, including an employee with documents:view", async () => {
    await expect(
      requireKit().invoke(
        issueShareSigningDownloadUrl,
        { fileId: signingDownloadOwnInput.fileId },
        { ...actorCompany, userId: clerks.noView },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      requireKit().invoke(
        issueShareSigningDownloadUrl,
        { fileId: signingDownloadOwnInput.fileId },
        { ...actorCompany, userId: clerks.employee },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("treats pending, foreign, catalog, document, and missing files as not-found", async () => {
    const pending = await requireKit().invoke(
      requestSigningUpload,
      signingInput,
    );
    const missing = randomUUID();
    await expect(
      requireKit().invoke(issueShareSigningDownloadUrl, {
        fileId: pending.fileId,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      requireKit().invoke(issueShareSigningDownloadUrl, {
        fileId: signingDownloadForeignInput.fileId,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      requireKit().invoke(issueShareSigningDownloadUrl, {
        fileId: downloadOwnInput.fileId,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      requireKit().invoke(issueShareSigningDownloadUrl, {
        fileId: docDownloadOwnInput.fileId,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      requireKit().invoke(issueShareSigningDownloadUrl, { fileId: missing }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("files.issueSystemSigningDownloadUrl", () => {
  it("returns attachment document.asice for the enqueuing tenant", async () => {
    const capturing = createCapturingLogger();
    const signed = await requireKit().invoke(
      issueSystemSigningDownloadUrl,
      { fileId: signingDownloadOwnInput.fileId },
      {},
      { deps: { ...requireKit().pipeline, logger: capturing.logger } },
    );
    expect(signed.fileId).toBe(signingDownloadOwnInput.fileId);
    const fetched = await fetch(signed.downloadUrl);
    expect(fetched.ok).toBe(true);
    expect(sha256Hex(new Uint8Array(await fetched.arrayBuffer()))).toBe(
      zipChecksum,
    );
    expect(fetched.headers.get("content-disposition")).toContain("attachment");
    expect(fetched.headers.get("content-disposition")).toContain(
      "document.asice",
    );
    const logs = JSON.stringify(capturing.entries());
    expect(logs).not.toContain(signed.downloadUrl);
    expect(logs).not.toMatch(/\/signing\//);
  });

  it("treats pending, foreign, catalog, and missing files as not-found", async () => {
    const pending = await requireKit().invoke(
      requestSigningUpload,
      signingInput,
    );
    await expect(
      requireKit().invoke(issueSystemSigningDownloadUrl, {
        fileId: pending.fileId,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      requireKit().invoke(issueSystemSigningDownloadUrl, {
        fileId: signingDownloadForeignInput.fileId,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      requireKit().invoke(issueSystemSigningDownloadUrl, {
        fileId: downloadOwnInput.fileId,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      requireKit().invoke(issueSystemSigningDownloadUrl, {
        fileId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("sweeps abandoned pending signing staging and rows, but not ready durable signing objects", async () => {
    const pending = await requireKit().invoke(
      requestSigningUpload,
      signingInput,
    );
    const signed = await requireKit().invoke(getSigningUploadUrl, {
      fileId: pending.fileId,
    });
    await putSigned(
      signed.uploadUrl,
      zipBytes,
      SIGNING_MIME_TYPE,
      stagingObjectKey(kitIdentities.companies.a, pending.fileId),
    );
    await putStoreObject(
      signingObjectKey(kitIdentities.companies.a, pending.fileId),
      zipBytes,
      SIGNING_MIME_TYPE,
    );
    await requireKit()
      .db.runtime.db.update(files)
      .set({
        createdAt: new Date(Date.now() - ABANDONED_PENDING_TTL_MS - 1_000),
      })
      .where(eq(files.id, pending.fileId));

    const readyDurableKey = signingObjectKey(
      kitIdentities.companies.a,
      signingDownloadOwnInput.fileId,
    );
    const store = getFilesObjectStore();
    const readyBefore = await store.getObject(readyDurableKey);
    expect(readyBefore).not.toBe("missing");
    if (readyBefore === "missing") {
      throw new Error("expected ready signing object before sweep");
    }
    const readyChecksum = sha256Hex(readyBefore.bytes);
    const beforeReady = await countReadySigningFiles(kitIdentities.companies.a);
    const beforeDocuments = await countDocumentFiles(kitIdentities.companies.a);

    const swept = await requireKit().invoke(sweepAbandonedUploads, {});
    expect(swept.abandonedPendingDeleted).toBeGreaterThanOrEqual(1);

    expect(await countReadySigningFiles(kitIdentities.companies.a)).toBe(
      beforeReady,
    );
    expect(await countDocumentFiles(kitIdentities.companies.a)).toBe(
      beforeDocuments,
    );
    const pendingGone = await requireKit()
      .db.runtime.db.select({ id: files.id })
      .from(files)
      .where(eq(files.id, pending.fileId));
    expect(pendingGone).toHaveLength(0);

    const pendingStaging = stagingObjectKey(
      kitIdentities.companies.a,
      pending.fileId,
    );
    const pendingSigning = signingObjectKey(
      kitIdentities.companies.a,
      pending.fileId,
    );
    await waitForObjectVisibility(store, pendingStaging, "missing");
    await waitForObjectVisibility(store, pendingSigning, "missing");
    expect(await store.headObject(pendingStaging)).toBe("missing");
    expect(await store.headObject(pendingSigning)).toBe("missing");

    const readyRows = await requireKit()
      .db.runtime.db.select({
        id: files.id,
        status: files.status,
        purpose: files.purpose,
        objectKey: files.objectKey,
      })
      .from(files)
      .where(eq(files.id, signingDownloadOwnInput.fileId));
    expect(readyRows).toEqual([
      {
        id: signingDownloadOwnInput.fileId,
        status: "ready",
        purpose: "signing",
        objectKey: readyDurableKey,
      },
    ]);
    const readyAfter = await store.getObject(readyDurableKey);
    expect(readyAfter).not.toBe("missing");
    if (readyAfter === "missing") {
      throw new Error("expected ready signing object after sweep");
    }
    expect(sha256Hex(readyAfter.bytes)).toBe(readyChecksum);

    const documentRows = await requireKit()
      .db.runtime.db.select({
        id: files.id,
        purpose: files.purpose,
      })
      .from(files)
      .where(eq(files.id, docDownloadOwnInput.fileId));
    expect(documentRows).toEqual([
      { id: docDownloadOwnInput.fileId, purpose: "document" },
    ]);
  });
});
