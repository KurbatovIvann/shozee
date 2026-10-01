import type { ActionContract } from "@showzy/core/contract";
import { CoreInvariantError } from "@showzy/core/errors";
import { tool, type Tool } from "ai";
import { z } from "zod";

import type { ActionToolExecute } from "../action-tool.js";
import {
  EXACTLY_ONE_REFERENCE_MESSAGE,
  entityLookupQuerySchema,
  nearestChoiceFromError,
} from "./entity-lookup.js";

export const CUSTOMERS_GET_CUSTOMER_ACTION_NAME = "customers.getCustomer";
export const CUSTOMERS_GET_CUSTOMER_TOOL_NAME = "customers_get_customer";

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
  "One CRM customer in the active company: id, name, phone, email, notes, group and price-list assignment, status, linked counterparty count, timestamps. Pass customerId for a known id, or customerQuery with a name, phone or email. «Знайди клієнта Катя Самбука» means this tool, not the list: a plural («покажи клієнтів», «усі клієнти») or a filter (group, status, archived) means customers_list_customers. Put the name in nominative (Катя Самбука) — not the inflected form from the staff sentence (Каті Самбуки). Pass only the name or contact, not the whole utterance. A unique match returns that customer, archived ones included. Several matches ask the staff member which one. Nothing matching offers the nearest customers and creating a new one. Missing customers and customers of another company fail with the same not-found. Company id is never input.";

function canonicalInput(
  input: CustomersGetCustomerFacadeInput,
): Record<string, string> {
  if (input.customerId !== undefined) {
    return { id: input.customerId };
  }
  if (input.customerQuery !== undefined) {
    return { query: input.customerQuery };
  }
  throw new CoreInvariantError(
    `${CUSTOMERS_GET_CUSTOMER_TOOL_NAME} input carries neither customerId nor customerQuery`,
  );
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
        try {
          return await execute(
            CUSTOMERS_GET_CUSTOMER_ACTION_NAME,
            contract.input.parse(canonicalInput(parsed)),
            { toolCallId: options.toolCallId },
          );
        } catch (error) {
          if (parsed.customerQuery === undefined) {
            throw error;
          }
          throw (
            nearestChoiceFromError(error, {
              kind: "customer",
              query: parsed.customerQuery,
            }) ?? error
          );
        }
      },
    }),
  };
}
