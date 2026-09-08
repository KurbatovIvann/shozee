/**
 * Host tool `pending_replace` (SHO-522 / ADR-0037).
 *
 * Not `implementAction`, not an ADR-0033 façade, not a second
 * `orders.create` execute. The host injects pending id + expected
 * version; the model schema must not include them.
 */
import { CoreInvariantError } from "@showzy/core/errors";
import { tool, type Tool } from "ai";
import { z } from "zod";

import { PENDING_REPLACE_TOOL_NAME } from "../pending.js";
import {
  mapOrdersCreateInput,
  ORDERS_CREATE_ACTION_NAME,
  ordersCreateInputSchema,
} from "../tool-facades/orders-create.js";

export { PENDING_REPLACE_TOOL_NAME };

const deleteCustomerReplaceSchema = z.strictObject({
  id: z.uuid(),
});

export const PENDING_REPLACE_DESCRIPTION =
  "Amend the current open pending write (quantity, customer, or other args of THIS job). Do not send pending id or version. Do not call a second create/delete while a pending card is open. Independent new writes are refused — finish, abandon, or replace this pending first.";

export function pendingReplaceFacadeSchema(actionName: string): z.ZodType {
  if (actionName === ORDERS_CREATE_ACTION_NAME) {
    return ordersCreateInputSchema;
  }
  if (actionName === "customers.deleteCustomer") {
    return deleteCustomerReplaceSchema;
  }
  return z.looseObject({});
}

export function mapPendingReplaceFacadeInput(
  actionName: string,
  facadeInput: unknown,
): unknown {
  if (actionName === ORDERS_CREATE_ACTION_NAME) {
    return mapOrdersCreateInput(ordersCreateInputSchema.parse(facadeInput));
  }
  if (actionName === "customers.deleteCustomer") {
    return deleteCustomerReplaceSchema.parse(facadeInput);
  }
  if (
    typeof facadeInput === "object" &&
    facadeInput !== null &&
    !Array.isArray(facadeInput)
  ) {
    return facadeInput;
  }
  throw new CoreInvariantError("pending_replace input must be an object");
}

export interface PendingReplaceHostApply {
  readonly actionName: string;
  readonly apply: (facadeInput: unknown) => Promise<unknown>;
}

/**
 * Tool the model sees. Schema is the pending action's façade args only.
 */
export function createPendingReplaceTool(host: PendingReplaceHostApply): Tool {
  const inputSchema = pendingReplaceFacadeSchema(host.actionName);
  return tool({
    description: PENDING_REPLACE_DESCRIPTION,
    inputSchema,
    execute: async (input) => {
      const parsed = inputSchema.parse(input);
      return host.apply(parsed);
    },
  });
}

export function pendingReplaceSchemaMentionsHostSecrets(
  schemaJson: string,
): boolean {
  return (
    schemaJson.includes("pendingId") ||
    schemaJson.includes("expectedVersion") ||
    schemaJson.includes("challengeId") ||
    schemaJson.includes("optionId")
  );
}
