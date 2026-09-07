import { describe, expect, it } from "vitest";

import { ORDERS_CREATE_TOOL_NAME } from "./action-tool.js";
import { STAFF_ASSISTANT_CONFIRMATION_COPY } from "./confirmation.js";
import { presentCatalogDomainError } from "./domain-error.js";
import { staffAssistantLocale } from "./locale.js";
import {
  commitTurnSpeech,
  usableStaffAssistantModelText,
  STAFF_ASSISTANT_EMPTY_SPEECH_FALLBACK,
  STAFF_ASSISTANT_SUCCESS_SPEECH_FALLBACK,
  STAFF_ASSISTANT_TOOL_ERROR_FALLBACK,
} from "./turn-speech.js";

const LIST_PAGE = {
  kind: "page.summary" as const,
  requestedLimit: 2,
  rows: [
    {
      orderId: "11111111-1111-4111-8111-111111111111",
      orderNumber: "1049",
      status: "new",
    },
  ],
  hasMore: false,
  nextCursor: null,
  customerMatchTruncated: false,
};

describe("usableStaffAssistantModelText", () => {
  it("keeps plain prose and rejects empty, JSON, and markdown dumps", () => {
    expect(
      usableStaffAssistantModelText("Ось три останні, найбільше — № 12"),
    ).toBe("Ось три останні, найбільше — № 12");
    expect(usableStaffAssistantModelText("  ")).toBeUndefined();
    expect(
      usableStaffAssistantModelText('{"spoken":"Four orders this week."}'),
    ).toBeUndefined();
    expect(
      usableStaffAssistantModelText("| order | total |\n| **#1** | 10 |"),
    ).toBeUndefined();
  });
});

describe("staff assistant locale and speech fallbacks", () => {
  it("looks up uk, en, and defaults to uk", () => {
    expect(staffAssistantLocale("uk")).toBe("uk");
    expect(staffAssistantLocale("en")).toBe("en");
    expect(staffAssistantLocale(undefined)).toBe("uk");
    expect(staffAssistantLocale("fr")).toBe("uk");
    expect(STAFF_ASSISTANT_SUCCESS_SPEECH_FALLBACK.uk).toBe(
      "Коротко про результат.",
    );
    expect(STAFF_ASSISTANT_SUCCESS_SPEECH_FALLBACK.en).toBe(
      "Here is a short summary of the result.",
    );
    expect(STAFF_ASSISTANT_TOOL_ERROR_FALLBACK.uk).toBe(
      "Не вдалося завершити цей хід.",
    );
    expect(STAFF_ASSISTANT_TOOL_ERROR_FALLBACK.en).toBe(
      "The assistant could not complete this turn.",
    );
    expect(STAFF_ASSISTANT_EMPTY_SPEECH_FALLBACK.uk).toBe("Готово.");
    expect(STAFF_ASSISTANT_EMPTY_SPEECH_FALLBACK.en).toBe("Done.");
  });
});

describe("commitTurnSpeech", () => {
  it("tags usable model prose as model", () => {
    expect(
      commitTurnSpeech({
        locale: "uk",
        toolResults: [],
        rawText: "You have no orders.",
        runs: [{ outcome: "success" }],
      }),
    ).toEqual({ source: "model", text: "You have no orders." });
  });

  it("does not extract spoken from leftover JSON and never dumps list rows", () => {
    const json = commitTurnSpeech({
      locale: "en",
      toolResults: [{ toolName: "orders_list_page", output: LIST_PAGE }],
      rawText: '{"spoken":"Albina has 4 orders this week."}',
      runs: [{ outcome: "success" }],
    });
    expect(json).toEqual({
      source: "fallback",
      text: STAFF_ASSISTANT_SUCCESS_SPEECH_FALLBACK.en,
    });
    expect(json.text).not.toBe("Albina has 4 orders this week.");
    expect(json.text).not.toContain("Latest orders");
    expect(json.text).not.toContain("Останні замовлення");
    expect(
      commitTurnSpeech({
        locale: "en",
        toolResults: [],
        rawText: '{"spoken":"x"}',
        runs: [],
      }),
    ).toEqual({
      source: "fallback",
      text: STAFF_ASSISTANT_EMPTY_SPEECH_FALLBACK.en,
    });
  });

  it("fail-opens markdown dumps after a successful list to the generic fallback", () => {
    expect(
      commitTurnSpeech({
        locale: "en",
        toolResults: [{ toolName: "orders_list_page", output: LIST_PAGE }],
        rawText: "| order | total |\n| **new** | 1 |",
        runs: [{ outcome: "success" }],
      }),
    ).toEqual({
      source: "fallback",
      text: STAFF_ASSISTANT_SUCCESS_SPEECH_FALLBACK.en,
    });
    expect(
      commitTurnSpeech({
        locale: "uk",
        toolResults: [{ toolName: "orders_list_page", output: LIST_PAGE }],
        rawText: "",
        runs: [{ outcome: "success" }],
      }),
    ).toEqual({
      source: "fallback",
      text: STAFF_ASSISTANT_SUCCESS_SPEECH_FALLBACK.uk,
    });
  });

  it("lets confirmation protocol copy win over markdown and model prose", () => {
    expect(
      commitTurnSpeech({
        locale: "en",
        toolResults: [{ toolName: "orders_list_page", output: LIST_PAGE }],
        rawText: "| order | total |\n| **new** | 1 |",
        runs: [{ outcome: "success" }, { outcome: "confirmation_required" }],
      }),
    ).toEqual({
      source: "protocol",
      text: STAFF_ASSISTANT_CONFIRMATION_COPY.en,
    });
    expect(
      commitTurnSpeech({
        locale: "uk",
        toolResults: [],
        rawText: "should not auto-confirm",
        runs: [{ outcome: "confirmation_required" }],
      }),
    ).toEqual({
      source: "protocol",
      text: STAFF_ASSISTANT_CONFIRMATION_COPY.uk,
    });
  });

  it("uses choice protocol copy over leftover spoken JSON", () => {
    const toolResults = [
      {
        toolName: ORDERS_CREATE_TOOL_NAME,
        output: {
          status: "needs_choice",
          challengeId: "77777777-7777-4777-8777-777777777777",
          reason: "variant_required",
          productName: "Macarons",
          options: [
            { id: "55555555-5555-4555-8555-555555555555", label: "Lemon" },
            { id: "66666666-6666-4666-8666-666666666666", label: "Vanilla" },
          ],
          optionsTruncated: false,
        },
      },
    ];
    expect(
      commitTurnSpeech({
        locale: "en",
        toolResults,
        rawText: '{"spoken":"MODEL_SPOKEN_SHOULD_NOT_PERSIST"}',
        runs: [{ outcome: "choice_required" }],
      }),
    ).toEqual({
      source: "protocol",
      text: "Select a variant for Macarons: Lemon, Vanilla.",
    });
  });

  it("falls back to the typed tool message after an error, never Done", () => {
    const message =
      'Multiple matches for "макаронс": Макаронси (UAH, 11111111-1111-4111-8111-111111111111).';
    expect(
      commitTurnSpeech({
        locale: "uk",
        toolResults: [
          {
            toolName: ORDERS_CREATE_TOOL_NAME,
            output: { status: "error", code: "CONFLICT", message },
          },
        ],
        rawText: "",
        runs: [{ outcome: "error" }],
      }),
    ).toEqual({ source: "fallback", text: message });
    expect(
      commitTurnSpeech({
        locale: "en",
        toolResults: [],
        rawText: "",
        runs: [{ outcome: "error" }],
      }),
    ).toEqual({
      source: "fallback",
      text: STAFF_ASSISTANT_TOOL_ERROR_FALLBACK.en,
    });
  });

  it("keeps model prose over the typed tool error message", () => {
    expect(
      commitTurnSpeech({
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
    ).toEqual({
      source: "model",
      text: "Не знайшла той товар. Уточніть назву.",
    });
  });

  it("uses domain-error protocol copy for archived and no_active_variants", () => {
    const archivedOutput = {
      status: "error" as const,
      code: "CONFLICT",
      message: '"Old Widget" is archived.',
      reason: "archived" as const,
      subject: { kind: "product_name" as const, name: "Old Widget" },
    };
    const expected = presentCatalogDomainError({
      locale: "uk",
      extras: {
        reason: "archived",
        subject: { kind: "product_name", name: "Old Widget" },
      },
    });
    expect(
      commitTurnSpeech({
        locale: "uk",
        toolResults: [
          { toolName: ORDERS_CREATE_TOOL_NAME, output: archivedOutput },
        ],
        rawText: '{"spoken":"MODEL_SPOKEN_SHOULD_NOT_PERSIST"}',
        runs: [{ outcome: "error" }],
      }),
    ).toEqual({ source: "protocol", text: expected });
  });

  it("defaults omitted locale to uk", () => {
    expect(
      commitTurnSpeech({
        locale: undefined,
        toolResults: [],
        rawText: "",
        runs: [{ outcome: "success" }],
      }),
    ).toEqual({
      source: "fallback",
      text: STAFF_ASSISTANT_SUCCESS_SPEECH_FALLBACK.uk,
    });
  });
});
