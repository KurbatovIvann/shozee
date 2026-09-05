import { getProductPricingFacts } from "@showzy/catalog";
import { implementAction } from "@showzy/core";
import { getCustomerPricingFacts } from "@showzy/customers/get-customer-pricing-facts";

import { resolveProductPricesForCompany } from "../services/resolve-product-prices.js";
import { resolveProductPricesContract } from "./resolve-product-prices.contract.js";

export const resolveProductPrices = implementAction(
  resolveProductPricesContract,
  {
    handler: async (input, ctx) => {
      const catalog = await ctx.call(getProductPricingFacts, {
        items: input.items,
      });
      const customer =
        input.customerId === undefined
          ? null
          : {
              customerId: input.customerId,
              ...(await ctx.call(getCustomerPricingFacts, {
                customerId: input.customerId,
              })),
            };

      const prices = await resolveProductPricesForCompany({
        tx: ctx.db,
        companyId: ctx.companyId,
        items: input.items,
        products: catalog.products,
        customer,
      });
      return { prices };
    },
  },
);
