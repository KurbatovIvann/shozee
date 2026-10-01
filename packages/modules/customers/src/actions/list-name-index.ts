import { implementAction } from "@showzy/core";
import { companyCustomers, customerGroups } from "@showzy/db/schema/customers";
import { and, asc, eq } from "drizzle-orm";

import {
  LIST_NAME_INDEX_CUSTOMERS_MAX,
  LIST_NAME_INDEX_GROUPS_MAX,
  listNameIndexContract,
} from "./list-name-index.contract.js";

export const listNameIndex = implementAction(listNameIndexContract, {
  handler: async (_input, ctx) => {
    const customerRows = await ctx.db
      .select({ id: companyCustomers.id, name: companyCustomers.name })
      .from(companyCustomers)
      .where(
        and(
          eq(companyCustomers.companyId, ctx.companyId),
          eq(companyCustomers.status, "active"),
        ),
      )
      .orderBy(asc(companyCustomers.id))
      .limit(LIST_NAME_INDEX_CUSTOMERS_MAX + 1);

    const groupRows = await ctx.db
      .select({ id: customerGroups.id, name: customerGroups.name })
      .from(customerGroups)
      .where(eq(customerGroups.companyId, ctx.companyId))
      .orderBy(asc(customerGroups.id))
      .limit(LIST_NAME_INDEX_GROUPS_MAX + 1);

    return {
      customers: {
        items: customerRows.slice(0, LIST_NAME_INDEX_CUSTOMERS_MAX),
        truncated: customerRows.length > LIST_NAME_INDEX_CUSTOMERS_MAX,
      },
      groups: {
        items: groupRows.slice(0, LIST_NAME_INDEX_GROUPS_MAX),
        truncated: groupRows.length > LIST_NAME_INDEX_GROUPS_MAX,
      },
    };
  },
});
