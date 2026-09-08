import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  unrestorableAssistantActionNames,
  type AssistantSurfaceDescriptor,
} from "@showzy/validation/assistant-surfaces";

import { assistantCopy } from "../../../i18n/assistant";
import { ordersCopy } from "../../../i18n/orders";
import { orderDetailHref } from "../../orders/shared/order-hrefs";
import {
  assistantSurfacesFromParts,
  type AssistantOrderEntityCardView,
  type AssistantSurface,
} from "../surfaces";
import {
  applyOpenPendingToHydratedMessages,
  associateToolRunsWithAssistantMessages,
  entityResultIdsFromToolRuns,
  findOwnConversationId,
  firstOwnConversationId,
  hydratedUiMessagesFromConversation,
  HYDRATABLE_ORDER_ENTITY_ACTIONS,
  isHydratableOrderEntityRun,
  isUnrestorableListRun,
  loadChoiceEnvelopes,
  loadOrdersById,
  UNRESTORABLE_LIST_ACTIONS,
  type AssistantConversationListItem,
  type AssistantHistoryMessage,
  type AssistantHistoryToolRun,
  type AssistantListConversationsInput,
} from "./assistant-hydrate";
import { pendingChoiceFromMessages } from "./choice-presenter";
import {
  assistantChatRows,
  assistantDisplayRows,
  assistantTurnIsWaiting,
} from "./chat-rows";
import type { StaffAssistantChoiceCardEnvelope } from "./choice";

function entitiesOf(
  surfaces: readonly AssistantSurface[],
): readonly AssistantOrderEntityCardView[] {
  return surfaces.filter(
    (surface): surface is AssistantOrderEntityCardView =>
      surface.kind === "order-entity",
  );
}

const SESSION_USER = "user-own";
const COLLEAGUE_USER = "user-colleague";
const CONV_OWN = "11111111-1111-4111-8111-111111111111";
const CONV_COLLEAGUE = "22222222-2222-4222-8222-222222222222";
const CONV_OWN_OLDER = "33333333-3333-4333-8333-333333333333";
const ORDER_A = "0f0e2d5c-4a1b-4c3d-9e8f-102938475601";
const ORDER_B = "1a2b3c4d-5e6f-4789-8abc-def012345678";
const NESTED_ORDER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MSG_USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MSG_ASSISTANT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const MSG_ASSISTANT_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const MSG_ASSISTANT_HIGH = "f0f0f0f0-f0f0-40f0-80f0-f0f0f0f0f0f0";
const RUN_LIST = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const RUN_GET = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const RUN_GET_LEX_LOW = "0a0a0a0a-0a0a-40a0-80a0-0a0a0a0a0a0a";
const RUN_CREATE = "99999999-9999-4999-8999-999999999999";
const RUN_CHOICE = "88888888-8888-4888-8888-888888888888";
const CHOICE_ID = "44444444-4444-4444-8444-444444444444";
const CHOICE_ID_B = "55555555-5555-4555-8555-555555555555";
const OPTION_LEMON = "77777777-7777-4777-8777-777777777777";
const RUN_CHOICE_B = "66666666-6666-4666-8666-666666666666";
const uk = assistantCopy("uk");
const ordersUk = ordersCopy("uk");

function listItem(id: string, userId: string): AssistantConversationListItem {
  return { id, userId };
}

function message(args: {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly body: string;
  readonly createdAt: string;
}): AssistantHistoryMessage {
  return args;
}

function toolRun(args: {
  readonly id: string;
  readonly actionName: string;
  readonly toolCallId: string;
  readonly resultIds?: readonly string[];
  readonly outcome?: AssistantHistoryToolRun["outcome"];
  readonly createdAt: string;
}): AssistantHistoryToolRun {
  return {
    id: args.id,
    actionName: args.actionName,
    toolCallId: args.toolCallId,
    resultIds: args.resultIds ?? [],
    outcome: args.outcome ?? "success",
    createdAt: args.createdAt,
  };
}

function choiceRequiredRun(args: {
  readonly id: string;
  readonly challengeId: string;
  readonly createdAt: string;
}): AssistantHistoryToolRun {
  return {
    id: args.id,
    actionName: "orders.create",
    toolCallId: `call-${args.id}`,
    challengeId: args.challengeId,
    resultIds: [],
    outcome: "choice_required",
    createdAt: args.createdAt,
  };
}

function orderSnapshot(
  orderId: string,
  status: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    orderId,
    orderNumber: "1049",
    status,
    totalGrossMinor: "33000",
    currency: "UAH",
    createdAt: "2026-09-03T10:00:00.000Z",
    ...extra,
  };
}

describe("firstOwnConversationId", () => {
  it("picks the first own-user row and skips a newer colleague thread", () => {
    expect(
      firstOwnConversationId(
        [
          listItem(CONV_COLLEAGUE, COLLEAGUE_USER),
          listItem(CONV_OWN, SESSION_USER),
        ],
        SESSION_USER,
      ),
    ).toBe(CONV_OWN);
  });

  it("returns null when the first page is only a colleague", () => {
    expect(
      firstOwnConversationId(
        [listItem(CONV_COLLEAGUE, COLLEAGUE_USER)],
        SESSION_USER,
      ),
    ).toBeNull();
  });
});

describe("findOwnConversationId", () => {
  it("does not send userId or companyId on listConversations input", async () => {
    const inputs: AssistantListConversationsInput[] = [];
    const ownId = await findOwnConversationId({
      sessionUserId: SESSION_USER,
      listConversations: (input) => {
        inputs.push(input);
        return Promise.resolve({
          items: [listItem(CONV_OWN, SESSION_USER)],
          nextCursor: null,
        });
      },
    });
    expect(ownId).toBe(CONV_OWN);
    expect(inputs).toEqual([{}]);
    expect(JSON.stringify(inputs[0])).not.toContain("userId");
    expect(JSON.stringify(inputs[0])).not.toContain("companyId");
  });

  it("follows nextCursor only until an own-user row", async () => {
    const inputs: AssistantListConversationsInput[] = [];
    const ownId = await findOwnConversationId({
      sessionUserId: SESSION_USER,
      listConversations: (input) => {
        inputs.push(input);
        if (input.cursor === undefined) {
          return Promise.resolve({
            items: [listItem(CONV_COLLEAGUE, COLLEAGUE_USER)],
            nextCursor: "cursor-2",
          });
        }
        return Promise.resolve({
          items: [listItem(CONV_OWN_OLDER, SESSION_USER)],
          nextCursor: null,
        });
      },
    });
    expect(ownId).toBe(CONV_OWN_OLDER);
    expect(inputs).toEqual([{}, { cursor: "cursor-2" }]);
    expect(JSON.stringify(inputs)).not.toContain("userId");
    expect(JSON.stringify(inputs)).not.toContain("companyId");
  });

  it("does not hydrate a colleague when no own row exists", async () => {
    const ownId = await findOwnConversationId({
      sessionUserId: SESSION_USER,
      listConversations: () =>
        Promise.resolve({
          items: [listItem(CONV_COLLEAGUE, COLLEAGUE_USER)],
          nextCursor: null,
        }),
    });
    expect(ownId).toBeNull();
  });
});

describe("entityResultIdsFromToolRuns", () => {
  it("collects top-level resultIds from orders.get / orders.create only", () => {
    const runs = [
      toolRun({
        id: RUN_LIST,
        actionName: "orders.list",
        toolCallId: "call-list",
        resultIds: [NESTED_ORDER],
        createdAt: "2026-09-03T10:00:00.000Z",
      }),
      toolRun({
        id: RUN_GET,
        actionName: "orders.get",
        toolCallId: "call-get",
        resultIds: [ORDER_A],
        createdAt: "2026-09-03T10:00:01.000Z",
      }),
      toolRun({
        id: RUN_CREATE,
        actionName: "orders.create",
        toolCallId: "call-create",
        resultIds: [ORDER_B],
        createdAt: "2026-09-03T10:00:02.000Z",
      }),
    ];
    expect(entityResultIdsFromToolRuns(runs)).toEqual([ORDER_A, ORDER_B]);
    const listRun = runs[0];
    const getRun = runs[1];
    expect(listRun).toBeDefined();
    expect(getRun).toBeDefined();
    if (listRun === undefined || getRun === undefined) {
      return;
    }
    expect(isUnrestorableListRun(listRun)).toBe(true);
    expect(isHydratableOrderEntityRun(listRun)).toBe(false);
    expect(isHydratableOrderEntityRun(getRun)).toBe(true);
  });

  it("does not walk nested items[].orderId because those are not resultIds", () => {
    const source = readFileSync(
      new URL("./assistant-hydrate.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain("items[].orderId");
    expect(source).not.toContain('["orderId"]');
    expect(source.includes("resultIds")).toBe(true);
    expect(
      entityResultIdsFromToolRuns([
        toolRun({
          id: RUN_LIST,
          actionName: "orders.list",
          toolCallId: "call-list",
          resultIds: [],
          createdAt: "2026-09-03T10:00:00.000Z",
        }),
      ]),
    ).toEqual([]);
  });
});

describe("hydratedUiMessagesFromConversation", () => {
  it("keeps list/aggregate prose and does not restore a list card", () => {
    const messages = hydratedUiMessagesFromConversation({
      messages: [
        message({
          id: MSG_USER,
          role: "user",
          body: "Замовлення в роботі",
          createdAt: "2026-09-03T10:00:00.000Z",
        }),
        message({
          id: MSG_ASSISTANT,
          role: "assistant",
          body: "Ось три останні, найбільше — № 12.\nМожна відкрити картку.",
          createdAt: "2026-09-03T10:00:01.000Z",
        }),
      ],
      toolRuns: [
        toolRun({
          id: RUN_LIST,
          actionName: "orders.list",
          toolCallId: "call-list",
          resultIds: [],
          createdAt: "2026-09-03T10:00:01.000Z",
        }),
      ],
      ordersById: new Map(),
    });
    expect(messages[1]?.parts).toEqual([
      {
        type: "text",
        text: "Ось три останні, найбільше — № 12.\nМожна відкрити картку.",
      },
    ]);
    const surfaces = assistantSurfacesFromParts(messages[1]?.parts ?? [], "uk");
    expect(surfaces).toEqual([]);
    const rows = assistantChatRows(messages, null, uk);
    expect(rows[1]?.text).toBe(
      "Ось три останні, найбільше — № 12.\nМожна відкрити картку.",
    );
    expect(rows[1]?.surfaces).toEqual([]);
    expect(JSON.stringify(rows[1])).not.toContain("orders_list_page");
    expect(JSON.stringify(rows[1])).not.toContain("orders_list_counts");
    expect(JSON.stringify(messages)).not.toContain("data-presentation");
    expect(rows[1]?.text.includes("{")).toBe(false);
    const visible = assistantDisplayRows(
      rows,
      assistantTurnIsWaiting({ status: "ready", rows }),
    );
    expect(visible.every((row) => !row.waiting)).toBe(true);
    expect(visible[1]?.text).toBe(
      "Ось три останні, найбільше — № 12.\nМожна відкрити картку.",
    );
  });

  it("does not restore a customers-list card on resume (hydratable: false)", () => {
    const messages = hydratedUiMessagesFromConversation({
      messages: [
        message({
          id: MSG_USER,
          role: "user",
          body: "Покажи клієнтів",
          createdAt: "2026-09-03T10:00:00.000Z",
        }),
        message({
          id: MSG_ASSISTANT,
          role: "assistant",
          body: "Ось клієнти.",
          createdAt: "2026-09-03T10:00:01.000Z",
        }),
      ],
      toolRuns: [
        toolRun({
          id: RUN_LIST,
          actionName: "customers.listCustomers",
          toolCallId: "call-customers-list",
          resultIds: [],
          createdAt: "2026-09-03T10:00:01.000Z",
        }),
      ],
      ordersById: new Map(),
    });
    expect(messages[1]?.parts).toEqual([
      { type: "text", text: "Ось клієнти." },
    ]);
    expect(assistantSurfacesFromParts(messages[1]?.parts ?? [], "uk")).toEqual(
      [],
    );
    expect(JSON.stringify(messages)).not.toContain("customers_list_customers");
  });

  it("hydrates thin entity cards via live orders.get snapshots", () => {
    const getOutput = orderSnapshot(ORDER_A, "in_progress");
    const createOutput = orderSnapshot(ORDER_B, "new", {
      customer: { nameSnapshot: "Оля", linkedCustomerId: null },
    });
    const messages = hydratedUiMessagesFromConversation({
      messages: [
        message({
          id: MSG_USER,
          role: "user",
          body: "Покажи замовлення",
          createdAt: "2026-09-03T10:00:00.000Z",
        }),
        message({
          id: MSG_ASSISTANT,
          role: "assistant",
          body: "Ось картка.",
          createdAt: "2026-09-03T10:00:01.000Z",
        }),
      ],
      toolRuns: [
        toolRun({
          id: RUN_GET,
          actionName: "orders.get",
          toolCallId: "call-get",
          resultIds: [ORDER_A],
          createdAt: "2026-09-03T10:00:01.000Z",
        }),
        toolRun({
          id: RUN_CREATE,
          actionName: "orders.create",
          toolCallId: "call-create",
          resultIds: [ORDER_B],
          createdAt: "2026-09-03T10:00:02.000Z",
        }),
      ],
      ordersById: new Map([
        [ORDER_A, getOutput],
        [ORDER_B, createOutput],
      ]),
    });
    const surfaces = assistantSurfacesFromParts(messages[1]?.parts ?? [], "uk");
    expect(surfaces.map((surface) => surface.kind)).toEqual([
      "order-entity",
      "order-entity",
    ]);
    const entityCards = entitiesOf(surfaces);
    expect(entityCards).toHaveLength(2);
    expect(entityCards[0]?.orderId).toBe(ORDER_A);
    expect(entityCards[0]?.href).toBe(orderDetailHref(ORDER_A));
    expect(entityCards[0]?.statusLabel).toBe(ordersUk.statuses.in_progress);
    expect(entityCards[0]?.statusTone).toBe("attention");
    expect(entityCards[1]?.customerName).toBe("Оля");
    expect(entityCards[1]?.statusLabel).toBe(ordersUk.statuses.new);
    expect(entityCards[1]?.statusTone).toBe("action");
    const rows = assistantChatRows(messages, null, uk);
    expect(rows[1]?.text).toBe("Ось картка.");
    expect(rows[1]?.surfaces).toHaveLength(2);
    expect(JSON.stringify(rows[1]?.text)).not.toContain("in_progress");
  });

  it("omits a missing or denied orders.get card and does not write status into the body", () => {
    const body = "Замовлення готове.";
    const messages = hydratedUiMessagesFromConversation({
      messages: [
        message({
          id: MSG_ASSISTANT,
          role: "assistant",
          body,
          createdAt: "2026-09-03T10:00:01.000Z",
        }),
      ],
      toolRuns: [
        toolRun({
          id: RUN_GET,
          actionName: "orders.get",
          toolCallId: "call-get",
          resultIds: [ORDER_A],
          createdAt: "2026-09-03T10:00:01.000Z",
        }),
      ],
      ordersById: new Map(),
    });
    expect(messages[0]?.parts).toEqual([{ type: "text", text: body }]);
    const surfaces = assistantSurfacesFromParts(messages[0]?.parts ?? [], "uk");
    expect(surfaces).toEqual([]);
    expect(messages[0]?.parts[0]).toEqual({ type: "text", text: body });
    expect(JSON.stringify(messages)).not.toContain("NOT_FOUND");
    expect(JSON.stringify(messages)).not.toContain("PERMISSION_DENIED");
    expect(JSON.stringify(messages)).not.toContain("canceled");
  });

  it("does not turn an orders.list run into N orders.get cards", () => {
    const messages = hydratedUiMessagesFromConversation({
      messages: [
        message({
          id: MSG_ASSISTANT,
          role: "assistant",
          body: "Знайшла кілька замовлень.",
          createdAt: "2026-09-03T10:00:01.000Z",
        }),
      ],
      toolRuns: [
        toolRun({
          id: RUN_LIST,
          actionName: "orders.list",
          toolCallId: "call-list",
          resultIds: [ORDER_A, ORDER_B],
          createdAt: "2026-09-03T10:00:01.000Z",
        }),
      ],
      ordersById: new Map([
        [ORDER_A, orderSnapshot(ORDER_A, "new")],
        [ORDER_B, orderSnapshot(ORDER_B, "confirmed")],
      ]),
    });
    const surfaces = assistantSurfacesFromParts(messages[0]?.parts ?? [], "uk");
    expect(surfaces).toEqual([]);
  });

  it("pairs entity runs with the later assistant when timestamps differ", () => {
    const grouped = associateToolRunsWithAssistantMessages(
      [
        message({
          id: MSG_ASSISTANT,
          role: "assistant",
          body: "Список.",
          createdAt: "2026-09-03T10:00:01.000Z",
        }),
        message({
          id: MSG_ASSISTANT_B,
          role: "assistant",
          body: "Картка.",
          createdAt: "2026-09-03T10:00:05.000Z",
        }),
      ],
      [
        toolRun({
          id: RUN_LIST,
          actionName: "orders.list",
          toolCallId: "call-list",
          createdAt: "2026-09-03T10:00:01.000Z",
        }),
        toolRun({
          id: RUN_GET,
          actionName: "orders.get",
          toolCallId: "call-get",
          resultIds: [ORDER_A],
          createdAt: "2026-09-03T10:00:05.000Z",
        }),
      ],
    );
    expect(grouped.get(MSG_ASSISTANT)?.map((run) => run.id)).toEqual([
      RUN_LIST,
    ]);
    expect(grouped.get(MSG_ASSISTANT_B)?.map((run) => run.id)).toEqual([
      RUN_GET,
    ]);
  });

  it("pairs a same-timestamp get run to the later assistant even when that message id is greater than the run id", () => {
    expect(MSG_ASSISTANT_HIGH.localeCompare(RUN_GET_LEX_LOW)).toBeGreaterThan(
      0,
    );
    const laterCreatedAt = "2026-09-03T10:00:05.000Z";
    const getOutput = orderSnapshot(ORDER_A, "in_progress");
    const historyMessages = [
      message({
        id: MSG_ASSISTANT,
        role: "assistant",
        body: "Список.",
        createdAt: "2026-09-03T10:00:01.000Z",
      }),
      message({
        id: MSG_ASSISTANT_HIGH,
        role: "assistant",
        body: "Картка.",
        createdAt: laterCreatedAt,
      }),
    ];
    const historyRuns = [
      toolRun({
        id: RUN_LIST,
        actionName: "orders.list",
        toolCallId: "call-list",
        createdAt: "2026-09-03T10:00:01.000Z",
      }),
      toolRun({
        id: RUN_GET_LEX_LOW,
        actionName: "orders.get",
        toolCallId: "call-get",
        resultIds: [ORDER_A],
        createdAt: laterCreatedAt,
      }),
    ];
    const grouped = associateToolRunsWithAssistantMessages(
      historyMessages,
      historyRuns,
    );
    expect(grouped.get(MSG_ASSISTANT)?.map((run) => run.id)).toEqual([
      RUN_LIST,
    ]);
    expect(grouped.get(MSG_ASSISTANT_HIGH)?.map((run) => run.id)).toEqual([
      RUN_GET_LEX_LOW,
    ]);
    const ui = hydratedUiMessagesFromConversation({
      messages: historyMessages,
      toolRuns: historyRuns,
      ordersById: new Map([[ORDER_A, getOutput]]),
    });
    expect(ui[0]?.parts).toEqual([{ type: "text", text: "Список." }]);
    expect(ui[1]?.id).toBe(MSG_ASSISTANT_HIGH);
    expect(ui[1]?.parts).toEqual([
      { type: "text", text: "Картка." },
      {
        type: "dynamic-tool",
        toolName: "orders.get",
        toolCallId: "call-get",
        state: "output-available",
        input: {},
        output: getOutput,
      },
    ]);
  });
});

describe("loadOrdersById", () => {
  it("omits failed live gets without throwing", async () => {
    const getOrder = vi.fn((orderId: string) => {
      if (orderId === ORDER_A) {
        return Promise.resolve(orderSnapshot(ORDER_A, "done"));
      }
      return Promise.reject(new Error("PERMISSION_DENIED"));
    });
    const orders = await loadOrdersById({
      orderIds: [ORDER_A, ORDER_B],
      getOrder,
    });
    expect(orders.get(ORDER_A)).toEqual(orderSnapshot(ORDER_A, "done"));
    expect(orders.has(ORDER_B)).toBe(false);
    expect(getOrder).toHaveBeenCalledWith(ORDER_A);
    expect(getOrder).toHaveBeenCalledWith(ORDER_B);
  });
});

describe("choice hydrate (SHO-418)", () => {
  const liveEnvelope = {
    status: "needs_choice" as const,
    challengeId: CHOICE_ID,
    reason: "variant_required" as const,
    productName: "Macarons",
    options: [{ id: OPTION_LEMON, label: "Lemon" }],
    optionsTruncated: false,
  };

  it("does not invent a ChoiceCard when choice_required has no challengeId", () => {
    const messages = hydratedUiMessagesFromConversation({
      messages: [
        message({
          id: MSG_ASSISTANT,
          role: "assistant",
          body: "Select a variant for Macarons: Lemon.",
          createdAt: "2026-09-03T10:00:01.000Z",
        }),
      ],
      toolRuns: [
        toolRun({
          id: RUN_CHOICE,
          actionName: "orders.create",
          toolCallId: "call-create",
          resultIds: [],
          outcome: "choice_required",
          createdAt: "2026-09-03T10:00:01.000Z",
        }),
      ],
      ordersById: new Map(),
      choiceEnvelopes: new Map([[CHOICE_ID, liveEnvelope]]),
    });
    expect(messages[0]?.parts).toEqual([
      { type: "text", text: "Select a variant for Macarons: Lemon." },
    ]);
  });

  it("attaches the peeked envelope when the run carries challengeId", () => {
    const messages = hydratedUiMessagesFromConversation({
      messages: [
        message({
          id: MSG_ASSISTANT,
          role: "assistant",
          body: "Select a variant for Macarons: Lemon.",
          createdAt: "2026-09-03T10:00:01.000Z",
        }),
      ],
      toolRuns: [
        {
          id: RUN_CHOICE,
          actionName: "orders.create",
          toolCallId: "call-create",
          challengeId: CHOICE_ID,
          resultIds: [],
          outcome: "choice_required",
          createdAt: "2026-09-03T10:00:01.000Z",
        },
      ],
      ordersById: new Map(),
      choiceEnvelopes: new Map([[CHOICE_ID, liveEnvelope]]),
    });
    expect(messages[0]?.parts).toEqual([
      { type: "text", text: "Select a variant for Macarons: Lemon." },
      { type: "data-choice", data: liveEnvelope },
    ]);
    expect(pendingChoiceFromMessages(messages, new Set())).toMatchObject({
      status: "needs_choice",
      challengeId: CHOICE_ID,
      messageId: MSG_ASSISTANT,
    });
  });

  it("restores expired, never a tappable picker, when the peek is expired", () => {
    const expired: StaffAssistantChoiceCardEnvelope = {
      status: "expired",
      challengeId: CHOICE_ID,
      options: [],
      optionsTruncated: false,
    };
    const messages = hydratedUiMessagesFromConversation({
      messages: [
        message({
          id: MSG_ASSISTANT,
          role: "assistant",
          body: "Select a variant.",
          createdAt: "2026-09-03T10:00:01.000Z",
        }),
      ],
      toolRuns: [
        {
          id: RUN_CHOICE,
          actionName: "orders.create",
          toolCallId: "call-create",
          challengeId: CHOICE_ID,
          resultIds: [],
          outcome: "choice_required",
          createdAt: "2026-09-03T10:00:01.000Z",
        },
      ],
      ordersById: new Map(),
      choiceEnvelopes: new Map([[CHOICE_ID, expired]]),
    });
    expect(messages[0]?.parts[1]).toEqual({
      type: "data-choice",
      data: expired,
    });
  });

  it("does not restore a list card when a list run sits next to a choice", () => {
    const messages = hydratedUiMessagesFromConversation({
      messages: [
        message({
          id: MSG_ASSISTANT,
          role: "assistant",
          body: "Ось список.",
          createdAt: "2026-09-03T10:00:01.000Z",
        }),
      ],
      toolRuns: [
        toolRun({
          id: RUN_LIST,
          actionName: "orders.list",
          toolCallId: "call-list",
          resultIds: [],
          createdAt: "2026-09-03T10:00:01.000Z",
        }),
        {
          id: RUN_CHOICE,
          actionName: "orders.create",
          toolCallId: "call-create",
          challengeId: CHOICE_ID,
          resultIds: [],
          outcome: "choice_required",
          createdAt: "2026-09-03T10:00:01.000Z",
        },
      ],
      ordersById: new Map(),
      choiceEnvelopes: new Map([[CHOICE_ID, liveEnvelope]]),
    });
    expect(messages[0]?.parts.map((part) => part.type)).toEqual([
      "text",
      "data-choice",
    ]);
    expect(assistantSurfacesFromParts(messages[0]?.parts ?? [], "uk")).toEqual(
      [],
    );
  });

  it("does not restore a tappable ChoiceCard when peek is completed", () => {
    const completed: StaffAssistantChoiceCardEnvelope = {
      ...liveEnvelope,
      status: "completed",
    };
    const createOutput = orderSnapshot(ORDER_B, "new");
    const messages = hydratedUiMessagesFromConversation({
      messages: [
        message({
          id: MSG_ASSISTANT,
          role: "assistant",
          body: "Select a variant for Macarons: Lemon.",
          createdAt: "2026-09-03T10:00:01.000Z",
        }),
        message({
          id: MSG_ASSISTANT_B,
          role: "assistant",
          body: "Замовлення створено.",
          createdAt: "2026-09-03T10:00:05.000Z",
        }),
      ],
      toolRuns: [
        choiceRequiredRun({
          id: RUN_CHOICE,
          challengeId: CHOICE_ID,
          createdAt: "2026-09-03T10:00:01.000Z",
        }),
        toolRun({
          id: RUN_CREATE,
          actionName: "orders.create",
          toolCallId: "call-create",
          resultIds: [ORDER_B],
          createdAt: "2026-09-03T10:00:05.000Z",
        }),
      ],
      ordersById: new Map([[ORDER_B, createOutput]]),
      choiceEnvelopes: new Map([[CHOICE_ID, completed]]),
    });
    expect(messages[0]?.parts).toEqual([
      { type: "text", text: "Select a variant for Macarons: Lemon." },
    ]);
    expect(messages[0]?.parts.map((part) => part.type)).not.toContain(
      "data-choice",
    );
    expect(pendingChoiceFromMessages(messages, new Set())).toBeNull();
    const surfaces = assistantSurfacesFromParts(messages[1]?.parts ?? [], "uk");
    expect(entitiesOf(surfaces).map((card) => card.orderId)).toEqual([ORDER_B]);
  });

  it("restores a claimed recovery card, not a free picker, after claim-before-create", () => {
    const claimed: StaffAssistantChoiceCardEnvelope = {
      ...liveEnvelope,
      status: "claimed",
      claimedOptionId: OPTION_LEMON,
      options: [
        { id: OPTION_LEMON, label: "Lemon" },
        { id: "88888888-8888-4888-8888-888888888888", label: "Vanilla" },
      ],
    };
    const messages = hydratedUiMessagesFromConversation({
      messages: [
        message({
          id: MSG_ASSISTANT,
          role: "assistant",
          body: "Select a variant.",
          createdAt: "2026-09-03T10:00:01.000Z",
        }),
      ],
      toolRuns: [
        choiceRequiredRun({
          id: RUN_CHOICE,
          challengeId: CHOICE_ID,
          createdAt: "2026-09-03T10:00:01.000Z",
        }),
      ],
      ordersById: new Map(),
      choiceEnvelopes: new Map([[CHOICE_ID, claimed]]),
    });
    expect(messages[0]?.parts).toEqual([
      { type: "text", text: "Select a variant." },
      { type: "data-choice", data: claimed },
    ]);
    const pending = pendingChoiceFromMessages(messages, new Set());
    expect(pending).toMatchObject({
      status: "claimed",
      challengeId: CHOICE_ID,
      claimedOptionId: OPTION_LEMON,
      messageId: MSG_ASSISTANT,
    });
    expect(JSON.stringify(claimed)).not.toContain("canonicalInput");
    expect(JSON.stringify(claimed)).not.toContain("optionMap");
    expect(JSON.stringify(claimed)).not.toContain("lineIndex");
  });

  it("still pending a sequential later needs_choice after a completed predecessor", () => {
    const completed: StaffAssistantChoiceCardEnvelope = {
      ...liveEnvelope,
      status: "completed",
    };
    const successor: StaffAssistantChoiceCardEnvelope = {
      ...liveEnvelope,
      challengeId: CHOICE_ID_B,
    };
    const messages = hydratedUiMessagesFromConversation({
      messages: [
        message({
          id: MSG_ASSISTANT,
          role: "assistant",
          body: "Select a variant for Macarons: Lemon.",
          createdAt: "2026-09-03T10:00:01.000Z",
        }),
        message({
          id: MSG_ASSISTANT_B,
          role: "assistant",
          body: "Select a variant for the second line.",
          createdAt: "2026-09-03T10:00:05.000Z",
        }),
      ],
      toolRuns: [
        choiceRequiredRun({
          id: RUN_CHOICE,
          challengeId: CHOICE_ID,
          createdAt: "2026-09-03T10:00:01.000Z",
        }),
        choiceRequiredRun({
          id: RUN_CHOICE_B,
          challengeId: CHOICE_ID_B,
          createdAt: "2026-09-03T10:00:05.000Z",
        }),
      ],
      ordersById: new Map(),
      choiceEnvelopes: new Map([
        [CHOICE_ID, completed],
        [CHOICE_ID_B, successor],
      ]),
    });
    expect(messages[0]?.parts.map((part) => part.type)).toEqual(["text"]);
    expect(messages[1]?.parts).toEqual([
      { type: "text", text: "Select a variant for the second line." },
      { type: "data-choice", data: successor },
    ]);
    expect(pendingChoiceFromMessages(messages, new Set())).toMatchObject({
      status: "needs_choice",
      challengeId: CHOICE_ID_B,
      messageId: MSG_ASSISTANT_B,
    });
  });

  it("hydrated expired peek is expired copy, not a tappable picker", () => {
    const expired: StaffAssistantChoiceCardEnvelope = {
      status: "expired",
      challengeId: CHOICE_ID,
      options: [],
      optionsTruncated: false,
    };
    const messages = hydratedUiMessagesFromConversation({
      messages: [
        message({
          id: MSG_ASSISTANT,
          role: "assistant",
          body: "Select a variant.",
          createdAt: "2026-09-03T10:00:01.000Z",
        }),
      ],
      toolRuns: [
        choiceRequiredRun({
          id: RUN_CHOICE,
          challengeId: CHOICE_ID,
          createdAt: "2026-09-03T10:00:01.000Z",
        }),
      ],
      ordersById: new Map(),
      choiceEnvelopes: new Map([[CHOICE_ID, expired]]),
    });
    const pending = pendingChoiceFromMessages(messages, new Set());
    expect(pending).toMatchObject({
      status: "expired",
      challengeId: CHOICE_ID,
      options: [],
    });
    expect(pending?.options).toEqual([]);
    expect(
      pendingChoiceFromMessages(messages, new Set([CHOICE_ID])),
    ).toMatchObject({
      status: "expired",
      challengeId: CHOICE_ID,
    });
  });
});

describe("loadChoiceEnvelopes", () => {
  const liveEnvelope: StaffAssistantChoiceCardEnvelope = {
    status: "needs_choice",
    challengeId: CHOICE_ID,
    reason: "variant_required",
    productName: "Macarons",
    options: [{ id: OPTION_LEMON, label: "Lemon" }],
    optionsTruncated: false,
  };

  it("omits a temporary peek failure instead of marking the choice expired", async () => {
    const envelopes = await loadChoiceEnvelopes({
      choiceIds: [CHOICE_ID],
      peekChoice: () => Promise.reject(new TypeError("Failed to fetch")),
    });
    expect(envelopes.has(CHOICE_ID)).toBe(false);
    const messages = hydratedUiMessagesFromConversation({
      messages: [
        message({
          id: MSG_ASSISTANT,
          role: "assistant",
          body: "Select a variant.",
          createdAt: "2026-09-03T10:00:01.000Z",
        }),
      ],
      toolRuns: [
        {
          id: RUN_CHOICE,
          actionName: "orders.create",
          toolCallId: "call-create",
          challengeId: CHOICE_ID,
          resultIds: [],
          outcome: "choice_required",
          createdAt: "2026-09-03T10:00:01.000Z",
        },
      ],
      ordersById: new Map(),
      choiceEnvelopes: envelopes,
    });
    expect(messages[0]?.parts).toEqual([
      { type: "text", text: "Select a variant." },
    ]);
    expect(pendingChoiceFromMessages(messages, new Set())).toBeNull();
  });

  it("restores the live card after a later successful peek", async () => {
    const failed = await loadChoiceEnvelopes({
      choiceIds: [CHOICE_ID],
      peekChoice: () => Promise.resolve(undefined),
    });
    expect(failed.size).toBe(0);
    const restored = await loadChoiceEnvelopes({
      choiceIds: [CHOICE_ID],
      peekChoice: () => Promise.resolve(liveEnvelope),
    });
    expect(restored.get(CHOICE_ID)).toEqual(liveEnvelope);
    const messages = hydratedUiMessagesFromConversation({
      messages: [
        message({
          id: MSG_ASSISTANT,
          role: "assistant",
          body: "Select a variant.",
          createdAt: "2026-09-03T10:00:01.000Z",
        }),
      ],
      toolRuns: [
        {
          id: RUN_CHOICE,
          actionName: "orders.create",
          toolCallId: "call-create",
          challengeId: CHOICE_ID,
          resultIds: [],
          outcome: "choice_required",
          createdAt: "2026-09-03T10:00:01.000Z",
        },
      ],
      ordersById: new Map(),
      choiceEnvelopes: restored,
    });
    expect(pendingChoiceFromMessages(messages, new Set())).toMatchObject({
      status: "needs_choice",
      challengeId: CHOICE_ID,
    });
  });
});

describe("assistant hydrate source", () => {
  it("does not look for façade names or walk nested list rows", () => {
    const source = readFileSync(
      new URL("./assistant-hydrate.ts", import.meta.url),
      "utf8",
    );
    const session = readFileSync(
      new URL("./assistant-session.ts", import.meta.url),
      "utf8",
    );
    const hook = readFileSync(
      new URL("../sheet/use-assistant-chat.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain("orders_list_page");
    expect(source).not.toContain("orders_list_counts");
    expect(source).not.toContain("data-presentation");
    expect(source).not.toContain("extractUuidResultIds");
    expect(source).not.toContain('"active"');
    expect(source).not.toContain("Підтвердити");
    expect(source).not.toContain("sit.svg");
    expect(source).not.toContain("dig.svg");
    expect(source).toContain("next.createdAt > run.createdAt");
    expect(source).toContain("unrestorableAssistantActionNames");
    expect(source).toContain("unrestorableActions.has(");
    expect(source).not.toContain("unrestorableAssistantListAction");
    expect(source).not.toMatch(/\bUNRESTORABLE_LIST_ACTION\b/);
    expect(session).toContain("resumeOwnAssistantConversation");
    expect(session).not.toContain("orders_list_page");
    expect(hook).toContain("resumeOwnAssistantConversation");
    expect(hook).toContain("auth.session?.userId");
    expect(hook).toContain('result.kind === "unavailable"');
    expect(hook).toContain("getAssistantPending");
    expect(hook).toContain("postAssistantChat");
    expect(hook).toContain("commitAssistantHostResult");
    expect(hook).toContain("postAssistantConfirm");
    expect(hook).toContain("postAssistantPendingAbandon");
    expect(hook).not.toContain("createStaffAssistantTransport");
    expect(hook).not.toContain("peekAssistantChoice");
    expect(hook).not.toContain("ensureAssistantConversation");
    expect(hook).not.toContain("userId:");
    expect(hook).not.toContain("companyId:");
  });
});

describe("hydration registry derivation (SHO-456)", () => {
  it("derives hydratable actions from the shared registry and does not restore lists", () => {
    expect([...HYDRATABLE_ORDER_ENTITY_ACTIONS].sort()).toEqual([
      "orders.create",
      "orders.get",
    ]);
    expect([...UNRESTORABLE_LIST_ACTIONS].sort()).toEqual([
      "customers.listCustomers",
      "orders.list",
    ]);
    expect(
      isHydratableOrderEntityRun({
        id: RUN_GET,
        actionName: "orders.get",
        toolCallId: "call-get",
        resultIds: [ORDER_A],
        outcome: "success",
        createdAt: "2026-09-03T10:00:01.000Z",
      }),
    ).toBe(true);
    expect(
      isHydratableOrderEntityRun({
        id: RUN_CREATE,
        actionName: "orders.create",
        toolCallId: "call-create",
        resultIds: [ORDER_B],
        outcome: "success",
        createdAt: "2026-09-03T10:00:02.000Z",
      }),
    ).toBe(true);
    expect(
      isUnrestorableListRun({
        id: RUN_LIST,
        actionName: "orders.list",
        toolCallId: "call-list",
        resultIds: [],
        outcome: "success",
        createdAt: "2026-09-03T10:00:01.000Z",
      }),
    ).toBe(true);
    expect(
      isUnrestorableListRun({
        id: RUN_GET,
        actionName: "customers.listCustomers",
        toolCallId: "call-customers-list",
        resultIds: [],
        outcome: "success",
        createdAt: "2026-09-03T10:00:01.000Z",
      }),
    ).toBe(true);
  });

  it("recognises every unrestorable action from a fixture registry (SHO-461)", () => {
    const fixtureRegistry: readonly AssistantSurfaceDescriptor[] = [
      {
        kind: "orders-list",
        version: 1,
        toolNames: [],
        actionNames: ["orders.list"],
        hydratable: false,
        promptLine: "fixture",
        destination: { kind: "screen" },
        parse: () => null,
      },
      {
        kind: "orders-aggregate",
        version: 1,
        toolNames: [],
        actionNames: ["customers.list"],
        hydratable: false,
        promptLine: "fixture",
        destination: { kind: "screen" },
        parse: () => null,
      },
      {
        kind: "order-entity",
        version: 1,
        toolNames: [],
        actionNames: ["orders.get", "orders.create"],
        hydratable: true,
        promptLine: "fixture",
        destination: { kind: "screen" },
        parse: () => null,
      },
    ];
    const unrestorable = unrestorableAssistantActionNames(fixtureRegistry);
    expect([...unrestorable].sort()).toEqual(["customers.list", "orders.list"]);
    const listRun = toolRun({
      id: RUN_LIST,
      actionName: "orders.list",
      toolCallId: "call-list",
      createdAt: "2026-09-03T10:00:01.000Z",
    });
    const customersListRun = toolRun({
      id: RUN_GET,
      actionName: "customers.list",
      toolCallId: "call-customers-list",
      createdAt: "2026-09-03T10:00:01.000Z",
    });
    const getRun = toolRun({
      id: RUN_CREATE,
      actionName: "orders.get",
      toolCallId: "call-get",
      resultIds: [ORDER_A],
      createdAt: "2026-09-03T10:00:01.000Z",
    });
    expect(isUnrestorableListRun(listRun, unrestorable)).toBe(true);
    expect(isUnrestorableListRun(customersListRun, unrestorable)).toBe(true);
    expect(isUnrestorableListRun(getRun, unrestorable)).toBe(false);
    expect(isHydratableOrderEntityRun(getRun)).toBe(true);
    expect(isHydratableOrderEntityRun(customersListRun)).toBe(false);
  });
});

describe("applyOpenPendingToHydratedMessages (SHO-522)", () => {
  it("injects a confirmation card from GET pending", () => {
    const challengeId = "22222222-2222-4222-8222-222222222222";
    const messages = applyOpenPendingToHydratedMessages({
      messages: [
        {
          id: MSG_ASSISTANT,
          role: "assistant",
          parts: [{ type: "text", text: "Confirm delete." }],
        },
      ],
      pending: {
        kind: "confirmation",
        id: challengeId,
        version: 2,
        status: "open",
        actionName: "customers.deleteCustomer",
        challengeId,
        summary: "Delete this archived customer.",
        expiresAt: "2026-09-08T12:00:00.000Z",
        toolCallId: "call-delete",
      },
    });
    expect(messages[0]?.parts[1]).toMatchObject({
      type: "data-confirmation",
      data: {
        challengeId,
        pendingVersion: 2,
        summary: "Delete this archived customer.",
      },
    });
  });

  it("injects a choice card with pendingVersion from GET pending", () => {
    const choiceId = "44444444-4444-4444-8444-444444444444";
    const envelope = {
      status: "needs_choice" as const,
      challengeId: choiceId,
      reason: "variant_required" as const,
      productName: "Macarons",
      options: [{ id: OPTION_LEMON, label: "Lemon" }],
      optionsTruncated: false,
    };
    const messages = applyOpenPendingToHydratedMessages({
      messages: [
        {
          id: MSG_ASSISTANT,
          role: "assistant",
          parts: [{ type: "text", text: "Select a variant." }],
        },
      ],
      pending: {
        kind: "choice",
        id: choiceId,
        version: 3,
        status: "open",
        actionName: "orders.create",
        envelope,
      },
    });
    expect(messages[0]?.parts[1]).toEqual({
      type: "data-choice",
      data: envelope,
      pendingVersion: 3,
    });
  });
});
