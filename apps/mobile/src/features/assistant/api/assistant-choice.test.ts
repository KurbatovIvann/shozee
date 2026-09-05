import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  classifyChoiceSelect,
  choiceSelectAllowsSameOptionRetry,
  choiceSelectShouldIgnoreChallenge,
} from "../shared/choice-presenter";

const fetchMock = vi.fn();

vi.mock("expo/fetch", () => ({
  fetch: (...args: unknown[]) => fetchMock(...args) as Promise<Response>,
}));

import {
  assistantChoicePeekUrl,
  assistantChoiceUrl,
  peekAssistantChoice,
  postAssistantChoice,
} from "./assistant-choice";

const conversationId = "11111111-1111-4111-8111-111111111111";
const choiceId = "33333333-3333-4333-8333-333333333333";
const optionId = "88888888-8888-4888-8888-888888888888";
const orderId = "0f0e2d5c-4a1b-4c3d-9e8f-102938475601";
const cookie = "better-auth.session_token=SECRET_SESSION_COOKIE";

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function postArgs() {
  return {
    apiUrl: "https://api.example.com",
    getCookie: () => cookie,
    getCompanyId: () => "company-a",
    conversationId,
    choiceId,
    optionId,
  };
}

function peekArgs() {
  return {
    apiUrl: "https://api.example.com",
    getCookie: () => cookie,
    getCompanyId: () => "company-a",
    conversationId,
    choiceId,
  };
}

describe("postAssistantChoice", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("decodes a successful completed resume", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        status: "completed",
        text: "Order #1049.",
        entity: { orderId, orderNumber: "1049" },
      }),
    );
    const result = await postAssistantChoice(postArgs());
    expect(result).toMatchObject({
      status: "completed",
      text: "Order #1049.",
      entity: { orderId, orderNumber: "1049" },
      httpStatus: 200,
      recoverability: "terminal",
    });
    expect(classifyChoiceSelect(result)).toBe("terminal");
    expect(fetchMock).toHaveBeenCalledWith(
      assistantChoiceUrl("https://api.example.com"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ conversationId, choiceId, optionId }),
      }),
    );
  });

  it("preserves RETRY_IN_PROGRESS 409 code and retryAfter for the same option", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        409,
        {
          code: "RETRY_IN_PROGRESS",
          status: 409,
          message:
            "A previous attempt of this request is still in progress. Retry shortly.",
          data: { retryAfterSec: 2 },
        },
        { "Retry-After": "2" },
      ),
    );
    const result = await postAssistantChoice(postArgs());
    expect(result.code).toBe("RETRY_IN_PROGRESS");
    expect(result.httpStatus).toBe(409);
    expect(result.retryAfterSec).toBe(2);
    expect(result.recoverability).toBe("retryable");
    expect(choiceSelectShouldIgnoreChallenge(result)).toBe(false);
    expect(choiceSelectAllowsSameOptionRetry(result)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("SECRET_SESSION_COOKIE");
  });

  it("preserves RATE_LIMITED 429 and Retry-After", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        429,
        {
          code: "RATE_LIMITED",
          status: 429,
          message: "Too many requests. Retry later.",
          data: { retryAfterSec: 12 },
        },
        { "Retry-After": "12" },
      ),
    );
    const result = await postAssistantChoice(postArgs());
    expect(result.code).toBe("RATE_LIMITED");
    expect(result.httpStatus).toBe(429);
    expect(result.retryAfterSec).toBe(12);
    expect(result.recoverability).toBe("retryable");
    expect(choiceSelectAllowsSameOptionRetry(result)).toBe(true);
  });

  it("keeps INTERNAL 500 retryable with the original code", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(500, {
        code: "INTERNAL",
        status: 500,
        message: "Internal error.",
      }),
    );
    const result = await postAssistantChoice(postArgs());
    expect(result.code).toBe("INTERNAL");
    expect(result.httpStatus).toBe(500);
    expect(result.recoverability).toBe("retryable");
    expect(choiceSelectShouldIgnoreChallenge(result)).toBe(false);
  });

  it("keeps HTTP 503 retryable even when the body is not JSON", async () => {
    fetchMock.mockResolvedValue(
      new Response("<html>unavailable</html>", {
        status: 503,
        headers: { "content-type": "text/html" },
      }),
    );
    const result = await postAssistantChoice(postArgs());
    expect(result.httpStatus).toBe(503);
    expect(result.recoverability).toBe("retryable");
    expect(result.status).toBe("error");
    expect(choiceSelectAllowsSameOptionRetry(result)).toBe(true);
  });

  it("treats a network rejection as retryable without losing the option identity", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const result = await postAssistantChoice(postArgs());
    expect(result.status).toBe("error");
    expect(result.recoverability).toBe("retryable");
    expect(choiceSelectShouldIgnoreChallenge(result)).toBe(false);
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        body: JSON.stringify({ conversationId, choiceId, optionId }),
      }),
    );
  });

  it("treats a malformed 200 body as ambiguous instead of a terminal generic error", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { foo: 1, status: 409 }));
    const result = await postAssistantChoice(postArgs());
    expect(result.status).toBe("error");
    expect(result.recoverability).toBe("ambiguous");
    expect(result.text).toBeUndefined();
    expect(choiceSelectShouldIgnoreChallenge(result)).toBe(false);
    expect(choiceSelectAllowsSameOptionRetry(result)).toBe(true);
  });

  it("decodes a valid sequential needs_choice resume", async () => {
    const successorId = "44444444-4444-4444-8444-444444444444";
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        status: "needs_choice",
        text: "Select a variant for Eclairs: Coffee.",
        challengeId: successorId,
        reason: "variant_required",
        productName: "Eclairs",
        options: [{ id: optionId, label: "Coffee" }],
        optionsTruncated: false,
      }),
    );
    const result = await postAssistantChoice(postArgs());
    expect(result).toMatchObject({
      status: "needs_choice",
      text: "Select a variant for Eclairs: Coffee.",
      challengeId: successorId,
      httpStatus: 200,
      recoverability: "terminal",
    });
    expect(choiceSelectShouldIgnoreChallenge(result)).toBe(true);
  });

  it("decodes a valid expired resume", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { status: "expired" }));
    const result = await postAssistantChoice(postArgs());
    expect(result).toMatchObject({
      status: "expired",
      httpStatus: 200,
      recoverability: "terminal",
    });
    expect(choiceSelectShouldIgnoreChallenge(result)).toBe(true);
  });

  it("treats HTTP 200 {status:completed} without text or entity as ambiguous", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { status: "completed" }));
    const result = await postAssistantChoice(postArgs());
    expect(result.status).toBe("error");
    expect(result.recoverability).toBe("ambiguous");
    expect(choiceSelectShouldIgnoreChallenge(result)).toBe(false);
    expect(choiceSelectAllowsSameOptionRetry(result)).toBe(true);
  });

  it("treats incomplete needs_choice as ambiguous", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        status: "needs_choice",
        challengeId: choiceId,
      }),
    );
    const result = await postAssistantChoice(postArgs());
    expect(result.status).toBe("error");
    expect(result.recoverability).toBe("ambiguous");
    expect(choiceSelectShouldIgnoreChallenge(result)).toBe(false);
  });

  it("treats a valid HTTP 200 domain CONFLICT as terminal, not ambiguous", async () => {
    const message =
      '"Macarons" is archived and cannot be added to an order. Name a different product, or repeat the order without it.';
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        status: "error",
        code: "CONFLICT",
        message,
      }),
    );
    const result = await postAssistantChoice(postArgs());
    expect(result).toMatchObject({
      status: "error",
      code: "CONFLICT",
      message,
      httpStatus: 200,
      recoverability: "terminal",
    });
    expect(classifyChoiceSelect(result)).toBe("terminal");
    expect(choiceSelectShouldIgnoreChallenge(result)).toBe(true);
    expect(choiceSelectAllowsSameOptionRetry(result)).toBe(false);
  });

  it("keeps HTTP 409 CONFLICT uncertain rather than terminal", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(409, {
        code: "CONFLICT",
        status: 409,
        message: "PDF generation failed.",
      }),
    );
    const result = await postAssistantChoice(postArgs());
    expect(result.code).toBe("CONFLICT");
    expect(result.httpStatus).toBe(409);
    expect(result.recoverability).toBe("ambiguous");
    expect(choiceSelectShouldIgnoreChallenge(result)).toBe(false);
    expect(choiceSelectAllowsSameOptionRetry(result)).toBe(true);
  });

  it("preserves UNAUTHENTICATED 401 as terminal without retry", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(401, {
        code: "UNAUTHENTICATED",
        status: 401,
        message: "Authentication required.",
      }),
    );
    const result = await postAssistantChoice(postArgs());
    expect(result.code).toBe("UNAUTHENTICATED");
    expect(result.httpStatus).toBe(401);
    expect(result.recoverability).toBe("terminal");
    expect(choiceSelectShouldIgnoreChallenge(result)).toBe(true);
    expect(choiceSelectAllowsSameOptionRetry(result)).toBe(false);
  });

  it("preserves PERMISSION_DENIED 403 as terminal without retry", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(403, {
        code: "PERMISSION_DENIED",
        status: 403,
        message: "You do not have permission to perform this action.",
      }),
    );
    const result = await postAssistantChoice(postArgs());
    expect(result.code).toBe("PERMISSION_DENIED");
    expect(result.httpStatus).toBe(403);
    expect(result.recoverability).toBe("terminal");
    expect(choiceSelectShouldIgnoreChallenge(result)).toBe(true);
    expect(choiceSelectAllowsSameOptionRetry(result)).toBe(false);
  });

  it("does not copy confirmation challenge tokens into the typed result", async () => {
    const challengeId = "secret-confirmation-challenge-token";
    fetchMock.mockResolvedValue(
      jsonResponse(409, {
        code: "CONFIRMATION_REQUIRED",
        status: 409,
        message: "This action requires explicit confirmation.",
        data: {
          challenge: {
            challengeId,
            summary: "Create order?",
            expiresAt: "2026-09-05T12:00:00.000Z",
          },
        },
      }),
    );
    const result = await postAssistantChoice(postArgs());
    expect(result.code).toBe("CONFIRMATION_REQUIRED");
    expect(result.recoverability).toBe("ambiguous");
    expect(JSON.stringify(result)).not.toContain(challengeId);
    expect(JSON.stringify(result)).not.toContain("secret-confirmation");
    expect(JSON.stringify(result)).not.toContain("SECRET_SESSION_COOKIE");
  });
});

describe("peekAssistantChoice", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("returns a live envelope on 200", async () => {
    const envelope = {
      status: "needs_choice",
      challengeId: choiceId,
      reason: "variant_required",
      productName: "Macarons",
      options: [{ id: optionId, label: "Lemon" }],
      optionsTruncated: false,
    };
    fetchMock.mockResolvedValue(jsonResponse(200, envelope));
    const result = await peekAssistantChoice(peekArgs());
    expect(result).toEqual({ kind: "envelope", envelope });
    expect(fetchMock).toHaveBeenCalledWith(
      assistantChoicePeekUrl(
        "https://api.example.com",
        choiceId,
        conversationId,
      ),
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("returns expired only for a real expired peek body", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { status: "expired" }));
    const result = await peekAssistantChoice(peekArgs());
    expect(result).toEqual({
      kind: "envelope",
      envelope: {
        status: "expired",
        challengeId: choiceId,
        options: [],
        optionsTruncated: false,
      },
    });
  });

  it("does not mark a 500 peek as expired", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(500, {
        code: "INTERNAL",
        status: 500,
        message: "Internal error.",
      }),
    );
    const result = await peekAssistantChoice(peekArgs());
    expect(result).toEqual({
      kind: "unavailable",
      recoverability: "retryable",
      httpStatus: 500,
      code: "INTERNAL",
    });
    expect(result.kind).not.toBe("envelope");
  });

  it("does not mark a malformed peek body as expired", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { status: 500, foo: true }));
    const result = await peekAssistantChoice(peekArgs());
    expect(result).toEqual({
      kind: "unavailable",
      recoverability: "ambiguous",
    });
  });

  it("does not mark a rejected peek as expired", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const result = await peekAssistantChoice(peekArgs());
    expect(result).toEqual({
      kind: "unavailable",
      recoverability: "retryable",
    });
    expect(JSON.stringify(result)).not.toContain("SECRET_SESSION_COOKIE");
  });
});
