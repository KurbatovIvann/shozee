import { implementAction } from "@showzy/core";

import { readCustomersNameIndex } from "../services/name-index.js";
import {
  LIST_NAME_INDEX_CUSTOMERS_MAX,
  LIST_NAME_INDEX_GROUPS_MAX,
  listNameIndexContract,
} from "./list-name-index.contract.js";

export const listNameIndex = implementAction(listNameIndexContract, {
  handler: async (_input, ctx) =>
    readCustomersNameIndex({
      db: ctx.db,
      companyId: ctx.companyId,
      caps: {
        customers: LIST_NAME_INDEX_CUSTOMERS_MAX,
        groups: LIST_NAME_INDEX_GROUPS_MAX,
      },
    }),
});
