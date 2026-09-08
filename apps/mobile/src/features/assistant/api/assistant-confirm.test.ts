import { beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIRMATION_CHALLENGE_HEADER } from "@showzy/contract";

const fetchMock = vi.fn();

vi.mock("expo/fetch", () => ({
  fetch: (...args: unknown[]) => fetchMock(...args) as Promise<Response>,
}));

import { assistantConfirmUrl, postAssistantConfirm } from "./assistant-confirm";

const conversationId = "11111111-1111-4111-8111-111111111111";
const challengeId = "22222222-2222-4222-8222-222222222222";
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
    challengeId,
  };
}

describe("postAssistantConfirm", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("decodes a successful completed resume without the chat challenge header", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        status: "completed",
        text: "Here is a short summary of the result.",
        actionName: "customers.deleteCustomer",
        toolCallId: "call-delete",
        output: { id: "44444444-4444-4444-8444-444444444444" },
      }),
    );
    const result = await postAssistantConfirm(postArgs());
    expect(result).toMatchObject({
      status: "completed",
      text: "Here is a short summary of the result.",
      actionName: "customers.deleteCustomer",
      toolCallId: "call-delete",
      httpStatus: 200,
      recoverability: "terminal",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      assistantConfirmUrl("https://api.example.com"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ conversationId, challengeId }),
      }),
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.[CONFIRMATION_CHALLENGE_HEADER]).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("SECRET_SESSION_COOKIE");
  });

  it("decodes expired as terminal", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { status: "expired" }));
    const result = await postAssistantConfirm(postArgs());
    expect(result).toMatchObject({
      status: "expired",
      httpStatus: 200,
      recoverability: "terminal",
    });
  });

  it("treats HTTP 200 domain error as terminal", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        status: "error",
        code: "CONFIRMATION_REQUIRED",
        message: "Confirmation expired. Ask again.",
      }),
    );
    const result = await postAssistantConfirm(postArgs());
    expect(result).toMatchObject({
      status: "error",
      code: "CONFIRMATION_REQUIRED",
      message: "Confirmation expired. Ask again.",
      httpStatus: 200,
      recoverability: "terminal",
    });
  });

  it("preserves UNAUTHENTICATED 401 as terminal", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(401, {
        code: "UNAUTHENTICATED",
        status: 401,
        message: "Authentication required.",
      }),
    );
    const result = await postAssistantConfirm(postArgs());
    expect(result.code).toBe("UNAUTHENTICATED");
    expect(result.httpStatus).toBe(401);
    expect(result.recoverability).toBe("terminal");
  });

  it("treats RETRY_IN_PROGRESS 409 as retryable", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        409,
        {
          code: "RETRY_IN_PROGRESS",
          status: 409,
          message:
            "A previous attempt of this request is still in progress. Retry shortly.",
          data: { retryAfterSec: 3 },
        },
        { "Retry-After": "3" },
      ),
    );
    const result = await postAssistantConfirm(postArgs());
    expect(result.code).toBe("RETRY_IN_PROGRESS");
    expect(result.httpStatus).toBe(409);
    expect(result.retryAfterSec).toBe(3);
    expect(result.recoverability).toBe("retryable");
  });

  it("keeps HTTP 503 retryable", async () => {
    fetchMock.mockResolvedValue(
      new Response("<html>unavailable</html>", {
        status: 503,
        headers: { "content-type": "text/html" },
      }),
    );
    const result = await postAssistantConfirm(postArgs());
    expect(result.httpStatus).toBe(503);
    expect(result.recoverability).toBe("retryable");
    expect(result.status).toBe("error");
  });

  it("treats a network rejection as retryable", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const result = await postAssistantConfirm(postArgs());
    expect(result.status).toBe("error");
    expect(result.recoverability).toBe("retryable");
  });

  it("treats a malformed 200 body as ambiguous", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { status: "completed" }));
    const result = await postAssistantConfirm(postArgs());
    expect(result.status).toBe("error");
    expect(result.recoverability).toBe("ambiguous");
  });
});
