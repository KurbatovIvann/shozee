import { implementAction } from "@showzy/core";
import { CoreInvariantError } from "@showzy/core/errors";
import { priceLists } from "@showzy/db/schema/pricing";
import { likeContainsPattern, paginate } from "@showzy/validation/pagination";
import { and, asc, desc, eq, gt, ilike, or } from "drizzle-orm";

import { countEntriesByPriceListIds } from "../services/count-price-list-entries.js";
import {
  formatListPriceListsCursor,
  listPriceListsContract,
  parseListPriceListsCursor,
} from "./list-price-lists.contract.js";

export const listPriceLists = implementAction(listPriceListsContract, {
  handler: async (input, ctx) => {
    const searchPattern =
      input.query === undefined ? undefined : likeContainsPattern(input.query);
    if (input.query !== undefined && searchPattern === undefined) {
      return { items: [], nextCursor: null };
    }

    const cursor =
      input.cursor === undefined
        ? undefined
        : parseListPriceListsCursor(input.cursor);
    if (input.cursor !== undefined && cursor === undefined) {
      throw new CoreInvariantError(
        "listPriceLists cursor passed validation but failed to parse",
      );
    }

    const cursorPredicate =
      cursor === undefined
        ? undefined
        : or(
            cursor.isDefault ? eq(priceLists.isDefault, false) : undefined,
            and(
              eq(priceLists.isDefault, cursor.isDefault),
              gt(priceLists.name, cursor.name),
            ),
            and(
              eq(priceLists.isDefault, cursor.isDefault),
              eq(priceLists.name, cursor.name),
              gt(priceLists.id, cursor.id),
            ),
          );

    const pageRows = await ctx.db
      .select({
        id: priceLists.id,
        name: priceLists.name,
        isDefault: priceLists.isDefault,
        isActive: priceLists.isActive,
      })
      .from(priceLists)
      .where(
        and(
          eq(priceLists.companyId, ctx.companyId),
          input.availability === "all"
            ? undefined
            : eq(priceLists.isActive, input.availability === "active"),
          searchPattern === undefined
            ? undefined
            : ilike(priceLists.name, searchPattern),
          cursorPredicate,
        ),
      )
      .orderBy(
        desc(priceLists.isDefault),
        asc(priceLists.name),
        asc(priceLists.id),
      )
      .limit(input.limit + 1);

    const { page, nextCursor } = paginate(pageRows, input.limit, (last) =>
      formatListPriceListsCursor(last.isDefault, last.id, last.name),
    );

    const entryCounts = await countEntriesByPriceListIds(
      ctx.db,
      ctx.companyId,
      page.map((row) => row.id),
    );

    return {
      items: page.map((row) => ({
        id: row.id,
        name: row.name,
        isDefault: row.isDefault,
        isActive: row.isActive,
        entryCount: entryCounts.get(row.id) ?? 0,
      })),
      nextCursor,
    };
  },
});
