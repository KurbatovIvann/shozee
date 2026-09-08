/**
 * Staff price-list search matcher SQL (SHO-532 / SHO-526). Hits use FTS
 * token-AND word-prefix (`simple`) + trgm 0.25 on `price_lists.name`.
 * No identifier layer, no entries/prices, no catalog join.
 *
 * Inactive lists return with `status` (`active` / `inactive`) and are
 * not hidden. `exact` is this list's own normalized name.
 *
 * SQL `ORDER BY` + `LIMIT n+1` must match `sortHits`: exact, then rank
 * desc, then id asc. T3 Bugbot: the SQL window must match that sort.
 */
import type { ActionCtx } from "@showzy/core";
import { priceLists } from "@showzy/db/schema/pricing";
import {
  SEARCH_APOSTROPHE_CANON,
  SEARCH_LABEL_MAX,
  SEARCH_STATUS_MAX,
  collapseSearchWhitespace,
  dedupSearchHits,
  foldSearchNameToken,
  type PreparedSearchQuery,
  type SearchHit,
} from "@showzy/validation/search";
import { and, eq, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";

type StaffDb = Extract<ActionCtx, { principal: "staff" }>["db"];
type PreparedTokens = Extract<PreparedSearchQuery, { empty: false }>;

/** v1 `word_similarity` threshold; SHO-526 names 0.25. */
export const SEARCH_NAME_TRGM_THRESHOLD = 0.25;

const TSQUERY_LEXEME = /[^\p{L}\p{N}]+/gu;

type InternalHit = SearchHit & {
  readonly type: "priceList";
  readonly rank: number;
};

export type PricingSearchMatchesResult = {
  readonly groups: Array<{
    readonly type: "priceList";
    readonly hits: SearchHit[];
    readonly truncated: boolean;
  }>;
};

export function emptySearchMatchesResult(): PricingSearchMatchesResult {
  return { groups: [] };
}

export async function runPricingSearchMatches(args: {
  readonly db: StaffDb;
  readonly companyId: string;
  readonly prepared: PreparedTokens;
  readonly limitPerType: number;
}): Promise<PricingSearchMatchesResult> {
  const hits = sortHits(
    dedupSearchHits(
      (await fetchPriceListRows(args)).map((row) =>
        toPriceListHit(row, args.prepared),
      ),
    ),
  );
  const group = toDisplayGroup(hits, args.limitPerType);
  return { groups: group === undefined ? [] : [group] };
}

async function fetchPriceListRows(args: {
  readonly db: StaffDb;
  readonly companyId: string;
  readonly prepared: PreparedTokens;
  readonly limitPerType: number;
}): Promise<readonly PriceListSearchRow[]> {
  const nameMatch = nameMatchSql(
    priceLists.name,
    priceLists.nameFts,
    args.prepared.tokens,
  );
  if (nameMatch === undefined) {
    return [];
  }
  const scoped = and(eq(priceLists.companyId, args.companyId), nameMatch);
  if (scoped === undefined) {
    return [];
  }
  const rank = nameRankSql(
    priceLists.name,
    priceLists.nameFts,
    args.prepared.tokens,
  );
  const exact = exactNameSql(priceLists.name, args.prepared.queryNormalized);
  return args.db
    .select({
      id: priceLists.id,
      name: priceLists.name,
      isActive: priceLists.isActive,
      rank,
    })
    .from(priceLists)
    .where(scoped)
    .orderBy(
      sql`${exactBoostSql(exact)} DESC`,
      sql`${rank} DESC`,
      sql`${priceLists.id} ASC`,
    )
    .limit(args.limitPerType + 1);
}

type PriceListSearchRow = {
  readonly id: string;
  readonly name: string;
  readonly isActive: boolean;
  readonly rank: unknown;
};

/**
 * Each token is constrained (FTS word-prefix AND/OR per-token trgm).
 * Not `FTS_match OR fuzzy_match` over the whole string.
 */
function nameMatchSql(
  name: SQLWrapper,
  nameFts: SQLWrapper,
  tokens: readonly string[],
): SQL | undefined {
  const clauses: SQL[] = [];
  for (const token of tokens) {
    const clause = nameTokenSql(name, nameFts, token);
    if (clause === undefined) {
      return undefined;
    }
    clauses.push(clause);
  }
  return combineAnd(clauses);
}

function nameTokenSql(
  name: SQLWrapper,
  nameFts: SQLWrapper,
  token: string,
): SQL | undefined {
  const trgm = sql`word_similarity(${token}, ${name}) >= ${SEARCH_NAME_TRGM_THRESHOLD}`;
  const tsquery = prefixTsQuery(token);
  if (tsquery === undefined) {
    return trgm;
  }
  return or(sql`${nameFts} @@ to_tsquery('simple', ${tsquery})`, trgm) ?? trgm;
}

function nameRankSql(
  name: SQLWrapper,
  nameFts: SQLWrapper,
  tokens: readonly string[],
): SQL {
  const parts: SQL[] = [];
  const joined = tokens
    .map((token) => prefixTsQuery(token))
    .filter((token): token is string => token !== undefined)
    .join(" & ");
  if (joined.length > 0) {
    parts.push(sql`ts_rank(${nameFts}, to_tsquery('simple', ${joined}))`);
  }
  for (const token of tokens) {
    parts.push(sql`word_similarity(${token}, ${name})`);
  }
  return combineSum(parts) ?? sql`0`;
}

/** Mirrors `nameCandidate` exact: collapsed NFC name, apostrophe-fold, lower. */
function exactNameSql(name: SQLWrapper, queryNormalized: string): SQL {
  const foldedQuery = foldSearchNameToken(queryNormalized);
  const collapsed = sql`btrim(regexp_replace(normalize(${name}, NFC), '[[:space:]]+', ' ', 'g'))`;
  const foldedName = sql`replace(replace(lower(${collapsed}), ${"\u2019"}, ${SEARCH_APOSTROPHE_CANON}), ${"\u02BC"}, ${SEARCH_APOSTROPHE_CANON})`;
  return sql`${foldedName} = ${foldedQuery}`;
}

function exactBoostSql(exactMatch: SQL): SQL {
  return sql`(CASE WHEN ${exactMatch} THEN 1 ELSE 0 END)`;
}

function prefixTsQuery(token: string): string | undefined {
  const lexeme = token.replace(TSQUERY_LEXEME, "");
  return lexeme.length === 0 ? undefined : `${lexeme}:*`;
}

function toPriceListHit(
  row: PriceListSearchRow,
  prepared: PreparedTokens,
): InternalHit {
  const name = nameCandidate(row.name, prepared);
  return {
    type: "priceList",
    id: row.id,
    label: clip(row.name, SEARCH_LABEL_MAX),
    matchedOn: "name",
    exact: name.exact,
    rank: toRank(row.rank),
    ...statusFields(row.isActive ? "active" : "inactive"),
  };
}

function nameCandidate(
  name: string,
  prepared: PreparedTokens,
): { matchedOn: "name"; exact: boolean } {
  return {
    matchedOn: "name",
    exact:
      foldSearchNameToken(collapseSearchWhitespace(name)) ===
      foldSearchNameToken(prepared.queryNormalized),
  };
}

function statusFields(status: string): { status?: string } {
  const clipped = optionalClip(status, SEARCH_STATUS_MAX);
  return clipped === undefined ? {} : { status: clipped };
}

function toDisplayGroup(
  hits: readonly InternalHit[],
  limit: number,
): { type: "priceList"; hits: SearchHit[]; truncated: boolean } | undefined {
  if (hits.length === 0) {
    return undefined;
  }
  const truncated = hits.length > limit;
  const page = truncated ? hits.slice(0, limit) : hits;
  return {
    type: "priceList",
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

function combineAnd(clauses: readonly SQL[]): SQL | undefined {
  let combined: SQL | undefined;
  for (const clause of clauses) {
    combined = combined === undefined ? clause : and(combined, clause);
  }
  return combined;
}

function combineSum(parts: readonly SQL[]): SQL | undefined {
  let combined: SQL | undefined;
  for (const part of parts) {
    combined = combined === undefined ? part : sql`${combined} + ${part}`;
  }
  return combined;
}
