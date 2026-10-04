import { getCompany } from "@showzy/companies";
import type { ActionCtx, CtxCall } from "@showzy/core";
import { CoreInvariantError } from "@showzy/core/errors";
import { documents } from "@showzy/db/schema/documents";
import {
  ENTITY_LOOKUP_OPTIONS_MAX,
  entityLookupRefusal,
  type EntityLookupOption,
} from "@showzy/module-kit/entity-lookup";
import {
  canonicalizeDocumentNumberQuery,
  type CanonicalDocumentNumberQuery,
} from "@showzy/validation/search";
import { and, asc, eq, inArray, like, type SQL } from "drizzle-orm";

import type { DocumentReferenceInput } from "../actions/document-reference.contract.js";

import {
  documentNumberLeftPrefixPattern,
  seqDocumentNumbers,
} from "./search-matches.js";

type DocumentReferenceDb = Pick<
  Extract<ActionCtx, { principal: "staff" }>["db"],
  "select"
>;

type DocumentNumberRow = {
  readonly id: string;
  readonly documentNumber: string;
};

type DocumentNumberMatch = {
  readonly where: SQL;
  readonly isExact: (documentNumber: string) => boolean;
};

function candidateOptions(
  rows: readonly DocumentNumberRow[],
): readonly EntityLookupOption[] {
  return rows.map((row) => ({ id: row.id, label: row.documentNumber }));
}

function documentNumberMatch(
  parsed: CanonicalDocumentNumberQuery,
  prefix: string,
): DocumentNumberMatch | undefined {
  if (parsed.kind === "seq") {
    const numbers = seqDocumentNumbers(prefix, parsed.sequence);
    if (numbers === undefined) {
      return undefined;
    }
    return {
      where: inArray(documents.documentNumber, [...numbers]),
      isExact: () => true,
    };
  }
  if (parsed.kind !== "canonical") {
    return undefined;
  }
  const pattern = documentNumberLeftPrefixPattern(parsed.value);
  if (pattern === undefined) {
    return undefined;
  }
  const canonical = parsed.value;
  return {
    where: like(documents.documentNumber, pattern),
    isExact: (documentNumber) => documentNumber === canonical,
  };
}

async function loadDocumentNumberCandidates(env: {
  readonly db: DocumentReferenceDb;
  readonly companyId: string;
  readonly where: SQL;
}): Promise<readonly DocumentNumberRow[]> {
  return env.db
    .select({ id: documents.id, documentNumber: documents.documentNumber })
    .from(documents)
    .where(and(eq(documents.companyId, env.companyId), env.where))
    .orderBy(asc(documents.documentNumber), asc(documents.id))
    .limit(ENTITY_LOOKUP_OPTIONS_MAX + 1);
}

async function documentIdFromNumber(env: {
  readonly db: DocumentReferenceDb;
  readonly companyId: string;
  readonly prefix: string;
  readonly documentNumber: string;
}): Promise<string> {
  const target = { kind: "document", query: env.documentNumber } as const;
  const match = documentNumberMatch(
    canonicalizeDocumentNumberQuery(env.documentNumber, env.prefix),
    env.prefix,
  );
  if (match === undefined) {
    throw entityLookupRefusal(target, "none", []);
  }
  const rows = await loadDocumentNumberCandidates({
    db: env.db,
    companyId: env.companyId,
    where: match.where,
  });
  const exact = rows.filter((row) => match.isExact(row.documentNumber));
  const only = exact.length === 1 ? exact[0] : undefined;
  if (only !== undefined) {
    return only.id;
  }
  const ambiguous = exact.length > 1 ? exact : rows;
  throw entityLookupRefusal(
    target,
    ambiguous.length === 0 ? "none" : "several",
    candidateOptions(ambiguous),
  );
}

export async function resolveDocumentReference(env: {
  readonly db: DocumentReferenceDb;
  readonly companyId: string;
  readonly call: CtxCall;
  readonly input: DocumentReferenceInput;
}): Promise<string> {
  if (env.input.documentId !== undefined) {
    return env.input.documentId;
  }
  if (env.input.documentNumber === undefined) {
    throw new CoreInvariantError(
      "a document reference carries neither documentId nor documentNumber",
    );
  }
  const company = await env.call(getCompany, {});
  return documentIdFromNumber({
    db: env.db,
    companyId: env.companyId,
    prefix: company.prefix,
    documentNumber: env.input.documentNumber,
  });
}
