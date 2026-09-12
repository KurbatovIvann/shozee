import { useInfiniteQuery, useQueries } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";

import {
  catalogFactsBlockSubmit,
  catalogFactsFromProduct,
  catalogQueryLoadStatus,
  classifyCatalogFactsLoad,
  overlayCatalogVariantCount,
  uniqueProductIds,
  type CatalogFactsLoadStatus,
  type CatalogFactsQuerySnapshot,
  type OrderLineCatalogFacts,
  type OrderLineCatalogFactsMap,
} from "@showzy/validation/order-line-catalog-facts";

import { useApiClient } from "../../../api/api-provider";
import { useActiveCompany } from "../../../api/query-provider";
import { useResolvedCompany } from "../../../company-resolution/resolved-company-provider";
import { flattenPages, optionSelectItems } from "../../../components/ui";
import { useDebouncedValue } from "../../../hooks/use-debounced-value";
import {
  getOrderCatalogProductQueryOptions,
  listOrderProductsInfiniteOptions,
  orderProductsLookupInput,
} from "../api/order-catalog-query";
import {
  listOrderCustomersInfiniteOptions,
  orderCustomersLookupInput,
} from "../api/order-customers-query";
import {
  normalizeOrderCustomerSearch,
  normalizeOrderProductQuery,
} from "../shared/order-caps";
import { canFetchFileDownloadUrls } from "../shared/order-permissions";
import {
  draftLineThumbnailItems,
  orderThumbnailView,
  type OrderThumbnailView,
} from "../shared/order-thumbnails";
import { useOrderThumbnails } from "../shared/use-order-thumbnails";
import type { ProductVariantsLoadStatus } from "./product-select";

const LOOKUP_SEARCH_DEBOUNCE_MS = 300;

export type OrderFormProductRow = {
  readonly id: string;
  readonly name: string;
  readonly variantCount: number;
  readonly primaryImageFileId: string | null;
};

export type OrderFormThumbnail = OrderThumbnailView;

export function useOrderFormLookups(args: {
  readonly enabled: boolean;
  readonly variantProductId: string | null;
  readonly draftProductIds: readonly string[];
}): {
  readonly customerOptions: ReturnType<typeof optionSelectItems>;
  readonly customerQuery: string;
  readonly onCustomerQueryChange: (value: string) => void;
  readonly customersLoadingMore: boolean;
  readonly onCustomersEndReached: () => void;
  readonly productRows: readonly OrderFormProductRow[];
  readonly productQuery: string;
  readonly onProductQueryChange: (value: string) => void;
  readonly productsLoadingMore: boolean;
  readonly onProductsEndReached: () => void;
  readonly variantOptions: ReturnType<typeof optionSelectItems>;
  readonly variantsStatus: ProductVariantsLoadStatus;
  readonly thumbnailsByProductId: ReadonlyMap<string, OrderFormThumbnail>;
  readonly catalogFacts: OrderLineCatalogFactsMap;
  readonly catalogFactsStatus: CatalogFactsLoadStatus;
  readonly catalogFactsPending: boolean;
} {
  const apiClient = useApiClient();
  const { activeCompanyId } = useActiveCompany();
  const membership = useResolvedCompany();
  const getActiveCompany = () => apiClient?.getActiveCompany() ?? null;
  const enabled = args.enabled;
  const canFetchThumbnails = canFetchFileDownloadUrls(membership);
  const catalogProductIds = uniqueProductIds([
    ...args.draftProductIds,
    args.variantProductId,
  ]);

  const [customerQuery, setCustomerQuery] = useState("");
  const debouncedCustomerQuery = useDebouncedValue(
    customerQuery,
    LOOKUP_SEARCH_DEBOUNCE_MS,
  );
  const customerSearch = normalizeOrderCustomerSearch(debouncedCustomerQuery);

  const [productQuery, setProductQuery] = useState("");
  const debouncedProductQuery = useDebouncedValue(
    productQuery,
    LOOKUP_SEARCH_DEBOUNCE_MS,
  );
  const productSearch = normalizeOrderProductQuery(debouncedProductQuery);

  const customersQuery = useInfiniteQuery(
    listOrderCustomersInfiniteOptions({
      client: apiClient,
      companyId: activeCompanyId,
      input: orderCustomersLookupInput(customerSearch),
      getActiveCompany,
      enabled,
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

  const productsQuery = useInfiniteQuery(
    listOrderProductsInfiniteOptions({
      client: apiClient,
      companyId: activeCompanyId,
      input: orderProductsLookupInput(productSearch),
      getActiveCompany,
      enabled,
    }),
  );
  const productsHasNextPage = productsQuery.hasNextPage;
  const productsFetchingNextPage = productsQuery.isFetchingNextPage;
  const productsFetchNextPage = productsQuery.fetchNextPage;
  const onProductsEndReached = useCallback(() => {
    if (productsHasNextPage && !productsFetchingNextPage) {
      void productsFetchNextPage();
    }
  }, [productsFetchNextPage, productsFetchingNextPage, productsHasNextPage]);

  const productQueries = useQueries({
    queries: catalogProductIds.map((productId) => {
      const options = getOrderCatalogProductQueryOptions({
        client: apiClient,
        companyId: activeCompanyId,
        productId,
        getActiveCompany,
      });
      return {
        ...options,
        enabled: options.enabled && enabled,
      };
    }),
  });

  const draftCatalogIds = uniqueProductIds(args.draftProductIds);
  const draftThumbnailItems = useMemo(
    () =>
      draftLineThumbnailItems(
        draftCatalogIds,
        catalogProductIds,
        productQueries.map((query) => query.data?.imageFileIds),
      ),
    [catalogProductIds, draftCatalogIds, productQueries],
  );

  const productPages = productsQuery.data?.pages ?? [];
  const { urlsByFileId, failedFileIds } = useOrderThumbnails({
    client: apiClient,
    companyId: activeCompanyId,
    getActiveCompany,
    pages: [...productPages, { items: draftThumbnailItems }],
    enabled: enabled && canFetchThumbnails,
  });

  const customerOptions = useMemo(() => {
    if (customersQuery.data === undefined) {
      return [];
    }
    const rows = flattenPages(customersQuery.data.pages);
    return optionSelectItems(
      rows.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.phone,
      })),
    );
  }, [customersQuery.data]);

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

  const productRows = useMemo((): readonly OrderFormProductRow[] => {
    if (productsQuery.data === undefined) {
      return [];
    }
    return flattenPages(productsQuery.data.pages).map((row) => ({
      id: row.id,
      name: row.name,
      variantCount: overlayCatalogVariantCount(
        row.variantCount,
        catalogFacts.get(row.id),
      ),
      primaryImageFileId: row.primaryImageFileId,
    }));
  }, [catalogFacts, productsQuery.data]);

  const thumbnailsByProductId = useMemo(() => {
    const map = new Map<string, OrderFormThumbnail>();
    const buildThumbnail = (rawFileId: string | null): OrderFormThumbnail => {
      const fileId = canFetchThumbnails ? rawFileId : null;
      return orderThumbnailView({
        fileId,
        url: fileId === null ? undefined : urlsByFileId.get(fileId),
        downloadFailed: fileId !== null && failedFileIds.has(fileId),
      });
    };
    for (const row of productRows) {
      map.set(row.id, buildThumbnail(row.primaryImageFileId));
    }
    for (const item of draftThumbnailItems) {
      if (!map.has(item.productId)) {
        map.set(item.productId, buildThumbnail(item.primaryImageFileId));
      }
    }
    return map;
  }, [
    canFetchThumbnails,
    draftThumbnailItems,
    failedFileIds,
    productRows,
    urlsByFileId,
  ]);

  const pickerIndex =
    args.variantProductId === null
      ? -1
      : catalogProductIds.indexOf(args.variantProductId);
  const pickerQuery = pickerIndex < 0 ? undefined : productQueries[pickerIndex];

  const variantOptions = useMemo(() => {
    if (pickerQuery?.data === undefined) {
      return [];
    }
    return optionSelectItems(
      pickerQuery.data.variants
        .filter((variant) => variant.status === "active")
        .map((variant) => ({
          id: variant.id,
          name: variant.name,
        })),
    );
  }, [pickerQuery?.data]);

  return {
    customerOptions,
    customerQuery,
    onCustomerQueryChange: setCustomerQuery,
    customersLoadingMore: customersQuery.isFetching,
    onCustomersEndReached,
    productRows,
    productQuery,
    onProductQueryChange: setProductQuery,
    productsLoadingMore: productsQuery.isFetching,
    onProductsEndReached,
    variantOptions,
    variantsStatus:
      args.variantProductId === null
        ? "idle"
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
