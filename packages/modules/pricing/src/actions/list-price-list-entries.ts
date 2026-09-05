import { implementAction } from "@showzy/core";
import { CoreInvariantError, NotFoundError } from "@showzy/core/errors";
import { priceListEntries, priceLists } from "@showzy/db/schema/pricing";
import { paginate } from "@showzy/validation/pagination";
import { and, desc, eq, lt, or } from "drizzle-orm";

import { toPriceListEntryView } from "../services/price-list-entry-view.js";
import {
  formatListPriceListEntriesCursor,
  listPriceListEntriesContract,
  parseListPriceListEntriesCursor,
} from "./list-price-list-entries.contract.js";

export const listPriceListEntries = implementAction(
  listPriceListEntriesContract,
  {
    handler: async (input, ctx) => {
      const list = (
        await ctx.db
          .select({ id: priceLists.id })
          .from(priceLists)
          .where(
            and(
              eq(priceLists.companyId, ctx.companyId),
              eq(priceLists.id, input.priceListId),
            ),
          )
          .limit(1)
      )[0];
      if (list === undefined) {
        throw new NotFoundError();
      }

      const cursor =
        input.cursor === undefined
          ? undefined
          : parseListPriceListEntriesCursor(input.cursor);
      if (input.cursor !== undefined && cursor === undefined) {
        throw new CoreInvariantError(
          "listPriceListEntries cursor passed validation but failed to parse",
        );
      }

      const cursorPredicate =
        cursor === undefined
          ? undefined
          : or(
              lt(priceListEntries.createdAt, new Date(cursor.createdAt)),
              and(
                eq(priceListEntries.createdAt, new Date(cursor.createdAt)),
                lt(priceListEntries.id, cursor.id),
              ),
            );

      const pageRows = await ctx.db
        .select({
          id: priceListEntries.id,
          priceListId: priceListEntries.priceListId,
          productId: priceListEntries.productId,
          variantId: priceListEntries.variantId,
          priceMinor: priceListEntries.priceMinor,
          currency: priceListEntries.currency,
          createdAt: priceListEntries.createdAt,
        })
        .from(priceListEntries)
        .where(
          and(
            eq(priceListEntries.companyId, ctx.companyId),
            eq(priceListEntries.priceListId, input.priceListId),
            input.productId === undefined
              ? undefined
              : eq(priceListEntries.productId, input.productId),
            cursorPredicate,
          ),
        )
        .orderBy(desc(priceListEntries.createdAt), desc(priceListEntries.id))
        .limit(input.limit + 1);

      const { page, nextCursor } = paginate(pageRows, input.limit, (last) =>
        formatListPriceListEntriesCursor(last.createdAt, last.id),
      );

      return {
        items: page.map((row) => toPriceListEntryView(row)),
        nextCursor,
      };
    },
  },
);
