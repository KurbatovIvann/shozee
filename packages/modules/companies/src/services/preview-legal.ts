import type { ActionPreviewEnv } from "@showzy/core";
import type { ActionPreviewLine } from "@showzy/core/errors";
import { companyLegalInfo } from "@showzy/db/schema/companies";
import { eq } from "drizzle-orm";
import type { z } from "zod";

type PreviewTx = ActionPreviewEnv["tx"];

import type { companyLegalTypeSchema } from "../actions/company-view.contract.js";
import type { updateLegalInputSchema } from "../actions/update-legal.contract.js";
import {
  legalFactsReturning,
  namedLegalFields,
  parseCompanyType,
  type StoredLegalFacts,
} from "./company-view.js";

type UpdateLegalInput = z.output<typeof updateLegalInputSchema>;
type CompanyLegalType = z.output<typeof companyLegalTypeSchema>;
type LegalField = keyof UpdateLegalInput;

const COMPANY_TYPE_LABELS = {
  fop: "ФОП",
  tov: "ТОВ",
} as const satisfies Record<CompanyLegalType, string>;

const LEGAL_FIELD_LABELS = {
  companyType: "Форма",
  legalName: "Юридична назва",
  edrpou: "ЄДРПОУ",
  legalAddress: "Юридична адреса",
  iban: "IBAN",
  bankName: "Банк",
  bankMfo: "МФО",
  bankEdrpou: "ЄДРПОУ банку",
  phone: "Телефон",
  email: "Email",
} as const satisfies Record<LegalField, string>;

const LEGAL_FIELD_ORDER = Object.keys(LEGAL_FIELD_LABELS) as LegalField[];

const CLEARED = "очистити";
const ABSENT = "—";

export function companyTypeLabel(companyType: CompanyLegalType): string {
  return COMPANY_TYPE_LABELS[companyType];
}

export async function loadStoredLegalFacts(env: {
  readonly tx: PreviewTx;
  readonly companyId: string;
}): Promise<StoredLegalFacts | undefined> {
  const rows = await env.tx
    .select(legalFactsReturning)
    .from(companyLegalInfo)
    .where(eq(companyLegalInfo.companyId, env.companyId))
    .limit(1);
  return rows[0];
}

function storedLabel(
  field: LegalField,
  stored: StoredLegalFacts | undefined,
): string | null {
  if (stored === undefined) {
    return null;
  }
  if (field === "companyType") {
    return companyTypeLabel(parseCompanyType(stored.companyType));
  }
  return stored[field];
}

function patchedLabel(patched: string | null, stored: string | null): string {
  if (patched !== null) {
    return patched;
  }
  return stored === null ? ABSENT : CLEARED;
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
  const patch: Partial<Record<LegalField, string | null>> =
    namedLegalFields(input);
  const lines: ActionPreviewLine[] = [];
  for (const field of LEGAL_FIELD_ORDER) {
    if (!(field in patch)) {
      continue;
    }
    const storedValue = storedLabel(field, stored);
    const next =
      input.companyType !== undefined && field === "companyType"
        ? companyTypeLabel(input.companyType)
        : patchedLabel(patch[field] ?? null, storedValue);
    lines.push(changeLine(LEGAL_FIELD_LABELS[field], storedValue, next));
  }
  return lines;
}
