import { describe, expect, it } from "vitest";
import { VOICE_MAX_SESSION_MS } from "@showzy/validation/assistant-voice";

import {
  rememberSpoken,
  voiceAnnouncementKey,
  voiceComposerPlaceholder,
  voiceComposerValue,
  voiceFailureMessage,
  voiceMicActive,
  voiceMicMode,
  voiceRemainingSeconds,
  voiceRingMotion,
  voiceRingOpacity,
  voiceRingScale,
  voiceRowSpoken,
  VOICE_RING_FULL_LEVEL,
  VOICE_RING_PEAK_OPACITY,
  VOICE_RING_PEAK_SCALE,
  VOICE_RING_REST_SCALE,
  VOICE_SPOKEN_MEMORY,
} from "./voice-composer";

const PLACEHOLDERS = {
  listening: "Listening…",
  recognizing: "Recognising…",
  idle: "Write a request…",
};

describe("voice mic mode", () => {
  it("maps every capture status to one mic state", () => {
    expect(voiceMicMode("idle")).toBe("idle");
    expect(voiceMicMode("requesting")).toBe("pending");
    expect(voiceMicMode("starting")).toBe("pending");
    expect(voiceMicMode("listening")).toBe("listening");
    expect(voiceMicMode("recognizing")).toBe("recognizing");
    expect(voiceMicMode("denied")).toBe("denied");
    expect(voiceMicMode("error")).toBe("error");
  });

  it("counts the three in-session states as active", () => {
    expect(voiceMicActive("pending")).toBe(true);
    expect(voiceMicActive("listening")).toBe(true);
    expect(voiceMicActive("recognizing")).toBe(true);
    expect(voiceMicActive("idle")).toBe(false);
    expect(voiceMicActive("denied")).toBe(false);
    expect(voiceMicActive("error")).toBe(false);
  });
});

describe("voice composer field", () => {
  it("shows the live partial while a session runs and the draft otherwise", () => {
    expect(
      voiceComposerValue({
        mode: "recognizing",
        partial: "two boxes",
        typed: "typed",
      }),
    ).toBe("two boxes");
    expect(
      voiceComposerValue({
        mode: "idle",
        partial: "two boxes",
        typed: "typed",
      }),
    ).toBe("typed");
    expect(
      voiceComposerValue({ mode: "denied", partial: "", typed: "typed" }),
    ).toBe("typed");
  });

  it("names the state in the placeholder", () => {
    expect(
      voiceComposerPlaceholder({ mode: "listening", ...PLACEHOLDERS }),
    ).toBe(PLACEHOLDERS.listening);
    expect(voiceComposerPlaceholder({ mode: "pending", ...PLACEHOLDERS })).toBe(
      PLACEHOLDERS.listening,
    );
    expect(
      voiceComposerPlaceholder({ mode: "recognizing", ...PLACEHOLDERS }),
    ).toBe(PLACEHOLDERS.recognizing);
    for (const mode of ["idle", "denied", "error"] as const) {
      expect(voiceComposerPlaceholder({ mode, ...PLACEHOLDERS })).toBe(
        PLACEHOLDERS.idle,
      );
    }
  });
});

describe("voice failure message", () => {
  const MESSAGES = { busy: "Зайнято", error: "Не вдалося" };

  it("names a refused handshake busy and every other failure an error", () => {
    expect(voiceFailureMessage({ failure: "busy", ...MESSAGES })).toBe(
      MESSAGES.busy,
    );
    for (const failure of [
      "network",
      "protocol",
      "recognizer",
      "audio",
      "format",
      null,
    ] as const) {
      expect(voiceFailureMessage({ failure, ...MESSAGES })).toBe(
        MESSAGES.error,
      );
    }
  });
});

describe("voice countdown", () => {
  it("counts the server's own session limit down to zero and no further", () => {
    const limit = VOICE_MAX_SESSION_MS;
    expect(voiceRemainingSeconds(0, limit)).toBe(15);
    expect(voiceRemainingSeconds(1_000, limit)).toBe(14);
    expect(voiceRemainingSeconds(14_400, limit)).toBe(1);
    expect(voiceRemainingSeconds(limit, limit)).toBe(0);
    expect(voiceRemainingSeconds(limit + 9_000, limit)).toBe(0);
    expect(voiceRemainingSeconds(-1_000, limit)).toBe(15);
    expect(voiceRemainingSeconds(0, 8_000)).toBe(8);
    expect(voiceRemainingSeconds(3_000, 8_000)).toBe(5);
  });
});

describe("voice announcements", () => {
  it("announces the session, then the result, then nothing", () => {
    expect(voiceAnnouncementKey({ mode: "listening", spokeLast: false })).toBe(
      "listening",
    );
    expect(
      voiceAnnouncementKey({ mode: "recognizing", spokeLast: false }),
    ).toBe("listening");
    expect(voiceAnnouncementKey({ mode: "idle", spokeLast: true })).toBe(
      "done",
    );
    expect(voiceAnnouncementKey({ mode: "idle", spokeLast: false })).toBe(null);
    expect(voiceAnnouncementKey({ mode: "denied", spokeLast: false })).toBe(
      null,
    );
  });
});

describe("spoken messages", () => {
  it("marks a user row whose text was dictated", () => {
    const spoken = rememberSpoken(new Set(), "  two boxes  ");
    expect(voiceRowSpoken({ role: "user", text: "two boxes", spoken })).toBe(
      true,
    );
    expect(
      voiceRowSpoken({ role: "assistant", text: "two boxes", spoken }),
    ).toBe(false);
    expect(voiceRowSpoken({ role: "user", text: "three boxes", spoken })).toBe(
      false,
    );
  });

  it("ignores empty transcripts and keeps the memory bounded", () => {
    expect(rememberSpoken(new Set(), "   ").size).toBe(0);
    let spoken: ReadonlySet<string> = new Set();
    for (let index = 0; index <= VOICE_SPOKEN_MEMORY; index += 1) {
      spoken = rememberSpoken(spoken, `said ${String(index)}`);
    }
    expect(spoken.size).toBe(VOICE_SPOKEN_MEMORY);
    expect(spoken.has("said 0")).toBe(false);
    expect(spoken.has(`said ${String(VOICE_SPOKEN_MEMORY)}`)).toBe(true);
  });
});

describe("voiceRingScale", () => {
  it("rests on silence and grows with the level", () => {
    expect(voiceRingScale(0)).toBe(VOICE_RING_REST_SCALE);
    const quiet = voiceRingScale(VOICE_RING_FULL_LEVEL / 4);
    const loud = voiceRingScale(VOICE_RING_FULL_LEVEL / 2);
    expect(quiet).toBeGreaterThan(VOICE_RING_REST_SCALE);
    expect(loud).toBeGreaterThan(quiet);
    expect(loud).toBeLessThan(VOICE_RING_PEAK_SCALE);
  });

  it("stops at the peak however loud the frame is", () => {
    expect(voiceRingScale(VOICE_RING_FULL_LEVEL)).toBe(VOICE_RING_PEAK_SCALE);
    expect(voiceRingScale(1)).toBe(VOICE_RING_PEAK_SCALE);
  });

  it("rests on a level that is not a reading", () => {
    expect(voiceRingScale(Number.NaN)).toBe(VOICE_RING_REST_SCALE);
    expect(voiceRingScale(-1)).toBe(VOICE_RING_REST_SCALE);
  });
});

describe("voiceRingOpacity", () => {
  it("fades in with the level and stops at the peak", () => {
    expect(voiceRingOpacity(0)).toBe(0);
    expect(voiceRingOpacity(VOICE_RING_FULL_LEVEL / 2)).toBeCloseTo(
      VOICE_RING_PEAK_OPACITY / 2,
      6,
    );
    expect(voiceRingOpacity(1)).toBe(VOICE_RING_PEAK_OPACITY);
    expect(voiceRingOpacity(Number.NaN)).toBe(0);
  });
});

describe("voiceRingMotion", () => {
  it("drops the scale for a reader who asked for less motion", () => {
    expect(voiceRingMotion(false)).toBe("scale");
    expect(voiceRingMotion(true)).toBe("opacity");
  });
});
