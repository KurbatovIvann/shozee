/**
 * Assistant result-surface registry (SHO-456 / SHO-470 / SHO-472). Each
 * kind owns the façade tools it binds, parse into an unlocalized
 * view-model, English `promptLine`, a required destination, and
 * hydration flags. Timeline and HITL are not registered here.
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
  readonly hydratable: boolean;
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
      hydratable: false,
      promptLine: ORDERS_LIST_PROMPT_LINE,
      destination: ORDERS_LIST_DESTINATION,
      parse: parseOrdersListSurface,
    },
    {
      kind: "orders-aggregate",
      version: 1,
      toolNames: ORDERS_AGGREGATE_SURFACE_TOOLS,
      actionNames: [ORDERS_LIST_ACTION_NAME],
      hydratable: false,
      promptLine: ORDERS_AGGREGATE_PROMPT_LINE,
      destination: ORDERS_AGGREGATE_DESTINATION,
      parse: parseOrdersAggregateSurface,
    },
    {
      kind: "order-entity",
      version: 1,
      toolNames: ORDER_ENTITY_SURFACE_TOOLS,
      actionNames: ORDER_ENTITY_ACTION_NAMES,
      hydratable: true,
      promptLine: ORDER_ENTITY_PROMPT_LINE,
      destination: ORDER_ENTITY_DESTINATION,
      parse: parseOrderEntitySurfaces,
    },
    {
      kind: "customers-list",
      version: 1,
      toolNames: CUSTOMERS_LIST_SURFACE_TOOLS,
      actionNames: [CUSTOMERS_LIST_ACTION_NAME],
      // Lists are unrestorable today (`assistant-hydrate.ts`: "Do not
      // restore list cards"; `orders-list` is `hydratable: false`). No
      // ticket mandates hydrating customers-list on resume.
      hydratable: false,
      promptLine: CUSTOMERS_LIST_PROMPT_LINE,
      destination: CUSTOMERS_LIST_DESTINATION,
      parse: parseCustomersListSurface,
    },
    {
      kind: "search-results",
      version: 1,
      toolNames: SEARCH_RESULTS_SURFACE_TOOLS,
      actionNames: [SEARCH_QUERY_ACTION_NAME],
      hydratable: false,
      promptLine: SEARCH_RESULTS_PROMPT_LINE,
      destination: SEARCH_RESULTS_DESTINATION,
      parse: parseSearchResultsSurface,
    },
  ];

function actionNamesFromRegistry(
  registry: readonly AssistantSurfaceDescriptor[],
  hydratable: boolean,
): ReadonlySet<string> {
  const names = new Set<string>();
  for (const descriptor of registry) {
    if (descriptor.hydratable !== hydratable) {
      continue;
    }
    for (const actionName of descriptor.actionNames) {
      names.add(actionName);
    }
  }
  return names;
}

export function hydratableAssistantActionNames(
  registry: readonly AssistantSurfaceDescriptor[] = ASSISTANT_SURFACE_REGISTRY,
): ReadonlySet<string> {
  return actionNamesFromRegistry(registry, true);
}

export function unrestorableAssistantActionNames(
  registry: readonly AssistantSurfaceDescriptor[] = ASSISTANT_SURFACE_REGISTRY,
): ReadonlySet<string> {
  return actionNamesFromRegistry(registry, false);
}
