import { describe, expect, it } from "vitest";
import { VOICE_MAX_SESSION_MS } from "@showzy/validation/assistant-voice";

import {
  rememberSpoken,
  voiceAnnouncementKey,
  voiceComposerPlaceholder,
  voiceComposerValue,
  voiceCountdownText,
  voiceCountdownVisible,
  voiceMicActive,
  voiceMicMode,
  voiceMicPressable,
  voiceRemainingSeconds,
  voiceRowSpoken,
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

describe("voice mic press", () => {
  it("is pressable from idle, denied and error when the thread is free", () => {
    for (const mode of ["idle", "denied", "error"] as const) {
      expect(voiceMicPressable({ mode, available: true, blocked: false })).toBe(
        true,
      );
    }
  });

  it("is not pressable without a call or while a turn runs", () => {
    expect(
      voiceMicPressable({ mode: "idle", available: false, blocked: false }),
    ).toBe(false);
    expect(
      voiceMicPressable({ mode: "idle", available: true, blocked: true }),
    ).toBe(false);
  });

  it("stays pressable while listening so the person can stop, but not while recognizing", () => {
    expect(
      voiceMicPressable({ mode: "listening", available: true, blocked: true }),
    ).toBe(true);
    expect(
      voiceMicPressable({
        mode: "recognizing",
        available: true,
        blocked: false,
      }),
    ).toBe(false);
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

describe("voice countdown", () => {
  it("shows only once the session is running", () => {
    expect(voiceCountdownVisible("listening")).toBe(true);
    expect(voiceCountdownVisible("recognizing")).toBe(true);
    expect(voiceCountdownVisible("pending")).toBe(false);
    expect(voiceCountdownVisible("idle")).toBe(false);
  });

  it("counts the session limit down to zero and no further", () => {
    expect(voiceRemainingSeconds(0)).toBe(15);
    expect(voiceRemainingSeconds(1_000)).toBe(14);
    expect(voiceRemainingSeconds(14_400)).toBe(1);
    expect(voiceRemainingSeconds(VOICE_MAX_SESSION_MS)).toBe(0);
    expect(voiceRemainingSeconds(VOICE_MAX_SESSION_MS + 9_000)).toBe(0);
    expect(voiceRemainingSeconds(-1_000)).toBe(15);
  });

  it("pads the clock", () => {
    expect(voiceCountdownText(15)).toBe("0:15");
    expect(voiceCountdownText(9)).toBe("0:09");
    expect(voiceCountdownText(0)).toBe("0:00");
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
