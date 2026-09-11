import { describe, expect, it } from "vitest";

import { authInstanceFrom } from "./auth-instance.js";

describe("the auth instance the transport uses", () => {
  it("forwards a session check's query to better-auth exactly as given, and adds none when there is none", async () => {
    const calls: object[] = [];
    const auth = authInstanceFrom({
      handler: () => new Response(null),
      getSession: (args) => {
        calls.push(args);
        return Promise.resolve({ user: { id: "user-1" } });
      },
    });
    const headers = new Headers({ cookie: "better-auth.session_token=x" });

    await auth.api.getSession({ headers });
    await auth.api.getSession({
      headers,
      query: { disableRefresh: true, disableCookieCache: true },
    });

    expect(calls).toEqual([
      { headers },
      { headers, query: { disableRefresh: true, disableCookieCache: true } },
    ]);
    expect(Object.keys(calls[0] ?? {})).toEqual(["headers"]);
  });

  it("hands the transport the user's id and nothing else of the session", async () => {
    const full = {
      user: { id: "user-1", email: "anna@example.com" },
      session: { token: "session-token" },
    };
    const auth = authInstanceFrom({
      handler: () => new Response(null),
      getSession: () => Promise.resolve(full),
    });

    expect(await auth.api.getSession({ headers: new Headers() })).toEqual({
      user: { id: "user-1" },
    });
  });

  it("answers no session as no session", async () => {
    const auth = authInstanceFrom({
      handler: () => new Response(null),
      getSession: () => Promise.resolve(null),
    });

    expect(await auth.api.getSession({ headers: new Headers() })).toBeNull();
  });
});
