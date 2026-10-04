import type { ActionCtx } from "@showzy/core";
import { CoreInvariantError } from "@showzy/core/errors";
import { companies, companyLegalInfo } from "@showzy/db/schema/companies";
import { keepOmitted } from "@showzy/module-kit/keep-omitted";
import { parseDbEnum } from "@showzy/module-kit/parse-db-enum";
import { requireOrValidationError } from "@showzy/module-kit/require";
import { eq } from "drizzle-orm";
import { z } from "zod";

import {
  companyLegalNameSchema,
  companyLegalTypeSchema,
  type companyViewSchema,
} from "../actions/company-view.contract.js";
import {
  LEGAL_IDENTITY_REQUIRED_MESSAGE,
  type updateLegalInputSchema,
} from "../actions/update-legal.contract.js";

type CompanyView = z.output<typeof companyViewSchema>;
type LegalView = NonNullable<CompanyView["legal"]>;
type UpdateLegalInput = z.output<typeof updateLegalInputSchema>;
type CompanyDb = Extract<ActionCtx, { principal: "staff" }>["db"];

export const companyIdentityReturning = {
  id: companies.id,
  name: companies.name,
  slug: companies.slug,
  prefix: companies.prefix,
} as const;

export const legalReturning = {
  id: companyLegalInfo.id,
  companyType: companyLegalInfo.companyType,
  legalName: companyLegalInfo.legalName,
  edrpou: companyLegalInfo.edrpou,
  legalAddress: companyLegalInfo.legalAddress,
  iban: companyLegalInfo.iban,
  bankName: companyLegalInfo.bankName,
  bankMfo: companyLegalInfo.bankMfo,
  bankEdrpou: companyLegalInfo.bankEdrpou,
  phone: companyLegalInfo.phone,
  email: companyLegalInfo.email,
  createdAt: companyLegalInfo.createdAt,
  updatedAt: companyLegalInfo.updatedAt,
} as const;

export type LegalRow = {
  readonly id: string;
  readonly companyType: string;
  readonly legalName: string | null;
  readonly edrpou: string | null;
  readonly legalAddress: string | null;
  readonly iban: string | null;
  readonly bankName: string | null;
  readonly bankMfo: string | null;
  readonly bankEdrpou: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

function nullableText(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  return value;
}

export function parseCompanyType(
  value: string,
): z.output<typeof companyLegalTypeSchema> {
  return parseDbEnum(
    companyLegalTypeSchema,
    value,
    `company_legal_info row has illegal company_type "${value}"`,
  );
}

export const legalFactsReturning = {
  companyType: companyLegalInfo.companyType,
  legalName: companyLegalInfo.legalName,
  edrpou: companyLegalInfo.edrpou,
  legalAddress: companyLegalInfo.legalAddress,
  iban: companyLegalInfo.iban,
  bankName: companyLegalInfo.bankName,
  bankMfo: companyLegalInfo.bankMfo,
  bankEdrpou: companyLegalInfo.bankEdrpou,
  phone: companyLegalInfo.phone,
  email: companyLegalInfo.email,
} as const;

export interface StoredLegalFacts {
  readonly companyType: string;
  readonly legalName: string | null;
  readonly edrpou: string | null;
  readonly legalAddress: string | null;
  readonly iban: string | null;
  readonly bankName: string | null;
  readonly bankMfo: string | null;
  readonly bankEdrpou: string | null;
  readonly phone: string | null;
  readonly email: string | null;
}

export interface MergedLegalFields {
  readonly companyType: z.output<typeof companyLegalTypeSchema>;
  readonly legalName: string;
  readonly edrpou: string | null;
  readonly legalAddress: string | null;
  readonly iban: string | null;
  readonly bankName: string | null;
  readonly bankMfo: string | null;
  readonly bankEdrpou: string | null;
  readonly phone: string | null;
  readonly email: string | null;
}

const legalIdentitySchema = z.object({
  companyType: companyLegalTypeSchema,
  legalName: companyLegalNameSchema,
});

function keptText(
  value: string | null | undefined,
  stored: string | null | undefined,
): string | null {
  return value === undefined ? (stored ?? null) : nullableText(value);
}

export function mergeLegalFields(
  input: UpdateLegalInput,
  stored: StoredLegalFacts | undefined,
): MergedLegalFields {
  const identity = requireOrValidationError(
    legalIdentitySchema,
    {
      companyType: keepOmitted(
        input.companyType,
        stored === undefined ? undefined : parseCompanyType(stored.companyType),
      ),
      legalName: keepOmitted(input.legalName, stored?.legalName ?? undefined),
    },
    LEGAL_IDENTITY_REQUIRED_MESSAGE,
  );
  return {
    ...identity,
    edrpou: keptText(input.edrpou, stored?.edrpou),
    legalAddress: keptText(input.legalAddress, stored?.legalAddress),
    iban: keptText(input.iban, stored?.iban),
    bankName: keptText(input.bankName, stored?.bankName),
    bankMfo: keptText(input.bankMfo, stored?.bankMfo),
    bankEdrpou: keptText(input.bankEdrpou, stored?.bankEdrpou),
    phone: keptText(input.phone, stored?.phone),
    email: keptText(input.email, stored?.email),
  };
}

const OPTIONAL_LEGAL_FIELDS = [
  "edrpou",
  "legalAddress",
  "iban",
  "bankName",
  "bankMfo",
  "bankEdrpou",
  "phone",
  "email",
] as const;

type OptionalLegalField = (typeof OPTIONAL_LEGAL_FIELDS)[number];

export function namedLegalFields(input: UpdateLegalInput): {
  readonly companyType?: z.output<typeof companyLegalTypeSchema>;
  readonly legalName?: string;
} & { readonly [K in OptionalLegalField]?: string | null } {
  const named: { [K in OptionalLegalField]?: string | null } = {};
  for (const field of OPTIONAL_LEGAL_FIELDS) {
    if (input[field] !== undefined) {
      named[field] = nullableText(input[field]);
    }
  }
  return {
    ...(input.companyType === undefined
      ? {}
      : { companyType: input.companyType }),
    ...(input.legalName === undefined ? {} : { legalName: input.legalName }),
    ...named,
  };
}

export function toLegalView(row: LegalRow): LegalView {
  return {
    id: row.id,
    companyType: parseCompanyType(row.companyType),
    legalName: row.legalName,
    edrpou: row.edrpou,
    legalAddress: row.legalAddress,
    iban: row.iban,
    bankName: row.bankName,
    bankMfo: row.bankMfo,
    bankEdrpou: row.bankEdrpou,
    phone: row.phone,
    email: row.email,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toCompanyView(
  company: {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
    readonly prefix: string;
  },
  legal: LegalRow | undefined,
): CompanyView {
  return {
    id: company.id,
    name: company.name,
    slug: company.slug,
    prefix: company.prefix,
    legal: legal === undefined ? null : toLegalView(legal),
  };
}

export async function loadCompanyView(
  db: CompanyDb,
  companyId: string,
): Promise<CompanyView> {
  const company = (
    await db
      .select(companyIdentityReturning)
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1)
  )[0];
  if (company === undefined) {
    throw new CoreInvariantError("companies expected the staff company row");
  }

  const legal = (
    await db
      .select(legalReturning)
      .from(companyLegalInfo)
      .where(eq(companyLegalInfo.companyId, companyId))
      .limit(1)
  )[0];

  return toCompanyView(company, legal);
}
