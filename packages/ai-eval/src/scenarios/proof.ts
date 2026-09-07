import {
  CUSTOMERS_LIST_CUSTOMERS_TOOL_NAME,
  ORDERS_CREATE_TOOL_NAME,
  ORDERS_LIST_COUNTS_TOOL_NAME,
  ORDERS_LIST_PAGE_TOOL_NAME,
  STAFF_ASSISTANT_TOOL_SEARCH_NAME,
  toProviderToolName,
} from "@showzy/ai";

import type { EvalScenario } from "../scenario.js";

export const PROOF_CUSTOMER_NAME = "Катя Самбука";
export const PROOF_PRODUCT_NAME = "Наполеон";
export const PROOF_CUSTOMER_PHONE = "+380501112233";
export const PROOF_PRODUCT_PRICE_MINOR = "25000";

const CUSTOMERS_CREATE_TOOL_NAME = toProviderToolName(
  "customers.createCustomer",
);

export const PROOF_SCENARIOS: readonly EvalScenario[] = [
  {
    id: "proof.orders-counts-today",
    description:
      "«скільки замовлень сьогодні» uses orders_list_counts period today, not Analytics.",
    fixture: "proof",
    turns: [{ text: "скільки замовлень сьогодні" }],
    expectation: {
      ordered: [
        {
          name: ORDERS_LIST_COUNTS_TOOL_NAME,
          args: { period: "today" },
        },
      ],
      textExcludes: ["Analytics", "Reports"],
    },
  },
  {
    id: "proof.orders-for-katya",
    description:
      "«замовлення для Каті Самбуки» lists the customer with a nominative search, then the page by id.",
    fixture: "proof",
    turns: [{ text: "замовлення для Каті Самбуки" }],
    expectation: {
      ordered: [
        {
          name: CUSTOMERS_LIST_CUSTOMERS_TOOL_NAME,
          searchNominativeKatyaSambuka: true,
        },
        {
          name: ORDERS_LIST_PAGE_TOOL_NAME,
          customerIdsFromPrior: CUSTOMERS_LIST_CUSTOMERS_TOOL_NAME,
        },
      ],
    },
  },
  {
    id: "proof.create-order-katya-napoleon",
    description:
      "«створи замовлення Каті на 2 наполеони» uses orders_create queries, not customers.createCustomer.",
    fixture: "proof",
    turns: [{ text: "створи замовлення Каті на 2 наполеони" }],
    expectation: {
      ordered: [
        {
          name: ORDERS_CREATE_TOOL_NAME,
          requireKeys: ["customerQuery"],
          requireItemKeys: ["productQuery"],
        },
      ],
      forbidden: [CUSTOMERS_CREATE_TOOL_NAME],
    },
  },
  {
    id: "proof.weather-chitchat",
    description: "«яка погода» is a short refusal with no tool call.",
    fixture: "proof",
    turns: [{ text: "яка погода" }],
    expectation: {
      none: true,
      maxTextChars: 400,
    },
  },
  {
    id: "proof.capability-tool-search",
    description: "«чим можеш допомогти» calls tool_search before answering.",
    fixture: "proof",
    turns: [{ text: "чим можеш допомогти" }],
    expectation: {
      first: STAFF_ASSISTANT_TOOL_SEARCH_NAME,
    },
  },
];
