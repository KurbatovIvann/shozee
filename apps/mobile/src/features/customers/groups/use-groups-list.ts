import { useInfiniteQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { useApiClient } from "../../../api/api-provider";
import { describeQueryFailure } from "../../../api/errors";
import { useActiveCompany } from "../../../api/query-provider";
import type { CustomersCopy } from "../../../i18n/customers";
import { interpolate, type Locale } from "../../../i18n/locale";
import { listGroupsInfiniteOptions } from "../api/group.queries";
import { LIST_GROUPS_SEARCH_MAX } from "../shared/customer-caps";
import { memberCountLabel } from "../shared/member-count";
import {
  SEARCH_DEBOUNCE_MS,
  useDebouncedValue,
} from "../../../hooks/use-debounced-value";
import {
  classifyGroupsList,
  flattenGroupListPages,
  listGroupsPageInput,
  normalizeCustomersSearch,
  toGroupRowView,
  type GroupsListState,
} from "./groups-list.presenter";
import { useGroupWrites } from "./use-group-writes";

export type GroupsListRow = {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly membersLabel: string;
  readonly memberCount: number;
  readonly priceListName: string | null;
  readonly deleteA11y: string;
};

export function useGroupsList(args: {
  readonly copy: CustomersCopy;
  readonly locale: Locale;
  readonly priceListsById: ReadonlyMap<string, string>;
  readonly canCreate: boolean;
  readonly canEdit: boolean;
}) {
  const { copy, locale } = args;
  const apiClient = useApiClient();
  const { activeCompanyId } = useActiveCompany();
  const writes = useGroupWrites({
    copy,
    canEdit: args.canEdit,
  });

  const [searchText, setSearchText] = useState("");
  const debouncedSearch = useDebouncedValue(searchText, SEARCH_DEBOUNCE_MS);
  const search = normalizeCustomersSearch(
    debouncedSearch,
    LIST_GROUPS_SEARCH_MAX,
  );
  const hasSearch = search !== undefined;

  const getActiveCompany = () => apiClient?.getActiveCompany() ?? null;
  const listQuery = useInfiniteQuery(
    listGroupsInfiniteOptions({
      client: apiClient,
      companyId: activeCompanyId,
      input: listGroupsPageInput(search),
      getActiveCompany,
    }),
  );

  const rows = useMemo((): readonly GroupsListRow[] => {
    const pages = listQuery.data?.pages;
    if (pages === undefined) {
      return [];
    }
    return flattenGroupListPages(pages).map((item) => {
      const view = toGroupRowView(item, args.priceListsById);
      return {
        ...view,
        membersLabel: memberCountLabel(view.memberCount, locale, copy.members),
        deleteA11y: interpolate(copy.deleteLabel, { name: view.name }),
      };
    });
  }, [listQuery.data?.pages, args.priceListsById, locale, copy]);

  const failureKind = listQuery.isError
    ? describeQueryFailure(listQuery.error).kind
    : null;
  const state: GroupsListState = classifyGroupsList({
    clientReady: apiClient !== null && activeCompanyId !== null,
    status: listQuery.status,
    failureKind,
    rowCount: rows.length,
    hasSearch,
  });

  return {
    copy,
    state,
    rows,
    searchText,
    searchMaxLength: LIST_GROUPS_SEARCH_MAX,
    changeSearch: setSearchText,
    resetSearch: () => {
      setSearchText("");
    },
    canCreate: args.canCreate,
    canEdit: args.canEdit,
    banner: writes.banner,
    writesPending: writes.pending,
    openEdit: writes.openEdit,
    remove: writes.remove,
    refreshing: listQuery.isRefetching && !listQuery.isFetchingNextPage,
    refresh: () => {
      void listQuery.refetch();
    },
    retry: () => {
      void listQuery.refetch();
    },
    loadingMore: listQuery.isFetchingNextPage,
    loadMore: () => {
      if (listQuery.hasNextPage && !listQuery.isFetchingNextPage) {
        void listQuery.fetchNextPage();
      }
    },
  };
}

export type GroupsListModel = ReturnType<typeof useGroupsList>;
