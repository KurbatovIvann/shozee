import { stemNameToken } from "@showzy/validation/pagination";
import {
  SEARCH_APOSTROPHE_CANON,
  foldSearchNameToken,
} from "@showzy/validation/search";
import { and, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";

export const NAME_MATCH_FUZZY_TOKEN_MIN = 5;
export const NAME_MATCH_STRICT_BOOST = 16;

const LEXEME_BREAK = /[^\p{L}\p{N}]+/u;

export interface NameMatchColumns {
  readonly name: SQLWrapper;
  readonly nameFts: SQLWrapper;
}

export interface NameMatch {
  readonly strict: SQL | undefined;
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

function fuzzyTokenSql(
  columns: NameMatchColumns,
  token: string,
): SQL | undefined {
  return isFuzzyToken(token) ? sql`${token} <% ${columns.name}` : undefined;
}

function eitherTokenSql(
  columns: NameMatchColumns,
  token: string,
): SQL | undefined {
  const strict = strictTokenSql(columns, token);
  const fuzzy = fuzzyTokenSql(columns, token);
  if (strict === undefined || fuzzy === undefined) {
    return strict ?? fuzzy;
  }
  return or(strict, fuzzy);
}

export function nameMatch(
  columns: NameMatchColumns,
  tokens: readonly string[],
): NameMatch {
  const strict =
    tokens.length === 0
      ? undefined
      : allOf(tokens.map((token) => strictTokenSql(columns, token)));
  const strictOrFuzzy =
    tokens.length === 0
      ? undefined
      : allOf(tokens.map((token) => eitherTokenSql(columns, token)));

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
  return { strict, strictOrFuzzy, rank };
}

export function exactNameSql(name: SQLWrapper, queryNormalized: string): SQL {
  const foldedQuery = foldSearchNameToken(queryNormalized);
  const collapsed = sql`btrim(regexp_replace(normalize(${name}, NFC), '[[:space:]]+', ' ', 'g'))`;
  const foldedName = sql`replace(replace(lower(${collapsed}), ${"’"}, ${SEARCH_APOSTROPHE_CANON}), ${"ʼ"}, ${SEARCH_APOSTROPHE_CANON})`;
  return sql`${foldedName} = ${foldedQuery}`;
}
