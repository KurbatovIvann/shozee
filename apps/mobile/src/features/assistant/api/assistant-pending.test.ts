import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();

vi.mock("expo/fetch", () => ({
  fetch: (...args: unknown[]) => fetchMock(...args) as Promise<Response>,
}));

import {
  assistantConfirmUrl,
  assistantPendingAbandonUrl,
  assistantPendingUrl,
  getAssistantPending,
  postAssistantConfirm,
  postAssistantPendingAbandon,
} from "./assistant-pending";

const conversationId = "11111111-1111-4111-8111-111111111111";
const challengeId = "22222222-2222-4222-8222-222222222222";
const cookie = "better-auth.session_token=SECRET_SESSION_COOKIE";
const companyId = "33333333-3333-4333-8333-333333333333";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function authArgs() {
  return {
    apiUrl: "https://api.example.com",
    getCookie: () => cookie,
    getCompanyId: () => companyId,
    conversationId,
  };
}

describe("assistant pending HTTP (SHO-522)", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("GETs /assistant/pending?conversationId=", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        pending: {
          kind: "confirmation",
          id: challengeId,
          version: 1,
          status: "open",
          actionName: "customers.deleteCustomer",
          challengeId,
          summary: "Delete this archived customer.",
          expiresAt: "2026-09-08T12:00:00.000Z",
          toolCallId: "call-delete",
        },
      }),
    );
    const result = await getAssistantPending(authArgs());
    expect(result).toMatchObject({
      kind: "ok",
      pending: { kind: "confirmation", id: challengeId, version: 1 },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      assistantPendingUrl("https://api.example.com", conversationId),
    );
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ method: "GET" }),
    );
    expect(JSON.stringify(fetchMock.mock.calls[0]?.[1])).not.toContain(
      "canonicalInput",
    );
  });

  it("POSTs /assistant/confirm with conversationId and challengeId only", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        status: "ok",
        speech: "Customer deleted.",
        cards: [],
        pending: null,
      }),
    );
    const result = await postAssistantConfirm({
      ...authArgs(),
      challengeId,
    });
    expect(result).toEqual({
      status: "ok",
      speech: "Customer deleted.",
      cards: [],
      pending: null,
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      assistantConfirmUrl("https://api.example.com"),
    );
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ conversationId, challengeId }),
      }),
    );
    expect(JSON.stringify(fetchMock.mock.calls[0]?.[1])).not.toContain(
      "canonicalInput",
    );
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://api.example.com/assistant/confirm",
    );
  });

  it("POSTs /assistant/pending/abandon with version CAS fields", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        status: "ok",
        speech: "",
        cards: [],
        pending: null,
      }),
    );
    const result = await postAssistantPendingAbandon({
      ...authArgs(),
      pendingId: challengeId,
      expectedVersion: 2,
    });
    expect(result.status).toBe("ok");
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      assistantPendingAbandonUrl("https://api.example.com"),
    );
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        body: JSON.stringify({
          conversationId,
          pendingId: challengeId,
          expectedVersion: 2,
        }),
      }),
    );
  });

  it("treats GET failure as unavailable so hydrate can fall back", async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { code: "NOT_FOUND" }));
    await expect(getAssistantPending(authArgs())).resolves.toEqual({
      kind: "unavailable",
    });
  });
});
