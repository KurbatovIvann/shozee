/**
 * Unlocalized order-entity surface parse (SHO-456). Binds live
 * `orders.get` / `orders.create` only. Do not walk list `items[].orderId`.
 */
import {
  resolveAssistantSurfaceDestination,
  type AssistantSurfaceDestination,
  type AssistantSurfaceDestinationDeclaration,
} from "./destination.js";
import {
  customerNameSnapshotFromPayload,
  isAssistantSurfaceResultOutput,
  isRecord,
  moneyMinorFromFields,
  unwrapToolOutput,
  type AssistantMoneyMinor,
  type AssistantSurfaceToolResult,
} from "./helpers.js";

/**
 * Registry names plus Anthropic provider keys. Literals, not
 * toProviderToolName or ORDERS_CREATE_TOOL_NAME: this zod-only leaf
 * must not depend on packages/ai or a module contract. packages/ai
 * owns the equality guard (SHO-462). Do not derive these strings by
 * adding a forbidden dependency.
 */
export const ORDERS_GET_TOOLS = new Set(["orders_get", "orders.get"]);
export const ORDERS_CREATE_TOOLS = new Set(["orders_create", "orders.create"]);

export const ORDER_ENTITY_SURFACE_TOOLS = [
  "orders.get",
  "orders.create",
  "orders_get",
  "orders_create",
] as const;

export const ORDER_ENTITY_ACTION_NAMES = [
  "orders.get",
  "orders.create",
] as const;

export const ORDER_ENTITY_PROMPT_LINE =
  "After orders.get or orders.create, the UI already shows an order entity card. Reply with a short product-language summary. Do not dump tool JSON.";

export const ORDER_ENTITY_DESTINATION = {
  kind: "screen",
} as const satisfies AssistantSurfaceDestinationDeclaration;

export type AssistantOrderEntityData = {
  readonly kind: "order-entity";
  readonly destination: AssistantSurfaceDestination;
  readonly orderId: string;
  readonly orderNumber: string;
  readonly customerNameSnapshot: string | null;
  readonly status: string | null;
  readonly total: AssistantMoneyMinor | null;
  readonly toolCallId?: string;
};

function parseEntity(
  result: AssistantSurfaceToolResult,
): AssistantOrderEntityData | null {
  const { payload } = unwrapToolOutput(result.output);
  if (!isRecord(payload)) {
    return null;
  }
  const orderId = payload["orderId"];
  if (typeof orderId !== "string" || orderId.length === 0) {
    return null;
  }
  const orderNumber =
    typeof payload["orderNumber"] === "string" ? payload["orderNumber"] : "";
  const status =
    typeof payload["status"] === "string" ? payload["status"] : null;
  const entity: AssistantOrderEntityData = {
    kind: "order-entity",
    destination: resolveAssistantSurfaceDestination(
      ORDER_ENTITY_DESTINATION,
      // Same path as mobile `orderDetailHref`. The app owns the route.
      `/orders/${orderId}`,
    ),
    orderId,
    orderNumber,
    customerNameSnapshot: customerNameSnapshotFromPayload(payload),
    status,
    total: moneyMinorFromFields(
      payload["totalGrossMinor"],
      payload["currency"],
    ),
  };
  const callId = result.toolCallId;
  if (typeof callId === "string" && callId.length > 0) {
    return { ...entity, toolCallId: callId };
  }
  return entity;
}

/**
 * N entity surfaces from live get/create results. Isolation / permission
 * errors and HITL payloads are omitted.
 */
export function parseOrderEntitySurfaces(
  results: readonly AssistantSurfaceToolResult[],
): readonly AssistantOrderEntityData[] {
  const entities: AssistantOrderEntityData[] = [];
  for (const result of results) {
    if (
      !ORDERS_GET_TOOLS.has(result.toolName) &&
      !ORDERS_CREATE_TOOLS.has(result.toolName)
    ) {
      continue;
    }
    if (!isAssistantSurfaceResultOutput(result.output)) {
      continue;
    }
    const entity = parseEntity(result);
    if (entity !== null) {
      entities.push(entity);
    }
  }
  return entities;
}
