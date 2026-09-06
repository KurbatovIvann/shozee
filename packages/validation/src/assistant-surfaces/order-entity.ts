/**
 * Unlocalized order-entity surface parse (SHO-456). Binds live
 * `orders.get` / `orders.create` only. Do not walk list `items[].orderId`.
 */
import {
  customerNameSnapshotFromPayload,
  isAssistantSurfaceResultOutput,
  isRecord,
  moneyMinorFromFields,
  unwrapToolOutput,
  type AssistantMoneyMinor,
  type AssistantSurfaceToolResult,
} from "./helpers.js";

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

export type AssistantOrderEntityData = {
  readonly kind: "order-entity";
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
