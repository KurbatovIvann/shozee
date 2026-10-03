import { COMPANY_SELECTOR_HEADER } from "@showzy/contract";
import {
  createInMemoryRateLimitStore,
  type RateLimitStore,
} from "@showzy/core";
import { NotFoundError, PermissionDeniedError } from "@showzy/core/errors";
import {
  ASSISTANT_VOICE_PATH,
  VOICE_CLOSE_CODE,
} from "@showzy/validation/assistant-voice";
import { WSContext } from "hono/ws";
import { pino, type Logger } from "pino";
import { describe, expect, it } from "vitest";

import type {
  VoiceRecognitionStream,
  VoiceRecognizer,
} from "./assistant-voice-chirp.js";
import { VOICE_SESSION_WINDOW_SEC } from "./assistant-voice-limit.js";
import {
  createAssistantVoiceApp,
  voiceSocketEvents,
  type AssistantVoiceRuntime,
  type VoiceStreamSlots,
} from "./assistant-voice.js";

const USER = "user-1";
const COMPANY = "11111111-1111-4111-8111-1111111111aa";
const OTHER_COMPANY = "22222222-2222-4222-8222-2222222222bb";
const WEB_ORIGIN = "https://panel.showzy.test";

interface TrackingRecognizer extends VoiceRecognizer {
  readonly streams: { readonly written: Buffer[] }[];
}

function trackingRecognizer(): TrackingRecognizer {
  const streams: { written: Buffer[] }[] = [];
  return {
    streams,
    start(): VoiceRecognitionStream {
      const written: Buffer[] = [];
      streams.push({ written });
      return {
        write: (pcm) => {
          written.push(pcm);
          return true;
        },
        finish: () => undefined,
        abort: () => undefined,
      };
    },
    close: () => Promise.resolve(),
  };
}

function countingSlots(available = 1): VoiceStreamSlots & {
  readonly held: Set<string>;
} {
  const held = new Set<string>();
  return {
    held,
    acquire: (_userId, streamId) => {
      if (held.size >= available) {
        return Promise.resolve(false);
      }
      held.add(streamId);
      return Promise.resolve(true);
    },
    release: (_userId, streamId) => {
      held.delete(streamId);
      return Promise.resolve();
    },
  };
}

function countingStore(inner?: RateLimitStore): {
  readonly store: RateLimitStore;
  readonly consumed: () => number;
} {
  const delegate = inner ?? createInMemoryRateLimitStore();
  let count = 0;
  return {
    store: {
      consume: (request) => {
        count += 1;
        return delegate.consume(request);
      },
    },
    consumed: () => count,
  };
}

function silentLogger(): Logger {
  return pino({ level: "silent" });
}

function runtime(options?: {
  readonly session?: { user: { id: string }; session: { id: string } } | null;
  readonly recognizer?: VoiceRecognizer;
  readonly slots?: VoiceStreamSlots;
  readonly staffCompany?: (caller: {
    readonly companySelector: string;
  }) => Promise<string>;
  readonly rateLimit?: AssistantVoiceRuntime["rateLimit"];
}): AssistantVoiceRuntime {
  return {
    logger: silentLogger(),
    recognizer: options?.recognizer ?? trackingRecognizer(),
    slots: options?.slots ?? countingSlots(5),
    rateLimit: options?.rateLimit ?? {
      store: createInMemoryRateLimitStore(),
      sessionsPerMinutePerUser: 20,
    },
    trustedOrigins: [WEB_ORIGIN],
    staffCompany:
      options?.staffCompany ??
      ((caller) =>
        caller.companySelector === COMPANY
          ? Promise.resolve(COMPANY)
          : Promise.reject(new NotFoundError("no membership"))),
    auth: {
      api: {
        getSession: () =>
          Promise.resolve(
            options?.session === undefined
              ? { user: { id: USER }, session: { id: "session-1" } }
              : options.session,
          ),
      },
    },
  };
}

async function handshake(
  voice: ReturnType<typeof createAssistantVoiceApp>,
  headers: Record<string, string>,
): Promise<Response> {
  return await voice.app.request(
    ASSISTANT_VOICE_PATH,
    { headers: { upgrade: "websocket", ...headers } },
    {},
  );
}

function fakeSocket(): {
  readonly ws: WSContext;
  readonly sent: string[];
  readonly closed: number[];
} {
  const sent: string[] = [];
  const closed: number[] = [];
  const ws = new WSContext({
    send: (data) => {
      if (typeof data === "string") {
        sent.push(data);
      }
    },
    close: (code) => {
      closed.push(code ?? 1000);
    },
    readyState: 1,
  });
  return { ws, sent, closed };
}

describe("assistant voice route", () => {
  it("refuses a handshake without a session", async () => {
    const voice = createAssistantVoiceApp(runtime({ session: null }));

    const response = await handshake(voice, {
      [COMPANY_SELECTOR_HEADER]: COMPANY,
    });

    expect(response.status).toBe(401);
  });

  it("refuses a handshake that names no company", async () => {
    const voice = createAssistantVoiceApp(runtime());

    const response = await handshake(voice, {});

    expect(response.status).toBe(400);
  });

  it("refuses a session that core does not accept as staff", async () => {
    const voice = createAssistantVoiceApp(
      runtime({
        staffCompany: () =>
          Promise.reject(new PermissionDeniedError("not staff")),
      }),
    );

    const response = await handshake(voice, {
      [COMPANY_SELECTOR_HEADER]: COMPANY,
    });

    expect(response.status).toBe(403);
  });

  it("refuses a staff member of another company", async () => {
    const voice = createAssistantVoiceApp(runtime());

    const response = await handshake(voice, {
      [COMPANY_SELECTOR_HEADER]: OTHER_COMPANY,
    });

    expect(response.status).toBe(403);
  });

  it("refuses an origin the auth instance does not trust", async () => {
    const voice = createAssistantVoiceApp(runtime());

    const response = await handshake(voice, {
      [COMPANY_SELECTOR_HEADER]: COMPANY,
      origin: "https://evil.example.com",
    });

    expect(response.status).toBe(403);
  });

  it("accepts a handshake from a trusted origin", async () => {
    const voice = createAssistantVoiceApp(runtime());

    const response = await handshake(voice, {
      [COMPANY_SELECTOR_HEADER]: COMPANY,
      origin: WEB_ORIGIN,
    });

    expect(response.status).toBe(200);
  });

  it("refuses a second socket once the caller holds every slot", async () => {
    const slots = countingSlots(1);
    const voice = createAssistantVoiceApp(runtime({ slots }));

    const first = await handshake(voice, {
      [COMPANY_SELECTOR_HEADER]: COMPANY,
    });
    const second = await handshake(voice, {
      [COMPANY_SELECTOR_HEADER]: COMPANY,
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(second.headers.get("Retry-After")).toBe("15");
    expect(await second.json()).toEqual({
      error: { code: "RATE_LIMITED" },
      retryAfterSec: 15,
    });
    expect(slots.held.size).toBe(1);
  });

  it("refuses a plain GET before it takes a slot", async () => {
    const slots = countingSlots(1);
    const voice = createAssistantVoiceApp(runtime({ slots }));

    const response = await voice.app.request(
      ASSISTANT_VOICE_PATH,
      { headers: { [COMPANY_SELECTOR_HEADER]: COMPANY } },
      {},
    );

    expect(response.status).toBe(426);
    expect(slots.held.size).toBe(0);
  });

  it("releases the slot when the upgrade itself fails", async () => {
    const slots = countingSlots(1);
    const voice = createAssistantVoiceApp(runtime({ slots }));

    const response = await voice.app.request(ASSISTANT_VOICE_PATH, {
      headers: { upgrade: "websocket", [COMPANY_SELECTOR_HEADER]: COMPANY },
    });

    expect(response.status).toBe(500);
    expect(slots.held.size).toBe(0);
  });

  it("answers 500 and takes no slot when membership cannot be read", async () => {
    const slots = countingSlots(1);
    const voice = createAssistantVoiceApp(
      runtime({
        slots,
        staffCompany: () => Promise.reject(new Error("redis is down")),
      }),
    );

    const response = await handshake(voice, {
      [COMPANY_SELECTOR_HEADER]: COMPANY,
    });

    expect(response.status).toBe(500);
    expect(slots.held.size).toBe(0);
  });

  it("releases the slot when the session cannot start", () => {
    const slots = countingSlots(1);
    void slots.acquire(USER, "stream-1");
    const failing: VoiceRecognizer = {
      start: () => {
        throw new Error("recognizer unavailable");
      },
      close: () => Promise.resolve(),
    };
    const events = voiceSocketEvents(
      runtime({ slots, recognizer: failing }),
      { userId: USER, companyId: COMPANY, requestId: "req-1" },
      () => {
        void slots.release(USER, "stream-1");
      },
    );
    const socket = fakeSocket();

    events.onOpen?.(new Event("open"), socket.ws);

    expect(slots.held.size).toBe(0);
    expect(socket.closed).toEqual([VOICE_CLOSE_CODE.recognizerFailed]);
  });

  it("releases the slot when the socket closes", () => {
    const slots = countingSlots(1);
    void slots.acquire(USER, "stream-1");
    const events = voiceSocketEvents(
      runtime({ slots }),
      { userId: USER, companyId: COMPANY, requestId: "req-1" },
      () => {
        void slots.release(USER, "stream-1");
      },
    );
    const socket = fakeSocket();

    events.onOpen?.(new Event("open"), socket.ws);
    events.onClose?.(new Event("close"), socket.ws);

    expect(slots.held.size).toBe(0);
  });

  it("gives each socket its own recognition stream", () => {
    const recognizer = trackingRecognizer();
    const shared = runtime({ recognizer });

    const first = voiceSocketEvents(
      shared,
      { userId: USER, companyId: COMPANY, requestId: "req-1" },
      () => undefined,
    );
    const second = voiceSocketEvents(
      shared,
      { userId: "user-2", companyId: OTHER_COMPANY, requestId: "req-2" },
      () => undefined,
    );
    const firstSocket = fakeSocket();
    const secondSocket = fakeSocket();

    first.onOpen?.(new Event("open"), firstSocket.ws);
    second.onOpen?.(new Event("open"), secondSocket.ws);
    first.onMessage?.(
      new MessageEvent("message", { data: new Uint8Array([1, 2]).buffer }),
      firstSocket.ws,
    );

    expect(recognizer.streams).toHaveLength(2);
    expect(recognizer.streams[0]?.written).toHaveLength(1);
    expect(recognizer.streams[1]?.written).toHaveLength(0);
  });

  it("refuses a frame that is neither audio nor a control message", () => {
    const events = voiceSocketEvents(
      runtime(),
      { userId: USER, companyId: COMPANY, requestId: "req-1" },
      () => undefined,
    );
    const socket = fakeSocket();

    events.onOpen?.(new Event("open"), socket.ws);
    events.onMessage?.(
      new MessageEvent("message", { data: new Blob([]) }),
      socket.ws,
    );

    expect(socket.closed).toEqual([VOICE_CLOSE_CODE.badFrame]);
  });

  it("sends the client the frame and session bounds when the socket opens", () => {
    const events = voiceSocketEvents(
      runtime(),
      { userId: USER, companyId: COMPANY, requestId: "req-1" },
      () => undefined,
    );
    const socket = fakeSocket();

    events.onOpen?.(new Event("open"), socket.ws);

    expect(JSON.parse(socket.sent[0] ?? "null")).toEqual({
      type: "ready",
      sampleRateHz: 16_000,
      maxFrameBytes: 32_000,
      maxTotalBytes: 480_000,
      maxSessionMs: 15_000,
    });
  });
});

describe("assistant voice per-user session limit", () => {
  it("refuses a handshake past the ceiling before any Chirp stream opens", async () => {
    const recognizer = trackingRecognizer();
    const slots = countingSlots(5);
    const voice = createAssistantVoiceApp(
      runtime({
        recognizer,
        slots,
        rateLimit: {
          store: createInMemoryRateLimitStore(),
          sessionsPerMinutePerUser: 1,
        },
      }),
    );

    const first = await handshake(voice, {
      [COMPANY_SELECTOR_HEADER]: COMPANY,
    });
    const second = await handshake(voice, {
      [COMPANY_SELECTOR_HEADER]: COMPANY,
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(Number(second.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(recognizer.streams).toHaveLength(0);
    expect(slots.held.size).toBe(1);
  });

  it("admits every handshake up to the ceiling", async () => {
    const voice = createAssistantVoiceApp(
      runtime({
        rateLimit: {
          store: createInMemoryRateLimitStore(),
          sessionsPerMinutePerUser: 3,
        },
      }),
    );

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await handshake(voice, {
        [COMPANY_SELECTOR_HEADER]: COMPANY,
      });
      statuses.push(response.status);
    }

    expect(statuses).toEqual([200, 200, 200]);
  });

  it("gives each user their own bucket", async () => {
    const rateLimit = {
      store: createInMemoryRateLimitStore(),
      sessionsPerMinutePerUser: 1,
    };
    const mine = createAssistantVoiceApp(runtime({ rateLimit }));
    const theirs = createAssistantVoiceApp(
      runtime({
        rateLimit,
        session: { user: { id: "user-2" }, session: { id: "session-2" } },
      }),
    );

    const first = await handshake(mine, { [COMPANY_SELECTOR_HEADER]: COMPANY });
    const mineAgain = await handshake(mine, {
      [COMPANY_SELECTOR_HEADER]: COMPANY,
    });
    const other = await handshake(theirs, {
      [COMPANY_SELECTOR_HEADER]: COMPANY,
    });

    expect(first.status).toBe(200);
    expect(mineAgain.status).toBe(429);
    expect(other.status).toBe(200);
  });

  it("admits the caller again once the bucket refills", async () => {
    let nowMs = 1_700_000_000_000;
    const voice = createAssistantVoiceApp(
      runtime({
        rateLimit: {
          store: createInMemoryRateLimitStore({ now: () => nowMs }),
          sessionsPerMinutePerUser: 1,
        },
      }),
    );

    const first = await handshake(voice, {
      [COMPANY_SELECTOR_HEADER]: COMPANY,
    });
    const refused = await handshake(voice, {
      [COMPANY_SELECTOR_HEADER]: COMPANY,
    });
    nowMs += VOICE_SESSION_WINDOW_SEC * 1000;
    const refilled = await handshake(voice, {
      [COMPANY_SELECTOR_HEADER]: COMPANY,
    });

    expect(first.status).toBe(200);
    expect(refused.status).toBe(429);
    expect(refilled.status).toBe(200);
  });

  it("refuses the handshake when the bucket cannot be read", async () => {
    const recognizer = trackingRecognizer();
    const slots = countingSlots(5);
    const voice = createAssistantVoiceApp(
      runtime({
        recognizer,
        slots,
        rateLimit: {
          store: {
            consume: () => Promise.reject(new Error("redis down")),
          },
          sessionsPerMinutePerUser: 5,
        },
      }),
    );

    const response = await handshake(voice, {
      [COMPANY_SELECTOR_HEADER]: COMPANY,
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe(
      String(VOICE_SESSION_WINDOW_SEC),
    );
    expect(await response.json()).toEqual({
      error: { code: "RATE_LIMIT_STORE" },
      retryAfterSec: VOICE_SESSION_WINDOW_SEC,
    });
    expect(slots.held.size).toBe(0);
    expect(recognizer.streams).toHaveLength(0);
  });

  it("spends no session when concurrency refuses the handshake", async () => {
    const bucket = countingStore();
    const slots = countingSlots(1);
    const voice = createAssistantVoiceApp(
      runtime({
        slots,
        rateLimit: { store: bucket.store, sessionsPerMinutePerUser: 5 },
      }),
    );

    const first = await handshake(voice, {
      [COMPANY_SELECTOR_HEADER]: COMPANY,
    });
    const second = await handshake(voice, {
      [COMPANY_SELECTOR_HEADER]: COMPANY,
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(bucket.consumed()).toBe(1);
  });

  it("spends no session on a handshake the gate refuses", async () => {
    const bucket = countingStore();
    const rateLimit = { store: bucket.store, sessionsPerMinutePerUser: 5 };
    const voice = createAssistantVoiceApp(runtime({ rateLimit }));
    const signedOut = createAssistantVoiceApp(
      runtime({ rateLimit, session: null }),
    );

    const untrustedOrigin = await handshake(voice, {
      [COMPANY_SELECTOR_HEADER]: COMPANY,
      origin: "https://evil.example.com",
    });
    const otherCompany = await handshake(voice, {
      [COMPANY_SELECTOR_HEADER]: OTHER_COMPANY,
    });
    const noCompany = await handshake(voice, {});
    const noSession = await handshake(signedOut, {
      [COMPANY_SELECTOR_HEADER]: COMPANY,
    });

    expect([
      untrustedOrigin.status,
      otherCompany.status,
      noCompany.status,
      noSession.status,
    ]).toEqual([403, 403, 400, 401]);
    expect(bucket.consumed()).toBe(0);
  });

  it("admits every handshake when the ceiling is disabled", async () => {
    const voice = createAssistantVoiceApp(
      runtime({
        rateLimit: {
          store: {
            consume: () => Promise.reject(new Error("never asked")),
          },
          sessionsPerMinutePerUser: 0,
        },
      }),
    );

    const first = await handshake(voice, {
      [COMPANY_SELECTOR_HEADER]: COMPANY,
    });
    const second = await handshake(voice, {
      [COMPANY_SELECTOR_HEADER]: COMPANY,
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });
});
