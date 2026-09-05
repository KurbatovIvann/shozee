import { implementAction } from "@showzy/core";
import { NotFoundError } from "@showzy/core/errors";
import { companyCustomers, customerGroups } from "@showzy/db/schema/customers";
import { and, eq } from "drizzle-orm";

import { getCustomerPricingFactsContract } from "./get-customer-pricing-facts.contract.js";

export const getCustomerPricingFacts = implementAction(
  getCustomerPricingFactsContract,
  {
    handler: async (input, ctx) => {
      const rows = await ctx.db
        .select({
          priceListId: companyCustomers.priceListId,
          groupId: companyCustomers.groupId,
          groupPriceListId: customerGroups.priceListId,
        })
        .from(companyCustomers)
        .leftJoin(
          customerGroups,
          and(
            eq(customerGroups.companyId, companyCustomers.companyId),
            eq(customerGroups.id, companyCustomers.groupId),
          ),
        )
        .where(
          and(
            eq(companyCustomers.companyId, ctx.companyId),
            eq(companyCustomers.id, input.customerId),
          ),
        );

      const row = rows[0];
      if (row === undefined) {
        throw new NotFoundError();
      }

      return {
        priceListId: row.priceListId,
        groupId: row.groupId,
        groupPriceListId: row.groupPriceListId,
      };
    },
  },
);
