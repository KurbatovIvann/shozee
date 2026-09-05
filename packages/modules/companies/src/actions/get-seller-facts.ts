import { implementAction } from "@showzy/core";
import { loadCompanyView } from "../services/company-view.js";
import { getSellerFactsContract } from "./get-seller-facts.contract.js";

export const getSellerFacts = implementAction(getSellerFactsContract, {
  handler: async (_input, ctx) => {
    return loadCompanyView(ctx.db, ctx.companyId);
  },
});
