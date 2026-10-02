import { describe, expect, it } from "vitest";

import {
  parseVoiceServerMessage,
  VOICE_BYTES_PER_SAMPLE,
  VOICE_CLOSE_CODE,
  VOICE_MAX_FRAME_BYTES,
  VOICE_MAX_SESSION_MS,
  VOICE_MAX_TOTAL_BYTES,
  VOICE_SAMPLE_RATE_HZ,
  VOICE_STOP_FRAME,
} from "./assistant-voice.js";

describe("voice protocol constants", () => {
  it("budgets exactly one session of 16 kHz mono PCM16", () => {
    expect(VOICE_MAX_TOTAL_BYTES).toBe(480_000);
    expect(VOICE_MAX_TOTAL_BYTES).toBe(
      (VOICE_MAX_SESSION_MS / 1000) *
        VOICE_SAMPLE_RATE_HZ *
        VOICE_BYTES_PER_SAMPLE,
    );
  });

  it("keeps a frame a whole number of samples and well under the budget", () => {
    expect(VOICE_MAX_FRAME_BYTES % VOICE_BYTES_PER_SAMPLE).toBe(0);
    expect(VOICE_MAX_FRAME_BYTES).toBeLessThan(VOICE_MAX_TOTAL_BYTES);
  });

  it("gives every close reason its own code", () => {
    const codes = Object.values(VOICE_CLOSE_CODE);

    expect(new Set(codes).size).toBe(codes.length);
    expect(VOICE_CLOSE_CODE.done).toBe(1000);
  });

  it("keeps the control frame distinguishable from audio", () => {
    expect(VOICE_STOP_FRAME).toBe("stop");
  });
});

describe("parseVoiceServerMessage", () => {
  it("reads the three server events", () => {
    expect(
      parseVoiceServerMessage(
        JSON.stringify({
          type: "ready",
          sampleRateHz: VOICE_SAMPLE_RATE_HZ,
          maxFrameBytes: VOICE_MAX_FRAME_BYTES,
          maxTotalBytes: VOICE_MAX_TOTAL_BYTES,
          maxSessionMs: VOICE_MAX_SESSION_MS,
        }),
      ),
    ).toMatchObject({ type: "ready", sampleRateHz: VOICE_SAMPLE_RATE_HZ });
    expect(
      parseVoiceServerMessage(JSON.stringify({ type: "partial", text: "дві" })),
    ).toEqual({ type: "partial", text: "дві" });
    expect(
      parseVoiceServerMessage(
        JSON.stringify({ type: "final", text: "дві", endedBy: "limit" }),
      ),
    ).toEqual({ type: "final", text: "дві", endedBy: "limit" });
  });

  it("refuses anything that is not one of them", () => {
    expect(parseVoiceServerMessage("not json")).toBeNull();
    expect(
      parseVoiceServerMessage(JSON.stringify({ type: "hello" })),
    ).toBeNull();
    expect(
      parseVoiceServerMessage(
        JSON.stringify({ type: "final", text: "дві", endedBy: "server" }),
      ),
    ).toBeNull();
    expect(
      parseVoiceServerMessage(JSON.stringify({ type: "partial" })),
    ).toBeNull();
    expect(
      parseVoiceServerMessage(JSON.stringify(VOICE_STOP_FRAME)),
    ).toBeNull();
  });
});
