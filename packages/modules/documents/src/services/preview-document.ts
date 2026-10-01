import type { ActionPreviewEnv } from "@showzy/core";
import type { ActionPreviewLine } from "@showzy/core/errors";
import { NotFoundError } from "@showzy/core/errors";
import { documents } from "@showzy/db/schema/documents";
import { and, eq } from "drizzle-orm";

type PreviewTx = ActionPreviewEnv["tx"];

const TYPE_LABELS = new Map<string, string>([
  ["payment_invoice", "Рахунок на оплату"],
  ["delivery_note", "Видаткова накладна"],
]);

const STATUS_LABELS = new Map<string, string>([
  ["issued", "Виданий"],
  ["cancelled", "Скасований"],
]);

export function documentTypeLabel(type: string): string {
  return TYPE_LABELS.get(type) ?? type;
}

export function documentStatusLabel(status: string): string {
  return STATUS_LABELS.get(status) ?? status;
}

export interface DocumentPreviewFacts {
  readonly documentNumber: string;
  readonly type: string;
  readonly status: string;
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
  return row;
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
