import {
  CATALOG_LIST_PRODUCTS_TOOL_NAME,
  CUSTOMERS_LIST_CUSTOMERS_TOOL_NAME,
  ORDERS_LIST_COUNTS_TOOL_NAME,
  ORDERS_LIST_PAGE_TOOL_NAME,
} from "@showzy/ai";

import type { EvalScenario } from "../scenario.js";

const FORBIDDEN_LIST_TOOLS = [
  CUSTOMERS_LIST_CUSTOMERS_TOOL_NAME,
  ORDERS_LIST_PAGE_TOOL_NAME,
  ORDERS_LIST_COUNTS_TOOL_NAME,
  CATALOG_LIST_PRODUCTS_TOOL_NAME,
] as const;

/**
 * SHO-535 / SHO-526 T9 hand-run corpus. CI unit tests assert the matcher;
 * live Anthropic is not on the PR path.
 */
export const SEARCH_RESULTS_SCENARIOS: readonly EvalScenario[] = [
  {
    id: "t10.search-results.find-katya-sambuka",
    description:
      "«знайди Катю Самбуку» is one search_query, not customers_list then orders_list.",
    fixture: "proof",
    host: "new",
    turns: [{ text: "знайди Катю Самбуку" }],
    expectation: {
      ordered: [{ name: "search_query" }],
      forbidden: [...FORBIDDEN_LIST_TOOLS],
    },
  },
];
