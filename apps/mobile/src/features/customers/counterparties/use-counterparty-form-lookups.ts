import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";

import { useApiClient } from "../../../api/api-provider";
import { useActiveCompany } from "../../../api/query-provider";
import {
  SEARCH_DEBOUNCE_MS,
  useDebouncedValue,
} from "../../../hooks/use-debounced-value";
import { getCustomerQueryOptions } from "../api/customer-detail-query";
import {
  counterpartyCustomersLookupInput,
  listCustomersInfiniteOptions,
} from "../api/customer.queries";
import {
  CUSTOMERS_LOOKUP_PAGE_SIZE,
  LIST_CUSTOMERS_SEARCH_MAX,
} from "../shared/customer-caps";
import {
  optionSelectItems,
  type OptionSelectItem,
} from "../shared/option-select";
import {
  flattenPages,
  nameById,
  normalizeCustomersSearch,
} from "../shared/paged-list";
import { mergePrefillCustomerName } from "./counterparty-form-options";

/**
 * Active-customer picker options for the counterparty form. Keep already
 * fetched pages on error. Does not import `list/` or `form/`.
 *
 * Create-from-client (`prefillCustomerId`) also loads `getCustomer` so
 * the linked name is available before `listCustomers` (`status:
 * "active"`) drains, and when the client is archived (never in that
 * list).
 */
export function useCounterpartyFormLookups(args: {
  readonly enabled: boolean;
  readonly prefillCustomerId: string | null;
}): {
  readonly customerOptions: readonly OptionSelectItem[];
  readonly customerNameById: ReadonlyMap<string, string>;
  readonly prefillCustomerName: string | null;
  readonly customerQuery: string;
  readonly onCustomerQueryChange: (value: string) => void;
  readonly customersLoadingMore: boolean;
  readonly onCustomersEndReached: () => void;
} {
  const apiClient = useApiClient();
  const { activeCompanyId } = useActiveCompany();
  const getActiveCompany = () => apiClient?.getActiveCompany() ?? null;

  const [customerQuery, setCustomerQuery] = useState("");
  const debouncedCustomerQuery = useDebouncedValue(
    customerQuery,
    SEARCH_DEBOUNCE_MS,
  );
  const customerSearch = normalizeCustomersSearch(
    debouncedCustomerQuery,
    LIST_CUSTOMERS_SEARCH_MAX,
  );

  const customersQuery = useInfiniteQuery(
    listCustomersInfiniteOptions({
      client: apiClient,
      companyId: activeCompanyId,
      input: counterpartyCustomersLookupInput(
        customerSearch,
        CUSTOMERS_LOOKUP_PAGE_SIZE,
      ),
      getActiveCompany,
      enabled: args.enabled,
    }),
  );
  const customersHasNextPage = customersQuery.hasNextPage;
  const customersFetchingNextPage = customersQuery.isFetchingNextPage;
  const customersFetchNextPage = customersQuery.fetchNextPage;
  const onCustomersEndReached = useCallback(() => {
    if (customersHasNextPage && !customersFetchingNextPage) {
      void customersFetchNextPage();
    }
  }, [customersFetchNextPage, customersFetchingNextPage, customersHasNextPage]);

  const prefillQuery = useQuery(
    getCustomerQueryOptions({
      client: args.enabled ? apiClient : null,
      companyId: activeCompanyId,
      customerId: args.prefillCustomerId,
      getActiveCompany,
    }),
  );

  const customers = useMemo(() => {
    if (customersQuery.data === undefined) {
      return [];
    }
    return flattenPages(customersQuery.data.pages);
  }, [customersQuery.data]);

  const prefillCustomerName =
    prefillQuery.data?.name != null && prefillQuery.data.name.length > 0
      ? prefillQuery.data.name
      : null;

  const customerOptions = useMemo(
    () =>
      optionSelectItems(
        customers.map((customer) => ({
          id: customer.id,
          name: customer.name,
          description: customer.phone,
        })),
      ),
    [customers],
  );
  const customerNameById = useMemo(
    () =>
      mergePrefillCustomerName(
        nameById(customers),
        args.prefillCustomerId,
        prefillCustomerName,
      ),
    [customers, args.prefillCustomerId, prefillCustomerName],
  );

  return {
    customerOptions,
    customerNameById,
    prefillCustomerName,
    customerQuery,
    onCustomerQueryChange: setCustomerQuery,
    customersLoadingMore: customersQuery.isFetching,
    onCustomersEndReached,
  };
}
