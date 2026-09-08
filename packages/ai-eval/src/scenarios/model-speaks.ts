import {
  CUSTOMERS_LIST_CUSTOMERS_TOOL_NAME,
  ORDERS_LIST_COUNTS_TOOL_NAME,
  ORDERS_LIST_PAGE_TOOL_NAME,
} from "@showzy/ai";

import type { EvalScenario } from "../scenario.js";

const FORBIDDEN_ENVELOPE = ['{"spoken"', '"spoken":', "```"] as const;

export const MODEL_SPEAKS_SCENARIOS: readonly EvalScenario[] = [
  {
    id: "t6.model-speaks.last-3-orders",
    description:
      "«останні 3 замовлення» lists a page; final text contains an order number from the tool result, not a card dump.",
    fixture: "proof",
    host: "new",
    turns: [{ text: "останні 3 замовлення" }],
    expectation: {
      ordered: [{ name: ORDERS_LIST_PAGE_TOOL_NAME }],
      textIncludesToolValues: ["orderNumber"],
      textExcludes: [...FORBIDDEN_ENVELOPE],
      speechSource: "model",
    },
  },
  {
    id: "t6.model-speaks.counts-this-week",
    description:
      "«скільки замовлень цього тижня» uses orders_list_counts; final text contains the count from the tool result.",
    fixture: "proof",
    host: "new",
    turns: [{ text: "скільки замовлень цього тижня" }],
    expectation: {
      ordered: [
        {
          name: ORDERS_LIST_COUNTS_TOOL_NAME,
          args: { period: "this_week" },
        },
      ],
      textIncludesToolValues: ["orderCount"],
      textExcludes: [...FORBIDDEN_ENVELOPE],
      speechSource: "model",
    },
  },
  {
    id: "t6.model-speaks.find-customer-katya",
    description:
      "«знайди клієнта Катя» lists customers; final text contains the customer name from the tool result.",
    fixture: "proof",
    host: "new",
    turns: [{ text: "знайди клієнта Катя" }],
    expectation: {
      ordered: [{ name: CUSTOMERS_LIST_CUSTOMERS_TOOL_NAME }],
      textIncludesToolValues: ["customerName"],
      textExcludes: [...FORBIDDEN_ENVELOPE],
      speechSource: "model",
    },
  },
];
