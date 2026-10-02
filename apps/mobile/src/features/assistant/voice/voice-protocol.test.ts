import { describe, expect, it } from "vitest";

import { voiceFrameLevel } from "./voice-protocol";

function pcm(samples: readonly number[]): ArrayBuffer {
  return Int16Array.from(samples).buffer;
}

describe("voice frame level", () => {
  it("is zero for silence and for an empty frame", () => {
    expect(voiceFrameLevel(pcm([0, 0, 0, 0]))).toBe(0);
    expect(voiceFrameLevel(new ArrayBuffer(0))).toBe(0);
  });

  it("rises with loudness and clamps at one", () => {
    const quiet = voiceFrameLevel(pcm([400, -400, 400, -400]));
    const loud = voiceFrameLevel(pcm([6_000, -6_000, 6_000, -6_000]));
    expect(quiet).toBeGreaterThan(0);
    expect(loud).toBeGreaterThan(quiet);
    expect(voiceFrameLevel(pcm([32_000, -32_000, 32_000]))).toBe(1);
  });
});
