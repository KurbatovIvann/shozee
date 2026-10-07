/**
 * Assistant result-surface registry (SHO-456 / SHO-470 / SHO-472). Each
 * kind owns the façade tools it binds, parse into an unlocalized
 * view-model, English `promptLine`, and a required destination. Timeline
 * and HITL are not registered here.
 *
 * There used to be a `hydratable` flag as well, read by the client that
 * rebuilt cards from database rows on reload. Nothing rebuilds them: the
 * server stores the surface it composed and the client reads it back
 * (ADR-0038).
 *
 * List-shaped surfaces share one collection block driven by a typed
 * column descriptor (per-surface row cap, not one shared constant).
 * `customers-list` is the second list. Do not copy `orders-list.ts` and
 * swap the columns — a later list is a new descriptor, not a new card.
 * `search-results` is grouped hits (SHO-535), not a third list.
 *
 * Aggregate surfaces share one block with two declared layouts
 * (`summary` | `breakdown`). `orders-aggregate` parses onto `summary`.
 * A later cut is a grouping key, not a new layout.
 */
import type { AssistantSurfaceData, AssistantSurfaceKind } from "./compose.js";
import {
  CUSTOMER_ENTITY_ACTION_NAMES,
  CUSTOMER_ENTITY_DESTINATION,
  CUSTOMER_ENTITY_PROMPT_LINE,
  CUSTOMER_ENTITY_SURFACE_TOOLS,
  parseCustomerEntitySurfaces,
} from "./customer-entity.js";
import {
  CUSTOMERS_LIST_ACTION_NAME,
  CUSTOMERS_LIST_DESTINATION,
  CUSTOMERS_LIST_PROMPT_LINE,
  CUSTOMERS_LIST_SURFACE_TOOLS,
  parseCustomersListSurface,
} from "./customers-list.js";
import type { AssistantSurfaceDestinationDeclaration } from "./destination.js";
import type { AssistantSurfaceToolResult } from "./helpers.js";
import {
  ORDER_ENTITY_ACTION_NAMES,
  ORDER_ENTITY_DESTINATION,
  ORDER_ENTITY_PROMPT_LINE,
  ORDER_ENTITY_SURFACE_TOOLS,
  parseOrderEntitySurfaces,
} from "./order-entity.js";
import {
  ORDERS_AGGREGATE_DESTINATION,
  ORDERS_AGGREGATE_PROMPT_LINE,
  ORDERS_AGGREGATE_SURFACE_TOOLS,
  parseOrdersAggregateSurface,
} from "./orders-aggregate.js";
import {
  ORDERS_LIST_ACTION_NAME,
  ORDERS_LIST_DESTINATION,
  ORDERS_LIST_PROMPT_LINE,
  ORDERS_LIST_SURFACE_TOOLS,
  parseOrdersListSurface,
} from "./orders-list.js";
import {
  CUSTOMER_GROUP_ENTITY_ACTION_NAMES,
  CUSTOMER_GROUP_ENTITY_DESTINATION,
  CUSTOMER_GROUP_ENTITY_PROMPT_LINE,
  CUSTOMER_GROUP_ENTITY_SURFACE_TOOLS,
  parseCustomerGroupEntitySurfaces,
} from "./customer-group-entity.js";
import {
  CUSTOMER_GROUPS_ACTION_NAME,
  CUSTOMER_GROUPS_DESTINATION,
  CUSTOMER_GROUPS_PROMPT_LINE,
  CUSTOMER_GROUPS_SURFACE_TOOLS,
  parseCustomerGroupsSurface,
} from "./customer-groups.js";
import {
  PRICE_LIST_ENTITY_ACTION_NAMES,
  PRICE_LIST_ENTITY_DESTINATION,
  PRICE_LIST_ENTITY_PROMPT_LINE,
  PRICE_LIST_ENTITY_SURFACE_TOOLS,
  parsePriceListEntitySurfaces,
} from "./price-list-entity.js";
import {
  PRICE_LISTS_ACTION_NAME,
  PRICE_LISTS_DESTINATION,
  PRICE_LISTS_PROMPT_LINE,
  PRICE_LISTS_SURFACE_TOOLS,
  parsePriceListsSurface,
} from "./price-lists.js";
import {
  PRODUCT_ENTITY_ACTION_NAMES,
  PRODUCT_ENTITY_DESTINATION,
  PRODUCT_ENTITY_PROMPT_LINE,
  PRODUCT_ENTITY_SURFACE_TOOLS,
  parseProductEntitySurfaces,
} from "./product-entity.js";
import {
  PRODUCTS_LIST_ACTION_NAME,
  PRODUCTS_LIST_DESTINATION,
  PRODUCTS_LIST_PROMPT_LINE,
  PRODUCTS_LIST_SURFACE_TOOLS,
  parseProductsListSurface,
} from "./products-list.js";
import {
  SEARCH_QUERY_ACTION_NAME,
  SEARCH_RESULTS_DESTINATION,
  SEARCH_RESULTS_PROMPT_LINE,
  SEARCH_RESULTS_SURFACE_TOOLS,
  parseSearchResultsSurface,
} from "./search-results.js";

export type AssistantSurfaceParse = (
  results: readonly AssistantSurfaceToolResult[],
) => AssistantSurfaceData | null | readonly AssistantSurfaceData[];

export type AssistantSurfaceDescriptor = {
  readonly kind: AssistantSurfaceKind;
  readonly version: number;
  readonly toolNames: readonly string[];
  readonly actionNames: readonly string[];
  readonly promptLine: string;
  readonly destination: AssistantSurfaceDestinationDeclaration;
  readonly parse: AssistantSurfaceParse;
};

export const ASSISTANT_SURFACE_REGISTRY: readonly AssistantSurfaceDescriptor[] =
  [
    {
      kind: "orders-list",
      version: 1,
      toolNames: ORDERS_LIST_SURFACE_TOOLS,
      actionNames: [ORDERS_LIST_ACTION_NAME],
      promptLine: ORDERS_LIST_PROMPT_LINE,
      destination: ORDERS_LIST_DESTINATION,
      parse: parseOrdersListSurface,
    },
    {
      kind: "orders-aggregate",
      version: 1,
      toolNames: ORDERS_AGGREGATE_SURFACE_TOOLS,
      actionNames: [ORDERS_LIST_ACTION_NAME],
      promptLine: ORDERS_AGGREGATE_PROMPT_LINE,
      destination: ORDERS_AGGREGATE_DESTINATION,
      parse: parseOrdersAggregateSurface,
    },
    {
      kind: "order-entity",
      version: 1,
      toolNames: ORDER_ENTITY_SURFACE_TOOLS,
      actionNames: ORDER_ENTITY_ACTION_NAMES,
      promptLine: ORDER_ENTITY_PROMPT_LINE,
      destination: ORDER_ENTITY_DESTINATION,
      parse: parseOrderEntitySurfaces,
    },
    {
      kind: "customer-entity",
      version: 1,
      toolNames: CUSTOMER_ENTITY_SURFACE_TOOLS,
      actionNames: CUSTOMER_ENTITY_ACTION_NAMES,
      promptLine: CUSTOMER_ENTITY_PROMPT_LINE,
      destination: CUSTOMER_ENTITY_DESTINATION,
      parse: parseCustomerEntitySurfaces,
    },
    {
      kind: "product-entity",
      version: 1,
      toolNames: PRODUCT_ENTITY_SURFACE_TOOLS,
      actionNames: PRODUCT_ENTITY_ACTION_NAMES,
      promptLine: PRODUCT_ENTITY_PROMPT_LINE,
      destination: PRODUCT_ENTITY_DESTINATION,
      parse: parseProductEntitySurfaces,
    },
    {
      kind: "price-list-entity",
      version: 1,
      toolNames: PRICE_LIST_ENTITY_SURFACE_TOOLS,
      actionNames: PRICE_LIST_ENTITY_ACTION_NAMES,
      promptLine: PRICE_LIST_ENTITY_PROMPT_LINE,
      destination: PRICE_LIST_ENTITY_DESTINATION,
      parse: parsePriceListEntitySurfaces,
    },
    {
      kind: "customer-group-entity",
      version: 1,
      toolNames: CUSTOMER_GROUP_ENTITY_SURFACE_TOOLS,
      actionNames: CUSTOMER_GROUP_ENTITY_ACTION_NAMES,
      promptLine: CUSTOMER_GROUP_ENTITY_PROMPT_LINE,
      destination: CUSTOMER_GROUP_ENTITY_DESTINATION,
      parse: parseCustomerGroupEntitySurfaces,
    },
    {
      kind: "customers-list",
      version: 1,
      toolNames: CUSTOMERS_LIST_SURFACE_TOOLS,
      actionNames: [CUSTOMERS_LIST_ACTION_NAME],
      promptLine: CUSTOMERS_LIST_PROMPT_LINE,
      destination: CUSTOMERS_LIST_DESTINATION,
      parse: parseCustomersListSurface,
    },
    {
      kind: "products-list",
      version: 1,
      toolNames: PRODUCTS_LIST_SURFACE_TOOLS,
      actionNames: [PRODUCTS_LIST_ACTION_NAME],
      promptLine: PRODUCTS_LIST_PROMPT_LINE,
      destination: PRODUCTS_LIST_DESTINATION,
      parse: parseProductsListSurface,
    },
    {
      kind: "price-lists",
      version: 1,
      toolNames: PRICE_LISTS_SURFACE_TOOLS,
      actionNames: [PRICE_LISTS_ACTION_NAME],
      promptLine: PRICE_LISTS_PROMPT_LINE,
      destination: PRICE_LISTS_DESTINATION,
      parse: parsePriceListsSurface,
    },
    {
      kind: "customer-groups",
      version: 1,
      toolNames: CUSTOMER_GROUPS_SURFACE_TOOLS,
      actionNames: [CUSTOMER_GROUPS_ACTION_NAME],
      promptLine: CUSTOMER_GROUPS_PROMPT_LINE,
      destination: CUSTOMER_GROUPS_DESTINATION,
      parse: parseCustomerGroupsSurface,
    },
    {
      kind: "search-results",
      version: 1,
      toolNames: SEARCH_RESULTS_SURFACE_TOOLS,
      actionNames: [SEARCH_QUERY_ACTION_NAME],
      promptLine: SEARCH_RESULTS_PROMPT_LINE,
      destination: SEARCH_RESULTS_DESTINATION,
      parse: parseSearchResultsSurface,
    },
  ];
