/**
 * Pure view-model logic for the groups list (SHO-179).
 */
import { LIST_GROUPS_SEARCH_MAX } from "@showzy/validation/customers";

import type { QueryFailureKind } from "../../../api/errors";
import type { GroupListItem } from "../api/group.queries";
import type { ListGroupsPageInput } from "../api/group.queries";
import {
  flattenPages,
  nameById,
  normalizeCustomersSearch,
} from "../shared/paged-list";

export { LIST_GROUPS_SEARCH_MAX };
export { nameById, normalizeCustomersSearch };

export function listGroupsPageInput(
  search: string | undefined,
): ListGroupsPageInput {
  return search === undefined ? {} : { search };
}

export type GroupRowView = {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly memberCount: number;
  readonly priceListName: string | null;
};

export function toGroupRowView(
  item: GroupListItem,
  priceLists: ReadonlyMap<string, string>,
): GroupRowView {
  return {
    id: item.id,
    name: item.name,
    description: item.description,
    memberCount: item.memberCount,
    priceListName:
      item.priceListId === null
        ? null
        : (priceLists.get(item.priceListId) ?? null),
  };
}

export type GroupsListState =
  | { readonly kind: "loading" }
  | { readonly kind: "offline" }
  | { readonly kind: "error" }
  | { readonly kind: "empty-search" }
  | { readonly kind: "empty-catalog" }
  | { readonly kind: "rows" };

export function classifyGroupsList(args: {
  readonly clientReady: boolean;
  readonly status: "pending" | "error" | "success";
  readonly failureKind: QueryFailureKind | null;
  readonly rowCount: number;
  readonly hasSearch: boolean;
}): GroupsListState {
  if (!args.clientReady) {
    return { kind: "error" };
  }
  if (args.status === "pending") {
    return { kind: "loading" };
  }
  if (args.status === "error") {
    return args.failureKind === "offline"
      ? { kind: "offline" }
      : { kind: "error" };
  }
  if (args.rowCount > 0) {
    return { kind: "rows" };
  }
  return args.hasSearch ? { kind: "empty-search" } : { kind: "empty-catalog" };
}

export function flattenGroupListPages(
  pages: ReadonlyArray<{ readonly items: readonly GroupListItem[] }>,
): readonly GroupListItem[] {
  return flattenPages(pages);
}

export type GroupRowActions = {
  readonly showEdit: boolean;
  readonly showDelete: boolean;
};

/** Group delete is `customers:edit`, not `customers:delete`. */
export function groupRowActions(canEdit: boolean): GroupRowActions {
  return {
    showEdit: canEdit,
    showDelete: canEdit,
  };
}
