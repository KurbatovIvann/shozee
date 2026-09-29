export const INT16_BYTES_PER_SAMPLE = 2;
export const GAP_TOLERANCE_MS = 5;

export type ProbeBuffer = {
  readonly byteLength: number;
  readonly sampleRate: number;
  readonly channels: number;
  readonly timestamp: number;
};

export type ProbeGap = {
  readonly atSeconds: number;
  readonly missingMs: number;
};

export type ProbeState = {
  readonly startedAtMs: number;
  readonly buffers: number;
  readonly ignored: number;
  readonly bytes: number;
  readonly frames: number;
  readonly sampleRate: number | null;
  readonly channels: number | null;
  readonly firstBufferAtMs: number | null;
  readonly lastBufferAtMs: number | null;
  readonly expectedTimestamp: number | null;
  readonly gaps: readonly ProbeGap[];
  readonly overlaps: number;
  readonly minIntervalMs: number | null;
  readonly maxIntervalMs: number | null;
};

export type ProbeSummary = ProbeState & {
  readonly capturedMs: number;
  readonly elapsedMs: number;
  readonly startLatencyMs: number | null;
  readonly meanBufferMs: number | null;
  readonly meanBufferBytes: number | null;
  readonly gapCount: number;
  readonly missingMs: number;
  readonly coverage: number | null;
};

export function createProbeState(startedAtMs: number): ProbeState {
  return {
    startedAtMs,
    buffers: 0,
    ignored: 0,
    bytes: 0,
    frames: 0,
    sampleRate: null,
    channels: null,
    firstBufferAtMs: null,
    lastBufferAtMs: null,
    expectedTimestamp: null,
    gaps: [],
    overlaps: 0,
    minIntervalMs: null,
    maxIntervalMs: null,
  };
}

export function bufferFrames(buffer: ProbeBuffer): number | null {
  const { byteLength, sampleRate, channels, timestamp } = buffer;
  const usable =
    byteLength > 0 &&
    sampleRate > 0 &&
    Number.isInteger(channels) &&
    channels > 0 &&
    Number.isFinite(timestamp);
  return usable ? byteLength / (INT16_BYTES_PER_SAMPLE * channels) : null;
}

export function framesToMs(frames: number, sampleRate: number): number {
  return (frames / sampleRate) * 1000;
}

export function recordBuffer(
  state: ProbeState,
  buffer: ProbeBuffer,
  receivedAtMs: number,
): ProbeState {
  const frames = bufferFrames(buffer);
  if (frames === null) {
    return { ...state, ignored: state.ignored + 1 };
  }

  const driftMs =
    state.expectedTimestamp === null
      ? 0
      : (buffer.timestamp - state.expectedTimestamp) * 1000;
  const intervalMs =
    state.lastBufferAtMs === null ? null : receivedAtMs - state.lastBufferAtMs;

  return {
    ...state,
    buffers: state.buffers + 1,
    bytes: state.bytes + buffer.byteLength,
    frames: state.frames + frames,
    sampleRate: buffer.sampleRate,
    channels: buffer.channels,
    firstBufferAtMs: state.firstBufferAtMs ?? receivedAtMs,
    lastBufferAtMs: receivedAtMs,
    expectedTimestamp:
      buffer.timestamp + framesToMs(frames, buffer.sampleRate) / 1000,
    gaps:
      driftMs > GAP_TOLERANCE_MS
        ? [...state.gaps, { atSeconds: buffer.timestamp, missingMs: driftMs }]
        : state.gaps,
    overlaps: driftMs < -GAP_TOLERANCE_MS ? state.overlaps + 1 : state.overlaps,
    minIntervalMs: extend(state.minIntervalMs, intervalMs, Math.min),
    maxIntervalMs: extend(state.maxIntervalMs, intervalMs, Math.max),
  };
}

export function summarizeProbe(state: ProbeState, nowMs: number): ProbeSummary {
  const capturedMs =
    state.sampleRate === null ? 0 : framesToMs(state.frames, state.sampleRate);
  const elapsedMs =
    state.firstBufferAtMs === null ? 0 : nowMs - state.firstBufferAtMs;

  return {
    ...state,
    capturedMs,
    elapsedMs,
    startLatencyMs:
      state.firstBufferAtMs === null
        ? null
        : state.firstBufferAtMs - state.startedAtMs,
    meanBufferMs: state.buffers === 0 ? null : capturedMs / state.buffers,
    meanBufferBytes: state.buffers === 0 ? null : state.bytes / state.buffers,
    gapCount: state.gaps.length,
    missingMs: state.gaps.reduce((total, gap) => total + gap.missingMs, 0),
    coverage: elapsedMs <= 0 ? null : capturedMs / elapsedMs,
  };
}

function extend(
  current: number | null,
  candidate: number | null,
  pick: (a: number, b: number) => number,
) {
  if (candidate === null) return current;
  return current === null ? candidate : pick(current, candidate);
}
