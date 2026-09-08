import { describe, expect, it } from "vitest";

import { STAFF_ASSISTANT_ORDER_CREATED_COPY } from "../choice.js";
import { STAFF_ASSISTANT_CONFIRMATION_COPY } from "../confirmation.js";
import { presentCatalogDomainError } from "../domain-error.js";
import {
  STAFF_ASSISTANT_EMPTY_SPEECH_FALLBACK,
  STAFF_ASSISTANT_SUCCESS_SPEECH_FALLBACK,
  STAFF_ASSISTANT_TOOL_ERROR_FALLBACK,
} from "../turn-speech.js";
import {
  commitHostSpeech,
  lastUsableHostModelText,
  usableHostModelText,
} from "./speech.js";

describe("usableHostModelText", () => {
  it("keeps plain prose, emphasis, and markdown tables", () => {
    expect(usableHostModelText("Ось три останні, найбільше — № 12")).toBe(
      "Ось три останні, найбільше — № 12",
    );
    expect(usableHostModelText("Confirm **#123**")).toBe("Confirm **#123**");
    expect(usableHostModelText("| order | total |\n| **#123** | 10 |")).toBe(
      "| order | total |\n| **#123** | 10 |",
    );
    expect(usableHostModelText("  ")).toBeUndefined();
    expect(
      usableHostModelText('{"spoken":"Four orders this week."}'),
    ).toBeUndefined();
  });

  it("picks the last usable step text after leftover JSON", () => {
    expect(
      lastUsableHostModelText([
        '{"spoken":"ignored leftover"}',
        "Please confirm deleting this customer.",
      ]),
    ).toBe("Please confirm deleting this customer.");
  });
});

describe("commitHostSpeech", () => {
  it("tags usable model prose as model over protocol copy", () => {
    expect(
      commitHostSpeech({
        locale: "uk",
        rawText: "You have no orders.",
        runs: [{ outcome: "success" }],
      }),
    ).toEqual({ source: "model", text: "You have no orders." });
    expect(
      commitHostSpeech({
        locale: "uk",
        rawText: "Please confirm deleting this customer.",
        runs: [{ outcome: "confirmation_required" }],
      }),
    ).toEqual({
      source: "model",
      text: "Please confirm deleting this customer.",
    });
    expect(
      commitHostSpeech({
        locale: "uk",
        rawText: "Please confirm deleting this customer.",
        runs: [{ outcome: "confirmation_required" }],
      }).text,
    ).not.toBe(STAFF_ASSISTANT_CONFIRMATION_COPY.uk);
  });

  it("falls back on leftover JSON and does not extract spoken", () => {
    expect(
      commitHostSpeech({
        locale: "en",
        rawText: '{"spoken":"Albina has 4 orders this week."}',
        runs: [{ outcome: "success" }],
      }),
    ).toEqual({
      source: "fallback",
      text: STAFF_ASSISTANT_SUCCESS_SPEECH_FALLBACK.en,
    });
  });

  it("does not substitute because of a markdown table or **", () => {
    const table = "| order | total |\n| **#123** | 10 |";
    expect(
      commitHostSpeech({
        locale: "en",
        rawText: table,
        runs: [{ outcome: "success" }],
      }),
    ).toEqual({ source: "model", text: table });
    expect(
      commitHostSpeech({
        locale: "en",
        rawText: "Created **#123**.",
        runs: [{ outcome: "success" }],
      }),
    ).toEqual({ source: "model", text: "Created **#123**." });
  });

  it("does not use create-success or domain-error copy as the bubble", () => {
    const archived = presentCatalogDomainError({
      locale: "uk",
      extras: {
        reason: "archived",
        subject: { kind: "product_name", name: "Old Widget" },
      },
    });
    expect(
      commitHostSpeech({
        locale: "uk",
        rawText: "That product is archived — pick another.",
        runs: [{ outcome: "error" }],
      }),
    ).toEqual({
      source: "model",
      text: "That product is archived — pick another.",
    });
    expect(
      commitHostSpeech({
        locale: "en",
        rawText: "",
        runs: [{ outcome: "success" }],
      }).text,
    ).not.toBe(STAFF_ASSISTANT_ORDER_CREATED_COPY.en);
    expect(
      commitHostSpeech({
        locale: "uk",
        rawText: "",
        runs: [{ outcome: "error" }],
      }).text,
    ).not.toBe(archived);
    expect(
      commitHostSpeech({
        locale: "uk",
        rawText: '{"spoken":"That product is archived."}',
        runs: [{ outcome: "error" }],
        toolOutputs: [
          {
            status: "error",
            code: "CONFLICT",
            message: archived,
          },
        ],
      }),
    ).toEqual({
      source: "fallback",
      text: STAFF_ASSISTANT_TOOL_ERROR_FALLBACK.uk,
    });
  });

  it("uses empty fallback when there is no model text and no runs", () => {
    expect(
      commitHostSpeech({
        locale: "en",
        rawText: "",
        runs: [],
      }),
    ).toEqual({
      source: "fallback",
      text: STAFF_ASSISTANT_EMPTY_SPEECH_FALLBACK.en,
    });
  });
});
