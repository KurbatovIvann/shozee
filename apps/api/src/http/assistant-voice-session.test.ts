import { pino, type Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  VoiceRecognitionEvents,
  VoiceRecognitionStream,
  VoiceRecognizer,
} from "./assistant-voice-recognizer.js";
import {
  startVoiceSession,
  VOICE_CLOSE_CODE,
  VOICE_MAX_FRAME_BYTES,
  VOICE_MAX_SESSION_MS,
  type VoiceSession,
} from "./assistant-voice-session.js";

interface FakeRecognizer extends VoiceRecognizer {
  readonly written: Buffer[];
  readonly calls: { finished: number; aborted: number };
  emit: VoiceRecognitionEvents;
}

function fakeRecognizer(): FakeRecognizer {
  const written: Buffer[] = [];
  const calls = { finished: 0, aborted: 0 };
  let events: VoiceRecognitionEvents | undefined;
  return {
    written,
    calls,
    emit: {
      partial: (text) => events?.partial(text),
      final: (text) => events?.final(text),
      failed: (code) => events?.failed(code),
    },
    start(bound): VoiceRecognitionStream {
      events = bound;
      return {
        write: (pcm) => {
          written.push(pcm);
        },
        finish: () => {
          calls.finished += 1;
        },
        abort: () => {
          calls.aborted += 1;
        },
      };
    },
    close: () => Promise.resolve(),
  };
}

interface FakeSocket {
  readonly sent: unknown[];
  readonly closed: { code: number; reason: string | undefined }[];
}

function silentLogger(): Logger {
  return pino({ level: "silent" });
}

function startSession(
  recognizer: VoiceRecognizer,
  maxSessionMs = VOICE_MAX_SESSION_MS,
): { session: VoiceSession; socket: FakeSocket } {
  const sent: unknown[] = [];
  const closed: { code: number; reason: string | undefined }[] = [];
  const session = startVoiceSession({
    recognizer,
    logger: silentLogger(),
    maxSessionMs,
    caller: {
      userId: "user-1",
      companySelector: "11111111-1111-4111-8111-1111111111aa",
      requestId: "req-1",
    },
    socket: {
      send: (payload) => {
        sent.push(JSON.parse(payload));
      },
      close: (code, reason) => {
        closed.push({ code, reason });
      },
    },
  });
  return { session, socket: { sent, closed } };
}

function pcm(bytes: number): Buffer {
  return Buffer.alloc(bytes);
}

describe("voice session", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("streams partials and answers stop with the final transcript", () => {
    const recognizer = fakeRecognizer();
    const { session, socket } = startSession(recognizer);

    expect(socket.sent[0]).toEqual({
      type: "ready",
      sampleRateHz: 16_000,
      maxFrameBytes: VOICE_MAX_FRAME_BYTES,
      maxSessionMs: VOICE_MAX_SESSION_MS,
    });

    session.audio(pcm(640));
    recognizer.emit.partial("дві");
    session.audio(pcm(640));
    recognizer.emit.partial("дві пачки");
    session.control(JSON.stringify({ type: "stop" }));

    expect(recognizer.written).toHaveLength(2);
    expect(recognizer.calls.finished).toBe(1);

    recognizer.emit.final("дві пачки кави");

    expect(socket.sent.slice(1)).toEqual([
      { type: "partial", text: "дві" },
      { type: "partial", text: "дві пачки" },
      { type: "final", text: "дві пачки кави", endedBy: "client" },
    ]);
    expect(socket.closed).toEqual([
      { code: VOICE_CLOSE_CODE.done, reason: "final" },
    ]);
  });

  it("ends the utterance at the 15 s cap and still delivers the final", () => {
    const recognizer = fakeRecognizer();
    const { session, socket } = startSession(recognizer);

    session.audio(pcm(640));
    vi.advanceTimersByTime(VOICE_MAX_SESSION_MS);

    expect(recognizer.calls.finished).toBe(1);

    session.audio(pcm(640));
    expect(recognizer.written).toHaveLength(1);

    recognizer.emit.final("дві пачки кави");

    expect(socket.sent.at(-1)).toEqual({
      type: "final",
      text: "дві пачки кави",
      endedBy: "limit",
    });
    expect(socket.closed).toEqual([
      { code: VOICE_CLOSE_CODE.done, reason: "final" },
    ]);
  });

  it("refuses a frame over the cap without forwarding it", () => {
    const recognizer = fakeRecognizer();
    const { session, socket } = startSession(recognizer);

    session.audio(pcm(VOICE_MAX_FRAME_BYTES + 2));

    expect(recognizer.written).toHaveLength(0);
    expect(recognizer.calls.aborted).toBe(1);
    expect(socket.closed).toEqual([
      { code: VOICE_CLOSE_CODE.badFrame, reason: "frame-too-large" },
    ]);
  });

  it("refuses audio that is not whole 16-bit samples", () => {
    const recognizer = fakeRecognizer();
    const { session, socket } = startSession(recognizer);

    session.audio(pcm(641));

    expect(recognizer.written).toHaveLength(0);
    expect(socket.closed).toEqual([
      { code: VOICE_CLOSE_CODE.badFrame, reason: "not-pcm16" },
    ]);
  });

  it("refuses an unknown control frame", () => {
    const recognizer = fakeRecognizer();
    const { session, socket } = startSession(recognizer);

    session.control(JSON.stringify({ type: "configure", model: "other" }));

    expect(recognizer.calls.finished).toBe(0);
    expect(socket.closed).toEqual([
      { code: VOICE_CLOSE_CODE.badFrame, reason: "unknown-command" },
    ]);
  });

  it("closes with the recognizer code and sends no transcript when Chirp fails", () => {
    const recognizer = fakeRecognizer();
    const { session, socket } = startSession(recognizer);

    session.audio(pcm(640));
    recognizer.emit.failed("UNAVAILABLE");

    expect(socket.closed).toEqual([
      { code: VOICE_CLOSE_CODE.recognizerFailed, reason: "UNAVAILABLE" },
    ]);
    expect(
      socket.sent.filter(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "final",
      ),
    ).toHaveLength(0);
  });

  it("aborts the recognition stream and goes quiet when the socket drops", () => {
    const recognizer = fakeRecognizer();
    const { session, socket } = startSession(recognizer);
    const sentBefore = socket.sent.length;

    session.abandon();
    session.audio(pcm(640));
    recognizer.emit.partial("дві");

    expect(recognizer.calls.aborted).toBe(1);
    expect(recognizer.written).toHaveLength(0);
    expect(socket.sent).toHaveLength(sentBefore);
    expect(socket.closed).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
