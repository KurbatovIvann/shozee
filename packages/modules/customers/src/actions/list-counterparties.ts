import { implementAction } from "@showzy/core";
import { CoreInvariantError } from "@showzy/core/errors";
import { counterparties } from "@showzy/db/schema/customers";
import { likeContainsPattern, paginate } from "@showzy/validation/pagination";
import { and, desc, eq, ilike, lt, or } from "drizzle-orm";

import {
  counterpartyReturning,
  customerNamesByIds,
  toCounterpartyView,
} from "../services/counterparty-view.js";
import {
  formatListCounterpartiesCursor,
  listCounterpartiesContract,
  parseListCounterpartiesCursor,
} from "./list-counterparties.contract.js";

export const listCounterparties = implementAction(listCounterpartiesContract, {
  handler: async (input, ctx) => {
    const searchPattern =
      input.search === undefined
        ? undefined
        : likeContainsPattern(input.search);
    if (input.search !== undefined && searchPattern === undefined) {
      return { items: [], nextCursor: null };
    }

    const cursor =
      input.cursor === undefined
        ? undefined
        : parseListCounterpartiesCursor(input.cursor);
    if (input.cursor !== undefined && cursor === undefined) {
      throw new CoreInvariantError(
        "listCounterparties cursor passed validation but failed to parse",
      );
    }

    const cursorPredicate =
      cursor === undefined
        ? undefined
        : or(
            lt(counterparties.updatedAt, new Date(cursor.updatedAt)),
            and(
              eq(counterparties.updatedAt, new Date(cursor.updatedAt)),
              lt(counterparties.id, cursor.id),
            ),
          );

    const searchPredicate =
      searchPattern === undefined
        ? undefined
        : or(
            ilike(counterparties.name, searchPattern),
            ilike(counterparties.edrpou, searchPattern),
          );

    const pageRows = await ctx.db
      .select(counterpartyReturning)
      .from(counterparties)
      .where(
        and(
          eq(counterparties.companyId, ctx.companyId),
          input.customerId === undefined
            ? undefined
            : eq(counterparties.customerId, input.customerId),
          searchPredicate,
          cursorPredicate,
        ),
      )
      .orderBy(desc(counterparties.updatedAt), desc(counterparties.id))
      .limit(input.limit + 1);

    const { page, nextCursor } = paginate(pageRows, input.limit, (last) =>
      formatListCounterpartiesCursor(last.updatedAt, last.id),
    );

    const linkedCustomerIds = page.flatMap((row) =>
      row.customerId === null ? [] : [row.customerId],
    );
    const names = await customerNamesByIds(
      ctx.db,
      ctx.companyId,
      linkedCustomerIds,
    );

    return {
      items: page.map((row) =>
        toCounterpartyView(
          row,
          row.customerId === null ? null : (names.get(row.customerId) ?? null),
        ),
      ),
      nextCursor,
    };
  },
});
