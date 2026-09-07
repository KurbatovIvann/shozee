import {
  ORDERS_CREATE_TOOL_NAME,
  ORDERS_LIST_COUNTS_TOOL_NAME,
  ORDERS_LIST_PAGE_TOOL_NAME,
} from "@showzy/ai";

import type { EvalScenario } from "../scenario.js";
import { PROOF_CUSTOMER_NAME } from "./proof.js";

export const T7_CAKE_PRODUCT_NAME = "Торт";
export const T7_MACARONS_PRODUCT_NAME = "Макаронси";
export const T7_MACARONS_LEMON_VARIANT = "Лемон";
export const T7_MACARONS_VANILLA_VARIANT = "Ваніль";

const FORBIDDEN_ENVELOPE = ['{"spoken"', '"spoken":', "```"] as const;

/** SHO-428 live set for T7 (gate classifies only; no forced-job tools). */
export const GATE_CLASSIFIES_SCENARIOS: readonly EvalScenario[] = [
  {
    id: "t7.sho-428.create-order-cake-macarons",
    description:
      "«створи замовлення для <клієнт> 3 торта 10 макаронс» calls orders_create. A failed write is not a success.",
    fixture: "proof",
    turns: [
      {
        text: `створи замовлення для ${PROOF_CUSTOMER_NAME} 3 торта 10 макаронс`,
      },
    ],
    expectation: {
      ordered: [
        {
          name: ORDERS_CREATE_TOOL_NAME,
          requireKeys: ["customerQuery"],
          requireItemKeys: ["productQuery"],
        },
      ],
      textExcludes: [...FORBIDDEN_ENVELOPE, "|"],
    },
  },
  {
    id: "t7.sho-428.last-3-orders",
    description:
      "«покажи останні 3 замовлення» lists a page; the tool result must succeed.",
    fixture: "proof",
    turns: [{ text: "покажи останні 3 замовлення" }],
    expectation: {
      ordered: [
        {
          name: ORDERS_LIST_PAGE_TOOL_NAME,
          requireSuccessfulResult: true,
        },
      ],
      textIncludesToolValues: ["orderNumber"],
      textExcludes: [...FORBIDDEN_ENVELOPE, "|"],
    },
  },
  {
    id: "t7.sho-428.counts-today",
    description:
      "«скільки замовлень сьогодні» uses orders_list_counts period today with a real count.",
    fixture: "proof",
    turns: [{ text: "скільки замовлень сьогодні" }],
    expectation: {
      ordered: [
        {
          name: ORDERS_LIST_COUNTS_TOOL_NAME,
          args: { period: "today" },
          requireSuccessfulResult: true,
        },
      ],
      textIncludesToolValues: ["orderCount"],
      textExcludes: [...FORBIDDEN_ENVELOPE, "Analytics", "Reports"],
    },
  },
  {
    id: "t7.sho-428.macarons-lemon-picker",
    description:
      "«макаронс лемон» pauses on a picker (needs_choice). Prose is not a substitute.",
    fixture: "proof",
    turns: [{ text: "макаронс лемон" }],
    expectation: {
      ordered: [
        {
          name: ORDERS_CREATE_TOOL_NAME,
          requireResultStatus: "needs_choice",
        },
      ],
      requireChoice: true,
      textExcludes: [...FORBIDDEN_ENVELOPE],
    },
  },
];
