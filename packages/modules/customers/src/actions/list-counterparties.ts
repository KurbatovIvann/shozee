import { implementAction } from "@showzy/core";
import { CoreInvariantError } from "@showzy/core/errors";
import { counterparties } from "@showzy/db/schema/customers";
import {
  listNameSearch,
  pickListNameSearch,
} from "@showzy/module-kit/name-match";
import { paginate } from "@showzy/validation/pagination";
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
    const search =
      input.search === undefined
        ? undefined
        : listNameSearch(
            { name: counterparties.name, nameFts: counterparties.nameFts },
            input.search,
            (queryNormalized) =>
              ilike(counterparties.edrpou, `%${queryNormalized}%`),
          );
    if (input.search !== undefined && search === undefined) {
      return { items: [], nextCursor: null };
    }
    const scope = and(
      eq(counterparties.companyId, ctx.companyId),
      input.customerId === undefined
        ? undefined
        : eq(counterparties.customerId, input.customerId),
    );
    const searchPredicate =
      search === undefined
        ? undefined
        : await pickListNameSearch(search, async (strict) => {
            const found = await ctx.db
              .select({ id: counterparties.id })
              .from(counterparties)
              .where(and(scope, strict))
              .limit(1);
            return found.length > 0;
          });

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

    const pageRows = await ctx.db
      .select(counterpartyReturning)
      .from(counterparties)
      .where(and(scope, searchPredicate, cursorPredicate))
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
