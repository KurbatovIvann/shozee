import { implementAction } from "@showzy/core";
import { CoreInvariantError } from "@showzy/core/errors";
import { companyCustomerInvites } from "@showzy/db/schema/invites";
import { paginate } from "@showzy/validation/pagination";
import { and, desc, eq, lt, or } from "drizzle-orm";

import { inviteRowColumns, toInviteView } from "../services/invite-view.js";
import {
  formatListInvitesCursor,
  listInvitesContract,
  parseListInvitesCursor,
} from "./list.contract.js";

export const listInvites = implementAction(listInvitesContract, {
  handler: async (input, ctx) => {
    const cursor =
      input.cursor === undefined
        ? undefined
        : parseListInvitesCursor(input.cursor);
    if (input.cursor !== undefined && cursor === undefined) {
      throw new CoreInvariantError(
        "listInvites cursor passed validation but failed to parse",
      );
    }

    const cursorPredicate =
      cursor === undefined
        ? undefined
        : or(
            lt(companyCustomerInvites.updatedAt, new Date(cursor.updatedAt)),
            and(
              eq(companyCustomerInvites.updatedAt, new Date(cursor.updatedAt)),
              lt(companyCustomerInvites.id, cursor.id),
            ),
          );

    const pageRows = await ctx.db
      .select(inviteRowColumns)
      .from(companyCustomerInvites)
      .where(
        and(
          eq(companyCustomerInvites.companyId, ctx.companyId),
          cursorPredicate,
        ),
      )
      .orderBy(
        desc(companyCustomerInvites.updatedAt),
        desc(companyCustomerInvites.id),
      )
      .limit(input.limit + 1);

    const { page, nextCursor } = paginate(pageRows, input.limit, (last) =>
      formatListInvitesCursor(last.updatedAt, last.id),
    );

    return {
      items: page.map((row) => toInviteView(row)),
      nextCursor,
    };
  },
});
