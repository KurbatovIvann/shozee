import type { ActionPreviewEnv } from "@showzy/core";
import type { ActionPreviewLine } from "@showzy/core/errors";
import { NotFoundError } from "@showzy/core/errors";
import { documents, documentShareTokens } from "@showzy/db/schema/documents";
import { parseDbEnum } from "@showzy/module-kit/parse-db-enum";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";

import {
  documentStatusSchema,
  documentTypeSchema,
} from "../actions/document-view.contract.js";
import { liveShareToken } from "./share-token-liveness.js";

type PreviewTx = ActionPreviewEnv["tx"];
type DocumentType = z.output<typeof documentTypeSchema>;
type DocumentStatus = z.output<typeof documentStatusSchema>;

const TYPE_LABELS = {
  payment_invoice: "Рахунок на оплату",
  delivery_note: "Видаткова накладна",
} as const satisfies Record<DocumentType, string>;

const STATUS_LABELS = {
  issued: "Виданий",
  cancelled: "Скасований",
} as const satisfies Record<DocumentStatus, string>;

export function documentTypeLabel(type: DocumentType): string {
  return TYPE_LABELS[type];
}

export function documentStatusLabel(status: DocumentStatus): string {
  return STATUS_LABELS[status];
}

export interface DocumentPreviewFacts {
  readonly documentNumber: string;
  readonly type: DocumentType;
  readonly status: DocumentStatus;
}

export async function loadDocumentPreviewFacts(env: {
  readonly tx: PreviewTx;
  readonly companyId: string;
  readonly documentId: string;
}): Promise<DocumentPreviewFacts> {
  const rows = await env.tx
    .select({
      documentNumber: documents.documentNumber,
      type: documents.type,
      status: documents.status,
    })
    .from(documents)
    .where(
      and(
        eq(documents.companyId, env.companyId),
        eq(documents.id, env.documentId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw new NotFoundError();
  }
  return {
    documentNumber: row.documentNumber,
    type: parseDbEnum(
      documentTypeSchema,
      row.type,
      `documents row has illegal type "${row.type}"`,
    ),
    status: parseDbEnum(
      documentStatusSchema,
      row.status,
      `documents row has illegal status "${row.status}"`,
    ),
  };
}

export async function hasLiveShareToken(env: {
  readonly tx: PreviewTx;
  readonly companyId: string;
  readonly documentId: string;
}): Promise<boolean> {
  const rows = await env.tx
    .select({ id: documentShareTokens.id })
    .from(documentShareTokens)
    .where(
      and(
        eq(documentShareTokens.companyId, env.companyId),
        eq(documentShareTokens.documentId, env.documentId),
        liveShareToken(new Date()),
      ),
    )
    .limit(1);
  return rows[0] !== undefined;
}

export function documentPreviewLines(
  facts: DocumentPreviewFacts,
): ActionPreviewLine[] {
  return [
    { label: "Документ", value: facts.documentNumber },
    { label: "Тип", value: documentTypeLabel(facts.type) },
    { label: "Статус", value: documentStatusLabel(facts.status) },
  ];
}
