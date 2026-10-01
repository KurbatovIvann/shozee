import { implementAction } from "@showzy/core";

import { readCatalogNameIndex } from "../services/name-index.js";
import {
  LIST_NAME_INDEX_PRODUCTS_MAX,
  LIST_NAME_INDEX_VARIANTS_MAX,
  listNameIndexContract,
} from "./list-name-index.contract.js";

export const listNameIndex = implementAction(listNameIndexContract, {
  handler: async (_input, ctx) =>
    readCatalogNameIndex({
      db: ctx.db,
      companyId: ctx.companyId,
      caps: {
        products: LIST_NAME_INDEX_PRODUCTS_MAX,
        variants: LIST_NAME_INDEX_VARIANTS_MAX,
      },
    }),
});
