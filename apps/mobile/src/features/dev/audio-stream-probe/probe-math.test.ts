import { describe, expect, it } from "vitest";

import {
  bufferFrames,
  createProbeState,
  framesToMs,
  recordBuffer,
  summarizeProbe,
  type ProbeBuffer,
  type ProbeState,
} from "./probe-math";

const FRAME_BYTES = 3200;
const FRAME_MS = 100;

function frame(
  index: number,
  overrides: Partial<ProbeBuffer> = {},
): ProbeBuffer {
  return {
    byteLength: FRAME_BYTES,
    sampleRate: 16000,
    channels: 1,
    timestamp: (index * FRAME_MS) / 1000,
    ...overrides,
  };
}

function captureContiguous(count: number, startedAtMs = 1000): ProbeState {
  let state = createProbeState(startedAtMs);
  for (let index = 0; index < count; index += 1) {
    state = recordBuffer(
      state,
      frame(index),
      startedAtMs + 120 + index * FRAME_MS,
    );
  }
  return state;
}

describe("buffer geometry", () => {
  it("derives frames from int16 mono byte length", () => {
    expect(bufferFrames(frame(0))).toBe(1600);
  });

  it("halves the frame count for interleaved stereo", () => {
    expect(bufferFrames(frame(0, { channels: 2 }))).toBe(800);
  });

  it("converts frames to milliseconds at the reported rate", () => {
    expect(framesToMs(1600, 16000)).toBe(100);
    expect(framesToMs(1600, 48000)).toBeCloseTo(33.333, 3);
  });
});

describe("measurable buffers", () => {
  it("rejects empty, zero-rate and zero-channel buffers", () => {
    expect(bufferFrames(frame(0, { byteLength: 0 }))).toBeNull();
    expect(bufferFrames(frame(0, { sampleRate: 0 }))).toBeNull();
    expect(bufferFrames(frame(0, { channels: 0 }))).toBeNull();
    expect(bufferFrames(frame(0, { timestamp: Number.NaN }))).toBeNull();
  });

  it("counts an unusable buffer without polluting the measurements", () => {
    const state = recordBuffer(
      captureContiguous(2),
      frame(2, { byteLength: 0 }),
      1400,
    );

    expect(state.ignored).toBe(1);
    expect(state.buffers).toBe(2);
    expect(state.bytes).toBe(FRAME_BYTES * 2);
  });
});

describe("contiguous capture", () => {
  it("reports no gaps and full coverage over 30 seconds", () => {
    const state = captureContiguous(300);
    const summary = summarizeProbe(state, 1120 + 300 * FRAME_MS);

    expect(summary.buffers).toBe(300);
    expect(summary.gapCount).toBe(0);
    expect(summary.overlaps).toBe(0);
    expect(summary.capturedMs).toBe(30_000);
    expect(summary.coverage).toBeCloseTo(1, 5);
    expect(summary.meanBufferMs).toBe(FRAME_MS);
    expect(summary.meanBufferBytes).toBe(FRAME_BYTES);
  });

  it("measures start latency from the start request to the first buffer", () => {
    const summary = summarizeProbe(captureContiguous(3), 1420);

    expect(summary.startLatencyMs).toBe(120);
  });

  it("tracks the slowest and fastest arrival intervals", () => {
    let state = createProbeState(0);
    state = recordBuffer(state, frame(0), 100);
    state = recordBuffer(state, frame(1), 260);
    state = recordBuffer(state, frame(2), 300);
    const summary = summarizeProbe(state, 300);

    expect(summary.minIntervalMs).toBe(40);
    expect(summary.maxIntervalMs).toBe(160);
  });
});

describe("gap detection", () => {
  it("records a dropped buffer as missing audio time", () => {
    let state = captureContiguous(2);
    state = recordBuffer(state, frame(3), 1420);
    const summary = summarizeProbe(state, 1520);

    expect(summary.gapCount).toBe(1);
    expect(summary.missingMs).toBeCloseTo(FRAME_MS, 6);
    expect(summary.coverage).toBeLessThan(1);
  });

  it("tolerates sub-millisecond timestamp jitter", () => {
    let state = createProbeState(0);
    state = recordBuffer(state, frame(0), 0);
    state = recordBuffer(state, frame(1, { timestamp: 0.1004 }), 100);

    expect(summarizeProbe(state, 200).gapCount).toBe(0);
  });

  it("counts a backwards timestamp as an overlap, not a gap", () => {
    let state = createProbeState(0);
    state = recordBuffer(state, frame(0), 0);
    state = recordBuffer(state, frame(1, { timestamp: 0.05 }), 100);
    const summary = summarizeProbe(state, 200);

    expect(summary.overlaps).toBe(1);
    expect(summary.gapCount).toBe(0);
  });
});

describe("hardware rate other than the request", () => {
  it("uses the reported rate for duration, not the requested one", () => {
    let state = createProbeState(0);
    state = recordBuffer(state, frame(0, { sampleRate: 48000 }), 0);
    const summary = summarizeProbe(state, 40);

    expect(summary.sampleRate).toBe(48000);
    expect(summary.capturedMs).toBeCloseTo(33.333, 3);
  });
});

describe("empty capture", () => {
  it("summarizes a stream that produced nothing", () => {
    const summary = summarizeProbe(createProbeState(500), 3000);

    expect(summary.buffers).toBe(0);
    expect(summary.capturedMs).toBe(0);
    expect(summary.elapsedMs).toBe(0);
    expect(summary.startLatencyMs).toBeNull();
    expect(summary.coverage).toBeNull();
  });
});
