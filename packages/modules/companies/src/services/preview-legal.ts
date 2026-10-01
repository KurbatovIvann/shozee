import type { ActionPreviewEnv } from "@showzy/core";
import type { ActionPreviewLine } from "@showzy/core/errors";
import { companyLegalInfo } from "@showzy/db/schema/companies";
import { eq } from "drizzle-orm";
import type { z } from "zod";

type PreviewTx = ActionPreviewEnv["tx"];

import type { updateLegalInputSchema } from "../actions/update-legal.contract.js";

type UpdateLegalInput = z.output<typeof updateLegalInputSchema>;

const COMPANY_TYPE_LABELS = new Map<string, string>([
  ["fop", "ФОП"],
  ["tov", "ТОВ"],
]);

const CLEARED = "очистити";
const ABSENT = "—";

export function companyTypeLabel(companyType: string): string {
  return COMPANY_TYPE_LABELS.get(companyType) ?? companyType;
}

export interface StoredLegalFacts {
  readonly companyType: string;
  readonly legalName: string | null;
  readonly edrpou: string | null;
  readonly iban: string | null;
}

export async function loadStoredLegalFacts(env: {
  readonly tx: PreviewTx;
  readonly companyId: string;
}): Promise<StoredLegalFacts | undefined> {
  const rows = await env.tx
    .select({
      companyType: companyLegalInfo.companyType,
      legalName: companyLegalInfo.legalName,
      edrpou: companyLegalInfo.edrpou,
      iban: companyLegalInfo.iban,
    })
    .from(companyLegalInfo)
    .where(eq(companyLegalInfo.companyId, env.companyId))
    .limit(1);
  return rows[0];
}

function patchedValue(
  provided: string | null | undefined,
  stored: string | null,
): string {
  if (provided === undefined) {
    return stored ?? ABSENT;
  }
  if (provided === null || provided.length === 0) {
    return stored === null ? ABSENT : CLEARED;
  }
  return provided;
}

function changeLine(
  label: string,
  stored: string | null,
  next: string,
): ActionPreviewLine {
  if (stored === null || stored === next) {
    return { label, value: next };
  }
  return { label, value: `${stored} → ${next}` };
}

export function legalPreviewLines(
  input: UpdateLegalInput,
  stored: StoredLegalFacts | undefined,
): ActionPreviewLine[] {
  const storedType =
    stored === undefined ? null : companyTypeLabel(stored.companyType);
  const storedLegalName = stored?.legalName ?? null;
  const storedEdrpou = stored?.edrpou ?? null;
  const storedIban = stored?.iban ?? null;
  return [
    changeLine("Форма", storedType, companyTypeLabel(input.companyType)),
    changeLine("Юридична назва", storedLegalName, input.legalName),
    changeLine(
      "ЄДРПОУ",
      storedEdrpou,
      patchedValue(input.edrpou, storedEdrpou),
    ),
    changeLine("IBAN", storedIban, patchedValue(input.iban, storedIban)),
  ];
}
