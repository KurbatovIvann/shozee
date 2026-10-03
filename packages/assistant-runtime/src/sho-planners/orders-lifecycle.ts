import { toProviderToolName } from "@showzy/ai";

import { shoRefLocator, shoRefused, type ShoActionPlanners } from "./kit.js";
import {
  shoWriteActions,
  shoWritePlanners,
  shoWritePlannerParams,
  type ShoWriteParamMapper,
  type ShoWritePlan,
  type ShoWritePlans,
} from "./write-kit.js";

export const SHO_CONFIRM_ORDER = "orders.confirm";

export const SHO_START_ORDER = "orders.start";

export const SHO_COMPLETE_ORDER = "orders.complete";

export const SHO_CANCEL_ORDER = "orders.cancel";

const focusedOrder: ShoWriteParamMapper = (param) => {
  const locator = shoRefLocator(param);
  if (shoRefused(locator)) {
    return locator;
  }
  return locator.by === "id" ? { orderId: locator.id } : "unresolved_reference";
};

const lifecycle = (action: string, reply: string): ShoWritePlan => ({
  toolName: toProviderToolName(action),
  reply,
  params: { order_number: focusedOrder },
  required: ["order_number"],
});

const SHO_ORDER_LIFECYCLE: ShoWritePlans = {
  [SHO_CONFIRM_ORDER]: lifecycle(SHO_CONFIRM_ORDER, "Замовлення підтверджено."),
  [SHO_START_ORDER]: lifecycle(SHO_START_ORDER, "Замовлення в роботі."),
  [SHO_COMPLETE_ORDER]: lifecycle(SHO_COMPLETE_ORDER, "Замовлення виконано."),
  [SHO_CANCEL_ORDER]: lifecycle(SHO_CANCEL_ORDER, "Замовлення скасовано."),
};

export const SHO_ORDER_LIFECYCLE_ACTIONS: readonly string[] =
  shoWriteActions(SHO_ORDER_LIFECYCLE);

export const SHO_ORDER_LIFECYCLE_PLANNER_PARAMS: Readonly<
  Record<string, readonly string[]>
> = shoWritePlannerParams(SHO_ORDER_LIFECYCLE);

export const SHO_ORDER_LIFECYCLE_PLANNERS: ShoActionPlanners =
  shoWritePlanners(SHO_ORDER_LIFECYCLE);
