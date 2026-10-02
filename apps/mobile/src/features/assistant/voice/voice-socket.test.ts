import { COMPANY_SELECTOR_HEADER } from "@showzy/contract";
import {
  VOICE_CLOSE_CODE,
  VOICE_FINALIZE_TIMEOUT_MS,
  VOICE_MAX_FRAME_BYTES,
  VOICE_MAX_TOTAL_BYTES,
  VOICE_SAMPLE_RATE_HZ,
  VOICE_STOP_FRAME,
  type VoiceUtteranceEnd,
} from "@showzy/validation/assistant-voice";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  openVoiceSocket,
  voiceFailureFromCloseCode,
  type VoiceSocketFailure,
  type VoiceWebSocketListener,
} from "./voice-socket";

const READY = JSON.stringify({
  type: "ready",
  sampleRateHz: VOICE_SAMPLE_RATE_HZ,
  maxFrameBytes: VOICE_MAX_FRAME_BYTES,
  maxTotalBytes: VOICE_MAX_TOTAL_BYTES,
  maxSessionMs: 15_000,
});

interface Wire {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly sent: (string | ArrayBuffer)[];
  readonly closed: number[];
  listener: VoiceWebSocketListener;
}

function harness(cookie: string | null = "session=abc") {
  const wires: Wire[] = [];
  const finals: { text: string; endedBy: VoiceUtteranceEnd }[] = [];
  const failures: VoiceSocketFailure[] = [];
  const partials: string[] = [];
  let ready = 0;

  const socket = openVoiceSocket({
    apiUrl: "https://api.showzy.test/",
    getCookie: () => cookie,
    getCompanyId: () => "company-1",
    createSocket: (url, headers, listener) => {
      const wire: Wire = { url, headers, sent: [], closed: [], listener };
      wires.push(wire);
      return {
        send: (data) => wire.sent.push(data),
        close: (code) => wire.closed.push(code ?? VOICE_CLOSE_CODE.done),
      };
    },
    handlers: {
      onReady: () => {
        ready += 1;
      },
      onPartial: (text) => partials.push(text),
      onFinal: (text, endedBy) => finals.push({ text, endedBy }),
      onFailed: (failure) => failures.push(failure),
    },
  });

  const wire = wires[0];
  if (wire === undefined) {
    throw new Error("the socket was never created");
  }
  return {
    socket,
    wire,
    finals,
    failures,
    partials,
    readyCount: () => ready,
    binary: () =>
      wire.sent.filter(
        (frame): frame is ArrayBuffer => frame !== VOICE_STOP_FRAME,
      ),
  };
}

function pcm(bytes: number): ArrayBuffer {
  return new ArrayBuffer(bytes);
}

describe("openVoiceSocket", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("connects to the voice route over ws with the staff session headers", () => {
    const { wire } = harness();

    expect(wire.url).toBe("wss://api.showzy.test/assistant/kit/voice");
    expect(wire.headers).toEqual({
      cookie: "session=abc",
      [COMPANY_SELECTOR_HEADER]: "company-1",
    });
  });

  it("holds frames captured before ready and sends them once the server is", () => {
    const run = harness();

    run.socket.send(pcm(3200));
    expect(run.binary()).toHaveLength(0);

    run.wire.listener.onText(READY);

    expect(run.readyCount()).toBe(1);
    expect(run.binary().map((frame) => frame.byteLength)).toEqual([3200]);
  });

  it("splits a buffer larger than one frame", () => {
    const run = harness();
    run.wire.listener.onText(READY);

    run.socket.send(pcm(VOICE_MAX_FRAME_BYTES * 2 + 6_000));

    expect(run.binary().map((frame) => frame.byteLength)).toEqual([
      VOICE_MAX_FRAME_BYTES,
      VOICE_MAX_FRAME_BYTES,
      6_000,
    ]);
  });

  it("stops sending at the audio budget", () => {
    const run = harness();
    run.wire.listener.onText(READY);

    const frames = VOICE_MAX_TOTAL_BYTES / VOICE_MAX_FRAME_BYTES;
    for (let index = 0; index < frames + 2; index += 1) {
      run.socket.send(pcm(VOICE_MAX_FRAME_BYTES));
    }

    expect(run.binary()).toHaveLength(frames);
  });

  it("reports partials and settles on the final transcript", () => {
    const run = harness();
    run.wire.listener.onText(READY);
    run.wire.listener.onText(JSON.stringify({ type: "partial", text: "дві" }));
    run.wire.listener.onText(
      JSON.stringify({ type: "final", text: "дві пачки", endedBy: "limit" }),
    );

    expect(run.partials).toEqual(["дві"]);
    expect(run.finals).toEqual([{ text: "дві пачки", endedBy: "limit" }]);
    expect(run.wire.closed).toEqual([VOICE_CLOSE_CODE.done]);
  });

  it("sends the stop control frame and ignores audio captured after it", () => {
    const run = harness();
    run.wire.listener.onText(READY);

    run.socket.stop();
    run.socket.send(pcm(3200));

    expect(run.wire.sent).toEqual([VOICE_STOP_FRAME]);
  });

  it("sends stop after ready when the speaker stopped before the server answered", () => {
    const run = harness();

    run.socket.send(pcm(3200));
    run.socket.stop();
    run.wire.listener.onText(READY);

    expect(run.wire.sent[run.wire.sent.length - 1]).toBe(VOICE_STOP_FRAME);
  });

  it("gives up when no final follows stop", () => {
    const run = harness();
    run.wire.listener.onText(READY);
    run.socket.stop();

    vi.advanceTimersByTime(VOICE_FINALIZE_TIMEOUT_MS);

    expect(run.failures).toEqual(["network"]);
  });

  it("refuses a server that is not speaking this protocol", () => {
    const run = harness();

    run.wire.listener.onText("not json");

    expect(run.failures).toEqual(["protocol"]);
  });

  it("refuses a ready that announces another sample rate", () => {
    const run = harness();

    run.wire.listener.onText(
      JSON.stringify({
        type: "ready",
        sampleRateHz: 48_000,
        maxFrameBytes: VOICE_MAX_FRAME_BYTES,
        maxTotalBytes: VOICE_MAX_TOTAL_BYTES,
        maxSessionMs: 15_000,
      }),
    );

    expect(run.failures).toEqual(["protocol"]);
  });

  it("settles when the server never answered the stop it never acknowledged", () => {
    const run = harness();

    run.socket.stop();
    vi.advanceTimersByTime(VOICE_FINALIZE_TIMEOUT_MS);

    expect(run.failures).toEqual(["network"]);
    expect(run.wire.closed).toEqual([VOICE_CLOSE_CODE.done]);
  });

  it("maps the typed close codes to causes", () => {
    expect(voiceFailureFromCloseCode(VOICE_CLOSE_CODE.done)).toBe("network");
    expect(voiceFailureFromCloseCode(VOICE_CLOSE_CODE.overloaded)).toBe("busy");
    expect(voiceFailureFromCloseCode(VOICE_CLOSE_CODE.badFrame)).toBe(
      "protocol",
    );
    expect(voiceFailureFromCloseCode(VOICE_CLOSE_CODE.recognizerFailed)).toBe(
      "recognizer",
    );
    expect(voiceFailureFromCloseCode(1006)).toBe("network");
  });

  it("turns a busy close into a busy failure", () => {
    const run = harness();

    run.wire.listener.onClose(VOICE_CLOSE_CODE.overloaded);

    expect(run.failures).toEqual(["busy"]);
    expect(run.finals).toHaveLength(0);
  });

  it("treats a close with no transcript as a lost session, however clean", () => {
    const run = harness();
    run.wire.listener.onText(READY);
    run.socket.stop();
    run.wire.listener.onClose(VOICE_CLOSE_CODE.done);

    expect(run.finals).toHaveLength(0);
    expect(run.failures).toEqual(["network"]);
  });

  it("follows the budget and frame size the server announced", () => {
    const run = harness();

    run.wire.listener.onText(
      JSON.stringify({
        type: "ready",
        sampleRateHz: VOICE_SAMPLE_RATE_HZ,
        maxFrameBytes: 1_000,
        maxTotalBytes: 2_000,
        maxSessionMs: 5_000,
      }),
    );
    run.socket.send(pcm(3_000));

    expect(run.binary().map((frame) => frame.byteLength)).toEqual([
      1_000, 1_000,
    ]);
  });

  it("reports nothing twice", () => {
    const run = harness();
    run.wire.listener.onText(READY);
    run.wire.listener.onText(
      JSON.stringify({ type: "final", text: "дві", endedBy: "client" }),
    );
    run.wire.listener.onClose(VOICE_CLOSE_CODE.overloaded);
    run.wire.listener.onError();

    expect(run.finals).toHaveLength(1);
    expect(run.failures).toHaveLength(0);
  });

  it("sends no cookie header when there is no session", () => {
    const run = harness(null);

    expect(run.wire.headers.cookie).toBeUndefined();
  });
});
