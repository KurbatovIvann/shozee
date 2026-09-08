import { describe, expect, it } from "vitest";

import { assistantCopy } from "../../../i18n/assistant";
import {
  assistantChatErrorKind,
  assistantChatErrorMessage,
} from "./chat-error";

describe("assistantChatErrorKind", () => {
  it("maps RATE_LIMITED 429 JSON onto the assistant rate-limit copy", () => {
    const error = new Error(
      JSON.stringify({
        code: "RATE_LIMITED",
        status: 429,
        message: "Too many requests. Retry later.",
        data: { retryAfterSec: 42 },
      }),
    );
    expect(assistantChatErrorKind(error)).toBe("rateLimited");
    expect(assistantChatErrorMessage("rateLimited", assistantCopy("en"))).toBe(
      "Too many requests. Try again later.",
    );
    expect(assistantChatErrorMessage("rateLimited", assistantCopy("uk"))).toBe(
      "Забагато запитів. Спробуй пізніше.",
    );
  });

  it("maps ASSISTANT_NOT_CONFIGURED from the SSE JSON body", () => {
    const error = new Error(
      JSON.stringify({
        code: "ASSISTANT_NOT_CONFIGURED",
        status: 503,
        message: "not configured",
      }),
    );
    expect(assistantChatErrorKind(error)).toBe("notConfigured");
    expect(
      assistantChatErrorMessage("notConfigured", assistantCopy("en")),
    ).toBe("The assistant is not configured.");
  });

  it("maps NETWORK JSON onto network copy", () => {
    const error = new Error(
      JSON.stringify({
        code: "NETWORK",
        message: "Chat request failed.",
      }),
    );
    expect(assistantChatErrorKind(error)).toBe("network");
  });

  it("maps TypeError and failed-fetch transport throws to network", () => {
    expect(assistantChatErrorKind(new TypeError("Failed to fetch"))).toBe(
      "network",
    );
    expect(assistantChatErrorKind(new Error("Failed to fetch"))).toBe(
      "network",
    );
    expect(assistantChatErrorMessage("network", assistantCopy("en"))).toBe(
      "Could not reach the assistant. Try again.",
    );
    expect(assistantChatErrorMessage("network", assistantCopy("uk"))).toBe(
      "Не вдалося звʼязатися з асистентом. Спробуй ще раз.",
    );
  });

  it("does not treat other non-JSON throws as a cookie leak surface", () => {
    expect(assistantChatErrorKind(new Error("stream interrupted"))).toBe(
      "unavailable",
    );
  });
});
