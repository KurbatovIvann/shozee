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

const audio = {
  granted: true,
  startFails: false,
  stops: 0,
  onBuffer: null as ((buffer: Captured) => void) | null,
};

vi.mock("expo-audio", () => ({
  requestRecordingPermissionsAsync: () =>
    Promise.resolve({ granted: audio.granted }),
  setAudioModeAsync: () => Promise.resolve(),
  useAudioStream: (options: {
    readonly onBuffer?: (buffer: Captured) => void;
  }) => {
    audio.onBuffer = options.onBuffer ?? null;
    return {
      isStreaming: false,
      stream: {
        start: () =>
          audio.startFails
            ? Promise.reject(new Error("start failed"))
            : Promise.resolve(),
        stop: () => {
          audio.stops += 1;
        },
      },
    };
  },
}));

import { useVoiceCapture, type VoiceCapture } from "./use-voice-capture";
import {
  VOICE_MAX_SESSION_MS,
  VOICE_SAMPLE_RATE_HZ,
  VOICE_STOP_FRAME,
} from "./voice-protocol";
import type {
  VoiceWebSocketFactory,
  VoiceWebSocketListener,
} from "./voice-socket";

const READY = JSON.stringify({
  type: "ready",
  sampleRateHz: VOICE_SAMPLE_RATE_HZ,
  maxFrameBytes: 32_000,
  maxTotalBytes: 480_000,
  maxSessionMs: VOICE_MAX_SESSION_MS,
});

function frame(sampleRate = VOICE_SAMPLE_RATE_HZ, channels = 1): Captured {
  return { data: new ArrayBuffer(3_200), sampleRate, channels, timestamp: 0 };
}

let roots: Root[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  audio.granted = true;
  audio.startFails = false;
  audio.stops = 0;
  audio.onBuffer = null;
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

  return { capture, wire, sent, binary };
}

async function listening() {
  const view = mount();
  act(() => {
    view.capture().start();
  });
  await flush();
  act(() => {
    view.wire().onText(READY);
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

  it("asks the server to finish when the speaker stops", async () => {
    const view = await listening();

    act(() => {
      view.capture().stop();
    });

    expect(view.sent).toContain(VOICE_STOP_FRAME);
  });

  it("stops itself at the session cap", async () => {
    const view = await listening();

    act(() => {
      vi.advanceTimersByTime(VOICE_MAX_SESSION_MS);
    });

    expect(view.sent).toContain(VOICE_STOP_FRAME);
  });

  it("fails when the hardware ignores the requested format", async () => {
    const view = await listening();

    act(() => {
      audio.onBuffer?.(frame(48_000));
    });

    expect(view.capture()).toMatchObject({ status: "error", failure: "audio" });
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
    act(() => {
      view.capture().reset();
    });
    expect(view.capture()).toMatchObject({ status: "idle", transcript: null });

    act(() => {
      view.capture().start();
    });
    await flush();

    expect(view.capture().status).toBe("starting");
  });
});
