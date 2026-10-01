import { implementAction } from "@showzy/core";

import { readPricingNameIndex } from "../services/name-index.js";
import {
  LIST_NAME_INDEX_PRICE_LISTS_MAX,
  listNameIndexContract,
} from "./list-name-index.contract.js";

export const listNameIndex = implementAction(listNameIndexContract, {
  handler: async (_input, ctx) =>
    readPricingNameIndex({
      db: ctx.db,
      companyId: ctx.companyId,
      cap: LIST_NAME_INDEX_PRICE_LISTS_MAX,
    }),
});
