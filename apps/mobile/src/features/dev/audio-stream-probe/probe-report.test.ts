import { describe, expect, it } from "vitest";

import { createProbeState, recordBuffer, summarizeProbe } from "./probe-math";
import {
  formatMs,
  formatProbeReport,
  formatRatio,
  type ProbeReportInput,
} from "./probe-report";

function baseInput(): ProbeReportInput {
  return {
    platform: "android 14",
    request: { sampleRate: 16000, channels: 1, encoding: "int16" },
    permission: "granted",
    isStreaming: false,
    startError: null,
    appStateEvents: [],
    summary: null,
  };
}

function valueOf(input: ProbeReportInput, key: string): string {
  const line = formatProbeReport(input)
    .split("\n")
    .find((candidate) => candidate.startsWith(`${key}: `));
  if (line === undefined) throw new Error(`missing line ${key}`);
  return line.slice(key.length + 2);
}

describe("formatters", () => {
  it("renders a missing measurement as n/a", () => {
    expect(formatMs(null)).toBe("n/a");
    expect(formatMs(undefined)).toBe("n/a");
    expect(formatRatio(null)).toBe("n/a");
  });

  it("renders coverage as a percentage", () => {
    expect(formatRatio(0.9987)).toBe("99.87 %");
  });
});

describe("formatProbeReport", () => {
  it("reports the request and a refused permission without a capture", () => {
    const input = { ...baseInput(), permission: "denied" };

    expect(valueOf(input, "requested")).toBe("16000 Hz / 1 ch / int16");
    expect(valueOf(input, "permission")).toBe("denied");
    expect(valueOf(input, "buffers")).toBe("0 (ignored 0)");
    expect(valueOf(input, "actualRate")).toBe("n/a");
    expect(valueOf(input, "coverage")).toBe("n/a");
    expect(valueOf(input, "appState")).toBe("none");
  });

  it("reports the delivered rate, buffer size and gaps", () => {
    let state = createProbeState(0);
    state = recordBuffer(
      state,
      { byteLength: 3200, sampleRate: 16000, channels: 1, timestamp: 0 },
      100,
    );
    state = recordBuffer(
      state,
      { byteLength: 3200, sampleRate: 16000, channels: 1, timestamp: 0.2 },
      300,
    );
    const input: ProbeReportInput = {
      ...baseInput(),
      isStreaming: true,
      appStateEvents: ["background @ 1200 ms", "active @ 4100 ms"],
      summary: summarizeProbe(state, 300),
    };

    expect(valueOf(input, "actualRate")).toBe("16000 Hz");
    expect(valueOf(input, "actualChannels")).toBe("1");
    expect(valueOf(input, "meanBuffer")).toBe("100.0 ms / 3200 B");
    expect(valueOf(input, "gaps")).toBe("1 totalling 100.0 ms");
    expect(valueOf(input, "streaming")).toBe("true");
    expect(valueOf(input, "appState")).toBe(
      "background @ 1200 ms, active @ 4100 ms",
    );
  });

  it("surfaces a start failure verbatim", () => {
    const input = { ...baseInput(), startError: "AudioStream unavailable" };

    expect(valueOf(input, "startError")).toBe("AudioStream unavailable");
    expect(valueOf(input, "platform")).toBe("android 14");
  });
});
