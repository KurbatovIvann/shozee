import { describe, expect, it } from "vitest";

import { assistantCopy } from "../../../i18n/assistant";
import {
  ASSISTANT_LIVE_WAIT_ROW_ID,
  assistantChatRows,
  assistantDisplayRows,
  assistantRowHasInFlightTools,
  assistantTurnIsWaiting,
} from "./chat-rows";
import type { PendingChoice } from "./choice-presenter";
import type { PendingConfirmation } from "./confirmation-presenter";

const copy = assistantCopy("uk");

const pending: PendingConfirmation = {
  status: "confirmation_required",
  challengeId: "22222222-2222-4222-8222-222222222222",
  summary: "Delete this archived customer.",
  expiresAt: "2026-09-01T12:00:00.000Z",
  actionName: "customers.deleteCustomer",
  toolCallId: "call-delete",
  messageId: "a1",
};

const hitlToolOutput = {
  status: "confirmation_required" as const,
  challengeId: pending.challengeId,
  summary: pending.summary,
  expiresAt: pending.expiresAt,
  actionName: pending.actionName,
  toolCallId: pending.toolCallId,
};

const pageOutput = {
  kind: "page.summary",
  items: [
    {
      orderId: "ord-1",
      orderNumber: "1049",
      totalGrossMinor: 33000,
    },
  ],
};

describe("assistantChatRows", () => {
  it("attaches the pending confirmation to the matching assistant row", () => {
    expect(
      assistantChatRows(
        [
          {
            id: "u1",
            role: "user",
            parts: [{ type: "text", text: "Delete the customer" }],
          },
          {
            id: "a1",
            role: "assistant",
            parts: [{ type: "text", text: "Confirmation required." }],
          },
        ],
        pending,
        copy,
      ),
    ).toEqual([
      {
        id: "u1",
        role: "user",
        text: "Delete the customer",
        confirmation: null,
        choice: null,
        timeline: [],
        surfaces: [],
      },
      {
        id: "a1",
        role: "assistant",
        text: "Confirmation required.",
        confirmation: pending,
        choice: null,
        timeline: [],
        surfaces: [],
      },
    ]);
  });

  it("keeps an empty-text in-flight tool row", () => {
    const rows = assistantChatRows(
      [
        {
          id: "u1",
          role: "user",
          parts: [{ type: "text", text: "Замовлення в роботі" }],
        },
        {
          id: "a1",
          role: "assistant",
          parts: [
            {
              type: "tool-orders_list_page",
              toolCallId: "call-page",
              state: "input-available",
            },
          ],
        },
      ],
      null,
      copy,
    );
    expect(rows).toHaveLength(2);
    const inFlightRow = {
      id: "a1",
      role: "assistant" as const,
      text: "",
      confirmation: null,
      choice: null,
      timeline: [
        {
          id: "call-page",
          label: "Шукаю замовлення",
          status: "running" as const,
        },
      ],
      surfaces: [],
    };
    expect(rows[1]).toEqual(inFlightRow);
    expect(assistantRowHasInFlightTools(inFlightRow)).toBe(true);
  });

  it("keeps an empty-text row after the tool result arrives", () => {
    const rows = assistantChatRows(
      [
        {
          id: "a1",
          role: "assistant",
          parts: [
            {
              type: "tool-orders_list_counts",
              toolCallId: "call-counts",
              state: "output-available",
              output: { kind: "aggregate", orderCount: 6 },
            },
          ],
        },
      ],
      null,
      copy,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).toBe("");
    expect(rows[0]?.confirmation).toBeNull();
    expect(rows[0]?.timeline).toEqual([
      {
        id: "call-counts",
        label: "Рахую виторг",
        status: "done",
      },
    ]);
    expect(rows[0]?.surfaces.map((surface) => surface.kind)).toEqual([
      "orders-aggregate",
    ]);
    const doneRow = rows[0];
    expect(doneRow).toBeDefined();
    if (doneRow === undefined) {
      return;
    }
    expect(assistantRowHasInFlightTools(doneRow)).toBe(false);
    expect(doneRow.text.includes("aggregate")).toBe(false);
    expect(doneRow.text.includes("orderCount")).toBe(false);
  });

  it("does not stringify tool JSON into the bubble text", () => {
    const rows = assistantChatRows(
      [
        {
          id: "a1",
          role: "assistant",
          parts: [
            { type: "text", text: "Ось що знайшла." },
            {
              type: "tool-orders_list_page",
              toolCallId: "call-page",
              state: "output-available",
              output: pageOutput,
            },
          ],
        },
      ],
      null,
      copy,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).toBe("Ось що знайшла.");
    expect(rows[0]?.text.includes("page.summary")).toBe(false);
    expect(rows[0]?.text.includes("totalGrossMinor")).toBe(false);
    expect(JSON.stringify(rows[0]?.timeline).includes("page.summary")).toBe(
      false,
    );
    expect(rows[0]?.timeline[0]?.label).toBe("Шукаю замовлення");
    expect(rows[0]?.timeline[0]?.label.includes("orders_list_page")).toBe(
      false,
    );
    expect(rows[0]?.surfaces.map((surface) => surface.kind)).toEqual([
      "orders-list",
    ]);
    expect(JSON.stringify(rows[0]?.text).includes("page.summary")).toBe(false);
  });

  it("still attaches HITL data-confirmation to the matching assistant row with tools", () => {
    const rows = assistantChatRows(
      [
        {
          id: "a1",
          role: "assistant",
          parts: [
            { type: "data-confirmation", data: pending },
            {
              type: "tool-customers.deleteCustomer",
              toolCallId: "call-delete",
              state: "input-available",
            },
          ],
        },
      ],
      pending,
      copy,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.confirmation).toEqual(pending);
    expect(rows[0]?.text).toBe("");
    expect(rows[0]?.timeline).toEqual([
      {
        id: "call-delete",
        label: "Працюю",
        status: "running",
      },
    ]);
  });

  it("still drops empty-text messages with no confirmation and no tools", () => {
    expect(
      assistantChatRows(
        [
          {
            id: "a1",
            role: "assistant",
            parts: [{ type: "text", text: "" }],
          },
        ],
        null,
        copy,
      ),
    ).toEqual([]);
  });

  it("keeps HITL output-available in-flight and bound while pending", () => {
    const rows = assistantChatRows(
      [
        {
          id: "a1",
          role: "assistant",
          parts: [
            { type: "data-confirmation", data: pending },
            {
              type: "tool-customers.deleteCustomer",
              toolCallId: "call-delete",
              state: "output-available",
              output: hitlToolOutput,
            },
          ],
        },
      ],
      pending,
      copy,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.confirmation).toEqual(pending);
    expect(rows[0]?.timeline).toEqual([
      {
        id: "call-delete",
        label: "Працюю",
        status: "running",
      },
    ]);
    const pendingHitlRow = rows[0];
    expect(pendingHitlRow).toBeDefined();
    if (pendingHitlRow === undefined) {
      return;
    }
    expect(assistantRowHasInFlightTools(pendingHitlRow)).toBe(true);
    expect(pendingHitlRow.text.includes("confirmation_required")).toBe(false);
    expect(
      JSON.stringify(pendingHitlRow.timeline).includes("confirmation_required"),
    ).toBe(false);
    expect(
      JSON.stringify(pendingHitlRow.timeline).includes(pending.summary),
    ).toBe(false);
  });

  it("omits a dismissed HITL timeline step and drops the empty row", () => {
    expect(
      assistantChatRows(
        [
          {
            id: "a1",
            role: "assistant",
            parts: [
              { type: "data-confirmation", data: pending },
              {
                type: "tool-customers.deleteCustomer",
                toolCallId: "call-delete",
                state: "output-available",
                output: hitlToolOutput,
              },
            ],
          },
        ],
        null,
        copy,
        new Set([pending.challengeId]),
      ),
    ).toEqual([]);
  });

  it("omits a dismissed in-flight HITL step matched by data-confirmation toolCallId", () => {
    expect(
      assistantChatRows(
        [
          {
            id: "a1",
            role: "assistant",
            parts: [
              { type: "data-confirmation", data: pending },
              {
                type: "tool-customers.deleteCustomer",
                toolCallId: "call-delete",
                state: "input-available",
              },
            ],
          },
        ],
        null,
        copy,
        new Set([pending.challengeId]),
      ),
    ).toEqual([]);
  });

  it("keeps other tools after omitting a dismissed HITL step", () => {
    const rows = assistantChatRows(
      [
        {
          id: "a1",
          role: "assistant",
          parts: [
            {
              type: "tool-orders_list_counts",
              toolCallId: "call-counts",
              state: "output-available",
              output: { kind: "aggregate", orderCount: 6 },
            },
            { type: "data-confirmation", data: pending },
            {
              type: "tool-customers.deleteCustomer",
              toolCallId: "call-delete",
              state: "output-available",
              output: hitlToolOutput,
            },
          ],
        },
      ],
      null,
      copy,
      new Set([pending.challengeId]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).toBe("");
    expect(rows[0]?.confirmation).toBeNull();
    expect(rows[0]?.timeline).toEqual([
      {
        id: "call-counts",
        label: "Рахую виторг",
        status: "done",
      },
    ]);
    expect(rows[0]?.surfaces.map((surface) => surface.kind)).toEqual([
      "orders-aggregate",
    ]);
    const remainingRow = rows[0];
    expect(remainingRow).toBeDefined();
    if (remainingRow === undefined) {
      return;
    }
    expect(assistantRowHasInFlightTools(remainingRow)).toBe(false);
  });

  it("attaches one list card for page + counts and one aggregate card for counts-only", () => {
    const pageAndCounts = assistantChatRows(
      [
        {
          id: "a1",
          role: "assistant",
          parts: [
            {
              type: "tool-orders_list_counts",
              toolCallId: "call-counts",
              state: "output-available",
              output: {
                kind: "aggregate",
                buckets: [
                  {
                    identity: { kind: "status", status: "new" },
                    orderCount: 1,
                  },
                ],
              },
            },
            {
              type: "tool-orders_list_page",
              toolCallId: "call-page",
              state: "output-available",
              output: {
                kind: "page.summary",
                items: [
                  {
                    orderId: "0f0e2d5c-4a1b-4c3d-9e8f-102938475601",
                    orderNumber: "1049",
                    customer: { nameSnapshot: "Іван", linkedCustomerId: null },
                    status: "new",
                    itemCount: 1,
                    totalGrossMinor: "1000",
                    currency: "UAH",
                    createdAt: "2026-09-03T10:00:00.000Z",
                  },
                ],
                nextCursor: null,
                customerMatchTruncated: false,
              },
            },
          ],
        },
      ],
      null,
      copy,
    );
    expect(pageAndCounts[0]?.surfaces.map((surface) => surface.kind)).toEqual([
      "orders-list",
    ]);
    const listSurface = pageAndCounts[0]?.surfaces[0];
    expect(listSurface?.kind).toBe("orders-list");
    expect(
      listSurface?.kind === "orders-list" ? listSurface.chips : [],
    ).toHaveLength(1);

    const countsOnly = assistantChatRows(
      [
        {
          id: "a1",
          role: "assistant",
          parts: [
            {
              type: "tool-orders_list_counts",
              toolCallId: "call-counts",
              state: "output-available",
              output: { kind: "aggregate", orderCount: 6 },
            },
          ],
        },
      ],
      null,
      copy,
    );
    expect(countsOnly[0]?.surfaces.map((surface) => surface.kind)).toEqual([
      "orders-aggregate",
    ]);
  });

  it("keeps a successful tool result after the HITL challenge is resolved", () => {
    const rows = assistantChatRows(
      [
        {
          id: "a1",
          role: "assistant",
          parts: [
            { type: "data-confirmation", data: pending },
            {
              type: "tool-customers.deleteCustomer",
              toolCallId: "call-delete",
              state: "output-available",
              output: { deleted: true },
            },
          ],
        },
      ],
      null,
      copy,
      new Set([pending.challengeId]),
    );
    expect(rows).toEqual([
      {
        id: "a1",
        role: "assistant",
        text: "",
        confirmation: null,
        choice: null,
        timeline: [
          {
            id: "call-delete",
            label: "Працюю",
            status: "done",
          },
        ],
        surfaces: [],
      },
    ]);
  });
});

const hitlParts = [
  { type: "data-confirmation" as const, data: pending },
  {
    type: "tool-customers.deleteCustomer" as const,
    toolCallId: "call-delete",
    state: "input-available" as const,
  },
];

describe("assistantTurnIsWaiting", () => {
  it("waits only on a live submitted or streaming turn without HITL", () => {
    expect(assistantTurnIsWaiting({ status: "submitted", rows: [] })).toBe(
      true,
    );
    expect(assistantTurnIsWaiting({ status: "streaming", rows: [] })).toBe(
      true,
    );
    expect(assistantTurnIsWaiting({ status: "ready", rows: [] })).toBe(false);
    expect(assistantTurnIsWaiting({ status: "error", rows: [] })).toBe(false);
  });

  it("does not wait when HITL is on the current turn", () => {
    const rows = assistantChatRows(
      [
        {
          id: "a1",
          role: "assistant",
          parts: hitlParts,
        },
      ],
      pending,
      copy,
    );
    expect(assistantTurnIsWaiting({ status: "streaming", rows })).toBe(false);
    expect(assistantTurnIsWaiting({ status: "submitted", rows })).toBe(false);
  });

  it("does not wait when a pending ChoiceCard is on the current turn", () => {
    const choice: PendingChoice = {
      status: "needs_choice",
      challengeId: "33333333-3333-4333-8333-333333333333",
      reason: "variant_required",
      productName: "Macarons",
      options: [{ id: "88888888-8888-4888-8888-888888888888", label: "Lemon" }],
      optionsTruncated: false,
      messageId: "a1",
    };
    const rows = assistantChatRows(
      [
        {
          id: "u1",
          role: "user",
          parts: [{ type: "text", text: "Create macarons" }],
        },
        {
          id: "a1",
          role: "assistant",
          parts: [
            { type: "text", text: "Select a variant." },
            { type: "data-choice", data: choice },
          ],
        },
      ],
      null,
      copy,
      new Set(),
      "uk",
      choice,
    );
    expect(rows[1]?.choice).toEqual(choice);
    expect(assistantTurnIsWaiting({ status: "streaming", rows })).toBe(false);
  });

  it("still waits when leftover HITL is on a past assistant", () => {
    const rows = assistantChatRows(
      [
        {
          id: "u1",
          role: "user",
          parts: [{ type: "text", text: "Delete the customer" }],
        },
        {
          id: "a1",
          role: "assistant",
          parts: hitlParts,
        },
        {
          id: "u2",
          role: "user",
          parts: [{ type: "text", text: "а за цей тиждень?" }],
        },
      ],
      pending,
      copy,
    );
    expect(rows[1]?.confirmation).toEqual(pending);
    expect(assistantTurnIsWaiting({ status: "submitted", rows })).toBe(true);
    expect(assistantTurnIsWaiting({ status: "streaming", rows })).toBe(true);
  });
});

describe("assistantDisplayRows", () => {
  const streamingParts = [
    { type: "text" as const, text: "Ось що знайшла." },
    {
      type: "tool-orders_list_page" as const,
      toolCallId: "call-page",
      state: "output-available" as const,
      output: pageOutput,
    },
  ];

  it("shows a wait line and hides streamed text and surfaces on a live in-flight turn", () => {
    const mapped = assistantChatRows(
      [
        {
          id: "u1",
          role: "user",
          parts: [{ type: "text", text: "покажи активні замовлення" }],
        },
        {
          id: "a1",
          role: "assistant",
          parts: streamingParts,
        },
      ],
      null,
      copy,
    );
    expect(mapped[1]?.text).toBe("Ось що знайшла.");
    expect(mapped[1]?.surfaces.map((surface) => surface.kind)).toEqual([
      "orders-list",
    ]);
    const visible = assistantDisplayRows(
      mapped,
      assistantTurnIsWaiting({ status: "streaming", rows: mapped }),
    );
    expect(visible).toHaveLength(2);
    expect(visible[0]?.role).toBe("user");
    expect(visible[1]).toEqual({
      id: ASSISTANT_LIVE_WAIT_ROW_ID,
      role: "assistant",
      text: "",
      confirmation: null,
      choice: null,
      surfaces: [],
      waiting: true,
    });
    expect(visible[1]?.text.includes("Ось")).toBe(false);
    expect(visible[1]?.surfaces).toEqual([]);
  });

  it("renders assistant text parts as prose without parsing a spoken envelope", () => {
    expect(
      assistantChatRows(
        [
          {
            id: "a1",
            role: "assistant",
            parts: [{ type: "text", text: '{"spoken":"nope"}' }],
          },
        ],
        null,
        copy,
      ),
    ).toEqual([
      {
        id: "a1",
        role: "assistant",
        text: '{"spoken":"nope"}',
        confirmation: null,
        choice: null,
        timeline: [],
        surfaces: [],
      },
    ]);
  });

  it("reveals spoken text and surfaces together when the turn is ready", () => {
    const mapped = assistantChatRows(
      [
        {
          id: "a1",
          role: "assistant",
          parts: streamingParts,
        },
      ],
      null,
      copy,
    );
    const visible = assistantDisplayRows(
      mapped,
      assistantTurnIsWaiting({ status: "ready", rows: mapped }),
    );
    expect(visible).toHaveLength(1);
    expect(visible[0]?.waiting).toBe(false);
    expect(visible[0]?.text).toBe("Ось що знайшла.");
    expect(visible[0]?.surfaces.map((surface) => surface.kind)).toEqual([
      "orders-list",
    ]);
    expect(visible[0]?.id).toBe("a1");
  });

  it("reveals on error the same way as ready — no wait line", () => {
    const mapped = assistantChatRows(
      [
        {
          id: "a1",
          role: "assistant",
          parts: streamingParts,
        },
      ],
      null,
      copy,
    );
    const visible = assistantDisplayRows(
      mapped,
      assistantTurnIsWaiting({ status: "error", rows: mapped }),
    );
    expect(visible[0]?.waiting).toBe(false);
    expect(visible[0]?.text).toBe("Ось що знайшла.");
    expect(visible[0]?.surfaces).toHaveLength(1);
  });

  it("hides the wait line and shows the HITL confirmation card immediately", () => {
    const mapped = assistantChatRows(
      [
        {
          id: "a1",
          role: "assistant",
          parts: [
            { type: "data-confirmation", data: pending },
            {
              type: "tool-customers.deleteCustomer",
              toolCallId: "call-delete",
              state: "input-available",
            },
          ],
        },
      ],
      pending,
      copy,
    );
    const liveWaiting = assistantTurnIsWaiting({
      status: "streaming",
      rows: mapped,
    });
    expect(liveWaiting).toBe(false);
    const visible = assistantDisplayRows(mapped, liveWaiting);
    expect(visible).toHaveLength(1);
    expect(visible[0]?.waiting).toBe(false);
    expect(visible[0]?.confirmation).toEqual(pending);
    expect(visible[0]?.id).toBe("a1");
  });

  it("waits on a follow-up while leftover HITL on a past assistant stays visible", () => {
    const mapped = assistantChatRows(
      [
        {
          id: "u1",
          role: "user",
          parts: [{ type: "text", text: "Delete the customer" }],
        },
        {
          id: "a1",
          role: "assistant",
          parts: hitlParts,
        },
        {
          id: "u2",
          role: "user",
          parts: [{ type: "text", text: "а за цей тиждень?" }],
        },
      ],
      pending,
      copy,
    );
    expect(mapped[1]?.confirmation).toEqual(pending);

    for (const status of ["submitted", "streaming"] as const) {
      const liveWaiting = assistantTurnIsWaiting({
        status,
        rows: mapped,
      });
      expect(liveWaiting).toBe(true);
      const visible = assistantDisplayRows(mapped, liveWaiting);
      expect(visible.map((row) => row.id)).toEqual([
        "u1",
        "a1",
        "u2",
        ASSISTANT_LIVE_WAIT_ROW_ID,
      ]);
      expect(visible[1]).toMatchObject({
        id: "a1",
        role: "assistant",
        waiting: false,
        confirmation: pending,
        choice: null,
      });
      expect(visible[1]?.waiting).toBe(false);
      expect(visible[3]?.waiting).toBe(true);
      expect(visible[3]?.id).toBe(ASSISTANT_LIVE_WAIT_ROW_ID);
    }
  });

  it("hides a new in-flight assistant on follow-up while leftover HITL stays", () => {
    const mapped = assistantChatRows(
      [
        {
          id: "u1",
          role: "user",
          parts: [{ type: "text", text: "Delete the customer" }],
        },
        {
          id: "a1",
          role: "assistant",
          parts: hitlParts,
        },
        {
          id: "u2",
          role: "user",
          parts: [{ type: "text", text: "а за цей тиждень?" }],
        },
        {
          id: "a2",
          role: "assistant",
          parts: streamingParts,
        },
      ],
      pending,
      copy,
    );
    const liveWaiting = assistantTurnIsWaiting({
      status: "streaming",
      rows: mapped,
    });
    expect(liveWaiting).toBe(true);
    const visible = assistantDisplayRows(mapped, liveWaiting);
    expect(visible.map((row) => row.id)).toEqual([
      "u1",
      "a1",
      "u2",
      ASSISTANT_LIVE_WAIT_ROW_ID,
    ]);
    expect(visible[1]?.confirmation).toEqual(pending);
    expect(visible[1]?.waiting).toBe(false);
    expect(visible.some((row) => row.id === "a2")).toBe(false);
    expect(visible[3]?.waiting).toBe(true);
  });

  it("never waits on hydrate / past turns", () => {
    const mapped = assistantChatRows(
      [
        {
          id: "u1",
          role: "user",
          parts: [{ type: "text", text: "Покажи активні замовлення" }],
        },
        {
          id: "a1",
          role: "assistant",
          parts: [{ type: "text", text: "Ось активні замовлення." }],
        },
      ],
      null,
      copy,
    );
    const visible = assistantDisplayRows(
      mapped,
      assistantTurnIsWaiting({ status: "ready", rows: mapped }),
    );
    expect(visible.every((row) => !row.waiting)).toBe(true);
    expect(visible[1]?.text).toBe("Ось активні замовлення.");
    expect(visible[1]?.surfaces).toEqual([]);
  });

  it("keeps a previous ready assistant visible while a follow-up waits", () => {
    const mapped = assistantChatRows(
      [
        {
          id: "u1",
          role: "user",
          parts: [{ type: "text", text: "покажи активні замовлення" }],
        },
        {
          id: "a1",
          role: "assistant",
          parts: streamingParts,
        },
        {
          id: "u2",
          role: "user",
          parts: [{ type: "text", text: "а за цей тиждень?" }],
        },
      ],
      null,
      copy,
    );
    const visible = assistantDisplayRows(
      mapped,
      assistantTurnIsWaiting({ status: "submitted", rows: mapped }),
    );
    expect(visible).toHaveLength(4);
    expect(visible[0]?.role).toBe("user");
    expect(visible[1]).toMatchObject({
      id: "a1",
      role: "assistant",
      text: "Ось що знайшла.",
      waiting: false,
    });
    expect(visible[1]?.waiting).toBe(false);
    expect(visible[1]?.surfaces.map((surface) => surface.kind)).toEqual([
      "orders-list",
    ]);
    expect(visible[2]).toMatchObject({
      id: "u2",
      role: "user",
      text: "а за цей тиждень?",
      waiting: false,
    });
    expect(visible[3]).toEqual({
      id: ASSISTANT_LIVE_WAIT_ROW_ID,
      role: "assistant",
      text: "",
      confirmation: null,
      choice: null,
      surfaces: [],
      waiting: true,
    });
  });

  it("hides only the current in-flight assistant on a follow-up stream", () => {
    const mapped = assistantChatRows(
      [
        {
          id: "u1",
          role: "user",
          parts: [{ type: "text", text: "покажи активні замовлення" }],
        },
        {
          id: "a1",
          role: "assistant",
          parts: streamingParts,
        },
        {
          id: "u2",
          role: "user",
          parts: [{ type: "text", text: "а за цей тиждень?" }],
        },
        {
          id: "a2",
          role: "assistant",
          parts: streamingParts,
        },
      ],
      null,
      copy,
    );
    const visible = assistantDisplayRows(
      mapped,
      assistantTurnIsWaiting({ status: "streaming", rows: mapped }),
    );
    expect(visible.map((row) => row.id)).toEqual([
      "u1",
      "a1",
      "u2",
      ASSISTANT_LIVE_WAIT_ROW_ID,
    ]);
    expect(visible[1]?.waiting).toBe(false);
    expect(visible[1]?.text).toBe("Ось що знайшла.");
    expect(visible[1]?.surfaces.map((surface) => surface.kind)).toEqual([
      "orders-list",
    ]);
    expect(visible[3]?.waiting).toBe(true);
    expect(visible.some((row) => row.id === "a2")).toBe(false);
  });

  it("injects a wait row when the live turn has no assistant message yet", () => {
    const mapped = assistantChatRows(
      [
        {
          id: "u1",
          role: "user",
          parts: [{ type: "text", text: "покажи активні замовлення" }],
        },
      ],
      null,
      copy,
    );
    const visible = assistantDisplayRows(mapped, true);
    expect(visible.map((row) => row.role)).toEqual(["user", "assistant"]);
    expect(visible[1]?.waiting).toBe(true);
    expect(visible[1]?.text).toBe("");
    expect(visible[1]?.surfaces).toEqual([]);
    expect(visible[1]?.id).toBe(ASSISTANT_LIVE_WAIT_ROW_ID);
  });

  it("does not persist wait-state onto a past ready turn after buffering", () => {
    const mapped = assistantChatRows(
      [
        {
          id: "a1",
          role: "assistant",
          parts: streamingParts,
        },
      ],
      null,
      copy,
    );
    const whileLive = assistantDisplayRows(mapped, true);
    expect(whileLive[0]?.waiting).toBe(true);
    const afterReady = assistantDisplayRows(mapped, false);
    expect(afterReady[0]?.waiting).toBe(false);
    expect(afterReady[0]?.text).toBe("Ось що знайшла.");
    expect(
      JSON.stringify(afterReady).includes(ASSISTANT_LIVE_WAIT_ROW_ID),
    ).toBe(false);
  });
});
