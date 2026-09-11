import { ActionRegistry, createInMemoryRateLimitStore } from "@showzy/core";
import { pino } from "pino";
import { describe, expect, it } from "vitest";

import { createApp, HEALTH_PATH, HTTP_INVOCATION_CHANNEL } from "./app.js";
import { ASSISTANT_CHAT_PATH } from "./assistant-invocation.js";
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

  /**
   * The previous assistant's five routes. Kept as a test rather than deleted
   * with them: a half-removal that left one of these answering would otherwise
   * be invisible, and the app must not carry two assistants again.
   */
  it("no longer answers on the retired assistant paths", async () => {
    const app = silentApp();
    const retired: readonly [string, RequestInit][] = [
      [ASSISTANT_CHAT_PATH, { method: "POST" }],
      ["/assistant/choice", { method: "POST" }],
      ["/assistant/confirm", { method: "POST" }],
      ["/assistant/pending/abandon", { method: "POST" }],
      [`/assistant/pending?conversationId=${UUID}`, { method: "GET" }],
    ];

    for (const [path, init] of retired) {
      const response = await app.request(path, {
        ...init,
        headers: { "content-type": "application/json" },
        ...(init.method === "POST" ? { body: "{}" } : {}),
      });
      expect(response.status).toBe(404);
    }
  });

  it("keeps /rpc and /api/v1 labeled ui", () => {
    expect(HTTP_INVOCATION_CHANNEL).toBe("ui");
  });
});
