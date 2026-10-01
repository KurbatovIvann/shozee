import type { ActionContract } from "@showzy/core/contract";
import { CoreInvariantError } from "@showzy/core/errors";
import { tool, type Tool } from "ai";
import { z } from "zod";

import type { ActionToolExecute } from "../action-tool.js";
import {
  EXACTLY_ONE_REFERENCE_MESSAGE,
  entityLookupQuerySchema,
  isNotFound,
  isRecord,
  nothingMatchedConflict,
} from "./entity-lookup.js";

export const CUSTOMERS_GET_CUSTOMER_ACTION_NAME = "customers.getCustomer";
export const CUSTOMERS_GET_CUSTOMER_TOOL_NAME = "customers_get_customer";

export const CUSTOMERS_RESOLVE_REFERENCE_ACTION_NAME =
  "customers.resolveCustomerReference";

export const customersGetCustomerInputSchema = z
  .strictObject({
    customerId: z.uuid().optional(),
    customerQuery: entityLookupQuerySchema.optional(),
  })
  .refine(
    (input) =>
      (input.customerId === undefined) !== (input.customerQuery === undefined),
    { message: EXACTLY_ONE_REFERENCE_MESSAGE },
  );

export type CustomersGetCustomerFacadeInput = z.output<
  typeof customersGetCustomerInputSchema
>;

const CUSTOMERS_GET_CUSTOMER_DESCRIPTION =
  "One CRM customer in the active company: id, name, phone, email, notes, group and price-list assignment, status, linked counterparty count, timestamps. Pass customerId for a known id, or customerQuery with a name, phone or email. «Знайди клієнта Катя Самбука» means this tool, not the list: a plural («покажи клієнтів», «усі клієнти») or a filter (group, status, archived) means customers_list_customers. Put the name in nominative (Катя Самбука) — not the inflected form from the staff sentence (Каті Самбуки). Pass only the name or contact, not the whole utterance. A unique match returns that customer. Several matches ask the staff member which one. Nothing matching offers creating a new customer. Missing customers and customers of another company fail with the same not-found. Company id is never input.";

async function resolveCustomerId(
  execute: ActionToolExecute,
  query: string,
  toolCallId: string,
): Promise<string> {
  let resolved: unknown;
  try {
    resolved = await execute(
      CUSTOMERS_RESOLVE_REFERENCE_ACTION_NAME,
      { by: "query", value: query },
      { toolCallId },
    );
  } catch (error) {
    if (isNotFound(error)) {
      throw nothingMatchedConflict({ kind: "customer", query });
    }
    throw error;
  }
  const customerId = isRecord(resolved) ? resolved["customerId"] : undefined;
  if (typeof customerId !== "string") {
    throw new CoreInvariantError(
      `${CUSTOMERS_RESOLVE_REFERENCE_ACTION_NAME} returned no customerId`,
    );
  }
  return customerId;
}

export function customersGetCustomerFacadeTools(
  contract: ActionContract,
  execute: ActionToolExecute,
): Record<string, Tool> {
  return {
    [CUSTOMERS_GET_CUSTOMER_TOOL_NAME]: tool({
      description: CUSTOMERS_GET_CUSTOMER_DESCRIPTION,
      inputSchema: customersGetCustomerInputSchema,
      execute: async (input, options) => {
        const parsed = customersGetCustomerInputSchema.parse(input);
        const customerId =
          parsed.customerId ??
          (await resolveCustomerId(
            execute,
            parsed.customerQuery ?? "",
            options.toolCallId,
          ));
        return await execute(
          CUSTOMERS_GET_CUSTOMER_ACTION_NAME,
          contract.input.parse({ id: customerId }),
          { toolCallId: options.toolCallId },
        );
      },
    }),
  };
}
