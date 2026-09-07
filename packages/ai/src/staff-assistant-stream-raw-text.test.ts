import { defineActionContract } from "@showzy/core/contract";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { ORDERS_LIST_PAGE_TOOL_NAME } from "./action-tool.js";
import {
  STAFF_ASSISTANT_EMPTY_SPOKEN_FALLBACK,
  STAFF_ASSISTANT_TOOL_ERROR_FALLBACK,
} from "./spoken-reply.js";
import { streamStaffAssistantChat } from "./staff-assistant-stream.js";
import {
  MockLanguageModelV3,
  mockSplitTextStream,
  mockTextStream,
  mockToolCallStream,
  readUiMessageSsePayloads,
  sseVisibleTextFromPayloads,
} from "./test.js";

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    streamText: ((...args: Parameters<typeof actual.streamText>) => {
      const result = actual.streamText(...args);
      return new Proxy(result, {
        get(target, prop, receiver) {
          if (prop === "text") {
            return Promise.reject(new Error("model text failed"));
          }
          return Reflect.get(target, prop, receiver);
        },
      });
    }) as typeof actual.streamText,
  };
});

const customerId = "11111111-1111-4111-8111-111111111111";

const listOrders = defineActionContract({
  name: "orders.list",
  description: "List orders in the active company.",
  principal: "staff",
  transport: "client",
  aiExposure: "exposed",
  permissions: ["orders:view"],
  risk: "read",
  requiresConfirmation: false,
  idempotent: false,
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: ["VALIDATION"],
  audit: false,
  timeout: 5_000,
  input: z.looseObject({}),
  output: z.object({
    items: z.array(z.object({ orderId: z.uuid() })),
    nextCursor: z.string().nullable(),
  }),
});

const listPage = {
  kind: "page.summary" as const,
  items: [
    {
      orderId: customerId,
      orderNumber: "1049",
      status: "new" as const,
    },
  ],
  nextCursor: null,
};

describe("streamStaffAssistantChat result.text failure (SHO-514)", () => {
  it.each([
    { locale: undefined, expected: "Останні замовлення: #1049 (Нове)." },
    { locale: "uk" as const, expected: "Останні замовлення: #1049 (Нове)." },
    { locale: "en" as const, expected: "Latest orders: #1049 (New)." },
  ])(
    "runs presenter lookup when result.text throws (locale=$locale)",
    async ({ locale, expected }) => {
      const execute = vi.fn(() => Promise.resolve(listPage));
      const model = new MockLanguageModelV3({
        doStream: [
          mockToolCallStream("call-list", ORDERS_LIST_PAGE_TOOL_NAME, "{}"),
          mockTextStream("MODEL_PROSE_MUST_NOT_WIN_VIA_ENGLISH_CATCH"),
        ],
      });
      const { response, completion } = streamStaffAssistantChat({
        model,
        messages: [{ role: "user", content: "Show the last orders" }],
        contracts: [listOrders],
        execute,
        ...(locale === undefined ? {} : { locale }),
      });
      const payloads = await readUiMessageSsePayloads(response);
      const turn = await completion;
      const payloadText = JSON.stringify(payloads);
      expect(turn.text).toBe(expected);
      expect(sseVisibleTextFromPayloads(payloads)).toBe(turn.text);
      expect(turn.text).not.toBe(STAFF_ASSISTANT_TOOL_ERROR_FALLBACK.en);
      expect(payloadText).not.toContain(STAFF_ASSISTANT_TOOL_ERROR_FALLBACK.en);
      expect(payloadText).not.toContain(
        "MODEL_PROSE_MUST_NOT_WIN_VIA_ENGLISH_CATCH",
      );
    },
  );

  it("uses default-uk empty fallback for leftover spoken JSON when result.text throws", async () => {
    const model = new MockLanguageModelV3({
      doStream: [mockSplitTextStream(['{"spo', 'ken":"SECRETX"}'])],
    });
    const { response, completion } = streamStaffAssistantChat({
      model,
      messages: [{ role: "user", content: "Hello" }],
      contracts: [listOrders],
      execute: () => Promise.resolve({ items: [], nextCursor: null }),
    });
    const payloads = await readUiMessageSsePayloads(response);
    const turn = await completion;
    expect(turn.text).toBe(STAFF_ASSISTANT_EMPTY_SPOKEN_FALLBACK.uk);
    expect(turn.text).toBe("Готово.");
    expect(turn.text).not.toBe("SECRETX");
    expect(turn.text).not.toBe(STAFF_ASSISTANT_TOOL_ERROR_FALLBACK.en);
    expect(sseVisibleTextFromPayloads(payloads)).toBe(turn.text);
    expect(JSON.stringify(payloads)).not.toContain("SECRETX");
  });
});
