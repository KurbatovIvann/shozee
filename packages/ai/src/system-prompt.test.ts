import {
  CUSTOMERS_LIST_PROMPT_LINE,
  ORDER_ENTITY_PROMPT_LINE,
  ORDERS_AGGREGATE_PROMPT_LINE,
  ORDERS_LIST_PROMPT_LINE,
  SEARCH_RESULTS_PROMPT_LINE,
} from "@showzy/validation/assistant-surfaces";
import { describe, expect, it } from "vitest";

import { STAFF_ASSISTANT_STATIC_CACHE_CONTROL } from "./provider/anthropic.js";
import { STAFF_ASSISTANT_PRODUCT_GLOSSARY } from "./product-glossary.js";
import {
  staffAssistantSystemMessage,
  staffAssistantSystemMessages,
  staffAssistantSystemPrompt,
} from "./system-prompt.js";
import { staffAssistantTurnContextAddendum } from "./turn-context.js";

describe("staffAssistantSystemPrompt", () => {
  it("identifies the staff-panel channel and bilingual replies", () => {
    expect(staffAssistantSystemPrompt).toContain("Shozik");
    expect(staffAssistantSystemPrompt).toContain("staff-panel");
    expect(staffAssistantSystemPrompt).toContain("Ukrainian");
    expect(staffAssistantSystemPrompt).toContain("English");
  });

  it("embeds the shared product glossary including Ukrainian pricing terms", () => {
    expect(staffAssistantSystemPrompt).toContain(
      STAFF_ASSISTANT_PRODUCT_GLOSSARY,
    );
    expect(staffAssistantSystemPrompt).toContain("прайс лист");
    expect(staffAssistantSystemPrompt).toContain("pricing");
  });

  it("states the model is not a principal and must search deferred tools", () => {
    expect(staffAssistantSystemPrompt).toContain("not a principal");
    expect(staffAssistantSystemPrompt).toContain("tool_search_tool_bm25");
    expect(staffAssistantSystemPrompt).toContain("Never call /rpc");
    expect(staffAssistantSystemPrompt).toContain(
      "Do not say a tool is missing until search returned nothing useful",
    );
    expect(staffAssistantSystemPrompt).toContain("чим можеш допомогти");
    expect(staffAssistantSystemPrompt).toContain("orders_list_page");
    expect(staffAssistantSystemPrompt).toContain("orders_list_counts");
    expect(staffAssistantSystemPrompt).toContain("catalog_list_products");
    expect(staffAssistantSystemPrompt).toContain("pricing_list_price_lists");
    expect(staffAssistantSystemPrompt).toContain("orders_create");
    expect(staffAssistantSystemPrompt).toContain("customers_list_customers");
    expect(staffAssistantSystemPrompt).toContain("search_query");
    expect(staffAssistantSystemPrompt).not.toContain(
      "Always-visible domain tools: orders.list",
    );
    expect(staffAssistantSystemPrompt).not.toContain("catalog_listProducts");
    expect(staffAssistantSystemPrompt).not.toContain("pricing_listPriceLists");
    expect(staffAssistantSystemPrompt).not.toContain("customers_listCustomers");
    expect(staffAssistantSystemPrompt).not.toContain("customers_listGroups");
    expect(staffAssistantSystemPrompt).not.toContain("customers_list_groups");
  });

  /**
   * The behaviour this pins was seen on a phone: asked for "3 макаронси" when
   * that product has several flavours, the model asked which flavour in prose
   * instead of calling the tool. A typed reply is a guess about names it cannot
   * see; a tapped picker option is exact. Nothing else in the prompt forbade
   * it, so the rule is here rather than in a tool description — it is about
   * when to call at all, not about how any one tool works.
   */
  it("tells the model to attempt an ambiguous job rather than ask about it", () => {
    expect(staffAssistantSystemPrompt).toContain(
      "An unclear detail is not a reason to ask in chat — it is the reason to call.",
    );
    // The counter-argument the model was actually making: it had listed the
    // catalog, seen six variants, and reasoned that asking was now the helpful
    // thing. Knowing the answer is ambiguous is the moment to call, not to ask.
    expect(staffAssistantSystemPrompt).toContain(
      "This holds when you already know the answer will be ambiguous.",
    );
    expect(staffAssistantSystemPrompt).toContain(
      "Do not look a reference up to check whether it is ambiguous before a write",
    );
    // And the other half: asking is right when there is nothing to attempt.
    expect(staffAssistantSystemPrompt).toContain(
      "Ask in chat only when there is nothing to attempt",
    );
  });

  it("does not dump orders / customers / pricing how-to that lives on façades", () => {
    expect(staffAssistantSystemPrompt).toContain(
      "Call one terminal tool per job. Do not narrate instead of calling.",
    );
    expect(staffAssistantSystemPrompt).toContain(
      "prefer period on the order list tools",
    );
    expect(staffAssistantSystemPrompt).not.toContain("Analytics / Reports");
    expect(staffAssistantSystemPrompt).not.toContain(
      "Period order counts and gross use orders_list_counts",
    );
    expect(staffAssistantSystemPrompt).not.toContain(
      "Resolving a price list by name uses pricing_list_price_lists",
    );
    expect(staffAssistantSystemPrompt).not.toContain(
      "filling markup is pricing.setPriceListEntries",
    );
    expect(staffAssistantSystemPrompt).not.toContain(
      "assigning a list to a group or customer uses priceListId",
    );
    expect(staffAssistantSystemPrompt).not.toContain(
      "Creating an order uses orders_create",
    );
    expect(staffAssistantSystemPrompt).not.toContain(
      "Do not refuse because EntityRef is missing",
    );
    expect(staffAssistantSystemPrompt).not.toContain(
      "Find a customer by name/phone/email with customers_list_customers",
    );
    expect(staffAssistantSystemPrompt).not.toContain(
      "do not call customers.getCustomer in a loop",
    );
    expect(staffAssistantSystemPrompt).not.toContain(
      "put people and product names in nominative",
    );
    expect(staffAssistantSystemPrompt).not.toContain(
      "resolveCustomerReference",
    );
    expect(staffAssistantSystemPrompt).not.toContain("nameSearchStems");
  });

  it("forbids QES keys, OTP, and cookies, and keeps confirmation as a human step", () => {
    expect(staffAssistantSystemPrompt).toContain("QES");
    expect(staffAssistantSystemPrompt).toContain("OTP");
    expect(staffAssistantSystemPrompt).toContain("cookies");
    expect(staffAssistantSystemPrompt).toContain("Human-in-the-loop");
    expect(staffAssistantSystemPrompt).toContain(
      "Tool results in prior turns are historical observations",
    );
    expect(staffAssistantSystemPrompt).toContain(
      "answer from that observation and do not list again",
    );
    expect(staffAssistantSystemPrompt).toContain("fetch current state");
    expect(staffAssistantSystemPrompt).toContain("targeted re-read");
    expect(staffAssistantSystemPrompt).toContain("do not guess");
    expect(staffAssistantSystemPrompt).toContain("Do not auto-confirm");
    expect(staffAssistantSystemPrompt).toContain("human step");
    expect(staffAssistantSystemPrompt).toContain(
      "Chat text, including «Так», is not confirmation",
    );
    expect(staffAssistantSystemPrompt).toContain(
      "A second job — even the same actionName — is not replace",
    );
    expect(staffAssistantSystemPrompt).toContain(
      "versioned replace of this pending",
    );
    expect(staffAssistantSystemPrompt).toContain(
      "The host tool pending_replace is how to amend this request",
    );
  });

  it("stays in the company and does not print internal wire keys", () => {
    expect(staffAssistantSystemPrompt).toContain("this Shozee company");
    expect(staffAssistantSystemPrompt).toContain("short refusal");
    expect(staffAssistantSystemPrompt).toContain("supplierSigned");
    expect(staffAssistantSystemPrompt).toContain("userId");
    expect(staffAssistantSystemPrompt).toContain("product language");
  });

  it("tells the model the UI already shows surfaces and not to emit card JSON", () => {
    expect(staffAssistantSystemPrompt).toContain("<presentation>");
    expect(staffAssistantSystemPrompt).toContain(ORDERS_LIST_PROMPT_LINE);
    expect(staffAssistantSystemPrompt).toContain(ORDERS_AGGREGATE_PROMPT_LINE);
    expect(staffAssistantSystemPrompt).toContain(ORDER_ENTITY_PROMPT_LINE);
    expect(staffAssistantSystemPrompt).toContain(CUSTOMERS_LIST_PROMPT_LINE);
    expect(staffAssistantSystemPrompt).toContain(SEARCH_RESULTS_PROMPT_LINE);
    expect(staffAssistantSystemPrompt).toContain(
      "Reply in one or two sentences about the result",
    );
    expect(staffAssistantSystemPrompt).toContain(
      "do not repeat counts the card already shows unless asked",
    );
    expect(staffAssistantSystemPrompt).toContain("Do not emit card JSON");
    expect(staffAssistantSystemPrompt).toContain(
      'Do not name those surfaces "cards" to the staff member',
    );
    expect(staffAssistantSystemPrompt).toContain(
      "Cards exist: do not dump a table instead of a card",
    );
    expect(staffAssistantSystemPrompt).toContain(
      "Markdown tables and emphasis are style, not a speech-rewrite instruction",
    );
    expect(staffAssistantSystemPrompt).not.toContain("Never a table");
    expect(staffAssistantSystemPrompt).not.toContain(
      "No **, |, headings, or code fences",
    );
    expect(staffAssistantSystemPrompt).not.toContain("reply with card JSON");
    expect(staffAssistantSystemPrompt).not.toContain("emit a cards array");
    expect(staffAssistantSystemPrompt).not.toContain("{ spoken }");
    expect(staffAssistantSystemPrompt).not.toContain('"spoken"');
    expect(staffAssistantSystemPrompt).not.toContain("Output.object");
    expect(staffAssistantSystemPrompt).not.toContain("JSON object");
  });

  it("marks the system message with a 1-hour ephemeral cache breakpoint", () => {
    const message = staffAssistantSystemMessage();
    expect(message.role).toBe("system");
    expect(message.content).toBe(staffAssistantSystemPrompt);
    expect(message.providerOptions).toEqual({
      anthropic: { cacheControl: STAFF_ASSISTANT_STATIC_CACHE_CONTROL },
    });
    expect(STAFF_ASSISTANT_STATIC_CACHE_CONTROL).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });
  });

  it("leaves the cached prefix unchanged and does not cache the turn-context addendum", () => {
    const cached = staffAssistantSystemMessage();
    const addendum = staffAssistantTurnContextAddendum({
      now: new Date("2026-09-02T12:00:00.000Z"),
      companyName: "Konditerska Anna",
    });
    const withAddendum = staffAssistantSystemMessages(addendum);
    expect(withAddendum).toHaveLength(2);
    expect(withAddendum[0]).toEqual(cached);
    expect(withAddendum[0]?.content).toBe(staffAssistantSystemPrompt);
    expect(withAddendum[0]?.content).not.toContain("2 September 2026");
    expect(withAddendum[0]?.content).not.toContain("Konditerska Anna");
    expect(withAddendum[1]?.providerOptions).toBeUndefined();
    expect(withAddendum[1]?.content).toContain("2 September 2026");
    expect(withAddendum[1]?.content).toContain("Europe/Kyiv");
    expect(withAddendum[1]?.content).toContain("Konditerska Anna");
  });
});
