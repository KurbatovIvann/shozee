import { implementAction } from "@showzy/core";
import { CoreInvariantError } from "@showzy/core/errors";
import { companyCustomers } from "@showzy/db/schema/customers";
import { paginate } from "@showzy/validation/pagination";
import { and, desc, eq, lt, or } from "drizzle-orm";

import { countLinkedCounterpartiesByCustomerIds } from "../services/count-linked-counterparties.js";
import { customerListSearchPredicate } from "../services/customer-list-search.js";
import { customerColumns, toCustomerView } from "../services/customer-view.js";
import {
  formatListCustomersCursor,
  listCustomersContract,
  parseListCustomersCursor,
} from "./list-customers.contract.js";

export const listCustomers = implementAction(listCustomersContract, {
  handler: async (input, ctx) => {
    const searchPredicate =
      input.search === undefined
        ? undefined
        : customerListSearchPredicate(input.search);
    if (input.search !== undefined && searchPredicate === undefined) {
      return { items: [], nextCursor: null };
    }

    const cursor =
      input.cursor === undefined
        ? undefined
        : parseListCustomersCursor(input.cursor);
    if (input.cursor !== undefined && cursor === undefined) {
      throw new CoreInvariantError(
        "listCustomers cursor passed validation but failed to parse",
      );
    }

    const cursorPredicate =
      cursor === undefined
        ? undefined
        : or(
            lt(companyCustomers.updatedAt, new Date(cursor.updatedAt)),
            and(
              eq(companyCustomers.updatedAt, new Date(cursor.updatedAt)),
              lt(companyCustomers.id, cursor.id),
            ),
          );

    const pageRows = await ctx.db
      .select(customerColumns)
      .from(companyCustomers)
      .where(
        and(
          eq(companyCustomers.companyId, ctx.companyId),
          input.status === "all"
            ? undefined
            : eq(companyCustomers.status, input.status),
          input.groupId === undefined
            ? undefined
            : eq(companyCustomers.groupId, input.groupId),
          searchPredicate,
          cursorPredicate,
        ),
      )
      .orderBy(desc(companyCustomers.updatedAt), desc(companyCustomers.id))
      .limit(input.limit + 1);

    const { page, nextCursor } = paginate(pageRows, input.limit, (last) =>
      formatListCustomersCursor(last.updatedAt, last.id),
    );

    const linkedByCustomer = await countLinkedCounterpartiesByCustomerIds(
      ctx.db,
      ctx.companyId,
      page.map((row) => row.id),
    );

    return {
      items: page.map((row) =>
        toCustomerView(row, linkedByCustomer.get(row.id) ?? 0),
      ),
      nextCursor,
    };
  },
});
