/**
 * SHO-456 / SHO-472 / SHO-535 compose: page (+ optional counts) → one
 * orders-list surface; counts-only → one aggregate; never both;
 * customers-list from `customers_list_customers`; search-results from
 * `search_query`; N entity surfaces from get/create. Do not walk
 * `items[].orderId` or customer ids into entity cards.
 */
import {
  parseCustomersListSurface,
  type AssistantCustomersListData,
} from "./customers-list.js";
import type { AssistantSurfaceToolResult } from "./helpers.js";
import {
  parseOrderEntitySurfaces,
  type AssistantOrderEntityData,
} from "./order-entity.js";
import {
  parseOrdersAggregateSurface,
  type AssistantOrdersAggregateData,
} from "./orders-aggregate.js";
import {
  parseOrdersListSurface,
  type AssistantOrdersListData,
} from "./orders-list.js";
import {
  parseSearchResultsSurface,
  type AssistantSearchResultsData,
} from "./search-results.js";

export type AssistantSurfaceData =
  | AssistantOrdersListData
  | AssistantOrdersAggregateData
  | AssistantOrderEntityData
  | AssistantCustomersListData
  | AssistantSearchResultsData;

export type AssistantSurfaceKind = AssistantSurfaceData["kind"];

/**
 * Discriminated unlocalized result surfaces for one assistant turn.
 * Timeline and HITL confirmation stay outside this list.
 */
export function assistantSurfacesFromToolResults(
  results: readonly AssistantSurfaceToolResult[],
): readonly AssistantSurfaceData[] {
  const list = parseOrdersListSurface(results);
  const aggregate = list === null ? parseOrdersAggregateSurface(results) : null;
  const customers = parseCustomersListSurface(results);
  const searchResults = parseSearchResultsSurface(results);
  const entities = parseOrderEntitySurfaces(results);
  const surfaces: AssistantSurfaceData[] = [];
  if (list !== null) {
    surfaces.push(list);
  }
  if (aggregate !== null) {
    surfaces.push(aggregate);
  }
  if (customers !== null) {
    surfaces.push(customers);
  }
  if (searchResults !== null) {
    surfaces.push(searchResults);
  }
  surfaces.push(...entities);
  return surfaces;
}
