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
  voiceFrameLevel,
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

describe("voiceFrameLevel", () => {
  function pcm16(samples: readonly number[]): ArrayBuffer {
    const data = new ArrayBuffer(samples.length * VOICE_BYTES_PER_SAMPLE);
    const view = new DataView(data);
    samples.forEach((sample, index) => {
      view.setInt16(index * VOICE_BYTES_PER_SAMPLE, sample, true);
    });
    return data;
  }

  it("is zero for silence and for an empty frame", () => {
    expect(voiceFrameLevel(pcm16([0, 0, 0, 0]))).toBe(0);
    expect(voiceFrameLevel(new ArrayBuffer(0))).toBe(0);
  });

  it("is the root mean square of the frame against full scale", () => {
    expect(voiceFrameLevel(pcm16([16_384, -16_384, 16_384, -16_384]))).toBe(
      0.5,
    );
    expect(voiceFrameLevel(pcm16([-32_768, -32_768]))).toBe(1);
  });

  it("reads a quiet frame below a loud one", () => {
    const quiet = voiceFrameLevel(pcm16([800, -800, 800, -800]));
    const loud = voiceFrameLevel(pcm16([9_000, -9_000, 9_000, -9_000]));
    expect(quiet).toBeGreaterThan(0);
    expect(quiet).toBeLessThan(loud);
    expect(loud).toBeLessThan(1);
  });

  it("averages over the frame rather than taking its peak", () => {
    expect(voiceFrameLevel(pcm16([32_767, 0, 0, 0]))).toBeLessThan(
      voiceFrameLevel(pcm16([32_767, 32_767, 32_767, 32_767])),
    );
  });
});
