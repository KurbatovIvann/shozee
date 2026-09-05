import { implementAction } from "@showzy/core";

import { executeListOrders } from "../services/order-list/index.js";
import { listOrdersContract } from "./list.contract.js";

export const listOrders = implementAction(listOrdersContract, {
  handler: (input, ctx) => executeListOrders(input, ctx),
});
