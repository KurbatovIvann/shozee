import { implementAction } from "@showzy/core";
import { CoreInvariantError } from "@showzy/core/errors";
import { assistantConversations } from "@showzy/db/schema/assistant";
import { paginate } from "@showzy/validation/pagination";
import { and, desc, eq, lt, or } from "drizzle-orm";

import {
  conversationColumns,
  toConversationView,
} from "../services/conversation-view.js";
import {
  formatListConversationsCursor,
  listConversationsContract,
  parseListConversationsCursor,
} from "./list-conversations.contract.js";

export const listConversations = implementAction(listConversationsContract, {
  handler: async (input, ctx) => {
    const cursor =
      input.cursor === undefined
        ? undefined
        : parseListConversationsCursor(input.cursor);
    if (input.cursor !== undefined && cursor === undefined) {
      throw new CoreInvariantError(
        "listConversations cursor passed validation but failed to parse",
      );
    }

    const cursorPredicate =
      cursor === undefined
        ? undefined
        : or(
            lt(assistantConversations.updatedAt, new Date(cursor.updatedAt)),
            and(
              eq(assistantConversations.updatedAt, new Date(cursor.updatedAt)),
              lt(assistantConversations.id, cursor.id),
            ),
          );

    const pageRows = await ctx.db
      .select(conversationColumns)
      .from(assistantConversations)
      .where(
        and(
          eq(assistantConversations.companyId, ctx.companyId),
          cursorPredicate,
        ),
      )
      .orderBy(
        desc(assistantConversations.updatedAt),
        desc(assistantConversations.id),
      )
      .limit(input.limit + 1);

    const { page, nextCursor } = paginate(pageRows, input.limit, (last) =>
      formatListConversationsCursor(last.updatedAt, last.id),
    );

    return {
      items: page.map(toConversationView),
      nextCursor,
    };
  },
});
