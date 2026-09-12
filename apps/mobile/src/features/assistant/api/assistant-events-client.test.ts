/**
 * Reading the stream: framing, and what ends it.
 *
 * The framing matters more than it looks. The server writes a heartbeat as an
 * SSE comment line, and a frame can be split across chunks at any byte — so a
 * reader that assumed one chunk is one frame would drop a card silently and
 * only on a slow network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();

vi.mock("expo/fetch", () => ({
  fetch: (...args: unknown[]) => fetchMock(...args) as Promise<Response>,
}));

import {
  ASSISTANT_EVENTS_HEARTBEAT_MS,
  type AssistantStreamEvent,
} from "@showzy/validation/assistant-events";

import {
  ASSISTANT_STREAM_SILENCE_LIMIT_MS,
  assistantStreamRetryDelayMs,
  openAssistantEventStream,
} from "./assistant-events-client";

const CONVERSATION = "11111111-1111-4111-8111-111111111111";
const COMMAND = "22222222-2222-4222-8222-222222222222";
const COOKIE = "better-auth.session_token=SECRET_SESSION_COOKIE";

const call = {
  apiUrl: "https://api.example.com/",
  getCookie: () => COOKIE,
  getCompanyId: () => "company-a",
};

const WINDOW = {
  conversationId: CONVERSATION,
  messages: [],
  olderCursor: null,
  openPause: null,
};

/** A body this test writes into, chunk by chunk, exactly as a network would. */
function bodyStream(): {
  readonly body: ReadableStream<Uint8Array>;
  push(text: string): void;
  close(): void;
} {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    body,
    push: (text) => controller?.enqueue(encoder.encode(text)),
    close: () => controller?.close(),
  };
}

function respondWith(body: ReadableStream<Uint8Array> | null, status = 200) {
  fetchMock.mockImplementationOnce(() =>
    Promise.resolve({ ok: status >= 200 && status < 300, status, body }),
  );
}

/** Lets the reader's pending `read()` resolve. */
async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

function open(): {
  readonly events: AssistantStreamEvent[];
  readonly closed: { count: number };
  readonly stream: ReturnType<typeof openAssistantEventStream>;
} {
  const events: AssistantStreamEvent[] = [];
  const closed = { count: 0 };
  const stream = openAssistantEventStream({
    ...call,
    conversationId: CONVERSATION,
    onEvent: (event) => events.push(event),
    onClosed: () => {
      closed.count += 1;
    },
  });
  return { events, closed, stream };
}

describe("the assistant event stream", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("asks the events route for one conversation, with the session as a header", async () => {
    respondWith(null, 204);
    open();
    await flush();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `https://api.example.com/assistant/kit/events?conversationId=${CONVERSATION}`,
    );
    const headers = init.headers as Record<string, string>;
    expect(headers.cookie).toBe(COOKIE);
    expect(headers["x-company-id"]).toBe("company-a");
    expect(headers.accept).toBe("text/event-stream");
    expect(init.credentials).toBe("omit");
  });

  it("reads the snapshot every connection opens with", async () => {
    const source = bodyStream();
    respondWith(source.body);
    const live = open();

    source.push(
      `event: snapshot\ndata: ${JSON.stringify({ type: "snapshot", window: WINDOW })}\n\n`,
    );
    await flush();

    expect(live.events).toHaveLength(1);
    expect(live.events[0]?.type).toBe("snapshot");
  });

  /**
   * A frame is not a chunk. The boundary can fall anywhere, including inside
   * the JSON, and a reader that parsed per chunk would lose the event.
   */
  it("joins a frame split across chunks", async () => {
    const source = bodyStream();
    respondWith(source.body);
    const live = open();

    const data = JSON.stringify({
      type: "turn.finished",
      kind: "chat",
      commandId: COMMAND,
      status: "done",
    });
    source.push(`event: turn.fini`);
    source.push(`shed\ndata: ${data.slice(0, 20)}`);
    source.push(`${data.slice(20)}\n\n`);
    await flush();

    expect(live.events).toHaveLength(1);
    expect(live.events[0]).toMatchObject({
      type: "turn.finished",
      status: "done",
    });
    // The window really is optional on the wire (SHO-570).
    expect(
      (live.events[0] as { window?: unknown } | undefined)?.window,
    ).toBeUndefined();
  });

  it("skips the heartbeat, which is a comment and not an event", async () => {
    const source = bodyStream();
    respondWith(source.body);
    const live = open();

    source.push(": heartbeat\n\n");
    source.push(
      `event: snapshot\ndata: ${JSON.stringify({ type: "snapshot", window: WINDOW })}\n\n`,
    );
    await flush();

    expect(live.events.map((event) => event.type)).toEqual(["snapshot"]);
    expect(live.closed.count).toBe(0);
  });

  /**
   * A build too old for an event type, or a reserved one like `text.delta`,
   * skips that event rather than failing the stream — the same forbearance a
   * window shows a message it cannot read.
   */
  it("skips what it cannot read and keeps the connection", async () => {
    const source = bodyStream();
    respondWith(source.body);
    const live = open();

    source.push(`event: text.delta\ndata: {"type":"text.delta"}\n\n`);
    source.push(`event: snapshot\ndata: not json\n\n`);
    source.push(
      `event: turn.started\ndata: ${JSON.stringify({ type: "message.updated" })}\n\n`,
    );
    source.push(
      `event: snapshot\ndata: ${JSON.stringify({ type: "snapshot", window: WINDOW })}\n\n`,
    );
    await flush();

    expect(live.events.map((event) => event.type)).toEqual(["snapshot"]);
    expect(live.closed.count).toBe(0);
  });

  it("reports the end once when the body finishes", async () => {
    const source = bodyStream();
    respondWith(source.body);
    const live = open();

    source.close();
    await flush();

    expect(live.closed.count).toBe(1);
  });

  it("reports the end once when it is closed, and says nothing after", async () => {
    const source = bodyStream();
    respondWith(source.body);
    const live = open();
    await flush();

    live.stream.close();
    live.stream.close();
    source.push(
      `event: snapshot\ndata: ${JSON.stringify({ type: "snapshot", window: WINDOW })}\n\n`,
    );
    await flush();

    expect(live.closed.count).toBe(1);
    expect(live.events).toEqual([]);
  });

  it("reports the end when the route refuses", async () => {
    respondWith(null, 429);
    const live = open();
    await flush();

    expect(live.closed.count).toBe(1);
    expect(live.events).toEqual([]);
  });

  it("reports the end when the connection never opened", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    const live = open();
    await flush();

    expect(live.closed.count).toBe(1);
  });
});

/**
 * The case that has no FIN: a carrier or NAT drops the path and the socket just
 * stops. `reader.read()` waits for ever, so nothing else in this module ever
 * runs — no close, so no backoff, and for an app that stayed in the foreground
 * no `AppState` either. The turn's result would never land.
 */
describe("a stream that goes silent", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ends a connection that has heard nothing for several heartbeats", async () => {
    const source = bodyStream();
    respondWith(source.body);
    const live = open();
    await flush();
    expect(live.closed.count).toBe(0);

    vi.advanceTimersByTime(ASSISTANT_STREAM_SILENCE_LIMIT_MS - 1);
    expect(live.closed.count).toBe(0);

    vi.advanceTimersByTime(1);
    expect(live.closed.count).toBe(1);
  });

  /**
   * The heartbeat carries no event, which is exactly why liveness has to be
   * "bytes arrived" rather than "something parsed".
   */
  it("is kept alive by heartbeats that carry no event at all", async () => {
    const source = bodyStream();
    respondWith(source.body);
    const live = open();
    await flush();

    for (let beat = 0; beat < 5; beat += 1) {
      vi.advanceTimersByTime(ASSISTANT_EVENTS_HEARTBEAT_MS);
      source.push(": heartbeat\n\n");
      await flush();
    }

    expect(live.closed.count).toBe(0);
    expect(live.events).toEqual([]);

    // And when the beats stop, so does the stream.
    vi.advanceTimersByTime(ASSISTANT_STREAM_SILENCE_LIMIT_MS);
    expect(live.closed.count).toBe(1);
  });

  it("does not leave the deadline armed after it closes", async () => {
    const source = bodyStream();
    respondWith(source.body);
    const live = open();
    await flush();

    live.stream.close();
    expect(live.closed.count).toBe(1);

    vi.advanceTimersByTime(ASSISTANT_STREAM_SILENCE_LIMIT_MS * 2);
    expect(live.closed.count).toBe(1);
  });
});

describe("how long a reader waits before trying again", () => {
  it("starts short and settles at a ceiling", () => {
    expect(assistantStreamRetryDelayMs(1)).toBe(1_000);
    expect(assistantStreamRetryDelayMs(2)).toBe(2_000);
    expect(assistantStreamRetryDelayMs(5)).toBe(20_000);
    // Bounded: a long outage never pushes the wait past the ceiling.
    expect(assistantStreamRetryDelayMs(99)).toBe(20_000);
  });
});
