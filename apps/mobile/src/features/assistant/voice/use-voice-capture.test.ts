import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "../../../auth/react-test-dom";

interface Captured {
  readonly data: ArrayBuffer;
  readonly sampleRate: number;
  readonly channels: number;
  readonly timestamp: number;
}

const appState = {
  background: null as (() => void) | null,
  unsubscribes: 0,
};

vi.mock("./voice-app-state", () => ({
  subscribeVoiceBackground: (listener: () => void) => {
    appState.background = listener;
    return () => {
      appState.unsubscribes += 1;
    };
  },
}));

const audio = {
  granted: true,
  holdPermission: false,
  audioModeFails: false,
  startFails: false,
  starts: 0,
  stops: 0,
  onBuffer: null as ((buffer: Captured) => void) | null,
  answerPermission: null as ((granted: boolean) => void) | null,
};

vi.mock("expo-audio", () => ({
  requestRecordingPermissionsAsync: () =>
    audio.holdPermission
      ? new Promise<{ granted: boolean }>((resolve) => {
          audio.answerPermission = (granted) => {
            resolve({ granted });
          };
        })
      : Promise.resolve({ granted: audio.granted }),
  setAudioModeAsync: (mode: { readonly allowsRecording: boolean }) =>
    audio.audioModeFails && !mode.allowsRecording
      ? Promise.reject(new Error("audio mode failed"))
      : Promise.resolve(),
  useAudioStream: (options: {
    readonly onBuffer?: (buffer: Captured) => void;
  }) => {
    audio.onBuffer = options.onBuffer ?? null;
    return {
      isStreaming: false,
      stream: {
        start: () => {
          audio.starts += 1;
          return audio.startFails
            ? Promise.reject(new Error("start failed"))
            : Promise.resolve();
        },
        stop: () => {
          audio.stops += 1;
        },
      },
    };
  },
}));

import { useVoiceCapture, type VoiceCapture } from "./use-voice-capture";
import {
  VOICE_FINALIZE_TIMEOUT_MS,
  VOICE_MAX_SESSION_MS,
  VOICE_SAMPLE_RATE_HZ,
  VOICE_STOP_FRAME,
} from "@showzy/validation/assistant-voice";
import type {
  VoiceWebSocketFactory,
  VoiceWebSocketListener,
} from "./voice-socket";

function ready(maxSessionMs: number = VOICE_MAX_SESSION_MS): string {
  return JSON.stringify({
    type: "ready",
    sampleRateHz: VOICE_SAMPLE_RATE_HZ,
    maxFrameBytes: 32_000,
    maxTotalBytes: 480_000,
    maxSessionMs,
  });
}

function frame(sampleRate = VOICE_SAMPLE_RATE_HZ, channels = 1): Captured {
  return { data: new ArrayBuffer(3_200), sampleRate, channels, timestamp: 0 };
}

let roots: Root[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  audio.granted = true;
  audio.holdPermission = false;
  audio.audioModeFails = false;
  audio.startFails = false;
  audio.starts = 0;
  audio.stops = 0;
  audio.onBuffer = null;
  audio.answerPermission = null;
  appState.background = null;
  appState.unsubscribes = 0;
});

afterEach(() => {
  for (const root of roots) {
    act(() => {
      root.unmount();
    });
  }
  roots = [];
  vi.useRealTimers();
});

type Latest = { current: VoiceCapture | null };

function Probe(props: {
  readonly latest: Latest;
  readonly createSocket: VoiceWebSocketFactory;
}) {
  props.latest.current = useVoiceCapture({
    apiUrl: "https://api.showzy.test",
    getCookie: () => "session=abc",
    getCompanyId: () => "company-1",
    createSocket: props.createSocket,
  });
  return null;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function mount() {
  const latest: Latest = { current: null };
  const sent: (string | ArrayBuffer)[] = [];
  let listener: VoiceWebSocketListener | null = null;

  const createSocket: VoiceWebSocketFactory = (_url, _headers, events) => {
    listener = events;
    return {
      send: (data) => sent.push(data),
      close: () => {},
    };
  };

  const root = createRoot(document.createElement("div"));
  roots.push(root);
  act(() => {
    root.render(createElement(Probe, { latest, createSocket }));
  });

  const capture = (): VoiceCapture => {
    if (latest.current === null) {
      throw new Error("the hook never ran");
    }
    return latest.current;
  };
  const wire = (): VoiceWebSocketListener => {
    if (listener === null) {
      throw new Error("no socket was opened");
    }
    return listener;
  };
  const binary = (): ArrayBuffer[] =>
    sent.filter((item): item is ArrayBuffer => item !== VOICE_STOP_FRAME);
  const unmount = (): void => {
    roots = roots.filter((item) => item !== root);
    act(() => {
      root.unmount();
    });
  };

  return { capture, wire, sent, binary, unmount };
}

async function listening(maxSessionMs?: number) {
  const view = mount();
  act(() => {
    view.capture().start();
  });
  await flush();
  act(() => {
    view.wire().onText(ready(maxSessionMs));
  });
  return view;
}

describe("useVoiceCapture", () => {
  it("lands in denied when the microphone is refused, and opens no socket", async () => {
    audio.granted = false;
    const view = mount();

    act(() => {
      view.capture().start();
    });
    await flush();

    expect(view.capture().status).toBe("denied");
    expect(() => view.wire()).toThrow();
    expect(audio.starts).toBe(0);
  });

  it("streams captured PCM to the socket once the server is ready", async () => {
    const view = await listening();

    expect(view.capture().status).toBe("listening");
    act(() => {
      audio.onBuffer?.(frame());
      audio.onBuffer?.(frame());
    });

    expect(view.binary().map((item) => item.byteLength)).toEqual([
      3_200, 3_200,
    ]);
  });

  it("shows partial text and keeps the final transcript", async () => {
    const view = await listening();

    act(() => {
      view.wire().onText(JSON.stringify({ type: "partial", text: "дві" }));
    });
    expect(view.capture()).toMatchObject({
      status: "recognizing",
      partial: "дві",
    });

    act(() => {
      view.wire().onText(
        JSON.stringify({
          type: "final",
          text: "дві пачки",
          endedBy: "client",
        }),
      );
    });

    expect(view.capture()).toMatchObject({
      status: "idle",
      transcript: "дві пачки",
      endedBy: "client",
    });
    expect(audio.stops).toBeGreaterThan(0);
  });

  it("asks the server to finish and closes the microphone when the speaker stops", async () => {
    const view = await listening();
    const stops = audio.stops;

    act(() => {
      view.capture().stop();
    });

    expect(view.sent).toContain(VOICE_STOP_FRAME);
    expect(audio.stops).toBeGreaterThan(stops);
  });

  it("gives up on a server that never says it is ready", async () => {
    const view = mount();
    act(() => {
      view.capture().start();
    });
    await flush();
    expect(view.capture().status).toBe("starting");

    act(() => {
      vi.advanceTimersByTime(VOICE_MAX_SESSION_MS + VOICE_FINALIZE_TIMEOUT_MS);
    });

    expect(view.capture()).toMatchObject({
      status: "error",
      failure: "network",
    });

    act(() => {
      view.capture().start();
    });
    await flush();
    expect(view.capture().status).toBe("starting");
  });

  it("closes the microphone when the app goes to the background", async () => {
    const view = await listening();
    const stops = audio.stops;

    act(() => {
      appState.background?.();
    });

    expect(view.capture()).toMatchObject({ status: "idle", transcript: null });
    expect(audio.stops).toBeGreaterThan(stops);

    act(() => {
      audio.onBuffer?.(frame());
    });
    expect(view.binary()).toHaveLength(0);
  });

  it("keeps a transcript the composer has not consumed when the app goes to the background", async () => {
    const view = await listening();

    act(() => {
      view.wire().onText(
        JSON.stringify({
          type: "final",
          text: "дві пачки",
          endedBy: "limit",
        }),
      );
      appState.background?.();
    });

    expect(view.capture()).toMatchObject({
      status: "idle",
      transcript: "дві пачки",
      endedBy: "limit",
    });
  });

  it("reports an audio session that will not close", async () => {
    const view = await listening();
    audio.audioModeFails = true;

    act(() => {
      view.capture().stop();
    });
    await flush();

    expect(view.capture()).toMatchObject({ status: "error", failure: "audio" });
  });

  it("stops itself at the session cap the server announced", async () => {
    const view = await listening(5_000);

    act(() => {
      vi.advanceTimersByTime(5_000);
    });

    expect(view.sent).toContain(VOICE_STOP_FRAME);
  });

  it("never opens the microphone when stop came while permission was pending", async () => {
    audio.holdPermission = true;
    const view = mount();

    act(() => {
      view.capture().start();
    });
    expect(view.capture().status).toBe("requesting");

    act(() => {
      view.capture().stop();
    });
    expect(view.capture().status).toBe("idle");

    act(() => {
      audio.answerPermission?.(true);
    });
    await flush();

    expect(audio.starts).toBe(0);
    expect(() => view.wire()).toThrow();
    expect(view.capture().status).toBe("idle");
  });

  it("closes the microphone when the screen leaves while listening", async () => {
    const view = await listening();
    const stops = audio.stops;

    view.unmount();

    expect(audio.stops).toBeGreaterThan(stops);
    expect(appState.unsubscribes).toBe(1);
  });

  it("never opens the microphone when the screen left while permission was pending", async () => {
    audio.holdPermission = true;
    const view = mount();

    act(() => {
      view.capture().start();
    });
    view.unmount();

    act(() => {
      audio.answerPermission?.(true);
    });
    await flush();

    expect(audio.starts).toBe(0);
    expect(() => view.wire()).toThrow();
  });

  it("names a device that cannot deliver the requested format", async () => {
    const view = await listening();

    act(() => {
      audio.onBuffer?.(frame(48_000));
    });

    expect(view.capture()).toMatchObject({
      status: "error",
      failure: "format",
    });
    expect(view.binary()).toHaveLength(0);
  });

  it("fails when the stream cannot start", async () => {
    audio.startFails = true;
    const view = mount();

    act(() => {
      view.capture().start();
    });
    await flush();

    expect(view.capture()).toMatchObject({ status: "error", failure: "audio" });
  });

  it("reports a busy server", async () => {
    const view = await listening();

    act(() => {
      view.wire().onClose(4429);
    });

    expect(view.capture()).toMatchObject({ status: "error", failure: "busy" });
  });

  it("can be cleared and started again", async () => {
    const view = await listening();

    act(() => {
      view
        .wire()
        .onText(
          JSON.stringify({ type: "final", text: "дві", endedBy: "client" }),
        );
    });
    const stops = audio.stops;
    act(() => {
      view.capture().reset();
    });
    expect(view.capture()).toMatchObject({ status: "idle", transcript: null });
    expect(audio.stops).toBeGreaterThan(stops);

    act(() => {
      view.capture().start();
    });
    await flush();

    expect(view.capture().status).toBe("starting");
  });
});
