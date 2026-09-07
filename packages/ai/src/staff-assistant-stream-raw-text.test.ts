import { defineActionContract } from "@showzy/core/contract";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { ORDERS_LIST_PAGE_TOOL_NAME } from "./action-tool.js";
import {
  STAFF_ASSISTANT_EMPTY_SPEECH_FALLBACK,
  STAFF_ASSISTANT_SUCCESS_SPEECH_FALLBACK,
  STAFF_ASSISTANT_TOOL_ERROR_FALLBACK,
} from "./turn-speech.js";
import {
  createHoldCandidateReplyTextTransform,
  streamStaffAssistantChat,
} from "./staff-assistant-stream.js";
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
    streamText: (...args: Parameters<typeof actual.streamText>) => {
      const result = actual.streamText(...args);
      Object.defineProperty(result, "text", {
        configurable: true,
        get: (): Promise<string> =>
          Promise.reject(new Error("model text failed")),
      });
      return result;
    },
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
    {
      locale: undefined,
      expected: STAFF_ASSISTANT_SUCCESS_SPEECH_FALLBACK.uk,
    },
    {
      locale: "uk" as const,
      expected: STAFF_ASSISTANT_SUCCESS_SPEECH_FALLBACK.uk,
    },
    {
      locale: "en" as const,
      expected: STAFF_ASSISTANT_SUCCESS_SPEECH_FALLBACK.en,
    },
  ])(
    "runs commitTurnSpeech when result.text throws (locale=$locale)",
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
      expect(turn.speech.source).toBe("fallback");
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
    expect(turn.text).toBe(STAFF_ASSISTANT_EMPTY_SPEECH_FALLBACK.uk);
    expect(turn.text).toBe("Готово.");
    expect(turn.text).not.toBe("SECRETX");
    expect(turn.text).not.toBe(STAFF_ASSISTANT_TOOL_ERROR_FALLBACK.en);
    expect(sseVisibleTextFromPayloads(payloads)).toBe(turn.text);
    expect(JSON.stringify(payloads)).not.toContain("SECRETX");
  });
});

describe("createHoldCandidateReplyTextTransform", () => {
  it("passes tool parts immediately and holds candidate text", async () => {
    const transform = createHoldCandidateReplyTextTransform<{
      readonly type: string;
      readonly toolCallId?: string;
      readonly text?: string;
    }>();
    const writer = transform.writable.getWriter();
    const reader = transform.readable.getReader();
    const parts: unknown[] = [];
    const read = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        parts.push(value);
      }
    })();
    await writer.write({
      type: "tool-orders_list_page",
      toolCallId: "call-list",
    });
    await writer.write({ type: "text-start" });
    await writer.write({ type: "text-delta", text: '{"spo' });
    await writer.write({ type: "text-delta", text: 'ken":"x"}' });
    await writer.write({ type: "text-end" });
    await writer.close();
    await read;
    expect(parts).toEqual([
      { type: "tool-orders_list_page", toolCallId: "call-list" },
    ]);
    expect(JSON.stringify(parts)).not.toContain('{"spo');
    expect(JSON.stringify(parts)).not.toContain("x");
  });

  it("passes HITL data parts without waiting for text finalization", async () => {
    const transform = createHoldCandidateReplyTextTransform<{
      readonly type: string;
      readonly data?: unknown;
      readonly text?: string;
    }>();
    const writer = transform.writable.getWriter();
    const reader = transform.readable.getReader();
    const parts: unknown[] = [];
    const read = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        parts.push(value);
      }
    })();
    await writer.write({
      type: "data-confirmation",
      data: { status: "confirmation_required" },
    });
    await writer.write({ type: "text-delta", text: "| order |" });
    await writer.close();
    await read;
    expect(parts).toEqual([
      {
        type: "data-confirmation",
        data: { status: "confirmation_required" },
      },
    ]);
  });
});
