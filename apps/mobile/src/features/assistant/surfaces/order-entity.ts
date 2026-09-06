/**
 * Order entity result surface (SHO-369 / SHO-385 / SHO-456). Localizes
 * shared `@showzy/validation/assistant-surfaces` data. Binds live
 * `orders.get` / `orders.create` only. Do not walk list `items[].orderId`.
 * Do not import `@showzy/ai`.
 */
import {
  parseOrderEntitySurfaces as parseOrderEntityData,
  ORDER_ENTITY_PROMPT_LINE,
  ORDER_ENTITY_SURFACE_TOOLS,
  ORDERS_CREATE_TOOLS,
  ORDERS_GET_TOOLS,
  type AssistantOrderEntityData,
} from "@showzy/validation/assistant-surfaces";

import { ordersCopy } from "../../../i18n/orders";
import { orderDetailHref } from "../../orders/shared/order-hrefs";
import {
  isOrderLifecycleStatus as isOrderStatus,
  orderStatusTone,
  type OrderStatusTone,
} from "../../orders/shared/order-status";
import type { AssistantChatPart } from "../shared/confirmation-presenter";
import {
  assistantSurfaceToolResultsFromParts,
  formatMoneyAmount,
  localizeCustomerName,
} from "./helpers";

export {
  ORDER_ENTITY_PROMPT_LINE,
  ORDER_ENTITY_SURFACE_TOOLS,
  ORDERS_CREATE_TOOLS,
  ORDERS_GET_TOOLS,
};

export type AssistantOrderEntityCardView = {
  readonly kind: "order-entity";
  readonly id: string;
  readonly orderId: string;
  readonly href: string;
  readonly orderNumberLabel: string;
  readonly customerName: string | null;
  readonly statusLabel: string | null;
  readonly statusTone: OrderStatusTone;
  readonly totalLabel: string | null;
};

export function localizeOrderEntityCard(
  data: AssistantOrderEntityData,
  orders: ReturnType<typeof ordersCopy>,
): AssistantOrderEntityCardView {
  const status = isOrderStatus(data.status) ? data.status : null;
  const callId = data.toolCallId;
  const id =
    typeof callId === "string" && callId.length > 0 ? callId : "order-entity";
  return {
    kind: "order-entity",
    id,
    orderId: data.orderId,
    href: orderDetailHref(data.orderId),
    orderNumberLabel: data.orderNumber.length > 0 ? `#${data.orderNumber}` : "",
    customerName:
      data.customerNameSnapshot === null
        ? null
        : localizeCustomerName(
            data.customerNameSnapshot,
            orders.missingCustomer,
          ),
    statusLabel: status !== null ? orders.statuses[status] : null,
    statusTone: status !== null ? orderStatusTone(status) : "action",
    totalLabel: formatMoneyAmount(data.total),
  };
}

/**
 * N entity surfaces from live get/create parts. Isolation / permission
 * errors and HITL payloads are omitted.
 */
export function parseOrderEntitySurfaces(
  parts: readonly AssistantChatPart[],
  locale: Parameters<typeof ordersCopy>[0],
): readonly AssistantOrderEntityCardView[] {
  const orders = ordersCopy(locale);
  return parseOrderEntityData(assistantSurfaceToolResultsFromParts(parts)).map(
    (data) => localizeOrderEntityCard(data, orders),
  );
}
