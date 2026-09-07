import { ActionRegistry, createInMemoryRateLimitStore } from "@showzy/core";
import { pino } from "pino";
import { describe, expect, it } from "vitest";

import { createApp, HEALTH_PATH, HTTP_INVOCATION_CHANNEL } from "./app.js";
import { ASSISTANT_CHAT_PATH } from "./assistant-chat.js";
import { PKI_PROXY_PATH } from "./pki-proxy.js";
import { REQUEST_ID_HEADER } from "./request-id.js";

const UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function silentApp() {
  return createApp({
    auth: {
      handler: () => Promise.resolve(new Response(null, { status: 404 })),
      api: { getSession: () => Promise.resolve(null) },
    },
    registry: new ActionRegistry(),
    contractModules: {},
    pipeline: {
      db: {
        transaction: () => {
          throw new Error("unit tests do not open transactions");
        },
      },
      logger: pino({ enabled: false }),
    },
    trustedProxies: [],
    getPeerAddress: () => "127.0.0.1",
    pkiProxy: {
      rateLimitStore: createInMemoryRateLimitStore(),
      ipHmacSecret: "test-pki-proxy-ip-hmac-secret!!",
    },
  });
}

describe("createApp HTTP shell", () => {
  it("GET /health returns ok", async () => {
    const app = silentApp();
    const response = await app.request(HEALTH_PATH);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("GET /d/:token does not require a session (never 401)", async () => {
    const app = silentApp();
    const response = await app.request("/d/not-a-session-token");
    expect(response.status).not.toBe(401);
    expect(response.headers.get("content-type")).toMatch(/text\/html/);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await response.text()).toContain(
      '<meta name="referrer" content="no-referrer">',
    );
  });

  it("echoes a valid x-request-id and mints one when absent", async () => {
    const app = silentApp();
    const echoed = await app.request(HEALTH_PATH, {
      headers: { [REQUEST_ID_HEADER]: UUID },
    });
    expect(echoed.headers.get(REQUEST_ID_HEADER)).toBe(UUID);

    const minted = await app.request(HEALTH_PATH);
    expect(minted.headers.get(REQUEST_ID_HEADER)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("POST /pki/proxy is unauthenticated HTTP (never 401)", async () => {
    const app = silentApp();
    const response = await app.request(PKI_PROXY_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com" }),
    });
    expect(response.status).not.toBe(401);
    expect(response.status).toBe(400);
  });

  it("POST /assistant/confirm without a session is 401 UNAUTHENTICATED", async () => {
    const app = silentApp();
    const response = await app.request("/assistant/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        conversationId: UUID,
        challengeId: UUID,
      }),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      code: "UNAUTHENTICATED",
      status: 401,
    });
  });

  it("POST /assistant/choice without a session is 401 UNAUTHENTICATED", async () => {
    const app = silentApp();
    const response = await app.request("/assistant/choice", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        conversationId: UUID,
        choiceId: UUID,
        optionId: UUID,
      }),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      code: "UNAUTHENTICATED",
      status: 401,
    });
  });

  it("GET /assistant/choice/:choiceId without a session is 401 UNAUTHENTICATED", async () => {
    const app = silentApp();
    const response = await app.request(
      `/assistant/choice/${UUID}?conversationId=${UUID}`,
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      code: "UNAUTHENTICATED",
      status: 401,
    });
  });

  it("POST /assistant/chat without a session is 401 UNAUTHENTICATED", async () => {
    const app = silentApp();
    const response = await app.request(ASSISTANT_CHAT_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        conversationId: UUID,
        messages: [
          { id: "m1", role: "user", parts: [{ type: "text", text: "Hi" }] },
        ],
      }),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      code: "UNAUTHENTICATED",
      status: 401,
    });
  });

  it("keeps /rpc and /api/v1 labeled ui", () => {
    expect(HTTP_INVOCATION_CHANNEL).toBe("ui");
  });
});
