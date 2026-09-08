import { activatePriceList } from "./actions/activate-price-list.js";
import { createPriceList } from "./actions/create-price-list.js";
import { deactivatePriceList } from "./actions/deactivate-price-list.js";
import { deletePriceList } from "./actions/delete-price-list.js";
import { getPriceList } from "./actions/get-price-list.js";
import { listPriceListEntries } from "./actions/list-price-list-entries.js";
import { listPriceLists } from "./actions/list-price-lists.js";
import { removePriceListEntries } from "./actions/remove-price-list-entries.js";
import { resolveProductPrices } from "./actions/resolve-product-prices.js";
import { searchMatches } from "./actions/search-matches.js";
import { setDefaultPriceList } from "./actions/set-default-price-list.js";
import { setPriceListEntries } from "./actions/set-price-list-entries.js";
import { updatePriceList } from "./actions/update-price-list.js";

export { activatePriceList };
export { createPriceList };
export { deactivatePriceList };
export { deletePriceList };
export { getPriceList };
export { listPriceListEntries };
export { listPriceLists };
export { removePriceListEntries };
export { resolveProductPrices };
export { searchMatches };
export { setDefaultPriceList };
export { setPriceListEntries };
export { updatePriceList };

export const pricingActions = [
  activatePriceList,
  createPriceList,
  deactivatePriceList,
  deletePriceList,
  getPriceList,
  listPriceListEntries,
  listPriceLists,
  removePriceListEntries,
  resolveProductPrices,
  searchMatches,
  setDefaultPriceList,
  setPriceListEntries,
  updatePriceList,
] as const;
