import type { ProbeSummary } from "./probe-math";

export type ProbeRequest = {
  readonly sampleRate: number;
  readonly channels: number;
  readonly encoding: string;
};

export type ProbeReportInput = {
  readonly platform: string;
  readonly request: ProbeRequest;
  readonly permission: string;
  readonly isStreaming: boolean;
  readonly startError: string | null;
  readonly appStateEvents: readonly string[];
  readonly summary: ProbeSummary | null;
};

export function render(
  value: number | null | undefined,
  format: (present: number) => string,
): string {
  return value === null || value === undefined ? "n/a" : format(value);
}

export function formatMs(value: number | null | undefined): string {
  return render(value, (present) => `${present.toFixed(1)} ms`);
}

export function formatRatio(value: number | null | undefined): string {
  return render(value, (present) => `${(present * 100).toFixed(2)} %`);
}

export function formatProbeReport(input: ProbeReportInput): string {
  const { request, appStateEvents, summary: found } = input;
  const bytes = render(found?.meanBufferBytes, (b) => `${b.toFixed(0)} B`);
  const count = (value: number | undefined) => String(value ?? 0);

  return [
    `platform: ${input.platform}`,
    `requested: ${count(request.sampleRate)} Hz / ${count(request.channels)} ch / ${request.encoding}`,
    `permission: ${input.permission}`,
    `streaming: ${String(input.isStreaming)}`,
    `startError: ${input.startError ?? "none"}`,
    `actualRate: ${render(found?.sampleRate, (rate) => `${String(rate)} Hz`)}`,
    `actualChannels: ${render(found?.channels, (channels) => String(channels))}`,
    `buffers: ${count(found?.buffers)} (ignored ${count(found?.ignored)})`,
    `totalBytes: ${count(found?.bytes)}`,
    `meanBuffer: ${formatMs(found?.meanBufferMs)} / ${bytes}`,
    `interval: ${formatMs(found?.minIntervalMs)} … ${formatMs(found?.maxIntervalMs)}`,
    `startLatency: ${formatMs(found?.startLatencyMs)}`,
    `captured: ${formatMs(found?.capturedMs)} of ${formatMs(found?.elapsedMs)}`,
    `coverage: ${formatRatio(found?.coverage)}`,
    `gaps: ${count(found?.gapCount)} totalling ${formatMs(found?.missingMs)}`,
    `overlaps: ${count(found?.overlaps)}`,
    `appState: ${appStateEvents.length === 0 ? "none" : appStateEvents.join(", ")}`,
  ].join("\n");
}
