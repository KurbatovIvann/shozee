/**
 * Staff catalog search matcher SQL (SHO-530 / SHO-526). Product hits
 * use FTS token-AND word-prefix (`simple`) + trgm 0.25 on `products.name`.
 * Variant hits apply the same per-token clauses to the **combo** of
 * parent product name + variant name (concatenated tsvector and text).
 * Searching each column in isolation is not enough; `sublabel` is
 * display-only and is never the match field.
 *
 * Variant `productId` is the typed parent column, not parsed from
 * `sublabel`. `sublabel` is the parent name truncated to 80. No SKU.
 * Archived rows return with `status`.
 *
 * SQL `ORDER BY` + `LIMIT n+1` must match `sortHits`: exact, then rank
 * desc, then id asc. Exact is this entity's own name, never a related
 * field (parent name does not make a variant exact).
 */
import type { ActionCtx } from "@showzy/core";
import { products, productVariants } from "@showzy/db/schema/catalog";
import {
  SEARCH_APOSTROPHE_CANON,
  SEARCH_CATALOG_TYPES,
  SEARCH_LABEL_MAX,
  SEARCH_STATUS_MAX,
  SEARCH_SUBLABEL_MAX,
  collapseSearchWhitespace,
  dedupSearchHits,
  foldSearchNameToken,
  type PreparedSearchQuery,
  type SearchCatalogType,
  type SearchHit,
  type SearchVariantHit,
} from "@showzy/validation/search";
import { and, eq, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";

type StaffDb = Extract<ActionCtx, { principal: "staff" }>["db"];
type PreparedTokens = Extract<PreparedSearchQuery, { empty: false }>;

const TSQUERY_LEXEME = /[^\p{L}\p{N}]+/gu;

type ProductInternalHit = SearchHit & {
  readonly type: "product";
  readonly rank: number;
};

type VariantInternalHit = SearchVariantHit & {
  readonly type: "variant";
  readonly rank: number;
};

type InternalHit = ProductInternalHit | VariantInternalHit;

export type CatalogSearchMatchesResult = {
  readonly groups: Array<
    | {
        readonly type: "product";
        readonly hits: SearchHit[];
        readonly truncated: boolean;
      }
    | {
        readonly type: "variant";
        readonly hits: SearchVariantHit[];
        readonly truncated: boolean;
      }
  >;
};

export function emptySearchMatchesResult(): CatalogSearchMatchesResult {
  return { groups: [] };
}

export async function runCatalogSearchMatches(args: {
  readonly db: StaffDb;
  readonly companyId: string;
  readonly prepared: PreparedTokens;
  readonly limitPerType: number;
  readonly types: readonly SearchCatalogType[] | undefined;
}): Promise<CatalogSearchMatchesResult> {
  const displayTypes = new Set(args.types ?? SEARCH_CATALOG_TYPES);
  const groups: CatalogSearchMatchesResult["groups"] = [];

  if (displayTypes.has("product")) {
    const productHits = sortHits(
      dedupSearchHits(
        (await fetchProductRows(args)).map((row) =>
          toProductHit(row, args.prepared),
        ),
      ),
    );
    const group = toProductGroup(productHits, args.limitPerType);
    if (group !== undefined) {
      groups.push(group);
    }
  }

  if (displayTypes.has("variant")) {
    const variantHits = sortHits(
      dedupSearchHits(
        (await fetchVariantRows(args)).map((row) =>
          toVariantHit(row, args.prepared),
        ),
      ),
    );
    const group = toVariantGroup(variantHits, args.limitPerType);
    if (group !== undefined) {
      groups.push(group);
    }
  }

  return { groups };
}

async function fetchProductRows(args: {
  readonly db: StaffDb;
  readonly companyId: string;
  readonly prepared: PreparedTokens;
  readonly limitPerType: number;
}): Promise<readonly ProductSearchRow[]> {
  const nameMatch = nameMatchSql(
    products.name,
    products.nameFts,
    args.prepared.tokens,
  );
  if (nameMatch === undefined) {
    return [];
  }
  const scoped = and(eq(products.companyId, args.companyId), nameMatch);
  if (scoped === undefined) {
    return [];
  }
  const rank = nameRankSql(
    products.name,
    products.nameFts,
    args.prepared.tokens,
  );
  const exact = exactNameSql(products.name, args.prepared.queryNormalized);
  return args.db
    .select({
      id: products.id,
      name: products.name,
      status: products.status,
      rank,
    })
    .from(products)
    .where(scoped)
    .orderBy(
      sql`${exactBoostSql(exact)} DESC`,
      sql`${rank} DESC`,
      sql`${products.id} ASC`,
    )
    .limit(args.limitPerType + 1);
}

async function fetchVariantRows(args: {
  readonly db: StaffDb;
  readonly companyId: string;
  readonly prepared: PreparedTokens;
  readonly limitPerType: number;
}): Promise<readonly VariantSearchRow[]> {
  const comboName = sql`(${products.name} || ' ' || ${productVariants.name})`;
  const comboFts = sql`(${products.nameFts} || ${productVariants.nameFts})`;
  const nameMatch = nameMatchSql(comboName, comboFts, args.prepared.tokens);
  if (nameMatch === undefined) {
    return [];
  }
  const scoped = and(eq(productVariants.companyId, args.companyId), nameMatch);
  if (scoped === undefined) {
    return [];
  }
  const rank = nameRankSql(comboName, comboFts, args.prepared.tokens);
  const exact = exactNameSql(
    productVariants.name,
    args.prepared.queryNormalized,
  );
  return args.db
    .select({
      id: productVariants.id,
      name: productVariants.name,
      productId: productVariants.productId,
      productName: products.name,
      status: productVariants.status,
      rank,
    })
    .from(productVariants)
    .innerJoin(
      products,
      and(
        eq(products.companyId, productVariants.companyId),
        eq(products.id, productVariants.productId),
      ),
    )
    .where(scoped)
    .orderBy(
      sql`${exactBoostSql(exact)} DESC`,
      sql`${rank} DESC`,
      sql`${productVariants.id} ASC`,
    )
    .limit(args.limitPerType + 1);
}

type ProductSearchRow = {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly rank: unknown;
};

type VariantSearchRow = {
  readonly id: string;
  readonly name: string;
  readonly productId: string;
  readonly productName: string;
  readonly status: string;
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
  const trgm = sql`${token} <% ${name}`;
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

function toProductHit(
  row: ProductSearchRow,
  prepared: PreparedTokens,
): ProductInternalHit {
  const name = nameCandidate(row.name, prepared);
  return {
    type: "product",
    id: row.id,
    label: clip(row.name, SEARCH_LABEL_MAX),
    matchedOn: "name",
    exact: name.exact,
    rank: toRank(row.rank),
    ...statusFields(row.status),
  };
}

function toVariantHit(
  row: VariantSearchRow,
  prepared: PreparedTokens,
): VariantInternalHit {
  const name = nameCandidate(row.name, prepared);
  const sublabel = optionalClip(row.productName, SEARCH_SUBLABEL_MAX);
  return {
    type: "variant",
    id: row.id,
    label: clip(row.name, SEARCH_LABEL_MAX),
    productId: row.productId,
    matchedOn: "name",
    exact: name.exact,
    rank: toRank(row.rank),
    ...statusFields(row.status),
    ...(sublabel === undefined ? {} : { sublabel }),
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

function toProductGroup(
  hits: readonly ProductInternalHit[],
  limit: number,
): { type: "product"; hits: SearchHit[]; truncated: boolean } | undefined {
  if (hits.length === 0) {
    return undefined;
  }
  const truncated = hits.length > limit;
  const page = truncated ? hits.slice(0, limit) : hits;
  return {
    type: "product",
    truncated,
    hits: page.map((hit) => toProductOutput(hit)),
  };
}

function toVariantGroup(
  hits: readonly VariantInternalHit[],
  limit: number,
):
  | { type: "variant"; hits: SearchVariantHit[]; truncated: boolean }
  | undefined {
  if (hits.length === 0) {
    return undefined;
  }
  const truncated = hits.length > limit;
  const page = truncated ? hits.slice(0, limit) : hits;
  return {
    type: "variant",
    truncated,
    hits: page.map((hit) => toVariantOutput(hit)),
  };
}

function toProductOutput(hit: ProductInternalHit): SearchHit {
  return {
    id: hit.id,
    label: hit.label,
    matchedOn: hit.matchedOn,
    exact: hit.exact,
    ...(hit.sublabel === undefined ? {} : { sublabel: hit.sublabel }),
    ...(hit.status === undefined ? {} : { status: hit.status }),
  };
}

function toVariantOutput(hit: VariantInternalHit): SearchVariantHit {
  return {
    id: hit.id,
    label: hit.label,
    matchedOn: hit.matchedOn,
    exact: hit.exact,
    productId: hit.productId,
    ...(hit.sublabel === undefined ? {} : { sublabel: hit.sublabel }),
    ...(hit.status === undefined ? {} : { status: hit.status }),
  };
}

function sortHits<T extends InternalHit>(hits: readonly T[]): T[] {
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
