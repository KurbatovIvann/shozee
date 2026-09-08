/**
 * Staff order search matcher SQL (SHO-531 / SHO-526). Match
 * `order_number` (equality or left-prefix, never FTS/trgm/contains),
 * optional `customerIds` (related — never exact), or token-AND ILIKE on
 * `customer_name_snapshot` (no tsvector). Sentinel `unlinked` is never
 * a snapshot hit. Prefix comes from the caller (`companies.get`).
 *
 * SQL `ORDER BY` + `LIMIT n+1` must match `sortHits`: exact, then rank
 * desc, then id asc. T3 Bugbot: the SQL window must match that sort.
 */
import type { ActionCtx } from "@showzy/core";
import { orders } from "@showzy/db/schema/orders";
import { likeContainsPattern } from "@showzy/validation/pagination";
import {
  SEARCH_APOSTROPHE_CANON,
  SEARCH_LABEL_MAX,
  SEARCH_STATUS_MAX,
  SEARCH_SUBLABEL_MAX,
  canonicalizeOrderNumberToken,
  collapseSearchWhitespace,
  dedupSearchHits,
  foldSearchNameToken,
  pickPreferredSearchHit,
  sanitizeLikeLiteral,
  type PreparedSearchQuery,
  type SearchHit,
  type SearchMatchedOn,
} from "@showzy/validation/search";
import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";

import { UNLINKED_CUSTOMER_NAME_SNAPSHOT } from "../actions/list.contract.js";

type StaffDb = Extract<ActionCtx, { principal: "staff" }>["db"];
type PreparedTokens = Extract<PreparedSearchQuery, { empty: false }>;

type InternalHit = SearchHit & {
  readonly type: "order";
  readonly rank: number;
};

export type OrdersSearchMatchesResult = {
  readonly groups: Array<{
    readonly type: "order";
    readonly hits: SearchHit[];
    readonly truncated: boolean;
  }>;
};

export function emptySearchMatchesResult(): OrdersSearchMatchesResult {
  return { groups: [] };
}

/** `LIKE 'canonical%'` — left-prefix only; never `%…%`. */
export function orderNumberLeftPrefixPattern(
  canonical: string,
): string | undefined {
  const literal = sanitizeLikeLiteral(canonical);
  if (literal === undefined) {
    return undefined;
  }
  return `${literal}%`;
}

export async function runOrdersSearchMatches(args: {
  readonly db: StaffDb;
  readonly companyId: string;
  readonly prefix: string;
  readonly query: string;
  readonly prepared: PreparedTokens;
  readonly limitPerType: number;
  readonly customerIds: readonly string[] | undefined;
}): Promise<OrdersSearchMatchesResult> {
  const hits = sortHits(
    dedupSearchHits(
      (await fetchOrderRows(args)).map((row) => toOrderHit(row, args)),
    ),
  );
  const group = toDisplayGroup(hits, args.limitPerType);
  return { groups: group === undefined ? [] : [group] };
}

async function fetchOrderRows(args: {
  readonly db: StaffDb;
  readonly companyId: string;
  readonly prefix: string;
  readonly query: string;
  readonly prepared: PreparedTokens;
  readonly limitPerType: number;
  readonly customerIds: readonly string[] | undefined;
}): Promise<readonly OrderSearchRow[]> {
  const numberToken = canonicalizeOrderNumberToken(args.query, args.prefix);
  const numberPattern =
    numberToken === undefined
      ? undefined
      : orderNumberLeftPrefixPattern(numberToken);
  const numberMatch =
    numberPattern === undefined
      ? undefined
      : sql`${orders.orderNumber} LIKE ${numberPattern}`;
  const numberExact =
    numberToken === undefined
      ? undefined
      : sql`${orders.orderNumber} = ${numberToken}`;
  const customerIds = uniqueIds(args.customerIds);
  const customerMatch =
    customerIds.length === 0
      ? undefined
      : sql`${inArray(orders.customerId, customerIds)}`;
  const snapshotMatch = snapshotMatchSql(args.prepared.tokens);
  const snapshotExact = snapshotExactSql(args.prepared.queryNormalized);
  const match = combineOr(
    definedSql([numberMatch, customerMatch, snapshotMatch]),
  );
  if (match === undefined) {
    return [];
  }
  const scoped = and(eq(orders.companyId, args.companyId), match);
  if (scoped === undefined) {
    return [];
  }
  const exact = exactBoostSql(numberExact, snapshotExact);
  const rank = rankSql({
    numberExact,
    numberMatch,
    snapshotExact,
    snapshotMatch,
    customerMatch,
  });
  return args.db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      customerId: orders.customerId,
      customerNameSnapshot: orders.customerNameSnapshot,
      status: orders.status,
      rank,
    })
    .from(orders)
    .where(scoped)
    .orderBy(sql`${exact} DESC`, sql`${rank} DESC`, sql`${orders.id} ASC`)
    .limit(args.limitPerType + 1);
}

type OrderSearchRow = {
  readonly id: string;
  readonly orderNumber: string;
  readonly customerId: string | null;
  readonly customerNameSnapshot: string;
  readonly status: string;
  readonly rank: unknown;
};

function snapshotMatchSql(tokens: readonly string[]): SQL | undefined {
  const clauses: SQL[] = [notUnlinkedSql()];
  for (const token of tokens) {
    const pattern = likeContainsPattern(token);
    if (pattern === undefined) {
      return undefined;
    }
    clauses.push(sql`${orders.customerNameSnapshot} ILIKE ${pattern}`);
  }
  return combineAnd(clauses);
}

function snapshotExactSql(queryNormalized: string): SQL {
  return sql`${foldedSnapshotSql()} = ${foldSearchNameToken(queryNormalized)} AND ${notUnlinkedSql()}`;
}

function foldedSnapshotSql(): SQL {
  const collapsed = sql`btrim(regexp_replace(normalize(${orders.customerNameSnapshot}, NFC), '[[:space:]]+', ' ', 'g'))`;
  return sql`replace(replace(lower(${collapsed}), ${"\u2019"}, ${SEARCH_APOSTROPHE_CANON}), ${"\u02BC"}, ${SEARCH_APOSTROPHE_CANON})`;
}

function notUnlinkedSql(): SQL {
  return sql`${orders.customerNameSnapshot} <> ${UNLINKED_CUSTOMER_NAME_SNAPSHOT}`;
}

function exactBoostSql(
  numberExact: SQL | undefined,
  snapshotExact: SQL | undefined,
): SQL {
  const exact = combineOr(definedSql([numberExact, snapshotExact]));
  if (exact === undefined) {
    return sql`0`;
  }
  return sql`(CASE WHEN ${exact} THEN 1 ELSE 0 END)`;
}

/**
 * Mirrors preferred-hit rank: exact wins, then T2 matchedOn order.
 * `customer` related matches stay at 0 so they never outrank a number
 * prefix in the SQL window.
 */
function rankSql(args: {
  readonly numberExact: SQL | undefined;
  readonly numberMatch: SQL | undefined;
  readonly snapshotExact: SQL | undefined;
  readonly snapshotMatch: SQL | undefined;
  readonly customerMatch: SQL | undefined;
}): SQL {
  return sql`(CASE
    WHEN ${args.numberExact ?? sql`FALSE`} THEN 3
    WHEN ${args.snapshotExact ?? sql`FALSE`} THEN 1
    WHEN ${args.numberMatch ?? sql`FALSE`} THEN 2
    WHEN ${args.customerMatch ?? sql`FALSE`} THEN 0
    WHEN ${args.snapshotMatch ?? sql`FALSE`} THEN 0.5
    ELSE 0
  END)`;
}

function toOrderHit(
  row: OrderSearchRow,
  args: {
    readonly prefix: string;
    readonly query: string;
    readonly prepared: PreparedTokens;
    readonly customerIds: readonly string[] | undefined;
  },
): InternalHit {
  const preferred = preferredHit([
    numberCandidate(row.orderNumber, args.query, args.prefix),
    customerCandidate(row.customerId, args.customerIds),
    snapshotCandidate(row.customerNameSnapshot, args.prepared),
  ]);
  return {
    type: "order",
    id: row.id,
    label: clip(row.orderNumber, SEARCH_LABEL_MAX),
    matchedOn: preferred.matchedOn,
    exact: preferred.exact,
    rank: hitRank(preferred),
    ...statusFields(row.status),
    ...sublabelFields(row.customerNameSnapshot),
  };
}

function numberCandidate(
  stored: string,
  query: string,
  prefix: string,
): { matchedOn: "number"; exact: boolean } | undefined {
  const canonical = canonicalizeOrderNumberToken(query, prefix);
  if (canonical === undefined || !stored.startsWith(canonical)) {
    return undefined;
  }
  return { matchedOn: "number", exact: stored === canonical };
}

function customerCandidate(
  customerId: string | null,
  customerIds: readonly string[] | undefined,
): { matchedOn: "customer"; exact: false } | undefined {
  if (customerId === null) {
    return undefined;
  }
  const ids = uniqueIds(customerIds);
  if (!ids.includes(customerId)) {
    return undefined;
  }
  return { matchedOn: "customer", exact: false };
}

function snapshotCandidate(
  snapshot: string,
  prepared: PreparedTokens,
): { matchedOn: "customerNameSnapshot"; exact: boolean } | undefined {
  if (snapshot === UNLINKED_CUSTOMER_NAME_SNAPSHOT) {
    return undefined;
  }
  const foldedSnapshot = foldSearchNameToken(
    collapseSearchWhitespace(snapshot),
  );
  const foldedQuery = foldSearchNameToken(prepared.queryNormalized);
  if (foldedSnapshot === foldedQuery) {
    return { matchedOn: "customerNameSnapshot", exact: true };
  }
  for (const token of prepared.tokens) {
    if (!foldedSnapshot.includes(token)) {
      return undefined;
    }
  }
  return { matchedOn: "customerNameSnapshot", exact: false };
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
    return { matchedOn: "number", exact: false };
  }
  return present.reduce(pickPreferredSearchHit, first);
}

function hitRank(preferred: {
  readonly matchedOn: SearchMatchedOn;
  readonly exact: boolean;
}): number {
  if (preferred.matchedOn === "number") {
    return preferred.exact ? 3 : 2;
  }
  if (preferred.matchedOn === "customerNameSnapshot") {
    return preferred.exact ? 1 : 0.5;
  }
  return 0;
}

function statusFields(status: string): { status?: string } {
  const clipped = optionalClip(status, SEARCH_STATUS_MAX);
  return clipped === undefined ? {} : { status: clipped };
}

function sublabelFields(snapshot: string): { sublabel?: string } {
  if (snapshot === UNLINKED_CUSTOMER_NAME_SNAPSHOT) {
    return {};
  }
  const sublabel = optionalClip(snapshot, SEARCH_SUBLABEL_MAX);
  return sublabel === undefined ? {} : { sublabel };
}

function toDisplayGroup(
  hits: readonly InternalHit[],
  limit: number,
): { type: "order"; hits: SearchHit[]; truncated: boolean } | undefined {
  if (hits.length === 0) {
    return undefined;
  }
  const truncated = hits.length > limit;
  const page = truncated ? hits.slice(0, limit) : hits;
  return {
    type: "order",
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

function uniqueIds(ids: readonly string[] | undefined): string[] {
  if (ids === undefined || ids.length === 0) {
    return [];
  }
  return [...new Set(ids)];
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
