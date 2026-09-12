/**
 * What the client does with each kind of answer.
 *
 * The case worth pinning hardest is a refusal that carries a window: the call
 * failed *and* the conversation is now known. Reporting only the failure is how
 * a stale picker stays on screen; reporting only the window is how a person
 * never learns their tap did nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();

vi.mock("expo/fetch", () => ({
  fetch: (...args: unknown[]) => fetchMock(...args) as Promise<Response>,
}));

import {
  ASSISTANT_KIT_ANSWER_PATH,
  ASSISTANT_KIT_TEXT_MAX,
  clipAssistantKitText,
  getAssistantKitWindow,
  postAssistantKitAbandon,
  postAssistantKitAnswer,
  postAssistantKitChat,
} from "./assistant-kit-client";

const CONVERSATION = "11111111-1111-4111-8111-111111111111";
const COMMAND = "22222222-2222-4222-8222-222222222222";
const INTERACTION = "33333333-3333-4333-8333-333333333333";
const COOKIE = "better-auth.session_token=SECRET_SESSION_COOKIE";

/** Reads a request body without stringifying an object by accident. */
function sentBody(index: number): Record<string, unknown> {
  const call = fetchMock.mock.calls[index] as
    [string, { readonly body?: unknown }] | undefined;
  const body = call?.[1].body;
  return JSON.parse(typeof body === "string" ? body : "{}") as Record<
    string,
    unknown
  >;
}

function conversationWindow(openPause: unknown = null) {
  return {
    conversationId: CONVERSATION,
    olderCursor: null,
    messages: [
      {
        messageId: "44444444-4444-4444-8444-444444444444",
        role: "assistant",
        createdAt: "2026-09-09T10:00:00.000Z",
        parts: [{ kind: "text", text: "Готово.", status: "complete" }],
        revision: 1,
      },
    ],
    openPause,
    turn: null,
  };
}

const OPEN_PAUSE = {
  kind: "choice",
  interactionId: INTERACTION,
  revision: 2,
  status: "open",
  prompt: {
    subject: "Катя",
    options: [{ optionId: "opt-a", label: "Катя Самбука" }],
    optionsTruncated: false,
  },
  expiresAt: "2026-09-09T10:15:00.000Z",
};

function respond(status: number, body: unknown): void {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

const call = {
  apiUrl: "https://api.example.com/",
  getCookie: () => COOKIE,
  getCompanyId: () => "company-a",
};

describe("the assistant kit client", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("keeps a message whose reply was interrupted", async () => {
    const window = conversationWindow();
    const [reply] = window.messages;
    respond(200, {
      status: "ok",
      window: {
        ...window,
        messages: [
          {
            ...reply,
            parts: [{ kind: "text", text: "Шукаю", status: "interrupted" }],
          },
        ],
      },
    });

    const outcome = await getAssistantKitWindow({
      ...call,
      conversationId: CONVERSATION,
    });

    expect(outcome.failure).toBeNull();
    expect(outcome.window?.messages).toHaveLength(1);
    expect(outcome.window?.messages[0]?.parts).toEqual([
      { kind: "text", text: "Шукаю", status: "interrupted" },
    ]);
  });

  it("returns the window on a successful turn", async () => {
    respond(200, { status: "ok", window: conversationWindow() });

    const outcome = await postAssistantKitChat({
      ...call,
      conversationId: CONVERSATION,
      commandId: COMMAND,
      text: "привіт",
    });

    expect(outcome.failure).toBeNull();
    expect(outcome.window?.messages).toHaveLength(1);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("https://api.example.com/assistant/kit/chat");
    // Posts what it was given: trimming and the length cap belong to the caller,
    // which is the layer that also has to put the text back on a failure.
    expect(sentBody(0)).toEqual({
      commandId: COMMAND,
      conversationId: CONVERSATION,
      text: "привіт",
    });
  });

  /**
   * The switch (ADR-0039): the turn is stored and queued, and this is the
   * window as the accept left it — the person's message and the placeholder the
   * worker writes into. A client that rendered nothing for a `202` would show
   * the thread without the message it had just sent.
   */
  it("returns the window of a turn that was accepted, not run", async () => {
    respond(202, { status: "accepted", window: conversationWindow() });

    const outcome = await postAssistantKitChat({
      ...call,
      conversationId: CONVERSATION,
      commandId: COMMAND,
      text: "привіт",
    });

    expect(outcome.failure).toBeNull();
    expect(outcome.window?.messages).toHaveLength(1);
  });

  /**
   * A replayed command answers `200 ok`, because `202` must mean "stored and
   * queued" and a command that accepted no turn may not claim it (SHO-563).
   * Both carry the conversation, and `ok` is emphatically not "nothing
   * happened" — the first attempt's turn is in the window it brings.
   */
  it("treats a replayed command's ok as news, not as an empty outcome", async () => {
    respond(200, { status: "ok", window: conversationWindow(OPEN_PAUSE) });

    const outcome = await postAssistantKitChat({
      ...call,
      conversationId: CONVERSATION,
      commandId: COMMAND,
      text: "привіт",
    });

    expect(outcome.failure).toBeNull();
    expect(outcome.window?.openPause?.interactionId).toBe(INTERACTION);
  });

  it("treats an accepted turn it cannot read as a fault", async () => {
    respond(202, { status: "accepted", window: { messages: "nope" } });

    const outcome = await postAssistantKitChat({
      ...call,
      conversationId: CONVERSATION,
      commandId: COMMAND,
      text: "привіт",
    });

    expect(outcome).toEqual({ window: null, failure: { kind: "unreadable" } });
  });

  it("clips text to what the route accepts", () => {
    expect(clipAssistantKitText("  привіт  ")).toBe("привіт");
    expect(clipAssistantKitText("x".repeat(5000))).toHaveLength(
      ASSISTANT_KIT_TEXT_MAX,
    );
  });

  it("sends the session as a header and never as body", async () => {
    respond(200, { status: "ok", window: conversationWindow() });

    await postAssistantKitChat({
      ...call,
      conversationId: CONVERSATION,
      commandId: COMMAND,
      text: "привіт",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.cookie).toBe(COOKIE);
    expect(headers["x-company-id"]).toBe("company-a");
    expect(JSON.stringify(sentBody(0))).not.toContain("SECRET_SESSION_COOKIE");
    expect(init.credentials).toBe("omit");
  });

  it("reports the failure and the corrected conversation together", async () => {
    respond(409, { status: "stale", window: conversationWindow(OPEN_PAUSE) });

    const outcome = await postAssistantKitAnswer({
      ...call,
      conversationId: CONVERSATION,
      commandId: COMMAND,
      interactionId: INTERACTION,
      revision: 1,
      answer: { optionId: "opt-a" },
    });

    expect(outcome.failure?.kind).toBe("stale");
    // Both, not one or the other: the tap did nothing, and this is the question
    // that is actually open now.
    expect(outcome.window?.openPause?.revision).toBe(2);
  });

  it("carries the reason a refusal gives", async () => {
    respond(409, {
      status: "action_failed",
      code: "CONFLICT",
      message: "no longer available",
      window: conversationWindow(OPEN_PAUSE),
    });

    const outcome = await postAssistantKitAnswer({
      ...call,
      conversationId: CONVERSATION,
      commandId: COMMAND,
      interactionId: INTERACTION,
      revision: 2,
      answer: { optionId: "opt-a" },
    });

    expect(outcome.failure).toEqual({
      kind: "action_failed",
      message: "no longer available",
    });
    expect(outcome.window).not.toBeNull();
  });

  it("passes the answer through without interpreting it", async () => {
    respond(200, { status: "ok", window: conversationWindow() });

    await postAssistantKitAnswer({
      ...call,
      conversationId: CONVERSATION,
      commandId: COMMAND,
      interactionId: INTERACTION,
      revision: 2,
      answer: { approved: true },
    });

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain(ASSISTANT_KIT_ANSWER_PATH);
    expect(sentBody(0).answer).toEqual({ approved: true });
  });

  it("says nothing about the conversation when the network fails", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));

    const outcome = await postAssistantKitChat({
      ...call,
      conversationId: CONVERSATION,
      commandId: COMMAND,
      text: "привіт",
    });

    // No window: the caller keeps whatever it was already showing.
    expect(outcome).toEqual({
      window: null,
      failure: { kind: "unreachable" },
    });
  });

  it("treats a 200 it cannot read as a fault, not an empty conversation", async () => {
    respond(200, { status: "ok", window: { messages: "nope" } });

    const outcome = await getAssistantKitWindow({
      ...call,
      conversationId: CONVERSATION,
    });

    expect(outcome).toEqual({
      window: null,
      failure: { kind: "unreadable" },
    });
  });

  it("maps the faults that are not about the conversation", async () => {
    respond(401, { error: { code: "UNAUTHENTICATED" } });
    respond(410, { status: "expired" });
    respond(429, { error: { code: "RATE_LIMITED" }, retryAfterSec: 42 });
    respond(500, { status: "pause_rejected", reason: "unknown kind" });

    const read = () =>
      getAssistantKitWindow({ ...call, conversationId: CONVERSATION });

    expect((await read()).failure?.kind).toBe("unauthorized");
    expect((await read()).failure?.kind).toBe("expired");
    // The spend ceiling, not a broken request.
    expect((await read()).failure?.kind).toBe("rate_limited");
    expect(await read()).toEqual({
      window: null,
      failure: { kind: "server", message: "unknown kind" },
    });
  });

  it("abandons without a revision, and accepts a body with no window", async () => {
    respond(200, { status: "abandoned" });

    const outcome = await postAssistantKitAbandon({
      ...call,
      conversationId: CONVERSATION,
      interactionId: INTERACTION,
    });

    expect(outcome).toEqual({ window: null, failure: null });
    expect(sentBody(0)).toEqual({
      conversationId: CONVERSATION,
      interactionId: INTERACTION,
    });
  });

  it("asks for the page before a cursor by the same query", async () => {
    respond(200, { status: "ok", window: conversationWindow() });

    await getAssistantKitWindow({
      ...call,
      conversationId: CONVERSATION,
      before: "31",
    });

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(
      `https://api.example.com/assistant/kit/messages?conversationId=${CONVERSATION}&before=31`,
    );
  });

  /**
   * A phone is updated when its owner updates it, not when the server ships a
   * new kind of part. One message it cannot read must not cost it the thread.
   */
  it("keeps the messages it can read when one it cannot is among them", async () => {
    const readable = conversationWindow();
    respond(200, {
      status: "ok",
      window: {
        ...readable,
        messages: [
          {
            messageId: "55555555-5555-4555-8555-555555555555",
            role: "assistant",
            createdAt: "2026-09-09T09:00:00.000Z",
            parts: [{ kind: "voice", clipId: "clip-1" }],
            revision: 1,
          },
          ...readable.messages,
        ],
      },
    });

    const outcome = await getAssistantKitWindow({
      ...call,
      conversationId: CONVERSATION,
    });

    expect(outcome.failure).toBeNull();
    expect(outcome.window?.messages.map((m) => m.messageId)).toEqual([
      "44444444-4444-4444-8444-444444444444",
    ]);
  });

  it("asks for a conversation by an encoded query, not a path", async () => {
    respond(200, { status: "ok", window: conversationWindow() });

    await getAssistantKitWindow({ ...call, conversationId: "a b/c" });

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(
      "https://api.example.com/assistant/kit/messages?conversationId=a%20b%2Fc",
    );
  });
});
