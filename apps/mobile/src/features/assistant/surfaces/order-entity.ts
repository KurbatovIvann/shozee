/**
 * Order entity result surface (SHO-369 / SHO-385 / SHO-456). Localizes
 * shared `@showzy/validation/assistant-surfaces` data. Binds live
 * `orders.get` / `orders.create` only. Do not walk list `items[].orderId`.
 * Do not import `@showzy/ai`.
 */
import {
  ORDER_ENTITY_DESTINATION,
  ORDER_ENTITY_PROMPT_LINE,
  ORDER_ENTITY_SURFACE_TOOLS,
  ORDERS_CREATE_TOOLS,
  ORDERS_GET_TOOLS,
  type AssistantOrderEntityData,
  type AssistantSurfaceDestination,
} from "@showzy/validation/assistant-surfaces";

import { assistantCopy } from "../../../i18n/assistant";
import { ordersCopy } from "../../../i18n/orders";
import {
  isOrderLifecycleStatus as isOrderStatus,
  orderStatusTone,
  type OrderStatusTone,
} from "../../orders/shared/order-status";
import { entityCardId, entityCardRecord } from "./entity-card-view";
import { formatMoneyAmount, localizeCustomerName } from "./helpers";
import type { AssistantResultMarks } from "./marks";

export {
  ORDER_ENTITY_PROMPT_LINE,
  ORDER_ENTITY_SURFACE_TOOLS,
  ORDERS_CREATE_TOOLS,
  ORDERS_GET_TOOLS,
};

export type AssistantOrderEntityCardView = {
  readonly kind: "order-entity";
  readonly destination: AssistantSurfaceDestination;
  readonly handoffLabel: string;
  readonly id: string;
  readonly orderId: string;
  readonly href: string;
  readonly orderNumberLabel: string;
  readonly customerName: string | null;
  readonly statusLabel: string | null;
  readonly statusTone: OrderStatusTone;
  readonly totalLabel: string | null;
  readonly marks?: AssistantResultMarks;
};

export function localizeOrderEntityCard(
  data: AssistantOrderEntityData,
  orders: ReturnType<typeof ordersCopy>,
  locale: Parameters<typeof ordersCopy>[0],
): AssistantOrderEntityCardView {
  const status = isOrderStatus(data.status) ? data.status : null;
  const record = entityCardRecord(
    "order",
    ORDER_ENTITY_DESTINATION,
    data.orderId,
  );
  return {
    kind: "order-entity",
    destination: record.destination,
    handoffLabel: assistantCopy(locale).cards.openOrder,
    id: entityCardId(data.toolCallId, "order-entity"),
    orderId: data.orderId,
    href: record.href,
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
