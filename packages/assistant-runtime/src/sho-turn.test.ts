import { runHostTurn, type ToolSet } from "@showzy/assistant-kit";
import { stubTextModel, testDeps } from "@showzy/assistant-kit/testing";
import { createAssistantKit } from "@showzy/assistant-kit";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { assistantInteractions } from "./assistant-interactions.js";
import type { ShoEngine, ShoResult } from "./sho-plan.js";
import { isShoToolCall, runShoTurn, SHO_TOOL_CALL_PREFIX } from "./sho-turn.js";

const CONVERSATION = randomUUID();
const BIND = "anna:company-a";

function listYesterday(): ShoResult {
  return {
    tooMany: false,
    commands: [
      {
        action: "orders.list",
        params: {
          period: { value: "yesterday" },
        },
        needs: [],
        confidence: { action: 0.99, margin: 0.9, spans: 0.95 },
      },
    ],
  };
}

const engine: ShoEngine = { parse: () => Promise.resolve(listYesterday()) };

function listTools(): ToolSet {
  return {
    orders_list_page: {
      description: "orders",
      inputSchema: { jsonSchema: { type: "object" } },
      execute: () =>
        Promise.resolve({
          kind: "ok",
          result: { kind: "page.summary", rows: [{ orderId: "o1" }] },
          card: {
            cardId: "orders-list",
            type: "orders-list",
            payload: { kind: "orders-list" },
          },
        }),
    } as never,
  };
}

async function shoHistory() {
  const outcome = await runShoTurn({
    text: "покажи замовлення за вчора",
    conversationId: CONVERSATION,
    commandId: "11111111-1111-4111-8111-111111111111",
    now: new Date("2026-09-29T09:00:00.000Z"),
    history: [],
    tools: () => Promise.resolve(listTools()),
    engine,
  });
  if (outcome.kind !== "settled") {
    throw new Error(`expected a settled turn, got ${outcome.kind}`);
  }
  return outcome;
}

describe("runShoTurn", () => {
  it("settles a read with a card, a reply and a synthetic tool call", async () => {
    const outcome = await shoHistory();
    expect(outcome.parts.map((part) => part.kind)).toEqual(["card", "text"]);
    const call = outcome.history.find(
      (message) =>
        message.role === "assistant" && Array.isArray(message.content),
    );
    const parts = call?.content;
    const id =
      Array.isArray(parts) && parts[0]?.type === "tool-call"
        ? parts[0].toolCallId
        : "";
    expect(id.startsWith(SHO_TOOL_CALL_PREFIX)).toBe(true);
    expect(isShoToolCall(id)).toBe(true);
  });

  it("leaves a history the provider path serializes without error", async () => {
    const outcome = await shoHistory();
    const kit = createAssistantKit(testDeps(assistantInteractions));
    const result = await runHostTurn({
      kit,
      conversationId: CONVERSATION,
      bind: BIND,
      messageId: randomUUID(),
      model: stubTextModel("перше — №1001"),
      messages: [
        ...outcome.history,
        { role: "user", content: "а перше з них?" },
      ],
      tools: {},
    });

    expect(result.kind).toBe("settled");
    expect(
      result.parts.some(
        (part) => part.kind === "text" && part.text.includes("1001"),
      ),
    ).toBe(true);
  });
});
