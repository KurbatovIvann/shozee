import { COMPANY_SELECTOR_HEADER } from "@showzy/contract";
import { WSContext } from "hono/ws";
import { pino, type Logger } from "pino";
import { describe, expect, it } from "vitest";

import type {
  VoiceRecognitionStream,
  VoiceRecognizer,
} from "./assistant-voice-recognizer.js";
import { VOICE_CLOSE_CODE } from "./assistant-voice-session.js";
import {
  ASSISTANT_VOICE_PATH,
  createAssistantVoiceApp,
  voiceSocketEvents,
  type AssistantVoiceRuntime,
} from "./assistant-voice.js";

const USER = "user-1";
const COMPANY = "11111111-1111-4111-8111-1111111111aa";
const OTHER_COMPANY = "22222222-2222-4222-8222-2222222222bb";

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
        },
        finish: () => undefined,
        abort: () => undefined,
      };
    },
    close: () => Promise.resolve(),
  };
}

function silentLogger(): Logger {
  return pino({ level: "silent" });
}

function runtime(options?: {
  readonly session?: { user: { id: string }; session: { id: string } } | null;
  readonly recognizer?: VoiceRecognizer;
}): AssistantVoiceRuntime {
  return {
    logger: silentLogger(),
    recognizer: options?.recognizer ?? trackingRecognizer(),
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
  return await voice.app.request(ASSISTANT_VOICE_PATH, { headers }, {});
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
      upgrade: "websocket",
      [COMPANY_SELECTOR_HEADER]: COMPANY,
    });

    expect(response.status).toBe(401);
  });

  it("refuses a handshake that names no company", async () => {
    const voice = createAssistantVoiceApp(runtime());

    const response = await handshake(voice, { upgrade: "websocket" });

    expect(response.status).toBe(400);
  });

  it("refuses a plain GET that is not a websocket upgrade", async () => {
    const voice = createAssistantVoiceApp(runtime());

    const response = await handshake(voice, {
      [COMPANY_SELECTOR_HEADER]: COMPANY,
    });

    expect(response.status).toBe(426);
  });

  it("accepts the handshake of a staff member who named a company", async () => {
    const voice = createAssistantVoiceApp(runtime());

    const response = await handshake(voice, {
      upgrade: "websocket",
      [COMPANY_SELECTOR_HEADER]: COMPANY,
    });

    expect(response.status).toBe(200);
  });

  it("gives each socket its own recognition stream", () => {
    const recognizer = trackingRecognizer();
    const shared = runtime({ recognizer });

    const first = voiceSocketEvents(shared, {
      userId: USER,
      companySelector: COMPANY,
      requestId: "req-1",
    });
    const second = voiceSocketEvents(shared, {
      userId: "user-2",
      companySelector: OTHER_COMPANY,
      requestId: "req-2",
    });
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
    const events = voiceSocketEvents(runtime(), {
      userId: USER,
      companySelector: COMPANY,
      requestId: "req-1",
    });
    const socket = fakeSocket();

    events.onOpen?.(new Event("open"), socket.ws);
    events.onMessage?.(
      new MessageEvent("message", { data: new Blob([]) }),
      socket.ws,
    );

    expect(socket.closed).toEqual([VOICE_CLOSE_CODE.badFrame]);
  });

  it("sends the client the frame and session bounds when the socket opens", () => {
    const events = voiceSocketEvents(runtime(), {
      userId: USER,
      companySelector: COMPANY,
      requestId: "req-1",
    });
    const socket = fakeSocket();

    events.onOpen?.(new Event("open"), socket.ws);

    expect(JSON.parse(socket.sent[0] ?? "null")).toEqual({
      type: "ready",
      sampleRateHz: 16_000,
      maxFrameBytes: 32_000,
      maxSessionMs: 15_000,
    });
  });
});
