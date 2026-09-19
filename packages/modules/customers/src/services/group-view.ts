import type { z } from "zod";

import type { groupViewSchema } from "../actions/group-view.contract.js";

type GroupView = z.output<typeof groupViewSchema>;

export function toGroupView(
  row: {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
    readonly description: string | null;
    readonly priceListId: string | null;
    readonly createdAt: Date;
    readonly updatedAt: Date;
  },
  memberCount: number,
): GroupView {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    priceListId: row.priceListId,
    memberCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function storedDescription(
  description: string | null | undefined,
): string | null {
  return description === undefined || description === "" ? null : description;
}

export function storedPriceListId(
  priceListId: string | null | undefined,
): string | null {
  return priceListId === undefined ? null : priceListId;
}
