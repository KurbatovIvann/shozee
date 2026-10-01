import { describe, expect, it } from "vitest";

import { LIST_GROUPS_SEARCH_MAX } from "@showzy/validation/customers";

import type { GroupListItem } from "../api/group.queries";
import {
  classifyGroupsList,
  groupRowActions,
  listGroupsPageInput,
  nameById,
  normalizeCustomersSearch,
  toGroupRowView,
  LIST_GROUPS_SEARCH_MAX as presenterSearchMax,
} from "./groups-list.presenter";

function group(overrides: Partial<GroupListItem> = {}): GroupListItem {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "VIP",
    slug: "vip",
    description: "Постійні",
    priceListId: "22222222-2222-4222-8222-222222222222",
    memberCount: 3,
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z",
    ...overrides,
  };
}

describe("listGroupsPageInput", () => {
  it("omits search when empty and caps via the shared normalizer", () => {
    expect(presenterSearchMax).toBe(LIST_GROUPS_SEARCH_MAX);
    expect(listGroupsPageInput(undefined)).toEqual({});
    expect(listGroupsPageInput("vip")).toEqual({ search: "vip" });
    expect(normalizeCustomersSearch("  vip  ", LIST_GROUPS_SEARCH_MAX)).toBe(
      "vip",
    );
  });
});

describe("toGroupRowView", () => {
  it("maps member count and price-list name", () => {
    expect(
      toGroupRowView(
        group(),
        nameById([{ id: "22222222-2222-4222-8222-222222222222", name: "Опт" }]),
      ),
    ).toEqual({
      id: "11111111-1111-4111-8111-111111111111",
      name: "VIP",
      description: "Постійні",
      memberCount: 3,
      priceListName: "Опт",
    });
  });
});

describe("classifyGroupsList", () => {
  const base = {
    clientReady: true,
    status: "success" as const,
    failureKind: null,
    rowCount: 0,
    hasSearch: false,
  };

  it("splits loading, offline, search-empty, and catalog-empty", () => {
    expect(classifyGroupsList({ ...base, status: "pending" })).toEqual({
      kind: "loading",
    });
    expect(
      classifyGroupsList({
        ...base,
        status: "error",
        failureKind: "offline",
      }),
    ).toEqual({ kind: "offline" });
    expect(classifyGroupsList({ ...base, hasSearch: true })).toEqual({
      kind: "empty-search",
    });
    expect(classifyGroupsList(base)).toEqual({ kind: "empty-catalog" });
    expect(classifyGroupsList({ ...base, rowCount: 2 })).toEqual({
      kind: "rows",
    });
  });
});

describe("groupRowActions", () => {
  it("hides edit and delete together — group delete is customers:edit", () => {
    expect(groupRowActions(false)).toEqual({
      showEdit: false,
      showDelete: false,
    });
    expect(groupRowActions(true)).toEqual({
      showEdit: true,
      showDelete: true,
    });
  });
});
