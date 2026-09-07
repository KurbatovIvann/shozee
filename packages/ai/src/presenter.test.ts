import { describe, expect, it } from "vitest";

import { STAFF_ASSISTANT_CLIPPED_STATUS } from "./clip-tool-result.js";
import { STAFF_ASSISTANT_CONFIRMATION_FALLBACK_TEXT } from "./confirmation.js";
import {
  CHOICE_TRUNCATED_COPY,
  CHOICE_TRUNCATED_MATCH_COPY,
  presentCatalogDomainError,
  presentChoiceStaffAssistantNeedsChoice,
  presentChoiceStaffAssistantTurn,
  presentCompletedStaffAssistantTurn,
  presentDomainErrorStaffAssistantTurn,
  staffAssistantPersistedTurnText,
  staffAssistantTurnUsesCompletedPresenter,
  STAFF_ASSISTANT_DEFAULT_LOCALE,
} from "./presenter.js";
import { STAFF_ASSISTANT_SUCCESS_SPOKEN_FALLBACK } from "./spoken-reply.js";
import { CUSTOMERS_LIST_CUSTOMERS_TOOL_NAME } from "./tool-facades/customers-list-customers.js";
import { ORDERS_CREATE_TOOL_NAME } from "./tool-facades/orders-create.js";
import {
  ORDERS_LIST_COUNTS_TOOL_NAME,
  ORDERS_LIST_PAGE_TOOL_NAME,
} from "./tool-facades/orders-list.js";

const ORDER_A = "11111111-1111-4111-8111-111111111111";
const ORDER_B = "22222222-2222-4222-8222-222222222222";
const MODEL_SPEAKS_LIST = "Ось три останні, найбільше — № 12";

const listPage = {
  kind: "page.summary" as const,
  requestedLimit: 2,
  rows: [
    {
      orderId: ORDER_A,
      orderNumber: "1049",
      status: "new",
      customer: { nameSnapshot: "Albina", linkedCustomerId: ORDER_A },
    },
    {
      orderId: ORDER_B,
      orderNumber: "1050",
      status: "confirmed",
      customer: { nameSnapshot: "Ivan", linkedCustomerId: ORDER_B },
    },
  ],
  hasMore: false,
  nextCursor: null,
  customerMatchTruncated: false,
};

describe("presentCompletedStaffAssistantTurn", () => {
  it("presents a list page in Ukrainian and English", () => {
    const results = [
      { toolName: ORDERS_LIST_PAGE_TOOL_NAME, output: listPage },
    ];
    expect(
      presentCompletedStaffAssistantTurn({
        locale: "uk",
        toolResults: results,
      }),
    ).toBe("Останні замовлення: #1049 (Нове), #1050 (Підтверджено).");
    expect(
      presentCompletedStaffAssistantTurn({
        locale: "en",
        toolResults: results,
      }),
    ).toBe("Latest orders: #1049 (New), #1050 (Confirmed).");
  });

  it("presents a customers list as a short product summary, not a table", () => {
    const results = [
      {
        toolName: CUSTOMERS_LIST_CUSTOMERS_TOOL_NAME,
        output: {
          items: [
            {
              id: ORDER_A,
              name: "Ivan",
              phone: "+380501112233",
              email: "ivan@example.com",
              status: "active",
              groupId: null,
              priceListId: null,
            },
            {
              id: ORDER_B,
              name: "Olya",
              phone: null,
              email: null,
              status: "archived",
              groupId: null,
              priceListId: null,
            },
          ],
          nextCursor: null,
        },
      },
    ];
    expect(
      presentCompletedStaffAssistantTurn({
        locale: "uk",
        toolResults: results,
      }),
    ).toBe("Клієнти: Ivan, Olya.");
    expect(
      presentCompletedStaffAssistantTurn({
        locale: "en",
        toolResults: results,
      }),
    ).toBe("Customers: Ivan, Olya.");
    const spoken = presentCompletedStaffAssistantTurn({
      locale: "en",
      toolResults: results,
    });
    expect(spoken).not.toContain("|");
    expect(spoken).not.toContain("ivan@example.com");
  });

  it("presents an empty page", () => {
    const results = [
      {
        toolName: ORDERS_LIST_PAGE_TOOL_NAME,
        output: {
          kind: "page.summary",
          rows: [],
          hasMore: false,
          nextCursor: null,
        },
      },
    ];
    expect(
      presentCompletedStaffAssistantTurn({
        locale: "uk",
        toolResults: results,
      }),
    ).toBe("Немає замовлень.");
    expect(
      presentCompletedStaffAssistantTurn({
        locale: "en",
        toolResults: results,
      }),
    ).toBe("No orders.");
  });

  it("appends a hasMore footnote when nextCursor is set", () => {
    const results = [
      {
        toolName: ORDERS_LIST_PAGE_TOOL_NAME,
        output: { ...listPage, hasMore: true, nextCursor: "cursor-1" },
      },
    ];
    expect(
      presentCompletedStaffAssistantTurn({
        locale: "uk",
        toolResults: results,
      }),
    ).toBe(
      "Останні замовлення: #1049 (Нове), #1050 (Підтверджено). Є ще замовлення.",
    );
    expect(
      presentCompletedStaffAssistantTurn({
        locale: "en",
        toolResults: results,
      }),
    ).toBe(
      "Latest orders: #1049 (New), #1050 (Confirmed). There are more orders.",
    );
  });

  it("speaks rows.length labels and hasMore from the completed view", () => {
    const rows = [
      { orderId: ORDER_A, orderNumber: "1", status: "new" },
      { orderId: ORDER_B, orderNumber: "2", status: "confirmed" },
      {
        orderId: "33333333-3333-4333-8333-333333333333",
        orderNumber: "3",
        status: "done",
      },
    ];
    const results = [
      {
        toolName: ORDERS_LIST_PAGE_TOOL_NAME,
        output: {
          kind: "page.summary",
          requestedLimit: 3,
          rows,
          hasMore: true,
          nextCursor: "more",
        },
      },
    ];
    const spoken = presentCompletedStaffAssistantTurn({
      locale: "en",
      toolResults: results,
    });
    expect(spoken).toBe(
      "Latest orders: #1 (New), #2 (Confirmed), #3 (Done). There are more orders.",
    );
    expect(spoken).not.toContain("requestedLimit");
    expect(spoken).not.toContain("3 orders");
  });

  it("lists all default-20 rows and omits hasMore when the view says false", () => {
    const rows = Array.from({ length: 20 }, (_, index) => ({
      orderId: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
      orderNumber: String(1000 + index),
      status: "new" as const,
    }));
    const spoken = presentCompletedStaffAssistantTurn({
      locale: "en",
      toolResults: [
        {
          toolName: ORDERS_LIST_PAGE_TOOL_NAME,
          output: {
            kind: "page.summary",
            requestedLimit: 20,
            rows,
            hasMore: false,
            nextCursor: null,
          },
        },
      ],
    });
    expect(spoken).toContain("#1000 (New)");
    expect(spoken).toContain("#1019 (New)");
    expect(spoken).not.toContain("There are more orders.");
    expect(spoken?.split(", ").length).toBe(20);
  });

  it("treats a clipped list preview as hasMore", () => {
    const results = [
      {
        toolName: ORDERS_LIST_PAGE_TOOL_NAME,
        output: {
          status: STAFF_ASSISTANT_CLIPPED_STATUS,
          preview: listPage,
          omitted: 2,
        },
      },
    ];
    expect(
      presentCompletedStaffAssistantTurn({
        locale: "en",
        toolResults: results,
      }),
    ).toContain("There are more orders.");
  });

  it("presents a counts-only aggregate", () => {
    const results = [
      {
        toolName: ORDERS_LIST_COUNTS_TOOL_NAME,
        output: {
          kind: "aggregate",
          orderCount: 6,
          grossByCurrency: [],
          buckets: [
            {
              identity: { kind: "status", status: "confirmed" },
              orderCount: 4,
            },
            {
              identity: { kind: "status", status: "new" },
              orderCount: 2,
            },
          ],
          statusBuckets: [
            {
              identity: { kind: "status", status: "confirmed" },
              orderCount: 4,
            },
            {
              identity: { kind: "status", status: "new" },
              orderCount: 2,
            },
          ],
        },
      },
    ];
    expect(
      presentCompletedStaffAssistantTurn({
        locale: "uk",
        toolResults: results,
      }),
    ).toBe("6 замовлень. Нове · 2, Підтверджено · 4.");
    expect(
      presentCompletedStaffAssistantTurn({
        locale: "en",
        toolResults: results,
      }),
    ).toBe("6 orders. New · 2, Confirmed · 4.");
  });

  it("speaks the status breakdown for a groupBy=product aggregate", () => {
    const results = [
      {
        toolName: ORDERS_LIST_COUNTS_TOOL_NAME,
        output: {
          kind: "aggregate",
          orderCount: 5,
          grossByCurrency: [],
          buckets: [
            {
              identity: {
                kind: "product",
                productId: ORDER_A,
                variantId: ORDER_B,
              },
              label: "Coffee",
              orderCount: 5,
            },
          ],
          statusBuckets: [
            {
              identity: { kind: "status", status: "new" },
              orderCount: 2,
            },
            {
              identity: { kind: "status", status: "confirmed" },
              orderCount: 3,
            },
          ],
        },
      },
    ];
    expect(
      presentCompletedStaffAssistantTurn({
        locale: "en",
        toolResults: results,
      }),
    ).toBe("5 orders. New · 2, Confirmed · 3.");
  });

  it("presents an empty aggregate", () => {
    const results = [
      {
        toolName: ORDERS_LIST_COUNTS_TOOL_NAME,
        output: {
          kind: "aggregate",
          orderCount: 0,
          grossByCurrency: [],
          buckets: [],
        },
      },
    ];
    expect(
      presentCompletedStaffAssistantTurn({
        locale: "uk",
        toolResults: results,
      }),
    ).toBe("Немає замовлень.");
  });

  it("does not emit aggregate spoken when a list page is on the same turn", () => {
    const results = [
      {
        toolName: ORDERS_LIST_COUNTS_TOOL_NAME,
        output: {
          kind: "aggregate",
          orderCount: 6,
          buckets: [],
        },
      },
      { toolName: ORDERS_LIST_PAGE_TOOL_NAME, output: listPage },
    ];
    expect(
      presentCompletedStaffAssistantTurn({
        locale: "en",
        toolResults: results,
      }),
    ).toBe("Latest orders: #1049 (New), #1050 (Confirmed).");
  });

  it("presents an order entity", () => {
    const results = [
      {
        toolName: "orders_get",
        output: {
          orderId: ORDER_A,
          orderNumber: "1049",
          status: "new",
          customer: { nameSnapshot: "Albina" },
        },
      },
    ];
    expect(
      presentCompletedStaffAssistantTurn({
        locale: "uk",
        toolResults: results,
      }),
    ).toBe("Замовлення #1049, Albina, Нове.");
    expect(
      presentCompletedStaffAssistantTurn({
        locale: "en",
        toolResults: results,
      }),
    ).toBe("Order #1049, Albina, New.");
  });

  it("joins multiple registered surfaces in tool-result order", () => {
    const results = [
      {
        toolName: "orders_get",
        output: {
          orderId: ORDER_A,
          orderNumber: "1049",
          status: "new",
        },
      },
      { toolName: ORDERS_LIST_PAGE_TOOL_NAME, output: listPage },
      {
        toolName: ORDERS_CREATE_TOOL_NAME,
        output: {
          orderId: ORDER_B,
          orderNumber: "1050",
          status: "confirmed",
        },
      },
    ];
    expect(
      presentCompletedStaffAssistantTurn({
        locale: "en",
        toolResults: results,
      }),
    ).toBe(
      "Order #1049, New.\nLatest orders: #1049 (New), #1050 (Confirmed).\nOrder #1050, Confirmed.",
    );
  });

  it("orders spoken fragments by source index, not by parsing toolCallId", () => {
    const results = [
      {
        toolName: "orders_get",
        toolCallId: "call_entity_first",
        output: {
          orderId: ORDER_A,
          orderNumber: "1049",
          status: "new",
        },
      },
      {
        toolName: ORDERS_LIST_PAGE_TOOL_NAME,
        toolCallId: "call_list_page",
        output: listPage,
      },
      {
        toolName: ORDERS_CREATE_TOOL_NAME,
        toolCallId: "call_entity_second",
        output: {
          orderId: ORDER_B,
          orderNumber: "1050",
          status: "confirmed",
        },
      },
    ];
    expect(
      presentCompletedStaffAssistantTurn({
        locale: "en",
        toolResults: results,
      }),
    ).toBe(
      "Order #1049, New.\nLatest orders: #1049 (New), #1050 (Confirmed).\nOrder #1050, Confirmed.",
    );
  });

  it("returns undefined when there is no registered surface", () => {
    expect(
      presentCompletedStaffAssistantTurn({
        locale: STAFF_ASSISTANT_DEFAULT_LOCALE,
        toolResults: [
          {
            toolName: "catalog_list_products",
            output: { items: [], nextCursor: null },
          },
        ],
      }),
    ).toBeUndefined();
  });
});

describe("staffAssistantTurnUsesCompletedPresenter", () => {
  it("is true for a silent completed list and false when the model spoke", () => {
    const toolResults = [
      { toolName: ORDERS_LIST_PAGE_TOOL_NAME, output: listPage },
    ];
    expect(
      staffAssistantTurnUsesCompletedPresenter({
        locale: "uk",
        toolResults,
        runs: [{ outcome: "success" }],
        rawText: "",
      }),
    ).toBe(true);
    expect(
      staffAssistantTurnUsesCompletedPresenter({
        locale: "uk",
        toolResults,
        runs: [{ outcome: "success" }],
        rawText: MODEL_SPEAKS_LIST,
      }),
    ).toBe(false);
    expect(
      staffAssistantTurnUsesCompletedPresenter({
        locale: "uk",
        toolResults,
        runs: [{ outcome: "success" }],
        rawText: '{"spoken":"Four orders this week."}',
      }),
    ).toBe(true);
    expect(
      staffAssistantTurnUsesCompletedPresenter({
        locale: "uk",
        toolResults,
        runs: [{ outcome: "success" }],
        rawText: "| order | total |\n| **#1** | 10 |",
      }),
    ).toBe(true);
    expect(
      staffAssistantTurnUsesCompletedPresenter({
        locale: "uk",
        toolResults,
        runs: [{ outcome: "success" }, { outcome: "confirmation_required" }],
        rawText: MODEL_SPEAKS_LIST,
      }),
    ).toBe(false);
    expect(
      staffAssistantTurnUsesCompletedPresenter({
        locale: "uk",
        toolResults,
        runs: [{ outcome: "choice_required" }],
        rawText: "",
      }),
    ).toBe(false);
  });

  it("is true when a needs_choice envelope is present so spoken matches the card", () => {
    const optionA = "55555555-5555-4555-8555-555555555555";
    const optionB = "66666666-6666-4666-8666-666666666666";
    const challengeId = "77777777-7777-4777-8777-777777777777";
    const needsChoice = {
      status: "needs_choice" as const,
      challengeId,
      reason: "variant_required" as const,
      productName: "Macarons",
      options: [
        { id: optionA, label: "Lemon" },
        { id: optionB, label: "Vanilla" },
      ],
      optionsTruncated: false,
    };
    const toolResults = [
      { toolName: ORDERS_CREATE_TOOL_NAME, output: needsChoice },
    ];
    expect(
      staffAssistantTurnUsesCompletedPresenter({
        locale: "en",
        toolResults,
        runs: [{ outcome: "choice_required" }],
        rawText: "MODEL_SPOKEN_SHOULD_NOT_PERSIST",
      }),
    ).toBe(true);
    expect(presentChoiceStaffAssistantTurn({ locale: "en", toolResults })).toBe(
      "Select a variant for Macarons: Lemon, Vanilla.",
    );
    expect(presentChoiceStaffAssistantTurn({ locale: "uk", toolResults })).toBe(
      "Оберіть варіант для Macarons: Lemon, Vanilla.",
    );
    expect(
      staffAssistantPersistedTurnText({
        locale: "en",
        toolResults,
        rawText: '{"spoken":"MODEL_SPOKEN_SHOULD_NOT_PERSIST"}',
        runs: [{ outcome: "choice_required" }],
      }),
    ).toBe("Select a variant for Macarons: Lemon, Vanilla.");
    const truncated = presentChoiceStaffAssistantTurn({
      locale: "en",
      toolResults: [
        {
          toolName: ORDERS_CREATE_TOOL_NAME,
          output: { ...needsChoice, optionsTruncated: true },
        },
      ],
    });
    expect(truncated).toContain(CHOICE_TRUNCATED_COPY.en);
  });

  it("is false when there is no registered surface", () => {
    expect(
      staffAssistantTurnUsesCompletedPresenter({
        locale: "uk",
        toolResults: [],
        runs: [{ outcome: "success" }],
        rawText: "Four orders this week.",
      }),
    ).toBe(false);
  });

  it("is true for archived / no_active_variants tool errors so presenter wins", () => {
    const archived = {
      status: "error" as const,
      code: "CONFLICT",
      message: '"Old Widget" is archived.',
      reason: "archived" as const,
      subject: { kind: "product_name" as const, name: "Old Widget" },
    };
    expect(
      staffAssistantTurnUsesCompletedPresenter({
        locale: "uk",
        toolResults: [{ toolName: ORDERS_CREATE_TOOL_NAME, output: archived }],
        runs: [{ outcome: "error" }],
        rawText: "MODEL_SPOKEN_SHOULD_NOT_PERSIST",
      }),
    ).toBe(true);
    expect(
      presentDomainErrorStaffAssistantTurn({
        locale: "uk",
        toolResults: [{ toolName: ORDERS_CREATE_TOOL_NAME, output: archived }],
      }),
    ).toBe(
      "«Old Widget» в архіві, в замовлення його додати не можна. Напишіть інший товар або повторіть замовлення без нього.",
    );
  });
});

describe("presentChoiceStaffAssistantNeedsChoice", () => {
  const optionA = "55555555-5555-4555-8555-555555555555";
  const optionB = "66666666-6666-4666-8666-666666666666";
  const challengeId = "77777777-7777-4777-8777-777777777777";
  const productId = "44444444-4444-4444-8444-444444444444";
  const customerId = "88888888-8888-4888-8888-888888888888";
  const companyId = "22222222-2222-4222-8222-222222222222";
  const conversationId = "11111111-1111-4111-8111-111111111111";
  const variantLemon = "aaaaaaaa-5555-4555-8555-555555555555";

  function successorRecord(optionsTruncated: boolean) {
    return {
      status: "open" as const,
      choiceId: challengeId,
      actorId: "anna",
      companyId,
      conversationId,
      canonicalInput: {
        customer: { by: "id" as const, id: customerId },
        items: [
          {
            product: { by: "id" as const, id: productId },
            variantSelection: { kind: "unspecified" as const },
            quantity: { milli: "1000" },
          },
        ],
      },
      target: {
        lineIndex: 0,
        productId,
        productName: "Еклери",
      },
      optionMap: { [optionA]: variantLemon },
      envelope: {
        status: "needs_choice" as const,
        challengeId,
        reason: "variant_required" as const,
        productName: "Еклери",
        options: [
          { id: optionA, label: "Кава" },
          { id: optionB, label: "Шоколад" },
        ],
        optionsTruncated,
      },
    };
  }

  it("returns the same presenter string the first ChoiceCard would persist", () => {
    const record = successorRecord(false);
    const uk = presentChoiceStaffAssistantNeedsChoice({
      locale: "uk",
      record,
    });
    const en = presentChoiceStaffAssistantNeedsChoice({
      locale: "en",
      record,
    });
    const toolResults = [
      {
        toolName: ORDERS_CREATE_TOOL_NAME,
        output: {
          status: "needs_choice" as const,
          challengeId,
          reason: "variant_required" as const,
          productName: "Еклери",
          options: [
            { id: optionA, label: "Кава" },
            { id: optionB, label: "Шоколад" },
          ],
          optionsTruncated: false,
        },
      },
    ];
    expect(uk.text).toBe(
      presentChoiceStaffAssistantTurn({ locale: "uk", toolResults }),
    );
    expect(en.text).toBe(
      presentChoiceStaffAssistantTurn({ locale: "en", toolResults }),
    );
    expect(uk.text).toBe("Оберіть варіант для Еклери: Кава, Шоколад.");
    expect(en.text).toBe("Select a variant for Еклери: Кава, Шоколад.");
    expect(uk.text).toContain("Кава");
    expect(uk.text).toContain("Шоколад");
    expect(uk.text).not.toBe('Select a variant for "Еклери".');
    expect(en.text).not.toBe('Select a variant for "Еклери".');
    expect(uk.challengeId).toBe(challengeId);
    expect(uk.options.map((option) => option.label)).toEqual([
      "Кава",
      "Шоколад",
    ]);
  });

  it("appends the same truncated refinement copy the first card uses", () => {
    const truncated = presentChoiceStaffAssistantNeedsChoice({
      locale: "uk",
      record: successorRecord(true),
    });
    expect(truncated.text).toContain(CHOICE_TRUNCATED_COPY.uk);
    expect(truncated.text).toBe(
      presentChoiceStaffAssistantTurn({
        locale: "uk",
        toolResults: [
          {
            toolName: ORDERS_CREATE_TOOL_NAME,
            output: {
              status: "needs_choice",
              challengeId,
              reason: "variant_required",
              productName: "Еклери",
              options: truncated.options,
              optionsTruncated: true,
            },
          },
        ],
      }),
    );
    expect(
      presentChoiceStaffAssistantNeedsChoice({
        locale: "en",
        record: successorRecord(true),
      }).text,
    ).toContain(CHOICE_TRUNCATED_COPY.en);
  });

  it("presents product and customer pickers without Multiple matches prose", () => {
    const productOutput = {
      status: "needs_choice" as const,
      challengeId,
      reason: "ambiguous" as const,
      choiceKind: "product" as const,
      productName: "макаронс",
      options: [{ id: optionA, label: "Макаронси" }],
      optionsTruncated: false,
    };
    const customerOutput = {
      status: "needs_choice" as const,
      challengeId,
      reason: "ambiguous" as const,
      choiceKind: "customer" as const,
      productName: "Katya",
      options: [
        { id: optionA, label: "Katya (…2233)" },
        { id: optionB, label: "Katya (…5566)" },
      ],
      optionsTruncated: false,
    };
    expect(
      presentChoiceStaffAssistantTurn({
        locale: "en",
        toolResults: [
          { toolName: ORDERS_CREATE_TOOL_NAME, output: productOutput },
        ],
      }),
    ).toBe("Select a product matching макаронс: Макаронси.");
    expect(
      presentChoiceStaffAssistantTurn({
        locale: "uk",
        toolResults: [
          { toolName: ORDERS_CREATE_TOOL_NAME, output: productOutput },
        ],
      }),
    ).toBe("Оберіть товар «макаронс»: Макаронси.");
    expect(
      presentChoiceStaffAssistantTurn({
        locale: "en",
        toolResults: [
          { toolName: ORDERS_CREATE_TOOL_NAME, output: customerOutput },
        ],
      }),
    ).toBe("Select a customer matching Katya: Katya (…2233), Katya (…5566).");
    expect(
      presentChoiceStaffAssistantTurn({
        locale: "en",
        toolResults: [
          {
            toolName: ORDERS_CREATE_TOOL_NAME,
            output: { ...productOutput, optionsTruncated: true },
          },
        ],
      }),
    ).toContain(CHOICE_TRUNCATED_MATCH_COPY.en);
    expect(
      presentChoiceStaffAssistantTurn({
        locale: "uk",
        toolResults: [
          {
            toolName: ORDERS_CREATE_TOOL_NAME,
            output: { ...customerOutput, optionsTruncated: true },
          },
        ],
      }),
    ).toContain(CHOICE_TRUNCATED_MATCH_COPY.uk);
    expect(
      presentChoiceStaffAssistantTurn({
        locale: "en",
        toolResults: [
          { toolName: ORDERS_CREATE_TOOL_NAME, output: productOutput },
        ],
      }),
    ).not.toContain("Multiple matches");
  });
});

describe("staffAssistantPersistedTurnText", () => {
  it("uses model text for a list surface when the sentence is usable", () => {
    const presented = presentCompletedStaffAssistantTurn({
      locale: "uk",
      toolResults: [{ toolName: ORDERS_LIST_PAGE_TOOL_NAME, output: listPage }],
    });
    expect(
      staffAssistantPersistedTurnText({
        locale: "uk",
        toolResults: [
          { toolName: ORDERS_LIST_PAGE_TOOL_NAME, output: listPage },
        ],
        rawText: MODEL_SPEAKS_LIST,
        runs: [{ outcome: "success" }],
      }),
    ).toBe(MODEL_SPEAKS_LIST);
    expect(presented).not.toBe(MODEL_SPEAKS_LIST);
  });

  it("uses presenter text when a list surface is silent", () => {
    const presented = presentCompletedStaffAssistantTurn({
      locale: "en",
      toolResults: [{ toolName: ORDERS_LIST_PAGE_TOOL_NAME, output: listPage }],
    });
    expect(
      staffAssistantPersistedTurnText({
        locale: "en",
        toolResults: [
          { toolName: ORDERS_LIST_PAGE_TOOL_NAME, output: listPage },
        ],
        rawText: "",
        runs: [{ outcome: "success" }],
      }),
    ).toBe(presented);
  });

  it("uses presenter text for leftover spoken JSON or a markdown dump", () => {
    const presented = presentCompletedStaffAssistantTurn({
      locale: "en",
      toolResults: [{ toolName: ORDERS_LIST_PAGE_TOOL_NAME, output: listPage }],
    });
    expect(
      staffAssistantPersistedTurnText({
        locale: "en",
        toolResults: [
          { toolName: ORDERS_LIST_PAGE_TOOL_NAME, output: listPage },
        ],
        rawText: '{"spoken":"MODEL_SPOKEN_SHOULD_NOT_PERSIST"}',
        runs: [{ outcome: "success" }],
      }),
    ).toBe(presented);
    expect(
      staffAssistantPersistedTurnText({
        locale: "en",
        toolResults: [
          { toolName: ORDERS_LIST_PAGE_TOOL_NAME, output: listPage },
        ],
        rawText: "| order | total |\n| **#1** | 10 |",
        runs: [{ outcome: "success" }],
      }),
    ).toBe(presented);
    expect(presented).not.toBe("MODEL_SPOKEN_SHOULD_NOT_PERSIST");
    expect(presented).not.toBe(STAFF_ASSISTANT_SUCCESS_SPOKEN_FALLBACK);
  });

  it("keeps model prose when there is no registered surface", () => {
    expect(
      staffAssistantPersistedTurnText({
        locale: "uk",
        toolResults: [],
        rawText: "Four orders this week.",
        runs: [{ outcome: "success" }],
      }),
    ).toBe("Four orders this week.");
  });

  it("does not extract spoken from leftover JSON when there is no surface", () => {
    expect(
      staffAssistantPersistedTurnText({
        locale: "uk",
        toolResults: [],
        rawText: '{"spoken":"Four orders this week."}',
        runs: [{ outcome: "success" }],
      }),
    ).toBe(STAFF_ASSISTANT_SUCCESS_SPOKEN_FALLBACK);
  });

  it("keeps confirmation fallback over a completed list when spoken is a markdown dump", () => {
    expect(
      staffAssistantPersistedTurnText({
        locale: "en",
        toolResults: [
          { toolName: ORDERS_LIST_PAGE_TOOL_NAME, output: listPage },
        ],
        rawText: '{"spoken":"| order | total |"}',
        runs: [{ outcome: "success" }, { outcome: "confirmation_required" }],
      }),
    ).toBe(STAFF_ASSISTANT_CONFIRMATION_FALLBACK_TEXT);
    expect(
      presentCompletedStaffAssistantTurn({
        locale: "en",
        toolResults: [
          { toolName: ORDERS_LIST_PAGE_TOOL_NAME, output: listPage },
        ],
      }),
    ).not.toBe(STAFF_ASSISTANT_CONFIRMATION_FALLBACK_TEXT);
  });

  it("still fail-opens markdown spoken when there is no surface", () => {
    expect(
      staffAssistantPersistedTurnText({
        locale: "uk",
        toolResults: [],
        rawText: '{"spoken":"| order | total |"}',
        runs: [{ outcome: "success" }],
      }),
    ).toBe(STAFF_ASSISTANT_SUCCESS_SPOKEN_FALLBACK);
  });

  it("falls back to the typed tool message when create errors without spoken", () => {
    const message =
      'Multiple matches for "макаронс": Макаронси (UAH, 11111111-1111-4111-8111-111111111111).';
    const notFound = 'No product matches "xyzzy".';
    for (const locale of ["uk", "en"] as const) {
      expect(
        staffAssistantPersistedTurnText({
          locale,
          toolResults: [
            {
              toolName: ORDERS_CREATE_TOOL_NAME,
              output: { status: "error", code: "CONFLICT", message },
            },
          ],
          rawText: "",
          runs: [{ outcome: "error" }],
        }),
      ).toBe(message);
      expect(
        staffAssistantPersistedTurnText({
          locale,
          toolResults: [
            {
              toolName: ORDERS_CREATE_TOOL_NAME,
              output: { status: "error", code: "NOT_FOUND", message: notFound },
            },
          ],
          rawText: "",
          runs: [{ outcome: "error" }],
        }),
      ).toBe(notFound);
    }
  });

  it("keeps model prose over catalog clientMessage on a tool error", () => {
    expect(
      staffAssistantPersistedTurnText({
        locale: "uk",
        toolResults: [
          {
            toolName: ORDERS_CREATE_TOOL_NAME,
            output: {
              status: "error",
              code: "CONFLICT",
              message:
                'Multiple matches for "макаронс": Макаронси (UAH, 11111111-1111-4111-8111-111111111111).',
            },
          },
        ],
        rawText: "Не знайшла той товар. Уточніть назву.",
        runs: [{ outcome: "error" }],
      }),
    ).toBe("Не знайшла той товар. Уточніть назву.");
  });

  it("uses presenter copy for archived and no_active_variants, not spoken or clientMessage", () => {
    const spoken = "MODEL_SPOKEN_SHOULD_NOT_PERSIST";
    const archivedMessage = '"Old Widget" is archived.';
    const archivedOutput = {
      status: "error" as const,
      code: "CONFLICT",
      message: archivedMessage,
      reason: "archived" as const,
      subject: { kind: "product_name" as const, name: "Old Widget" },
    };
    const queryOutput = {
      status: "error" as const,
      code: "CONFLICT",
      message:
        'No active product matched "ZzzArchiveTwin"; matching products are archived.',
      reason: "archived" as const,
      subject: { kind: "query" as const, query: "ZzzArchiveTwin" },
    };
    const variantsOutput = {
      status: "error" as const,
      code: "CONFLICT",
      message: '"Macarons" has no active variants.',
      reason: "no_active_variants" as const,
      subject: { kind: "product_name" as const, name: "Macarons" },
    };
    for (const locale of ["uk", "en"] as const) {
      expect(
        staffAssistantPersistedTurnText({
          locale,
          toolResults: [
            { toolName: ORDERS_CREATE_TOOL_NAME, output: archivedOutput },
          ],
          rawText: `{"spoken":"${spoken}"}`,
          runs: [{ outcome: "error" }],
        }),
      ).toBe(
        presentCatalogDomainError({
          locale,
          extras: {
            reason: "archived",
            subject: { kind: "product_name", name: "Old Widget" },
          },
        }),
      );
      expect(
        staffAssistantPersistedTurnText({
          locale,
          toolResults: [
            { toolName: ORDERS_CREATE_TOOL_NAME, output: queryOutput },
          ],
          rawText: `{"spoken":"${spoken}"}`,
          runs: [{ outcome: "error" }],
        }),
      ).toBe(
        presentCatalogDomainError({
          locale,
          extras: {
            reason: "archived",
            subject: { kind: "query", query: "ZzzArchiveTwin" },
          },
        }),
      );
      expect(
        staffAssistantPersistedTurnText({
          locale,
          toolResults: [
            { toolName: ORDERS_CREATE_TOOL_NAME, output: variantsOutput },
          ],
          rawText: `{"spoken":"${spoken}"}`,
          runs: [{ outcome: "error" }],
        }),
      ).toBe(
        presentCatalogDomainError({
          locale,
          extras: {
            reason: "no_active_variants",
            subject: { kind: "product_name", name: "Macarons" },
          },
        }),
      );
    }
    expect(
      presentCatalogDomainError({
        locale: "en",
        extras: {
          reason: "archived",
          subject: { kind: "product_name", name: "Old Widget" },
        },
      }),
    ).toBe(
      '"Old Widget" is archived and cannot be added to an order. Name a different product, or repeat the order without it.',
    );
    expect(
      staffAssistantPersistedTurnText({
        locale: "en",
        toolResults: [
          {
            toolName: ORDERS_CREATE_TOOL_NAME,
            output: {
              status: "error",
              code: "CONFLICT",
              message: archivedMessage,
            },
          },
        ],
        rawText: spoken,
        runs: [{ outcome: "error" }],
      }),
    ).toBe(spoken);
  });
});
