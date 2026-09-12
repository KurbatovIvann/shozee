/**
 * `customers.listCustomers` read bindings (SHO-179). Keys follow
 * SHO-102: `[actionName, companyId, input]`; the page cursor is the
 * infinite query page param, never part of the key.
 */
import type { ContractClient } from "../../../api/client";
import {
  contractInfiniteQueryOptions,
  contractQueryOptions,
} from "../../../api/query-options";

export const LIST_CUSTOMERS_ACTION = "customers.listCustomers";

type ShowzyClient = ContractClient;
export type ListCustomersOutput = Awaited<
  ReturnType<ShowzyClient["client"]["customers"]["listCustomers"]>
>;
export type CustomerListItem = ListCustomersOutput["items"][number];

export type CustomersStatusFilter = "active" | "archived" | "all";

export type ListCustomersPageInput = {
  readonly status: CustomersStatusFilter;
  readonly search?: string;
  readonly groupId?: string;
  readonly limit?: number;
};

export type CustomersListClient = {
  readonly client: {
    readonly customers: {
      readonly listCustomers: ShowzyClient["client"]["customers"]["listCustomers"];
    };
  };
};

export function listCustomersInfiniteOptions(args: {
  readonly client: CustomersListClient | null;
  readonly companyId: string | null;
  readonly input: ListCustomersPageInput;
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

/**
 * One-row `status: "all"` probe: distinguishes an empty CRM from
 * "no active customers" when the default (active) chip comes back empty.
 */
export const CUSTOMERS_PROBE_INPUT = {
  status: "all",
  limit: 1,
} as const;

export function customersProbeQueryOptions(args: {
  readonly client: ContractClient | null;
  readonly companyId: string | null;
  readonly getActiveCompany: () => string | null;
}) {
  const client = args.client;
  return contractQueryOptions({
    actionName: LIST_CUSTOMERS_ACTION,
    companyId: args.companyId,
    input: CUSTOMERS_PROBE_INPUT,
    getActiveCompany: args.getActiveCompany,
    queryFn: () => {
      if (client === null) {
        return Promise.reject(new TypeError("Failed to fetch"));
      }
      return client.client.customers.listCustomers(CUSTOMERS_PROBE_INPUT);
    },
  });
}
