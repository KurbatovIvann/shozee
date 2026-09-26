import { stemNameToken } from "@showzy/validation/pagination";
import {
  SEARCH_APOSTROPHE_CANON,
  foldSearchNameToken,
  prepareSearchQuery,
} from "@showzy/validation/search";
import { and, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";

export const NAME_MATCH_FUZZY_TOKEN_MIN = 5;
export const NAME_MATCH_SUBSTRING_TOKEN_MIN = 3;
export const NAME_MATCH_TYPO_SIMILARITY_MIN = 0.5;
export const NAME_MATCH_STRICT_BOOST = 16;

const LEXEME_BREAK = /[^\p{L}\p{N}]+/u;

export interface NameMatchColumns {
  readonly name: SQLWrapper;
  readonly nameFts: SQLWrapper;
}

export interface NameMatch {
  readonly strict: SQL | undefined;
  readonly strictOrSubstring: SQL | undefined;
  readonly strictOrFuzzy: SQL | undefined;
  readonly rank: SQL;
}

export function strictTsQuery(token: string): string | undefined {
  const parts = stemNameToken(token)
    .split(LEXEME_BREAK)
    .filter((part) => part.length > 0);
  const last = parts.pop();
  if (last === undefined) {
    return undefined;
  }
  return [...parts, `${last}:*`].join(" <-> ");
}

export function isFuzzyToken(token: string): boolean {
  return Array.from(token).length >= NAME_MATCH_FUZZY_TOKEN_MIN;
}

export function isSubstringToken(token: string): boolean {
  return Array.from(token).length >= NAME_MATCH_SUBSTRING_TOKEN_MIN;
}

function allOf(clauses: ReadonlyArray<SQL | undefined>): SQL | undefined {
  let combined: SQL | undefined;
  for (const clause of clauses) {
    if (clause === undefined) {
      return undefined;
    }
    combined = combined === undefined ? clause : and(combined, clause);
  }
  return combined;
}

function strictTokenSql(
  columns: NameMatchColumns,
  token: string,
): SQL | undefined {
  const tsquery = strictTsQuery(token);
  return tsquery === undefined
    ? undefined
    : sql`${columns.nameFts} @@ to_tsquery('simple', ${tsquery})`;
}

function substringTokenSql(
  columns: NameMatchColumns,
  token: string,
): SQL | undefined {
  return isSubstringToken(token)
    ? sql`${columns.name} ILIKE ${`%${token}%`}`
    : undefined;
}

function typoTokenSql(
  columns: NameMatchColumns,
  token: string,
): SQL | undefined {
  return isFuzzyToken(token)
    ? sql`(${token} <% ${columns.name} AND word_similarity(${token}, ${columns.name}) >= ${NAME_MATCH_TYPO_SIMILARITY_MIN})`
    : undefined;
}

function anyOf(clauses: ReadonlyArray<SQL | undefined>): SQL | undefined {
  let combined: SQL | undefined;
  for (const clause of clauses) {
    if (clause !== undefined) {
      combined = combined === undefined ? clause : or(combined, clause);
    }
  }
  return combined;
}

export function nameMatch(
  columns: NameMatchColumns,
  tokens: readonly string[],
): NameMatch {
  const strict =
    tokens.length === 0
      ? undefined
      : allOf(tokens.map((token) => strictTokenSql(columns, token)));
  const strictOrSubstring =
    tokens.length === 0
      ? undefined
      : allOf(
          tokens.map((token) =>
            anyOf([
              strictTokenSql(columns, token),
              substringTokenSql(columns, token),
            ]),
          ),
        );
  const strictOrFuzzy =
    tokens.length === 0
      ? undefined
      : allOf(
          tokens.map((token) =>
            anyOf([
              strictTokenSql(columns, token),
              substringTokenSql(columns, token),
              typoTokenSql(columns, token),
            ]),
          ),
        );

  let rank =
    strict === undefined
      ? sql`0`
      : sql`(CASE WHEN ${strict} THEN ${NAME_MATCH_STRICT_BOOST} ELSE 0 END)`;
  const joined = tokens
    .map((token) => strictTsQuery(token))
    .filter((tsquery): tsquery is string => tsquery !== undefined)
    .map((tsquery) => `(${tsquery})`)
    .join(" & ");
  if (joined.length > 0) {
    rank = sql`${rank} + ts_rank(${columns.nameFts}, to_tsquery('simple', ${joined}))`;
  }
  for (const token of tokens) {
    rank = sql`${rank} + word_similarity(${token}, ${columns.name})`;
  }
  return { strict, strictOrSubstring, strictOrFuzzy, rank };
}

export function exactNameSql(name: SQLWrapper, queryNormalized: string): SQL {
  const foldedQuery = foldSearchNameToken(queryNormalized);
  const collapsed = sql`btrim(regexp_replace(normalize(${name}, NFC), '[[:space:]]+', ' ', 'g'))`;
  const foldedName = sql`replace(replace(lower(${collapsed}), ${"’"}, ${SEARCH_APOSTROPHE_CANON}), ${"ʼ"}, ${SEARCH_APOSTROPHE_CANON})`;
  return sql`${foldedName} = ${foldedQuery}`;
}

export interface ListNameSearch {
  readonly strict: SQL;
  readonly relaxed: SQL;
  readonly canRelax: boolean;
}

function tieredNameSearch(
  columns: NameMatchColumns,
  query: string,
  firstTier: "strict" | "strictOrSubstring",
  alsoMatches?: (queryNormalized: string) => SQL | undefined,
): ListNameSearch | undefined {
  const prepared = prepareSearchQuery(query);
  if (prepared.empty) {
    return undefined;
  }
  const match = nameMatch(columns, prepared.tokens);
  const first = match[firstTier];
  if (first === undefined || match.strictOrFuzzy === undefined) {
    return undefined;
  }
  const also = alsoMatches?.(prepared.queryNormalized);
  return {
    strict: also === undefined ? first : sql`(${first} OR ${also})`,
    relaxed:
      also === undefined
        ? match.strictOrFuzzy
        : sql`(${match.strictOrFuzzy} OR ${also})`,
    canRelax: prepared.tokens.some((token) =>
      firstTier === "strict" ? isSubstringToken(token) : isFuzzyToken(token),
    ),
  };
}

export function listNameSearch(
  columns: NameMatchColumns,
  query: string,
  alsoMatches?: (queryNormalized: string) => SQL | undefined,
): ListNameSearch | undefined {
  return tieredNameSearch(columns, query, "strict", alsoMatches);
}

export function referenceNameSearch(
  columns: NameMatchColumns,
  query: string,
  alsoMatches?: (queryNormalized: string) => SQL | undefined,
): ListNameSearch | undefined {
  return tieredNameSearch(columns, query, "strictOrSubstring", alsoMatches);
}

export async function pickListNameSearch(
  search: ListNameSearch,
  hasStrictRow: (strict: SQL) => Promise<boolean>,
): Promise<SQL> {
  if (!search.canRelax || (await hasStrictRow(search.strict))) {
    return search.strict;
  }
  return search.relaxed;
}
