import { describe, expect, it } from "vitest";

import { STAFF_ASSISTANT_CONFIRMATION_FALLBACK_TEXT } from "./confirmation.js";
import {
  createHoldCandidateReplyTextTransform,
  spokenContainsMarkdownDump,
  spokenTurnText,
  STAFF_ASSISTANT_SUCCESS_SPOKEN_FALLBACK,
  STAFF_ASSISTANT_TOOL_ERROR_FALLBACK,
} from "./spoken-reply.js";

describe("spokenTurnText", () => {
  it("keeps plain prose", () => {
    expect(
      spokenTurnText({
        rawText: "You have no orders.",
        runs: [{ outcome: "success" }],
      }),
    ).toBe("You have no orders.");
  });

  it("does not extract spoken from leftover JSON envelope", () => {
    expect(
      spokenTurnText({
        rawText: '{"spoken":"Albina has 4 orders this week."}',
        runs: [{ outcome: "success" }],
      }),
    ).toBe(STAFF_ASSISTANT_SUCCESS_SPOKEN_FALLBACK);
    expect(
      spokenTurnText({
        rawText: '{"spoken":"x"}',
        runs: [],
      }),
    ).toBe("Done.");
    expect(
      spokenTurnText({
        rawText: '{"spoken":"x"}',
        runs: [],
      }),
    ).not.toBe("x");
  });

  it("fail-opens markdown dumps after a successful list, never Done", () => {
    expect(spokenContainsMarkdownDump("| order | total |\n|---|---|")).toBe(
      true,
    );
    expect(
      spokenTurnText({
        rawText: "| order | total |\n| **new** | 1 |",
        runs: [{ outcome: "success" }],
      }),
    ).toBe(STAFF_ASSISTANT_SUCCESS_SPOKEN_FALLBACK);
    expect(
      spokenTurnText({
        rawText: "",
        runs: [{ outcome: "success" }],
      }),
    ).toBe(STAFF_ASSISTANT_SUCCESS_SPOKEN_FALLBACK);
  });

  it("lets confirmation_required win over markdown fail-open after a successful list", () => {
    expect(
      spokenTurnText({
        rawText: "| order | total |\n| **new** | 1 |",
        runs: [{ outcome: "success" }, { outcome: "confirmation_required" }],
      }),
    ).toBe(STAFF_ASSISTANT_CONFIRMATION_FALLBACK_TEXT);
    expect(
      spokenTurnText({
        rawText: "| order | total |\n| **new** | 1 |",
        runs: [{ outcome: "success" }, { outcome: "confirmation_required" }],
      }),
    ).not.toBe(STAFF_ASSISTANT_SUCCESS_SPOKEN_FALLBACK);
  });

  it("keeps the HITL confirmation fallback when the model wrote prose", () => {
    expect(
      spokenTurnText({
        rawText: "should not auto-confirm",
        runs: [{ outcome: "confirmation_required" }],
      }),
    ).toBe(STAFF_ASSISTANT_CONFIRMATION_FALLBACK_TEXT);
    expect(
      spokenTurnText({
        rawText: "",
        runs: [{ outcome: "confirmation_required" }],
      }),
    ).toBe(STAFF_ASSISTANT_CONFIRMATION_FALLBACK_TEXT);
  });

  it("falls back to the typed tool message after an error, never Done", () => {
    const message =
      'Multiple matches for "макаронс": Макаронси (UAH, 11111111-1111-4111-8111-111111111111).';
    expect(
      spokenTurnText({
        rawText: "",
        runs: [{ outcome: "error" }],
        toolErrorMessage: message,
      }),
    ).toBe(message);
    expect(
      spokenTurnText({
        rawText: '{"spoken":""}',
        runs: [{ outcome: "error" }],
        toolErrorMessage: message,
      }),
    ).not.toBe("Done.");
    expect(
      spokenTurnText({
        rawText: "",
        runs: [{ outcome: "error" }],
      }),
    ).toBe(STAFF_ASSISTANT_TOOL_ERROR_FALLBACK);
  });

  it("keeps model prose over the typed tool error message", () => {
    expect(
      spokenTurnText({
        rawText: "Не знайшла той товар. Уточніть назву.",
        runs: [{ outcome: "error" }],
        toolErrorMessage:
          'Multiple matches for "макаронс": Макаронси (UAH, 11111111-1111-4111-8111-111111111111).',
      }),
    ).toBe("Не знайшла той товар. Уточніть назву.");
  });

  it("does not extract spoken from leftover JSON on a tool error", () => {
    const message =
      'Multiple matches for "макаронс": Макаронси (UAH, 11111111-1111-4111-8111-111111111111).';
    expect(
      spokenTurnText({
        rawText: '{"spoken":"Не знайшла той товар. Уточніть назву."}',
        runs: [{ outcome: "error" }],
        toolErrorMessage: message,
      }),
    ).toBe(message);
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
