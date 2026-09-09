/**
 * Host tool `pending_replace` (SHO-522 / ADR-0037).
 *
 * Not a domain action handler, not an ADR-0033 façade, not a second
 * `orders.create` execute. The host injects pending id + expected
 * version; the model schema must not include them.
 *
 * Fail closed unless `actionName` has a named façade schema — the
 * pause-capable exposed writes this host can open (choice or
 * confirmation). No `looseObject` passthrough.
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

const idReplaceSchema = z.strictObject({
  id: z.uuid(),
});

const requestSignReplaceSchema = z.strictObject({
  documentId: z.uuid(),
});

const PENDING_REPLACE_FACADE_SCHEMAS = {
  [ORDERS_CREATE_ACTION_NAME]: ordersCreateInputSchema,
  "customers.deleteCustomer": idReplaceSchema,
  "customers.deleteGroup": idReplaceSchema,
  "customers.deleteCounterparty": idReplaceSchema,
  "pricing.deletePriceList": idReplaceSchema,
  "documents.requestSign": requestSignReplaceSchema,
} as const;

type PendingReplaceActionName = keyof typeof PENDING_REPLACE_FACADE_SCHEMAS;

export const PENDING_REPLACE_ACTION_NAMES = Object.freeze(
  Object.keys(PENDING_REPLACE_FACADE_SCHEMAS),
);

export function isPendingReplaceActionName(
  actionName: string,
): actionName is PendingReplaceActionName {
  return Object.hasOwn(PENDING_REPLACE_FACADE_SCHEMAS, actionName);
}

export const PENDING_REPLACE_DESCRIPTION =
  "Amend THIS open pending write (quantity, customer, or other args of the current job) with a versioned replace. Do not send pending id or version. Chat text, including «Так», is not confirmation, picker resolution, replace, or abandon. Arguments that already uniquely identify the write persist a confirmation; they do not execute it. A second job — even another create with the same actionName — is not replace; point at the open card to finish or dismiss. Do not call a second create/delete while a pending card is open. Unfinished jobs stay until tap, this pending_replace, abandon, or TTL.";

export function pendingReplaceFacadeSchema(actionName: string): z.ZodType {
  if (!isPendingReplaceActionName(actionName)) {
    throw new CoreInvariantError(
      `pending_replace has no façade schema for ${actionName}`,
    );
  }
  return PENDING_REPLACE_FACADE_SCHEMAS[actionName];
}

export function mapPendingReplaceFacadeInput(
  actionName: string,
  facadeInput: unknown,
): unknown {
  const schema = pendingReplaceFacadeSchema(actionName);
  const parsed = schema.parse(facadeInput);
  if (actionName === ORDERS_CREATE_ACTION_NAME) {
    return mapOrdersCreateInput(ordersCreateInputSchema.parse(facadeInput));
  }
  return parsed;
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
