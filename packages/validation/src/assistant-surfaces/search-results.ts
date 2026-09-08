/**
 * Unlocalized search-results surface parse (SHO-535 / SHO-526 T9).
 * Binds `search_query` / `search.query` T8 output
 * `{ groups, searchedTypes, queryNormalized }`. Grouped hits, not a
 * column-swapped list. Do not import `@showzy/ai` or `../search`.
 *
 * Empty groups and `truncated` are kept — the card chrome must show
 * them. Variant hits require typed `productId`; do not recover it from
 * `sublabel`.
 *
 * Hit / query caps are literal copies of SEARCH_LIMIT_PER_TYPE_MAX (10)
 * and GLOBAL_HIT_CAP (40). This zod-only leaf must not depend on the
 * search schema subpath. packages/ai owns the clip-budget guard.
 */
import {
  resolveAssistantSurfaceDestination,
  type AssistantSurfaceDestination,
  type AssistantSurfaceDestinationDeclaration,
} from "./destination.js";
import {
  isRecord,
  lastSuccessfulResult,
  unwrapToolOutput,
  type AssistantSurfaceToolResult,
} from "./helpers.js";

/** Literal copy of SEARCH_LIMIT_PER_TYPE_MAX (SHO-527). */
export const ASSISTANT_SEARCH_RESULTS_GROUP_HIT_MAX = 10;

/** Literal copy of GLOBAL_HIT_CAP (SHO-527). */
export const ASSISTANT_SEARCH_RESULTS_HIT_MAX = 40;

export const SEARCH_QUERY_TOOL = "search_query";

export const SEARCH_RESULTS_SURFACE_TOOLS = [
  SEARCH_QUERY_TOOL,
  "search.query",
] as const;

export const SEARCH_QUERY_ACTION_NAME = "search.query";

export const SEARCH_RESULTS_PROMPT_LINE =
  "After search_query, the UI already shows the search-results card (grouped hits, including empty groups and truncated). Reply with a short product-language summary. Do not dump a markdown table of the hits. Archived status is not writable without restore. exact means a full match of this entity's own field, not uniqueness. Related orders use matchedOn customer or customerNameSnapshot. Simple find-by-name-or-id is one search_query. Filters, full lists, and details use domain tools (orders.list, orders.get, and the other module tools).";

export const SEARCH_RESULTS_DESTINATION = {
  kind: "terminal",
} as const satisfies AssistantSurfaceDestinationDeclaration;

export const SEARCH_RESULTS_ENTITY_TYPES = [
  "order",
  "customer",
  "customerGroup",
  "counterparty",
  "product",
  "variant",
  "priceList",
  "document",
] as const;

export type AssistantSearchEntityType =
  (typeof SEARCH_RESULTS_ENTITY_TYPES)[number];

const ENTITY_TYPE_SET = new Set<string>(SEARCH_RESULTS_ENTITY_TYPES);

export type AssistantSearchHitData = {
  readonly id: string;
  readonly label: string;
  readonly sublabel: string | null;
  readonly status: string | null;
  readonly matchedOn: string | null;
  readonly exact: boolean;
  readonly productId: string | null;
};

export type AssistantSearchGroupData = {
  readonly entityType: AssistantSearchEntityType;
  readonly truncated: boolean;
  readonly hits: readonly AssistantSearchHitData[];
};

export type AssistantSearchResultsData = {
  readonly kind: "search-results";
  readonly destination: AssistantSurfaceDestination;
  readonly queryNormalized: string;
  readonly searchedTypes: readonly AssistantSearchEntityType[];
  readonly groups: readonly AssistantSearchGroupData[];
  readonly clipped: boolean;
  readonly truncated: boolean;
};

function isSearchEntityType(
  value: unknown,
): value is AssistantSearchEntityType {
  return typeof value === "string" && ENTITY_TYPE_SET.has(value);
}

function optionalText(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  return value;
}

function parseSearchHit(
  type: AssistantSearchEntityType,
  row: unknown,
): AssistantSearchHitData | null {
  if (!isRecord(row)) {
    return null;
  }
  const id = row["id"];
  if (typeof id !== "string" || id.length === 0) {
    return null;
  }
  const label = typeof row["label"] === "string" ? row["label"] : "";
  const productId = optionalText(row["productId"]);
  if (type === "variant" && productId === null) {
    return null;
  }
  return {
    id,
    label,
    sublabel: optionalText(row["sublabel"]),
    status: optionalText(row["status"]),
    matchedOn: optionalText(row["matchedOn"]),
    exact: row["exact"] === true,
    productId: type === "variant" ? productId : null,
  };
}

function parseSearchGroup(value: unknown): AssistantSearchGroupData | null {
  if (!isRecord(value)) {
    return null;
  }
  const type = value["type"];
  if (!isSearchEntityType(type)) {
    return null;
  }
  const hitsRaw = value["hits"];
  const hits: AssistantSearchHitData[] = [];
  if (Array.isArray(hitsRaw)) {
    for (const row of hitsRaw) {
      const parsed = parseSearchHit(type, row);
      if (parsed !== null) {
        hits.push(parsed);
      }
    }
  }
  const truncated =
    value["truncated"] === true ||
    hits.length > ASSISTANT_SEARCH_RESULTS_GROUP_HIT_MAX;
  return {
    entityType: type,
    truncated,
    hits: hits.slice(0, ASSISTANT_SEARCH_RESULTS_GROUP_HIT_MAX),
  };
}

function parseSearchedTypes(
  value: unknown,
): readonly AssistantSearchEntityType[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const types: AssistantSearchEntityType[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isSearchEntityType(entry) || seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    types.push(entry);
  }
  return types;
}

function isSearchQueryTool(name: string): boolean {
  return name === SEARCH_QUERY_TOOL || name === SEARCH_QUERY_ACTION_NAME;
}

/**
 * One search-results surface when a live `search_query` result is
 * present. Empty groups stay in `groups`. Returns null when there is no
 * successful search tool result.
 */
export function parseSearchResultsSurface(
  results: readonly AssistantSurfaceToolResult[],
): AssistantSearchResultsData | null {
  const searchResult = lastSuccessfulResult(results, isSearchQueryTool);
  if (searchResult === null) {
    return null;
  }
  const { payload, clipped } = unwrapToolOutput(searchResult.output);
  const groups: AssistantSearchGroupData[] = [];
  if (isRecord(payload) && Array.isArray(payload["groups"])) {
    for (const group of payload["groups"]) {
      const parsed = parseSearchGroup(group);
      if (parsed !== null) {
        groups.push(parsed);
      }
    }
  }
  const queryNormalized =
    isRecord(payload) && typeof payload["queryNormalized"] === "string"
      ? payload["queryNormalized"]
      : "";
  const searchedTypes = isRecord(payload)
    ? parseSearchedTypes(payload["searchedTypes"])
    : [];
  const truncated = groups.some((group) => group.truncated);
  return {
    kind: "search-results",
    destination: resolveAssistantSurfaceDestination(
      SEARCH_RESULTS_DESTINATION,
      "",
    ),
    queryNormalized,
    searchedTypes,
    groups,
    clipped,
    truncated,
  };
}
