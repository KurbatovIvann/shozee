/**
 * Assistant result-surface registry (SHO-456). Each kind owns the façade
 * tools it binds, parse into an unlocalized view-model, English
 * `promptLine`, and hydration flags. Timeline and HITL are not
 * registered here.
 *
 * Adding the **second list-shaped** surface is a later ticket — do not
 * generalise `orders-list` into a generic table in this slice.
 */
import type { AssistantSurfaceData, AssistantSurfaceKind } from "./compose.js";
import type { AssistantSurfaceToolResult } from "./helpers.js";
import {
  ORDER_ENTITY_ACTION_NAMES,
  ORDER_ENTITY_PROMPT_LINE,
  ORDER_ENTITY_SURFACE_TOOLS,
  parseOrderEntitySurfaces,
} from "./order-entity.js";
import {
  ORDERS_AGGREGATE_PROMPT_LINE,
  ORDERS_AGGREGATE_SURFACE_TOOLS,
  parseOrdersAggregateSurface,
} from "./orders-aggregate.js";
import {
  ORDERS_LIST_ACTION_NAME,
  ORDERS_LIST_PROMPT_LINE,
  ORDERS_LIST_SURFACE_TOOLS,
  parseOrdersListSurface,
} from "./orders-list.js";

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
      parse: parseOrdersListSurface,
    },
    {
      kind: "orders-aggregate",
      version: 1,
      toolNames: ORDERS_AGGREGATE_SURFACE_TOOLS,
      actionNames: [ORDERS_LIST_ACTION_NAME],
      hydratable: false,
      promptLine: ORDERS_AGGREGATE_PROMPT_LINE,
      parse: parseOrdersAggregateSurface,
    },
    {
      kind: "order-entity",
      version: 1,
      toolNames: ORDER_ENTITY_SURFACE_TOOLS,
      actionNames: ORDER_ENTITY_ACTION_NAMES,
      hydratable: true,
      promptLine: ORDER_ENTITY_PROMPT_LINE,
      parse: parseOrderEntitySurfaces,
    },
  ];

export function hydratableAssistantActionNames(): ReadonlySet<string> {
  const names = new Set<string>();
  for (const descriptor of ASSISTANT_SURFACE_REGISTRY) {
    if (!descriptor.hydratable) {
      continue;
    }
    for (const actionName of descriptor.actionNames) {
      names.add(actionName);
    }
  }
  return names;
}

export function unrestorableAssistantActionNames(): ReadonlySet<string> {
  const names = new Set<string>();
  for (const descriptor of ASSISTANT_SURFACE_REGISTRY) {
    if (descriptor.hydratable) {
      continue;
    }
    for (const actionName of descriptor.actionNames) {
      names.add(actionName);
    }
  }
  return names;
}

export function unrestorableAssistantListAction(): string {
  for (const name of unrestorableAssistantActionNames()) {
    return name;
  }
  return ORDERS_LIST_ACTION_NAME;
}
