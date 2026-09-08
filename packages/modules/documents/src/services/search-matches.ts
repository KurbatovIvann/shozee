/**
 * Staff document search matcher SQL (SHO-533 / SHO-526). Identifier
 * layer only: match `document_number` (equality or left-prefix on a
 * canonical full number, never FTS/trgm/contains). Does not reuse the
 * order-number canonicalize. Prefix comes from the caller
 * (`companies.get`). Issued and cancelled rows return with `status`.
 *
 * SQL `ORDER BY` + `LIMIT n+1` must match `sortHits`: exact, then rank
 * desc, then id asc. T3 Bugbot: the SQL window must match that sort.
 * `row.rank` is one SQL expression, fed to `sortHits` via `toRank`.
 */
import type { ActionCtx } from "@showzy/core";
import { documents } from "@showzy/db/schema/documents";
import {
  SEARCH_LABEL_MAX,
  SEARCH_STATUS_MAX,
  SEARCH_SUBLABEL_MAX,
  canonicalizeDocumentNumberQuery,
  dedupSearchHits,
  sanitizeLikeLiteral,
  type CanonicalDocumentNumberQuery,
  type SearchHit,
} from "@showzy/validation/search";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";

import {
  DELIVERY_NOTE_TYPE_CODE,
  formatDocumentNumber,
  PAYMENT_INVOICE_TYPE_CODE,
} from "./document-number.js";

type StaffDb = Extract<ActionCtx, { principal: "staff" }>["db"];
type DocumentType = "payment_invoice" | "delivery_note";

type InternalHit = SearchHit & {
  readonly type: "document";
  readonly documentType: DocumentType;
  readonly rank: number;
};

export type DocumentsSearchMatchesResult = {
  readonly groups: Array<{
    readonly type: "document";
    readonly hits: SearchHit[];
    readonly truncated: boolean;
  }>;
};

export function emptySearchMatchesResult(): DocumentsSearchMatchesResult {
  return { groups: [] };
}

/** `LIKE 'canonical%'` — left-prefix only; never `%…%`. */
export function documentNumberLeftPrefixPattern(
  canonical: string,
): string | undefined {
  const literal = sanitizeLikeLiteral(canonical);
  if (literal === undefined) {
    return undefined;
  }
  return `${literal}%`;
}

export async function runDocumentsSearchMatches(args: {
  readonly db: StaffDb;
  readonly companyId: string;
  readonly prefix: string;
  readonly query: string;
  readonly limitPerType: number;
}): Promise<DocumentsSearchMatchesResult> {
  const parsed = canonicalizeDocumentNumberQuery(args.query, args.prefix);
  const hits = sortHits(
    applySeqExact(
      dedupSearchHits(
        (await fetchDocumentRows({ ...args, parsed })).map((row) =>
          toDocumentHit(row, parsed, args.prefix),
        ),
      ),
      parsed,
    ),
  );
  const group = toDisplayGroup(hits, args.limitPerType);
  return { groups: group === undefined ? [] : [group] };
}

async function fetchDocumentRows(args: {
  readonly db: StaffDb;
  readonly companyId: string;
  readonly prefix: string;
  readonly parsed: CanonicalDocumentNumberQuery;
  readonly limitPerType: number;
}): Promise<readonly DocumentSearchRow[]> {
  const matchPlan = matchPlanFor(args.parsed, args.prefix);
  if (matchPlan === undefined) {
    return [];
  }
  const scoped = and(eq(documents.companyId, args.companyId), matchPlan.match);
  if (scoped === undefined) {
    return [];
  }
  const exact = exactBoostSql(matchPlan.numberExact);
  const rank = rankSql(matchPlan.numberExact, matchPlan.numberMatch);
  return args.db
    .select({
      id: documents.id,
      documentNumber: documents.documentNumber,
      type: documents.type,
      status: documents.status,
      rank,
    })
    .from(documents)
    .where(scoped)
    .orderBy(sql`${exact} DESC`, sql`${rank} DESC`, sql`${documents.id} ASC`)
    .limit(args.limitPerType + 1);
}

type DocumentSearchRow = {
  readonly id: string;
  readonly documentNumber: string;
  readonly type: string;
  readonly status: string;
  readonly rank: unknown;
};

type MatchPlan = {
  readonly match: SQL;
  readonly numberExact: SQL | undefined;
  readonly numberMatch: SQL | undefined;
};

function matchPlanFor(
  parsed: CanonicalDocumentNumberQuery,
  prefix: string,
): MatchPlan | undefined {
  if (parsed.kind === "empty" || parsed.kind === "none") {
    return undefined;
  }
  if (parsed.kind === "seq") {
    const numbers = seqDocumentNumbers(prefix, parsed.sequence);
    if (numbers === undefined) {
      return undefined;
    }
    const numberExact = sql`${inArray(documents.documentNumber, [...numbers])}`;
    return {
      match: numberExact,
      numberExact,
      numberMatch: undefined,
    };
  }
  const pattern = documentNumberLeftPrefixPattern(parsed.value);
  if (pattern === undefined) {
    return undefined;
  }
  const numberMatch = sql`${documents.documentNumber} LIKE ${pattern}`;
  const numberExact = sql`${documents.documentNumber} = ${parsed.value}`;
  return {
    match: numberMatch,
    numberExact,
    numberMatch,
  };
}

function seqDocumentNumbers(
  prefix: string,
  sequence: string,
): readonly [string, string] | undefined {
  if (!/^\d+$/.test(sequence)) {
    return undefined;
  }
  const seq = BigInt(sequence);
  const invoice = formatDocumentNumber(prefix, "payment_invoice", seq);
  const delivery = formatDocumentNumber(prefix, "delivery_note", seq);
  const invoiceSeq = invoice.slice(invoice.lastIndexOf("-") + 1);
  if (invoiceSeq !== sequence) {
    return undefined;
  }
  return [invoice, delivery];
}

function exactBoostSql(numberExact: SQL | undefined): SQL {
  if (numberExact === undefined) {
    return sql`0`;
  }
  return sql`(CASE WHEN ${numberExact} THEN 1 ELSE 0 END)`;
}

/**
 * Selected as `row.rank` and fed to `sortHits` via `toRank`. One
 * expression — the same SQL fragment is selected and ordered by.
 */
function rankSql(
  numberExact: SQL | undefined,
  numberMatch: SQL | undefined,
): SQL {
  return sql`(CASE
    WHEN ${numberExact ?? sql`FALSE`} THEN 1
    WHEN ${numberMatch ?? sql`FALSE`} THEN 0
    ELSE 0
  END)`;
}

function toDocumentHit(
  row: DocumentSearchRow,
  parsed: CanonicalDocumentNumberQuery,
  prefix: string,
): InternalHit {
  const documentType = asDocumentType(row.type);
  const preferred = numberCandidate(row.documentNumber, parsed, prefix);
  return {
    type: "document",
    documentType,
    id: row.id,
    label: clip(row.documentNumber, SEARCH_LABEL_MAX),
    matchedOn: preferred.matchedOn,
    exact: preferred.exact,
    rank: toRank(row.rank),
    ...statusFields(row.status),
    ...sublabelFields(documentType),
  };
}

function numberCandidate(
  stored: string,
  parsed: CanonicalDocumentNumberQuery,
  prefix: string,
): { matchedOn: "number"; exact: boolean } {
  if (parsed.kind === "seq") {
    const numbers = seqDocumentNumbers(prefix, parsed.sequence);
    if (
      numbers === undefined ||
      (stored !== numbers[0] && stored !== numbers[1])
    ) {
      return { matchedOn: "number", exact: false };
    }
    return { matchedOn: "number", exact: true };
  }
  if (parsed.kind === "canonical" && stored.startsWith(parsed.value)) {
    return { matchedOn: "number", exact: stored === parsed.value };
  }
  return { matchedOn: "number", exact: false };
}

function applySeqExact(
  hits: readonly InternalHit[],
  parsed: CanonicalDocumentNumberQuery,
): InternalHit[] {
  if (parsed.kind !== "seq") {
    return [...hits];
  }
  const types = new Set(hits.map((hit) => hit.documentType));
  if (types.size <= 1) {
    return [...hits];
  }
  return hits.map((hit) => (hit.exact ? { ...hit, exact: false } : hit));
}

function asDocumentType(type: string): DocumentType {
  return type === "delivery_note" ? "delivery_note" : "payment_invoice";
}

function statusFields(status: string): { status?: string } {
  const clipped = optionalClip(status, SEARCH_STATUS_MAX);
  return clipped === undefined ? {} : { status: clipped };
}

function sublabelFields(type: DocumentType): { sublabel?: string } {
  const code =
    type === "payment_invoice"
      ? PAYMENT_INVOICE_TYPE_CODE
      : DELIVERY_NOTE_TYPE_CODE;
  const sublabel = optionalClip(code, SEARCH_SUBLABEL_MAX);
  return sublabel === undefined ? {} : { sublabel };
}

function toDisplayGroup(
  hits: readonly InternalHit[],
  limit: number,
): { type: "document"; hits: SearchHit[]; truncated: boolean } | undefined {
  if (hits.length === 0) {
    return undefined;
  }
  const truncated = hits.length > limit;
  const page = truncated ? hits.slice(0, limit) : hits;
  return {
    type: "document",
    truncated,
    hits: page.map((hit) => toOutputHit(hit)),
  };
}

function toOutputHit(hit: InternalHit): SearchHit {
  return {
    id: hit.id,
    label: hit.label,
    matchedOn: hit.matchedOn,
    exact: hit.exact,
    ...(hit.sublabel === undefined ? {} : { sublabel: hit.sublabel }),
    ...(hit.status === undefined ? {} : { status: hit.status }),
  };
}

function sortHits(hits: readonly InternalHit[]): InternalHit[] {
  return [...hits].sort((left, right) => {
    if (left.exact !== right.exact) {
      return left.exact ? -1 : 1;
    }
    if (left.rank !== right.rank) {
      return right.rank - left.rank;
    }
    if (left.id < right.id) {
      return -1;
    }
    if (left.id > right.id) {
      return 1;
    }
    return 0;
  });
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function optionalClip(
  value: string | null | undefined,
  max: number,
): string | undefined {
  if (value === null || value === undefined || value.length === 0) {
    return undefined;
  }
  const clipped = clip(value, max);
  return clipped.length === 0 ? undefined : clipped;
}

function toRank(value: unknown): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value === "string" && value.length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}
