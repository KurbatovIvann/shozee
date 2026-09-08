/**
 * Staff CRM search matcher SQL (SHO-529 / SHO-526). Sibling of
 * `customer-list-search` / `listMatchingIds` — this path is FTS token-AND
 * word-prefix (`simple`) + trgm 0.25 on name, and canonical identifier
 * match on phone / email / ЄДРПОУ (no FTS/trgm on those fields).
 *
 * `orderCustomerLookup` is a separate cap-20 customer-id list. Display
 * `limitPerType` must not shrink those ids.
 *
 * SQL `ORDER BY` + `LIMIT n+1` must match `sortHits`: exact, then rank
 * desc, then id asc. Identifier prefix match is not `exact`.
 */
import type { ActionCtx } from "@showzy/core";
import {
  companyCustomers,
  counterparties,
  customerGroups,
} from "@showzy/db/schema/customers";
import {
  ORDER_CUSTOMER_LOOKUP_MAX,
  SEARCH_APOSTROPHE_CANON,
  SEARCH_CUSTOMER_TYPES,
  SEARCH_LABEL_MAX,
  SEARCH_STATUS_MAX,
  SEARCH_SUBLABEL_MAX,
  canonicalizeEdrpou,
  canonicalizeEmail,
  canonicalizePhoneDigits,
  collapseSearchWhitespace,
  dedupSearchHits,
  foldSearchNameToken,
  pickPreferredSearchHit,
  sanitizeLikeLiteral,
  type PreparedSearchQuery,
  type SearchCustomerType,
  type SearchHit,
  type SearchMatchedOn,
} from "@showzy/validation/search";
import { and, eq, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";

type StaffDb = Extract<ActionCtx, { principal: "staff" }>["db"];
type PreparedTokens = Extract<PreparedSearchQuery, { empty: false }>;

/** v1 `word_similarity` threshold; SHO-526 names 0.25. */
export const SEARCH_NAME_TRGM_THRESHOLD = 0.25;

const TSQUERY_LEXEME = /[^\p{L}\p{N}]+/gu;

type InternalHit = SearchHit & {
  readonly type: SearchCustomerType;
  readonly rank: number;
};

export type CustomersSearchMatchesResult = {
  readonly groups: Array<{
    readonly type: SearchCustomerType;
    readonly hits: SearchHit[];
    readonly truncated: boolean;
  }>;
  readonly orderCustomerLookup: {
    readonly ids: string[];
    readonly truncated: boolean;
  };
};

export function emptySearchMatchesResult(): CustomersSearchMatchesResult {
  return {
    groups: [],
    orderCustomerLookup: { ids: [], truncated: false },
  };
}

export async function runCustomersSearchMatches(args: {
  readonly db: StaffDb;
  readonly companyId: string;
  readonly prepared: PreparedTokens;
  readonly limitPerType: number;
  readonly types: readonly SearchCustomerType[] | undefined;
}): Promise<CustomersSearchMatchesResult> {
  const displayTypes = new Set(args.types ?? SEARCH_CUSTOMER_TYPES);
  const customerRows = await fetchCustomerRows(args);
  const customerHits = sortHits(
    dedupSearchHits(
      customerRows.map((row) => toCustomerHit(row, args.prepared)),
    ),
  );

  const lookupTruncated = customerHits.length > ORDER_CUSTOMER_LOOKUP_MAX;
  const orderCustomerLookup = {
    ids: customerHits.slice(0, ORDER_CUSTOMER_LOOKUP_MAX).map((hit) => hit.id),
    truncated: lookupTruncated,
  };

  const groups: CustomersSearchMatchesResult["groups"] = [];
  const customerGroup = toDisplayGroup(
    "customer",
    customerHits,
    args.limitPerType,
  );
  if (displayTypes.has("customer") && customerGroup !== undefined) {
    groups.push(customerGroup);
  }

  if (displayTypes.has("customerGroup")) {
    const groupHits = sortHits(
      dedupSearchHits(
        (await fetchGroupRows(args)).map((row) =>
          toNameHit("customerGroup", row, args.prepared),
        ),
      ),
    );
    const group = toDisplayGroup("customerGroup", groupHits, args.limitPerType);
    if (group !== undefined) {
      groups.push(group);
    }
  }

  if (displayTypes.has("counterparty")) {
    const partyHits = sortHits(
      dedupSearchHits(
        (await fetchCounterpartyRows(args)).map((row) =>
          toCounterpartyHit(row, args.prepared),
        ),
      ),
    );
    const group = toDisplayGroup("counterparty", partyHits, args.limitPerType);
    if (group !== undefined) {
      groups.push(group);
    }
  }

  return { groups, orderCustomerLookup };
}

async function fetchCustomerRows(args: {
  readonly db: StaffDb;
  readonly companyId: string;
  readonly prepared: PreparedTokens;
}): Promise<readonly CustomerSearchRow[]> {
  const nameMatch = nameMatchSql(
    companyCustomers.name,
    companyCustomers.nameFts,
    args.prepared.tokens,
  );
  const phoneMatch = phoneMatchSql(
    companyCustomers.phone,
    args.prepared.queryNormalized,
  );
  const emailMatch = emailMatchSql(
    companyCustomers.email,
    args.prepared.queryNormalized,
    args.prepared.tokens,
  );
  const match = combineOr(definedSql([nameMatch, phoneMatch, emailMatch]));
  if (match === undefined) {
    return [];
  }
  const scoped = and(eq(companyCustomers.companyId, args.companyId), match);
  if (scoped === undefined) {
    return [];
  }
  const rank = nameRankSql(
    companyCustomers.name,
    companyCustomers.nameFts,
    args.prepared.tokens,
  );
  const exact = combineOr(
    definedSql([
      exactPhoneSql(companyCustomers.phone, args.prepared.queryNormalized),
      emailMatch,
      exactNameSql(companyCustomers.name, args.prepared.queryNormalized),
    ]),
  );
  const rows = await args.db
    .select({
      id: companyCustomers.id,
      name: companyCustomers.name,
      phone: companyCustomers.phone,
      email: companyCustomers.email,
      status: companyCustomers.status,
      rank,
    })
    .from(companyCustomers)
    .where(scoped)
    .orderBy(
      sql`${exactBoostSql(exact)} DESC`,
      sql`${rank} DESC`,
      sql`${companyCustomers.id} ASC`,
    )
    .limit(ORDER_CUSTOMER_LOOKUP_MAX + 1);
  return rows;
}

async function fetchGroupRows(args: {
  readonly db: StaffDb;
  readonly companyId: string;
  readonly prepared: PreparedTokens;
  readonly limitPerType: number;
}): Promise<readonly NameSearchRow[]> {
  const nameMatch = nameMatchSql(
    customerGroups.name,
    customerGroups.nameFts,
    args.prepared.tokens,
  );
  if (nameMatch === undefined) {
    return [];
  }
  const scoped = and(eq(customerGroups.companyId, args.companyId), nameMatch);
  if (scoped === undefined) {
    return [];
  }
  const rank = nameRankSql(
    customerGroups.name,
    customerGroups.nameFts,
    args.prepared.tokens,
  );
  const exact = exactNameSql(
    customerGroups.name,
    args.prepared.queryNormalized,
  );
  return args.db
    .select({
      id: customerGroups.id,
      name: customerGroups.name,
      rank,
    })
    .from(customerGroups)
    .where(scoped)
    .orderBy(
      sql`${exactBoostSql(exact)} DESC`,
      sql`${rank} DESC`,
      sql`${customerGroups.id} ASC`,
    )
    .limit(args.limitPerType + 1);
}

async function fetchCounterpartyRows(args: {
  readonly db: StaffDb;
  readonly companyId: string;
  readonly prepared: PreparedTokens;
  readonly limitPerType: number;
}): Promise<readonly CounterpartySearchRow[]> {
  const nameMatch = nameMatchSql(
    counterparties.name,
    counterparties.nameFts,
    args.prepared.tokens,
  );
  const phoneMatch = phoneMatchSql(
    counterparties.phone,
    args.prepared.queryNormalized,
  );
  const emailMatch = emailMatchSql(
    counterparties.email,
    args.prepared.queryNormalized,
    args.prepared.tokens,
  );
  const edrpouMatch = edrpouMatchSql(
    counterparties.edrpou,
    args.prepared.queryNormalized,
    args.prepared.tokens,
  );
  const match = combineOr(
    definedSql([nameMatch, phoneMatch, emailMatch, edrpouMatch]),
  );
  if (match === undefined) {
    return [];
  }
  const scoped = and(eq(counterparties.companyId, args.companyId), match);
  if (scoped === undefined) {
    return [];
  }
  const rank = nameRankSql(
    counterparties.name,
    counterparties.nameFts,
    args.prepared.tokens,
  );
  const exact = combineOr(
    definedSql([
      exactPhoneSql(counterparties.phone, args.prepared.queryNormalized),
      emailMatch,
      edrpouMatch,
      exactNameSql(counterparties.name, args.prepared.queryNormalized),
    ]),
  );
  return args.db
    .select({
      id: counterparties.id,
      name: counterparties.name,
      phone: counterparties.phone,
      email: counterparties.email,
      edrpou: counterparties.edrpou,
      rank,
    })
    .from(counterparties)
    .where(scoped)
    .orderBy(
      sql`${exactBoostSql(exact)} DESC`,
      sql`${rank} DESC`,
      sql`${counterparties.id} ASC`,
    )
    .limit(args.limitPerType + 1);
}

type CustomerSearchRow = {
  readonly id: string;
  readonly name: string;
  readonly phone: string | null;
  readonly email: string | null;
  readonly status: string;
  readonly rank: unknown;
};

type NameSearchRow = {
  readonly id: string;
  readonly name: string;
  readonly rank: unknown;
};

type CounterpartySearchRow = NameSearchRow & {
  readonly phone: string | null;
  readonly email: string | null;
  readonly edrpou: string | null;
};

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

function phoneMatchSql(
  phone: SQLWrapper,
  queryNormalized: string,
): SQL | undefined {
  const canonical = canonicalizePhoneDigits(queryNormalized);
  if (canonical === undefined) {
    return undefined;
  }
  const literal = sanitizeLikeLiteral(canonical);
  if (literal === undefined) {
    return undefined;
  }
  return sql`${canonicalPhoneSql(phone)} ILIKE ${`${literal}%`}`;
}

function emailMatchSql(
  email: SQLWrapper,
  queryNormalized: string,
  tokens: readonly string[],
): SQL | undefined {
  const candidates = new Set<string>();
  const full = canonicalizeEmail(queryNormalized);
  if (full !== undefined) {
    candidates.add(full);
  }
  for (const token of tokens) {
    if (!token.includes("@")) {
      continue;
    }
    const canonical = canonicalizeEmail(token);
    if (canonical !== undefined) {
      candidates.add(canonical);
    }
  }
  const clauses: SQL[] = [];
  for (const canonical of candidates) {
    clauses.push(sql`lower(${email}) = ${canonical}`);
  }
  return combineOr(clauses);
}

function edrpouMatchSql(
  edrpou: SQLWrapper,
  queryNormalized: string,
  tokens: readonly string[],
): SQL | undefined {
  const candidates = new Set<string>();
  const full = canonicalizeEdrpou(queryNormalized);
  if (full !== undefined) {
    candidates.add(full);
  }
  for (const token of tokens) {
    const canonical = canonicalizeEdrpou(token);
    if (canonical !== undefined) {
      candidates.add(canonical);
    }
  }
  const clauses: SQL[] = [];
  for (const canonical of candidates) {
    clauses.push(
      sql`regexp_replace(coalesce(${edrpou}, ''), '[^0-9]', '', 'g') = ${canonical}`,
    );
  }
  return combineOr(clauses);
}

function canonicalPhoneSql(phone: SQLWrapper): SQL {
  const digits = sql`regexp_replace(coalesce(${phone}, ''), '[^0-9]', '', 'g')`;
  return sql`(CASE WHEN ${digits} LIKE '0%' THEN '380' || substr(${digits}, 2) ELSE ${digits} END)`;
}

function exactPhoneSql(
  phone: SQLWrapper,
  queryNormalized: string,
): SQL | undefined {
  const canonical = canonicalizePhoneDigits(queryNormalized);
  if (canonical === undefined) {
    return undefined;
  }
  return sql`${canonicalPhoneSql(phone)} = ${canonical}`;
}

/** Mirrors `nameCandidate` exact: collapsed NFC name, apostrophe-fold, lower. */
function exactNameSql(name: SQLWrapper, queryNormalized: string): SQL {
  const foldedQuery = foldSearchNameToken(queryNormalized);
  const collapsed = sql`btrim(regexp_replace(normalize(${name}, NFC), '[[:space:]]+', ' ', 'g'))`;
  const foldedName = sql`replace(replace(lower(${collapsed}), ${"\u2019"}, ${SEARCH_APOSTROPHE_CANON}), ${"\u02BC"}, ${SEARCH_APOSTROPHE_CANON})`;
  return sql`${foldedName} = ${foldedQuery}`;
}

function exactBoostSql(exactMatch: SQL | undefined): SQL {
  if (exactMatch === undefined) {
    return sql`0`;
  }
  return sql`(CASE WHEN ${exactMatch} THEN 1 ELSE 0 END)`;
}

function prefixTsQuery(token: string): string | undefined {
  const lexeme = token.replace(TSQUERY_LEXEME, "");
  return lexeme.length === 0 ? undefined : `${lexeme}:*`;
}

function toCustomerHit(
  row: CustomerSearchRow,
  prepared: PreparedTokens,
): InternalHit {
  const base = {
    type: "customer" as const,
    id: row.id,
    label: clip(row.name, SEARCH_LABEL_MAX),
    status: optionalClip(row.status, SEARCH_STATUS_MAX),
    rank: toRank(row.rank),
  };
  const preferred = preferredHit([
    phoneCandidate(row.phone, prepared.queryNormalized),
    emailCandidate(row.email, prepared.queryNormalized, prepared.tokens),
    nameCandidate(row.name, prepared),
  ]);
  return {
    ...base,
    matchedOn: preferred.matchedOn,
    exact: preferred.exact,
    ...sublabelFields(preferred.matchedOn, row.phone, row.email, undefined),
  };
}

function toCounterpartyHit(
  row: CounterpartySearchRow,
  prepared: PreparedTokens,
): InternalHit {
  const preferred = preferredHit([
    phoneCandidate(row.phone, prepared.queryNormalized),
    emailCandidate(row.email, prepared.queryNormalized, prepared.tokens),
    edrpouCandidate(row.edrpou, prepared.queryNormalized, prepared.tokens),
    nameCandidate(row.name, prepared),
  ]);
  return {
    type: "counterparty",
    id: row.id,
    label: clip(row.name, SEARCH_LABEL_MAX),
    matchedOn: preferred.matchedOn,
    exact: preferred.exact,
    rank: toRank(row.rank),
    ...sublabelFields(preferred.matchedOn, row.phone, row.email, row.edrpou),
  };
}

function toNameHit(
  type: "customerGroup",
  row: NameSearchRow,
  prepared: PreparedTokens,
): InternalHit {
  const name = nameCandidate(row.name, prepared);
  return {
    type,
    id: row.id,
    label: clip(row.name, SEARCH_LABEL_MAX),
    matchedOn: "name",
    exact: name.exact,
    rank: toRank(row.rank),
  };
}

function phoneCandidate(
  stored: string | null,
  queryNormalized: string,
): { matchedOn: "phone"; exact: boolean } | undefined {
  const queryCanonical = canonicalizePhoneDigits(queryNormalized);
  const storedCanonical =
    stored === null ? undefined : canonicalizePhoneDigits(stored);
  if (
    queryCanonical === undefined ||
    storedCanonical === undefined ||
    !storedCanonical.startsWith(queryCanonical)
  ) {
    return undefined;
  }
  return { matchedOn: "phone", exact: storedCanonical === queryCanonical };
}

function emailCandidate(
  stored: string | null,
  queryNormalized: string,
  tokens: readonly string[],
): { matchedOn: "email"; exact: true } | undefined {
  if (stored === null) {
    return undefined;
  }
  const storedCanonical = canonicalizeEmail(stored);
  if (storedCanonical === undefined) {
    return undefined;
  }
  const full = canonicalizeEmail(queryNormalized);
  if (full === storedCanonical) {
    return { matchedOn: "email", exact: true };
  }
  for (const token of tokens) {
    if (canonicalizeEmail(token) === storedCanonical) {
      return { matchedOn: "email", exact: true };
    }
  }
  return undefined;
}

function edrpouCandidate(
  stored: string | null,
  queryNormalized: string,
  tokens: readonly string[],
): { matchedOn: "edrpou"; exact: true } | undefined {
  if (stored === null) {
    return undefined;
  }
  const storedCanonical = canonicalizeEdrpou(stored);
  if (storedCanonical === undefined) {
    return undefined;
  }
  if (canonicalizeEdrpou(queryNormalized) === storedCanonical) {
    return { matchedOn: "edrpou", exact: true };
  }
  for (const token of tokens) {
    if (canonicalizeEdrpou(token) === storedCanonical) {
      return { matchedOn: "edrpou", exact: true };
    }
  }
  return undefined;
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

function preferredHit(
  candidates: ReadonlyArray<
    { matchedOn: SearchMatchedOn; exact: boolean } | undefined
  >,
): { matchedOn: SearchMatchedOn; exact: boolean } {
  const present = candidates.filter(
    (candidate): candidate is { matchedOn: SearchMatchedOn; exact: boolean } =>
      candidate !== undefined,
  );
  const first = present[0];
  if (first === undefined) {
    return { matchedOn: "name", exact: false };
  }
  return present.reduce(pickPreferredSearchHit, first);
}

function sublabelFields(
  matchedOn: SearchMatchedOn,
  phone: string | null,
  email: string | null,
  edrpou: string | null | undefined,
): { sublabel?: string } {
  const preferred =
    matchedOn === "phone"
      ? phone
      : matchedOn === "email"
        ? email
        : matchedOn === "edrpou"
          ? (edrpou ?? null)
          : (phone ?? email ?? edrpou ?? null);
  const fallback = phone ?? email ?? edrpou ?? null;
  const sublabel = optionalClip(preferred ?? fallback, SEARCH_SUBLABEL_MAX);
  return sublabel === undefined ? {} : { sublabel };
}

function toDisplayGroup<T extends SearchCustomerType>(
  type: T,
  hits: readonly InternalHit[],
  limit: number,
): { type: T; hits: SearchHit[]; truncated: boolean } | undefined {
  if (hits.length === 0) {
    return undefined;
  }
  const truncated = hits.length > limit;
  const page = truncated ? hits.slice(0, limit) : hits;
  return {
    type,
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

function definedSql(clauses: ReadonlyArray<SQL | undefined>): SQL[] {
  const present: SQL[] = [];
  for (const clause of clauses) {
    if (clause !== undefined) {
      present.push(clause);
    }
  }
  return present;
}

function combineAnd(clauses: readonly SQL[]): SQL | undefined {
  let combined: SQL | undefined;
  for (const clause of clauses) {
    combined = combined === undefined ? clause : and(combined, clause);
  }
  return combined;
}

function combineOr(clauses: readonly SQL[]): SQL | undefined {
  let combined: SQL | undefined;
  for (const clause of clauses) {
    combined = combined === undefined ? clause : or(combined, clause);
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
