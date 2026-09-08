import { cancelOrder } from "./actions/cancel.js";
import { completeOrder } from "./actions/complete.js";
import { confirmOrder } from "./actions/confirm.js";
import { createOrder } from "./actions/create.js";
import { getOrder } from "./actions/get.js";
import { listOrders } from "./actions/list.js";
import { searchMatches } from "./actions/search-matches.js";
import { startOrder } from "./actions/start.js";

export { cancelOrder };
export { completeOrder };
export { confirmOrder };
export { createOrder };
export { getOrder };
export { listOrders };
export { searchMatches };
export { startOrder };
export { ordersCanceled } from "./events/canceled.js";
export { ordersCompleted } from "./events/completed.js";
export { ordersConfirmed } from "./events/confirmed.js";
export { ordersCreated } from "./events/created.js";
export { ordersStarted } from "./events/started.js";

export const ordersActions = [
  createOrder,
  confirmOrder,
  startOrder,
  completeOrder,
  cancelOrder,
  getOrder,
  listOrders,
  searchMatches,
] as const;
