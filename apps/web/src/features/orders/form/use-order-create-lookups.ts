/**
 * Customer/product lookups for order create (SHO-379 / SHO-408). Debounced
 * picker query is `customers.listCustomers.search` /
 * `catalog.listProducts.query` (key includes that input). Client
 * `includes` is a last-resort filter on the returned page. Draft lines
 * and the open variant picker overlay `catalog.getProduct` rows so list
 * `variantCount` (active-only) cannot treat archived-only as simple.
 */
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import {
  catalogFactsBlockSubmit,
  catalogFactsFromProduct,
  catalogQueryLoadStatus,
  classifyCatalogFactsLoad,
  overlayCatalogVariantCount,
  uniqueProductIds,
  type CatalogFactsQuerySnapshot,
  type OrderLineCatalogFacts,
  type OrderLineCatalogFactsMap,
} from "@showzy/validation/order-line-catalog-facts";

import { useApiClient } from "../../../api/api-provider";
import { useActiveCompany } from "../../../api/query-provider";
import {
  catalogGetProductQueryOptions,
  catalogListProductsQueryKey,
  catalogListProductsQueryOptions,
} from "../api/catalog";
import {
  customersListQueryKey,
  customersListQueryOptions,
} from "../api/customers-list";
import {
  LIST_CUSTOMERS_SEARCH_MAX,
  LIST_PRODUCTS_QUERY_MAX,
  normalizeOrderLookupSearch,
  ORDER_LOOKUP_SEARCH_DEBOUNCE_MS,
} from "../shared/order-caps";
import {
  orderThumbnailView,
  type OrderThumbnailView,
} from "../shared/order-thumbnails";
import { useOrderThumbnails } from "../shared/use-order-thumbnails";

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(value);
    }, delayMs);
    return () => {
      clearTimeout(timer);
    };
  }, [delayMs, value]);
  return debounced;
}

export function useOrderCreateLookups(args: {
  readonly enabled: boolean;
  readonly variantProductId: string | null;
  readonly draftProductIds: readonly string[];
  readonly customerQuery: string;
  readonly productQuery: string;
  readonly canFetchThumbnails: boolean;
}) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { activeCompanyId } = useActiveCompany();
  const debouncedCustomerQuery = useDebouncedValue(
    args.customerQuery,
    ORDER_LOOKUP_SEARCH_DEBOUNCE_MS,
  );
  const debouncedProductQuery = useDebouncedValue(
    args.productQuery,
    ORDER_LOOKUP_SEARCH_DEBOUNCE_MS,
  );
  const customerSearch = normalizeOrderLookupSearch(
    debouncedCustomerQuery,
    LIST_CUSTOMERS_SEARCH_MAX,
  );
  const productSearch = normalizeOrderLookupSearch(
    debouncedProductQuery,
    LIST_PRODUCTS_QUERY_MAX,
  );
  const catalogProductIds = uniqueProductIds([
    ...args.draftProductIds,
    args.variantProductId,
  ]);
  const customers = useQuery({
    ...customersListQueryOptions({
      client,
      companyId: activeCompanyId,
      ...(customerSearch === undefined ? {} : { search: customerSearch }),
    }),
    enabled: args.enabled && activeCompanyId !== null,
  });
  const products = useQuery({
    ...catalogListProductsQueryOptions({
      client,
      companyId: activeCompanyId,
      ...(productSearch === undefined ? {} : { query: productSearch }),
    }),
    enabled: args.enabled && activeCompanyId !== null,
  });
  const productQueries = useQueries({
    queries: catalogProductIds.map((productId) => {
      const options = catalogGetProductQueryOptions({
        client,
        companyId: activeCompanyId,
        productId,
      });
      return {
        ...options,
        enabled: options.enabled && args.enabled,
      };
    }),
  });

  const customerRows = useMemo(
    () => customers.data?.items ?? [],
    [customers.data?.items],
  );

  const catalogFacts = useMemo((): OrderLineCatalogFactsMap => {
    const map = new Map<string, OrderLineCatalogFacts>();
    for (const [index, productId] of catalogProductIds.entries()) {
      const data = productQueries[index]?.data;
      if (data !== undefined) {
        map.set(productId, catalogFactsFromProduct(data));
      }
    }
    return map;
  }, [catalogProductIds, productQueries]);

  const productRows = useMemo(() => {
    const items = products.data?.items ?? [];
    return items.map((row) => ({
      ...row,
      variantCount: overlayCatalogVariantCount(
        row.variantCount,
        catalogFacts.get(row.id),
      ),
    }));
  }, [catalogFacts, products.data?.items]);

  const thumbnailPages = useMemo(() => [{ items: productRows }], [productRows]);
  const { urlsByFileId, failedFileIds } = useOrderThumbnails({
    client,
    companyId: activeCompanyId,
    getActiveCompany: () => client.getActiveCompany(),
    pages: thumbnailPages,
    enabled: args.enabled && args.canFetchThumbnails,
  });

  const thumbnailsByProductId = useMemo(() => {
    const map = new Map<string, OrderThumbnailView>();
    for (const row of productRows) {
      const fileId = args.canFetchThumbnails ? row.primaryImageFileId : null;
      map.set(
        row.id,
        orderThumbnailView({
          fileId,
          url: fileId === null ? undefined : urlsByFileId.get(fileId),
          downloadFailed: fileId !== null && failedFileIds.has(fileId),
        }),
      );
    }
    return map;
  }, [args.canFetchThumbnails, failedFileIds, productRows, urlsByFileId]);

  const draftCatalogIds = uniqueProductIds(args.draftProductIds);
  const catalogQueryByProductId = new Map<
    string,
    CatalogFactsQuerySnapshot | undefined
  >();
  for (const [index, productId] of catalogProductIds.entries()) {
    const query = productQueries[index];
    catalogQueryByProductId.set(
      productId,
      query === undefined ? undefined : { status: query.status },
    );
  }
  const catalogFactsStatus = classifyCatalogFactsLoad(
    draftCatalogIds,
    catalogQueryByProductId,
  );
  const catalogFactsPending = catalogFactsBlockSubmit(catalogFactsStatus);

  const pickerIndex =
    args.variantProductId === null
      ? -1
      : catalogProductIds.indexOf(args.variantProductId);
  const pickerQuery = pickerIndex < 0 ? undefined : productQueries[pickerIndex];

  function retryCustomers(): void {
    if (activeCompanyId === null) {
      return;
    }
    void queryClient.invalidateQueries({
      queryKey: customersListQueryKey(activeCompanyId, customerSearch),
    });
  }

  function retryProducts(): void {
    if (activeCompanyId === null) {
      return;
    }
    void queryClient.invalidateQueries({
      queryKey: catalogListProductsQueryKey(activeCompanyId, productSearch),
    });
  }

  return {
    customers: customerRows,
    customersStatus: customers.status,
    customersError: customers.status === "error" ? customers.error : null,
    retryCustomers,
    products: productRows,
    productsStatus: products.status,
    productsError: products.status === "error" ? products.error : null,
    retryProducts,
    variants: (pickerQuery?.data?.variants ?? []).filter(
      (variant) => variant.status === "active",
    ),
    variantsStatus:
      args.variantProductId === null
        ? ("idle" as const)
        : catalogQueryLoadStatus(
            pickerQuery === undefined
              ? undefined
              : { status: pickerQuery.status },
          ),
    thumbnailsByProductId,
    catalogFacts,
    catalogFactsStatus,
    catalogFactsPending,
  };
}
