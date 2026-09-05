import type { ActionCtx } from "@showzy/core";
import { NotFoundError, PermissionDeniedError } from "@showzy/core/errors";
import { documentGenerationJobs } from "@showzy/db/schema/doc-generation";
import { getForGeneration } from "@showzy/documents";
import { recordGeneratedObject } from "@showzy/files";
import { postgresUniqueConstraint } from "@showzy/module-kit/postgres-unique";
import { sha256Hex } from "@showzy/module-kit/sha256";
import { and, eq, ne } from "drizzle-orm";

import { artifactFileId } from "./artifact-file-id.js";
import {
  forgetPdfInvocationScope,
  PdfGenerationTerminalError,
  rememberPdfInvocationScope,
  sanitizePdfFailureReason,
  toPdfGenerationRetryableError,
} from "./pdf-retry.js";
import { DOCUMENT_MIME_TYPE, putGeneratedPdf } from "./put-generated-pdf.js";
import { requireWritable } from "./writable.js";
import type { DocumentPdfModel } from "../templates/model.js";
import { renderDocumentPdfBytes } from "../templates/render-document.js";

export const JOBS_DOCUMENT_ID_UQ = "document_generation_jobs_document_id_uq";

type SystemTenantCtx = Extract<
  ActionCtx,
  { principal: "system"; scope: "tenant" }
>;

export type RenderPdfResult = {
  readonly status: "pending" | "ready" | "failed";
  readonly fileId: string | null;
  readonly documentId: string;
};

type JobRow = {
  readonly status: string;
  readonly fileId: string | null;
};

export function mapViewToPdfModel(view: {
  readonly type: "payment_invoice" | "delivery_note";
  readonly templateName: string;
  readonly documentNumber: string;
  readonly issuedOn: string;
  readonly currency: string;
  readonly supplierDetails: {
    readonly name: string;
    readonly companyType: "fop" | "tov";
    readonly legalName: string | null;
    readonly edrpou: string | null;
    readonly legalAddress: string | null;
    readonly iban: string | null;
    readonly bankName: string | null;
    readonly bankMfo: string | null;
    readonly phone: string | null;
    readonly email: string | null;
  };
  readonly buyerDetails:
    | {
        readonly kind: "customer";
        readonly displayName: string;
      }
    | {
        readonly kind: "counterparty";
        readonly name: string;
        readonly edrpou: string | null;
        readonly legalAddress: string | null;
        readonly iban: string | null;
        readonly bankName: string | null;
        readonly bankMfo: string | null;
        readonly phone: string | null;
        readonly email: string | null;
      };
  readonly items: readonly {
    readonly itemId: string;
    readonly titleSnapshot: string;
    readonly quantityMilli: string;
    readonly unitPriceMinor: string;
    readonly netAmountMinor: string;
    readonly grossAmountMinor: string;
  }[];
  readonly totalNetMinor: string;
  readonly totalTaxMinor: string;
  readonly totalGrossMinor: string;
  readonly basis: string | null;
}): DocumentPdfModel {
  if (view.currency !== "UAH") {
    throw new PdfGenerationTerminalError(
      `document money snapshot currency "${view.currency}" is not UAH`,
    );
  }
  return {
    type: view.type,
    templateName: view.templateName,
    documentNumber: view.documentNumber,
    issuedOn: view.issuedOn,
    currency: "UAH",
    basis: view.basis,
    supplier: {
      name: view.supplierDetails.name,
      companyType: view.supplierDetails.companyType,
      legalName: view.supplierDetails.legalName,
      edrpou: view.supplierDetails.edrpou,
      legalAddress: view.supplierDetails.legalAddress,
      iban: view.supplierDetails.iban,
      bankName: view.supplierDetails.bankName,
      bankMfo: view.supplierDetails.bankMfo,
      phone: view.supplierDetails.phone,
      email: view.supplierDetails.email,
    },
    buyer: view.buyerDetails,
    items: view.items.map((item) => ({
      itemId: item.itemId,
      title: item.titleSnapshot,
      quantityMilli: item.quantityMilli,
      unitPriceMinor: item.unitPriceMinor,
      netAmountMinor: item.netAmountMinor,
      grossAmountMinor: item.grossAmountMinor,
    })),
    totalNetMinor: view.totalNetMinor,
    totalTaxMinor: view.totalTaxMinor,
    totalGrossMinor: view.totalGrossMinor,
  };
}

async function loadJob(
  ctx: SystemTenantCtx,
  documentId: string,
): Promise<JobRow | undefined> {
  const rows = await ctx.db
    .select({
      status: documentGenerationJobs.status,
      fileId: documentGenerationJobs.fileId,
    })
    .from(documentGenerationJobs)
    .where(
      and(
        eq(documentGenerationJobs.companyId, ctx.companyId),
        eq(documentGenerationJobs.documentId, documentId),
      ),
    )
    .limit(1);
  return rows[0];
}

async function insertPendingJob(
  ctx: SystemTenantCtx,
  documentId: string,
): Promise<void> {
  const db = requireWritable(ctx.db);
  try {
    await db.insert(documentGenerationJobs).values({
      companyId: ctx.companyId,
      documentId,
      status: "pending",
      fileId: null,
    });
  } catch (error) {
    if (postgresUniqueConstraint(error) !== JOBS_DOCUMENT_ID_UQ) {
      throw error;
    }
  }
}

async function markJobReady(
  ctx: SystemTenantCtx,
  documentId: string,
  fileId: string,
): Promise<void> {
  const db = requireWritable(ctx.db);
  await db
    .update(documentGenerationJobs)
    .set({
      status: "ready",
      fileId,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(documentGenerationJobs.companyId, ctx.companyId),
        eq(documentGenerationJobs.documentId, documentId),
      ),
    );
}

/**
 * Persist terminal failed without clobbering a concurrent ready win.
 * UPDATE matches 0 rows when status is already ready; reload the
 * surviving row like `markTenantDocumentFailed`.
 */
export async function markJobFailed(
  ctx: SystemTenantCtx,
  documentId: string,
): Promise<RenderPdfResult> {
  const db = requireWritable(ctx.db);
  const updated = await db
    .update(documentGenerationJobs)
    .set({
      status: "failed",
      fileId: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(documentGenerationJobs.companyId, ctx.companyId),
        eq(documentGenerationJobs.documentId, documentId),
        ne(documentGenerationJobs.status, "ready"),
      ),
    )
    .returning({
      status: documentGenerationJobs.status,
      fileId: documentGenerationJobs.fileId,
    });
  const afterUpdate = updated[0] ?? (await loadJob(ctx, documentId));
  if (
    afterUpdate !== undefined &&
    afterUpdate.status === "ready" &&
    afterUpdate.fileId !== null
  ) {
    return {
      status: "ready",
      fileId: afterUpdate.fileId,
      documentId,
    };
  }
  return { status: "failed", fileId: null, documentId };
}

function logRenderFailure(
  ctx: SystemTenantCtx,
  documentId: string,
  error: unknown,
  failureClass: "retryable" | "terminal",
): void {
  ctx.log.error(
    {
      document_id: documentId,
      pdf_failure_class: failureClass,
      err_name: error instanceof Error ? error.name : "unknown",
      err_message: sanitizePdfFailureReason(error),
    },
    "docGeneration.renderPdf failed",
  );
}

export async function renderTenantDocumentPdf(env: {
  readonly ctx: SystemTenantCtx;
  readonly eventId: string;
  readonly documentId: string;
}): Promise<RenderPdfResult> {
  const { ctx, documentId } = env;
  const existing = await loadJob(ctx, documentId);
  if (
    existing !== undefined &&
    existing.status === "ready" &&
    existing.fileId !== null
  ) {
    forgetPdfInvocationScope(env.eventId);
    return {
      status: "ready",
      fileId: existing.fileId,
      documentId,
    };
  }

  try {
    const view = await ctx.call(getForGeneration, { documentId });
    rememberPdfInvocationScope({
      eventId: env.eventId,
      documentId,
      companyId: ctx.companyId,
    });
    if (existing === undefined) {
      await insertPendingJob(ctx, documentId);
    }

    const fileId = artifactFileId(documentId);
    const bytes = await renderDocumentPdfBytes(mapViewToPdfModel(view));
    await putGeneratedPdf({
      companyId: ctx.companyId,
      fileId,
      bytes,
    });
    await ctx.callAtomic(recordGeneratedObject, {
      fileId,
      purpose: "document",
      mimeType: DOCUMENT_MIME_TYPE,
      byteSize: bytes.byteLength,
      checksumSha256: sha256Hex(bytes),
    });
    await markJobReady(ctx, documentId, fileId);
    forgetPdfInvocationScope(env.eventId);
    return { status: "ready", fileId, documentId };
  } catch (error) {
    if (error instanceof PdfGenerationTerminalError) {
      const outcome = await markJobFailed(ctx, documentId);
      logRenderFailure(ctx, documentId, error, "terminal");
      return outcome;
    }
    logRenderFailure(ctx, documentId, error, "retryable");
    // Isolation suites require NotFound/PermissionDenied on foreign
    // access. Outbox delivery still retries those CoreErrors; wrapping
    // would turn a tenant denial into CONFLICT. After five attempts the
    // worker has no retry scope and does not persist failed — deleted
    // and foreign deliveries are that class (see pdf-retry.ts).
    if (
      error instanceof NotFoundError ||
      error instanceof PermissionDeniedError
    ) {
      throw error;
    }
    throw toPdfGenerationRetryableError({
      documentId,
      companyId: ctx.companyId,
      cause: error,
    });
  }
}
