import { getProductPricingFacts } from "@showzy/catalog";
import { implementAction } from "@showzy/core";
import { priceListAuditTarget } from "../services/price-list-audit-target.js";
import { setStaffPriceListEntries } from "../services/set-price-list-entries.js";
import { setPriceListEntriesContract } from "./set-price-list-entries.contract.js";

export const setPriceListEntries = implementAction(
  setPriceListEntriesContract,
  {
    handler: async (input, ctx) => {
      await ctx.call(getProductPricingFacts, {
        items: input.entries.map((entry) =>
          entry.variantId === undefined
            ? { productId: entry.productId }
            : { productId: entry.productId, variantId: entry.variantId },
        ),
      });

      return setStaffPriceListEntries({ ctx, input });
    },
    auditTarget: priceListAuditTarget,
  },
);
