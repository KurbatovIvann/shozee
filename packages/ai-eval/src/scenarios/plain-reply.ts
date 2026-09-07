import {
  ORDERS_LIST_COUNTS_TOOL_NAME,
  ORDERS_LIST_PAGE_TOOL_NAME,
} from "@showzy/ai";

import type { EvalScenario } from "../scenario.js";

const FORBIDDEN_ENVELOPE = ['{"spoken"', '"spoken":', "```"] as const;

export const PLAIN_REPLY_SCENARIOS: readonly EvalScenario[] = [
  {
    id: "t5.plain-reply.list",
    description:
      "«покажи останні 3 замовлення» lists a page; reply is not a JSON spoken envelope or markdown dump.",
    fixture: "proof",
    turns: [{ text: "покажи останні 3 замовлення" }],
    expectation: {
      ordered: [{ name: ORDERS_LIST_PAGE_TOOL_NAME }],
      textExcludes: [...FORBIDDEN_ENVELOPE, "|"],
    },
  },
  {
    id: "t5.plain-reply.aggregate",
    description:
      "«скільки замовлень цього тижня» uses orders_list_counts; reply is not a JSON spoken envelope or markdown dump.",
    fixture: "proof",
    turns: [{ text: "скільки замовлень цього тижня" }],
    expectation: {
      ordered: [
        {
          name: ORDERS_LIST_COUNTS_TOOL_NAME,
          args: { period: "this_week" },
        },
      ],
      textExcludes: [...FORBIDDEN_ENVELOPE, "|"],
    },
  },
  {
    id: "t5.plain-reply.chitchat",
    description:
      "«привіт» is chit-chat with no tool call and no leftover spoken JSON envelope.",
    fixture: "proof",
    turns: [{ text: "привіт" }],
    expectation: {
      none: true,
      textExcludes: [...FORBIDDEN_ENVELOPE],
      maxTextChars: 400,
    },
  },
];
