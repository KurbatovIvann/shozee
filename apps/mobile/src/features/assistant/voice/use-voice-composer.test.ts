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
};

vi.mock("./voice-app-state", () => ({
  subscribeVoiceBackground: (listener: () => void) => {
    appState.background = listener;
    return () => undefined;
  },
}));

const audio = {
  granted: true,
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
        start: () => Promise.resolve(),
        stop: () => undefined,
      },
    };
  },
}));

const platform = {
  settings: 0,
  announced: [] as string[],
};

vi.mock("./voice-platform", () => ({
  openVoiceSettings: () => {
    platform.settings += 1;
  },
  announceVoice: (message: string) => {
    platform.announced.push(message);
  },
}));

import {
  useVoiceComposer,
  type VoiceComposerModel,
} from "./use-voice-composer";
import { VOICE_SAMPLE_RATE_HZ } from "@showzy/validation/assistant-voice";
import type {
  VoiceWebSocketFactory,
  VoiceWebSocketListener,
} from "./voice-socket";

const ANNOUNCEMENTS = { listening: "Listening", done: "Recognised" };

const SERVER_SESSION_MS = 10_000;

function ready(): string {
  return JSON.stringify({
    type: "ready",
    sampleRateHz: VOICE_SAMPLE_RATE_HZ,
    maxFrameBytes: 32_000,
    maxTotalBytes: 480_000,
    maxSessionMs: SERVER_SESSION_MS,
  });
}

let roots: Root[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  audio.granted = true;
  audio.onBuffer = null;
  appState.background = null;
  platform.settings = 0;
  platform.announced = [];
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

type Latest = { current: VoiceComposerModel | null };

function Probe(props: {
  readonly latest: Latest;
  readonly send: (text: string) => Promise<boolean>;
  readonly blocked: boolean;
  readonly createSocket: VoiceWebSocketFactory;
  readonly available: boolean;
}) {
  props.latest.current = useVoiceComposer({
    call: props.available
      ? {
          apiUrl: "https://api.showzy.test",
          getCookie: () => "session=abc",
          getCompanyId: () => "company-1",
        }
      : null,
    send: props.send,
    blocked: props.blocked,
    announcements: ANNOUNCEMENTS,
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

function mount(options?: {
  readonly blocked?: boolean;
  readonly available?: boolean;
  readonly refused?: boolean;
}) {
  const latest: Latest = { current: null };
  const sent: string[] = [];
  let listener: VoiceWebSocketListener | null = null;

  const createSocket: VoiceWebSocketFactory = (_url, _headers, events) => {
    listener = events;
    return {
      send: () => undefined,
      close: () => undefined,
    };
  };

  const root = createRoot(document.createElement("div"));
  roots.push(root);
  const render = (): void => {
    act(() => {
      root.render(
        createElement(Probe, {
          latest,
          send: (text: string) => {
            sent.push(text);
            return Promise.resolve(options?.refused !== true);
          },
          blocked: options?.blocked ?? false,
          available: options?.available ?? true,
          createSocket,
        }),
      );
    });
  };
  render();

  const model = (): VoiceComposerModel => {
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

  return { model, wire, sent, render };
}

async function listening(options?: {
  readonly blocked?: boolean;
  readonly refused?: boolean;
}) {
  const view = mount(options);
  act(() => {
    view.model().toggle();
  });
  await flush();
  act(() => {
    view.wire().onText(ready());
  });
  return view;
}

function finalText(text: string): string {
  return JSON.stringify({ type: "final", text, endedBy: "client" });
}

describe("useVoiceComposer", () => {
  it("walks idle to listening and announces it", async () => {
    const view = await listening();

    expect(view.model().mode).toBe("listening");
    expect(platform.announced).toContain(ANNOUNCEMENTS.listening);
  });

  it("shows the live transcript while recognizing", async () => {
    const view = await listening();

    act(() => {
      view.wire().onText(JSON.stringify({ type: "partial", text: "дві" }));
    });

    expect(view.model()).toMatchObject({ mode: "recognizing", partial: "дві" });
  });

  it("sends the final transcript once and remembers it was spoken", async () => {
    const view = await listening();

    act(() => {
      view.wire().onText(finalText("  дві пачки  "));
    });
    await flush();
    view.render();
    await flush();

    expect(view.sent).toEqual(["дві пачки"]);
    expect(view.model().mode).toBe("idle");
    expect([...view.model().spoken]).toEqual(["дві пачки"]);
    expect(platform.announced).toContain(ANNOUNCEMENTS.done);
  });

  it("sends a transcript the app backgrounded before the composer read it", async () => {
    const view = await listening();

    act(() => {
      view.wire().onText(finalText("дві пачки"));
      appState.background?.();
    });
    await flush();

    expect(view.sent).toEqual(["дві пачки"]);
  });

  it("counts down from the limit the server announced, not the client constant", async () => {
    const view = await listening();

    expect(view.model().countdown).toBe("0:10");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(view.model().countdown).toBe("0:08");
  });

  it("does not mark a refused transcript as spoken", async () => {
    const view = await listening({ refused: true });

    act(() => {
      view.wire().onText(finalText("дві пачки"));
    });
    await flush();
    view.render();
    await flush();

    expect(view.sent).toEqual(["дві пачки"]);
    expect([...view.model().spoken]).toEqual([]);
    expect(platform.announced).not.toContain(ANNOUNCEMENTS.done);
  });

  it("offers the settings seam when the microphone is denied", async () => {
    audio.granted = false;
    const view = mount();

    act(() => {
      view.model().toggle();
    });
    await flush();

    expect(view.model().mode).toBe("denied");
    act(() => {
      view.model().openSettings();
    });
    expect(platform.settings).toBe(1);
  });

  it("surfaces a failure and starts a new session on retry", async () => {
    const view = await listening();

    act(() => {
      view.wire().onText("{not a protocol message}");
    });
    expect(view.model()).toMatchObject({
      mode: "error",
      failure: "protocol",
    });

    act(() => {
      view.model().retry();
    });
    await flush();
    expect(view.model().mode).toBe("pending");
  });

  it("does not start while a turn is running or without a conversation", () => {
    const blocked = mount({ blocked: true });
    expect(blocked.model().canPress).toBe(false);
    act(() => {
      blocked.model().toggle();
    });
    expect(blocked.model().mode).toBe("idle");

    const offline = mount({ available: false });
    expect(offline.model()).toMatchObject({
      available: false,
      canPress: false,
    });
    act(() => {
      offline.model().toggle();
    });
    expect(offline.model().mode).toBe("idle");
  });

  it("stays pressable while listening so the speaker can stop, but not while recognizing", async () => {
    const view = await listening();
    expect(view.model().canPress).toBe(true);

    act(() => {
      view.wire().onText(JSON.stringify({ type: "partial", text: "дві" }));
    });
    expect(view.model()).toMatchObject({
      mode: "recognizing",
      canPress: false,
    });
  });
});
