/**
 * Staff `search.query` orchestrator (SHO-534 / SHO-526 T8). Pure `ctx.call`
 * fan-out: no tables, no projections, no read-model grants. Numbering
 * prefix is resolved inside matchers. Matcher errors propagate.
 */
import { searchMatches as catalogSearchMatches } from "@showzy/catalog";
import {
  staffHasPermission,
  type CtxCall,
  type StaffMembership,
} from "@showzy/core";
import { searchMatches as customersSearchMatches } from "@showzy/customers";
import { searchMatches as documentsSearchMatches } from "@showzy/documents";
import { searchMatches as ordersSearchMatches } from "@showzy/orders";
import { searchMatches as pricingSearchMatches } from "@showzy/pricing";
import {
  GLOBAL_HIT_CAP,
  prepareSearchQuery,
  SEARCH_CATALOG_TYPES,
  SEARCH_CUSTOMER_TYPES,
  SEARCH_ENTITY_TYPES,
  type SearchCustomerType,
  type SearchEntityType,
  type SearchGroup,
  type SearchQueryInput,
  type SearchQueryOutput,
} from "@showzy/validation/search";

const SEARCH_TYPE_PERMISSION = {
  order: "orders:view",
  customer: "customers:view",
  customerGroup: "customers:view",
  counterparty: "customers:view",
  product: "products:view",
  variant: "products:view",
  priceList: "pricing:view",
  document: "documents:view",
} as const satisfies Record<SearchEntityType, string>;

export function requestedSearchTypes(
  types: readonly SearchEntityType[] | undefined,
): SearchEntityType[] {
  if (types === undefined) {
    return [...SEARCH_ENTITY_TYPES];
  }
  const wanted = new Set(types);
  return SEARCH_ENTITY_TYPES.filter((type) => wanted.has(type));
}

export function permittedSearchTypes(
  requested: readonly SearchEntityType[],
  membership: StaffMembership,
): SearchEntityType[] {
  return requested.filter((type) =>
    staffHasPermission(membership, SEARCH_TYPE_PERMISSION[type]),
  );
}

export function assembleSearchGroups(
  matcherGroups: readonly SearchGroup[],
  orderLookupTruncated: boolean,
): SearchGroup[] {
  const byType = new Map<SearchEntityType, SearchGroup>();
  for (const group of matcherGroups) {
    byType.set(group.type, group);
  }
  if (orderLookupTruncated && !byType.has("order")) {
    byType.set("order", { type: "order", hits: [], truncated: true });
  }

  let remaining = GLOBAL_HIT_CAP;
  const keptIndexes = new Map<SearchEntityType, Set<number>>();
  const droppedByCap = new Set<SearchEntityType>();

  /**
   * Exact hits claim the global budget first (type-enum order), then the
   * second pass spends what is left. Selection is by **index**, not by a
   * count sliced off the front: a matcher that returns its hits in some
   * other order still keeps its exact rows instead of losing them to the
   * non-exact ones that happened to sort earlier.
   */
  const takeHits = (wantExact: boolean): void => {
    for (const type of SEARCH_ENTITY_TYPES) {
      const group = byType.get(type);
      if (group === undefined) {
        continue;
      }
      for (let index = 0; index < group.hits.length; index += 1) {
        if (group.hits[index]?.exact !== wantExact) {
          continue;
        }
        if (remaining <= 0) {
          droppedByCap.add(type);
          continue;
        }
        let indexes = keptIndexes.get(type);
        if (indexes === undefined) {
          indexes = new Set<number>();
          keptIndexes.set(type, indexes);
        }
        indexes.add(index);
        remaining -= 1;
      }
    }
  };
  takeHits(true);
  takeHits(false);

  const assembled: SearchGroup[] = [];
  for (const type of SEARCH_ENTITY_TYPES) {
    const group = byType.get(type);
    if (group === undefined) {
      continue;
    }
    const indexes = keptIndexes.get(type) ?? new Set<number>();
    const truncated =
      group.truncated ||
      droppedByCap.has(type) ||
      (type === "order" && orderLookupTruncated);
    if (indexes.size === 0 && !truncated) {
      continue;
    }
    if (group.type === "variant") {
      assembled.push({
        type: "variant",
        truncated,
        hits: keepHitsAt(group.hits, indexes),
      });
      continue;
    }
    assembled.push({
      ...group,
      hits: keepHitsAt(group.hits, indexes),
      truncated,
    });
  }
  return assembled;
}

/** Kept hits stay in the matcher's own order (exact → rank → id). */
function keepHitsAt<T>(hits: readonly T[], indexes: ReadonlySet<number>): T[] {
  const kept: T[] = [];
  for (let index = 0; index < hits.length; index += 1) {
    const hit = hits[index];
    if (hit !== undefined && indexes.has(index)) {
      kept.push(hit);
    }
  }
  return kept;
}

export async function executeSearchQuery(
  input: SearchQueryInput,
  ctx: {
    readonly membership: StaffMembership;
    readonly call: CtxCall;
  },
): Promise<SearchQueryOutput> {
  const prepared = prepareSearchQuery(input.query);
  const requested = requestedSearchTypes(input.types);
  const searchedTypes = permittedSearchTypes(requested, ctx.membership);
  if (prepared.empty) {
    return {
      groups: [],
      searchedTypes,
      queryNormalized: prepared.queryNormalized,
    };
  }

  const collected = await fanOutSearchMatchers({
    query: input.query,
    limitPerType: input.limitPerType,
    searchedTypes,
    membership: ctx.membership,
    call: ctx.call,
  });

  return {
    groups: assembleSearchGroups(
      collected.groups,
      collected.orderLookupTruncated,
    ),
    searchedTypes,
    queryNormalized: prepared.queryNormalized,
  };
}

async function fanOutSearchMatchers(args: {
  readonly query: string;
  readonly limitPerType: number;
  readonly searchedTypes: readonly SearchEntityType[];
  readonly membership: StaffMembership;
  readonly call: CtxCall;
}): Promise<{
  readonly groups: SearchGroup[];
  readonly orderLookupTruncated: boolean;
}> {
  const groups: SearchGroup[] = [];
  let orderLookupTruncated = false;
  let orderCustomerIds: string[] | undefined;

  const canCustomers = staffHasPermission(
    args.membership,
    SEARCH_TYPE_PERMISSION.customer,
  );
  const wantsOrder = args.searchedTypes.includes("order");
  const requestedCustomerTypes = SEARCH_CUSTOMER_TYPES.filter((type) =>
    args.searchedTypes.includes(type),
  );
  const runCustomers =
    canCustomers && (wantsOrder || requestedCustomerTypes.length > 0);

  if (runCustomers) {
    const lookupOnly = requestedCustomerTypes.length === 0;
    const customerTypes: SearchCustomerType[] = lookupOnly
      ? ["customer"]
      : [...requestedCustomerTypes];
    const customersResult = await args.call(customersSearchMatches, {
      query: args.query,
      limitPerType: args.limitPerType,
      types: customerTypes,
    });
    if (!lookupOnly) {
      groups.push(...customersResult.groups);
    }
    if (wantsOrder) {
      orderCustomerIds = customersResult.orderCustomerLookup.ids;
      orderLookupTruncated = customersResult.orderCustomerLookup.truncated;
    }
  }

  const catalogTypes = SEARCH_CATALOG_TYPES.filter((type) =>
    args.searchedTypes.includes(type),
  );
  if (catalogTypes.length > 0) {
    const catalogResult = await args.call(catalogSearchMatches, {
      query: args.query,
      limitPerType: args.limitPerType,
      types: [...catalogTypes],
    });
    groups.push(...catalogResult.groups);
  }

  if (wantsOrder) {
    const ordersResult = await args.call(ordersSearchMatches, {
      query: args.query,
      limitPerType: args.limitPerType,
      ...(orderCustomerIds === undefined
        ? {}
        : { customerIds: orderCustomerIds }),
    });
    groups.push(...ordersResult.groups);
  }

  if (args.searchedTypes.includes("priceList")) {
    const pricingResult = await args.call(pricingSearchMatches, {
      query: args.query,
      limitPerType: args.limitPerType,
    });
    groups.push(...pricingResult.groups);
  }

  if (args.searchedTypes.includes("document")) {
    const documentsResult = await args.call(documentsSearchMatches, {
      query: args.query,
      limitPerType: args.limitPerType,
    });
    groups.push(...documentsResult.groups);
  }

  return { groups, orderLookupTruncated };
}
