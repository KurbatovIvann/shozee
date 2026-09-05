import { implementAction } from "@showzy/core";
import { loadCompanyView } from "../services/company-view.js";
import { getCompanyContract } from "./get.contract.js";

export const getCompany = implementAction(getCompanyContract, {
  handler: async (_input, ctx) => {
    return loadCompanyView(ctx.db, ctx.companyId);
  },
});
