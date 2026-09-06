/**
 * SHO-456 compose: page (+ optional counts) → one list surface;
 * counts-only → one aggregate; never both; N entity surfaces from
 * get/create. Do not walk `items[].orderId` into entities.
 */
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

export type AssistantSurfaceData =
  | AssistantOrdersListData
  | AssistantOrdersAggregateData
  | AssistantOrderEntityData;

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
  const entities = parseOrderEntitySurfaces(results);
  const surfaces: AssistantSurfaceData[] = [];
  if (list !== null) {
    surfaces.push(list);
  }
  if (aggregate !== null) {
    surfaces.push(aggregate);
  }
  surfaces.push(...entities);
  return surfaces;
}
