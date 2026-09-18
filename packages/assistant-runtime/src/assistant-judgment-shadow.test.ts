import { STAFF_ASSISTANT_TOOL_SEARCH_NAME } from "@showzy/ai";
import type { ModelMessage } from "@showzy/assistant-kit";
import { describe, expect, it } from "vitest";

import {
  earlierExchanges,
  firstToolCall,
  lastUserText,
} from "./assistant-judgment-shadow.js";

const call = (toolName: string, input: unknown): ModelMessage => ({
  role: "assistant",
  content: [
    { type: "text", text: "Зараз подивлюсь." },
    { type: "tool-call", toolCallId: "call_1", toolName, input },
  ],
});

describe("lastUserText", () => {
  it("reads the person's latest message, whatever its shape", () => {
    expect(
      lastUserText([{ role: "user", content: "  Покажи клієнтів " }]),
    ).toBe("Покажи клієнтів");
    expect(
      lastUserText([
        {
          role: "user",
          content: [
            { type: "text", text: "Покажи" },
            { type: "text", text: "клієнтів" },
          ],
        },
      ]),
    ).toBe("Покажи клієнтів");
  });

  it("has nothing to plan from when the history does not end with the person", () => {
    expect(lastUserText([])).toBeUndefined();
    expect(lastUserText([{ role: "user", content: "   " }])).toBeUndefined();
    expect(
      lastUserText([
        { role: "user", content: "Покажи клієнтів" },
        { role: "assistant", content: "Ось вони." },
      ]),
    ).toBeUndefined();
  });
});

describe("firstToolCall", () => {
  it("is the model's first staff tool call, not the provider's tool search", () => {
    expect(
      firstToolCall([
        call(STAFF_ASSISTANT_TOOL_SEARCH_NAME, { query: "customers" }),
        call("customers_list_customers", { search: "Олена" }),
        call("orders_list_page", {}),
      ]),
    ).toEqual({
      toolName: "customers_list_customers",
      input: { search: "Олена" },
    });
  });

  it("is absent for a turn that only talked", () => {
    expect(
      firstToolCall([{ role: "assistant", content: "Привіт!" }]),
    ).toBeUndefined();
  });
});

describe("earlierExchanges", () => {
  it("pairs what the person asked with what the assistant said, without tool traffic or the latest message", () => {
    expect(
      earlierExchanges([
        { role: "user", content: "Скільки замовлень сьогодні?" },
        call("orders_list_counts", { period: "today" }),
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call_1",
              toolName: "orders_list_counts",
              output: { type: "json", value: { total: 12 } },
            },
          ],
        },
        { role: "assistant", content: "Сьогодні 12 замовлень." },
        { role: "user", content: "А за тиждень?" },
      ]),
    ).toEqual([
      {
        user: "Скільки замовлень сьогодні?",
        assistant: "Зараз подивлюсь. Сьогодні 12 замовлень.",
      },
    ]);
  });

  it("keeps the last three exchanges and is empty for an opening message", () => {
    const history = [1, 2, 3, 4].flatMap((n): ModelMessage[] => [
      { role: "user", content: `питання ${String(n)}` },
      { role: "assistant", content: `відповідь ${String(n)}` },
    ]);
    expect(
      earlierExchanges([...history, { role: "user", content: "і ще?" }]).map(
        (exchange) => exchange.user,
      ),
    ).toEqual(["питання 2", "питання 3", "питання 4"]);
    expect(earlierExchanges([{ role: "user", content: "Привіт" }])).toEqual([]);
  });
});
