import {
  CUSTOMERS_LIST_PROMPT_LINE,
  ORDER_ENTITY_PROMPT_LINE,
  ORDERS_AGGREGATE_PROMPT_LINE,
  ORDERS_LIST_PROMPT_LINE,
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
    expect(staffAssistantSystemPrompt).not.toContain(
      "Always-visible domain tools: orders.list",
    );
    expect(staffAssistantSystemPrompt).not.toContain("catalog_listProducts");
    expect(staffAssistantSystemPrompt).not.toContain("pricing_listPriceLists");
    expect(staffAssistantSystemPrompt).not.toContain("customers_listCustomers");
    expect(staffAssistantSystemPrompt).not.toContain("customers_listGroups");
    expect(staffAssistantSystemPrompt).not.toContain("customers_list_groups");
  });

  it("sends period order counts and gross to orders_list_counts instead of analytics tabs", () => {
    expect(staffAssistantSystemPrompt).toContain(
      "Period order counts and gross use orders_list_counts with period (today, this_week, this_month) or createdFrom / createdTo ISO",
    );
    expect(staffAssistantSystemPrompt).toContain(
      "Do not refuse those jobs as analytics",
    );
    expect(staffAssistantSystemPrompt).toContain("Analytics / Reports");
    expect(staffAssistantSystemPrompt).toContain(
      "prefer period on the order list tools",
    );
  });

  it("sends find-by-name, fill, and assign to existing pricing and customers tools", () => {
    expect(staffAssistantSystemPrompt).toContain(
      "Resolving a price list by name uses pricing_list_price_lists",
    );
    expect(staffAssistantSystemPrompt).toContain(
      "filling markup is pricing.setPriceListEntries after catalog_list_products prices",
    );
    expect(staffAssistantSystemPrompt).toContain(
      "assigning a list to a group or customer uses priceListId on the existing customers writes",
    );
  });

  it("sends unique-name order create to orders_create instead of a missing-tool refusal", () => {
    expect(staffAssistantSystemPrompt).toContain(
      "Creating an order uses orders_create",
    );
    expect(staffAssistantSystemPrompt).toContain(
      "Do not refuse because EntityRef is missing",
    );
    expect(staffAssistantSystemPrompt).toContain(
      "Do not create a customer, group, or price list in that same write",
    );
    expect(staffAssistantSystemPrompt).toContain(
      "Call one terminal tool per job. Do not narrate instead of calling.",
    );
  });

  it("sends find-customer to customers_list_customers instead of getCustomer loops", () => {
    expect(staffAssistantSystemPrompt).toContain(
      "Find a customer by name/phone/email with customers_list_customers",
    );
    expect(staffAssistantSystemPrompt).toContain(
      "do not call customers.getCustomer in a loop to recover notes",
    );
    expect(staffAssistantSystemPrompt).toContain(
      "create uses existing customers.createCustomer",
    );
  });

  it("tells the model to pass nominative names, not the whole utterance, and retry an empty page", () => {
    expect(staffAssistantSystemPrompt).toContain(
      "put people and product names in nominative (Катя Самбука, Наполеон)",
    );
    expect(staffAssistantSystemPrompt).toContain(
      "not the inflected form from the staff sentence (Каті Самбуки, наполеона)",
    );
    expect(staffAssistantSystemPrompt).toContain(
      "Pass only the name or query, not the whole utterance («замовлення для …»)",
    );
    expect(staffAssistantSystemPrompt).toContain(
      'One empty page is not "does not exist": retry with nominative',
    );
    expect(staffAssistantSystemPrompt).toContain(
      "last-name or product-name stem",
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
      workingSetAddendum:
        "Working set from earlier tool runs in this conversation (ids only; not live record state):\ncatalog.listProducts: aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
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
    expect(withAddendum[1]?.content).toContain("catalog.listProducts");
  });
});
