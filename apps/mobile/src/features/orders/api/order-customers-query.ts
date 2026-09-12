/**
 * `customers.listCustomers` for the order editor picker (SHO-213).
 * Keys follow SHO-102: `[actionName, companyId, input]`. Lives in the
 * orders slice so form code does not import `features/customers`.
 */
import type { ContractClient } from "../../../api/client";
import { contractInfiniteQueryOptions } from "../../../api/query-options";
import { ORDER_LOOKUP_PAGE_SIZE } from "../shared/order-caps";

export const LIST_CUSTOMERS_ACTION = "customers.listCustomers";

type ShowzyClient = ContractClient;
export type ListCustomersOutput = Awaited<
  ReturnType<ShowzyClient["client"]["customers"]["listCustomers"]>
>;
export type OrderCustomerListItem = ListCustomersOutput["items"][number];

export const ORDER_CUSTOMERS_LOOKUP_INPUT = {
  status: "active" as const,
  limit: ORDER_LOOKUP_PAGE_SIZE,
};

export type ListOrderCustomersPageInput =
  typeof ORDER_CUSTOMERS_LOOKUP_INPUT & { readonly search?: string };

export function orderCustomersLookupInput(
  search: string | undefined,
): ListOrderCustomersPageInput {
  return {
    ...ORDER_CUSTOMERS_LOOKUP_INPUT,
    ...(search === undefined ? {} : { search }),
  };
}

export function listOrderCustomersInfiniteOptions(args: {
  readonly client: ContractClient | null;
  readonly companyId: string | null;
  readonly input: ListOrderCustomersPageInput;
  readonly getActiveCompany: () => string | null;
  readonly enabled?: boolean;
}) {
  const client = args.client;
  return {
    ...contractInfiniteQueryOptions({
      actionName: LIST_CUSTOMERS_ACTION,
      companyId: args.companyId,
      input: args.input,
      getActiveCompany: args.getActiveCompany,
      queryFn: (cursor: string | null) => {
        if (client === null) {
          return Promise.reject(new TypeError("Failed to fetch"));
        }
        return client.client.customers.listCustomers({
          ...args.input,
          ...(cursor === null ? {} : { cursor }),
        });
      },
      nextCursor: (page: ListCustomersOutput) => page.nextCursor,
    }),
    enabled:
      (args.enabled ?? true) && client !== null && args.companyId !== null,
  };
}
