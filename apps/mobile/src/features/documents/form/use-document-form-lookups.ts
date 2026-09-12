import { useInfiniteQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";

import { useApiClient } from "../../../api/api-provider";
import { useActiveCompany } from "../../../api/query-provider";
import {
  flattenPages,
  optionSelectItems,
  type OptionSelectItem,
} from "../../../components/ui";
import {
  SEARCH_DEBOUNCE_MS,
  useDebouncedValue,
} from "../../../hooks/use-debounced-value";
import { useDrainInfinitePages } from "../../../hooks/use-drain-pages";
import { listDocumentCounterpartiesInfiniteOptions } from "../api/counterparty-list-query";
import {
  documentOrdersLookupInput,
  listDocumentOrdersInfiniteOptions,
} from "../api/order-list-query";
import { normalizeDocumentOrderQuery } from "../shared/document-caps";
import {
  documentCounterpartyOptionDescription,
  documentOrderOptionDescription,
  documentOrderOptionName,
} from "./document-form-pickers";

export type DocumentFormOrderRow = {
  readonly id: string;
  readonly customerId: string | null;
  readonly name: string;
  readonly description: string;
};

export function useDocumentFormLookups(args: {
  readonly enabled: boolean;
  readonly customerId: string | null;
  readonly missingCustomer: string;
}): {
  readonly orderOptions: readonly OptionSelectItem[];
  readonly orderRows: readonly DocumentFormOrderRow[];
  readonly orderQuery: string;
  readonly onOrderQueryChange: (value: string) => void;
  readonly ordersLoadingMore: boolean;
  readonly onOrdersEndReached: () => void;
  readonly counterpartyOptions: readonly OptionSelectItem[];
} {
  const apiClient = useApiClient();
  const { activeCompanyId } = useActiveCompany();
  const getActiveCompany = () => apiClient?.getActiveCompany() ?? null;
  const enabled = args.enabled;
  const { missingCustomer, customerId } = args;

  const [orderQuery, setOrderQuery] = useState("");
  const debouncedOrderQuery = useDebouncedValue(orderQuery, SEARCH_DEBOUNCE_MS);
  const orderSearch = normalizeDocumentOrderQuery(debouncedOrderQuery);

  const ordersQuery = useInfiniteQuery(
    listDocumentOrdersInfiniteOptions({
      client: apiClient,
      companyId: activeCompanyId,
      input: documentOrdersLookupInput(orderSearch),
      getActiveCompany,
      enabled,
    }),
  );
  const ordersHasNextPage = ordersQuery.hasNextPage;
  const ordersFetchingNextPage = ordersQuery.isFetchingNextPage;
  const ordersFetchNextPage = ordersQuery.fetchNextPage;
  const onOrdersEndReached = useCallback(() => {
    if (ordersHasNextPage && !ordersFetchingNextPage) {
      void ordersFetchNextPage();
    }
  }, [ordersFetchNextPage, ordersFetchingNextPage, ordersHasNextPage]);

  const counterpartiesQuery = useInfiniteQuery(
    listDocumentCounterpartiesInfiniteOptions({
      client: apiClient,
      companyId: activeCompanyId,
      customerId,
      getActiveCompany,
      enabled,
    }),
  );
  useDrainInfinitePages({
    status: counterpartiesQuery.status,
    hasNextPage: counterpartiesQuery.hasNextPage,
    isFetchingNextPage: counterpartiesQuery.isFetchingNextPage,
    fetchNextPage: counterpartiesQuery.fetchNextPage,
  });

  const orderRows = useMemo((): readonly DocumentFormOrderRow[] => {
    if (ordersQuery.data === undefined) {
      return [];
    }
    return flattenPages(ordersQuery.data.pages).map((row) => ({
      id: row.orderId,
      customerId: row.customer.linkedCustomerId,
      name: documentOrderOptionName(row, missingCustomer),
      description: documentOrderOptionDescription(row, null),
    }));
  }, [ordersQuery.data, missingCustomer]);

  const orderOptions = useMemo(
    () =>
      optionSelectItems(
        orderRows.map((row) => ({
          id: row.id,
          name: row.name,
          description: row.description,
        })),
      ),
    [orderRows],
  );

  const counterpartyOptions = useMemo(() => {
    if (counterpartiesQuery.data === undefined) {
      return [];
    }
    return optionSelectItems(
      flattenPages(counterpartiesQuery.data.pages).map((row) => ({
        id: row.id,
        name: row.name,
        description: documentCounterpartyOptionDescription(row),
      })),
    );
  }, [counterpartiesQuery.data]);

  return {
    orderOptions,
    orderRows,
    orderQuery,
    onOrderQueryChange: setOrderQuery,
    ordersLoadingMore: ordersQuery.isFetching,
    onOrdersEndReached,
    counterpartyOptions,
  };
}
