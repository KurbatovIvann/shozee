import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Platform } from "react-native";
import {
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioStream,
} from "expo-audio";

import {
  createProbeState,
  recordBuffer,
  summarizeProbe,
  type ProbeState,
  type ProbeSummary,
} from "./probe-math";
import { formatProbeReport, type ProbeRequest } from "./probe-report";

export const PROBE_REQUEST: ProbeRequest = {
  sampleRate: 16000,
  channels: 1,
  encoding: "int16",
};

const SNAPSHOT_INTERVAL_MS = 250;

export function useAudioStreamProbe(): {
  readonly running: boolean;
  readonly report: string;
  readonly start: () => void;
  readonly stop: () => void;
} {
  const stateRef = useRef<ProbeState | null>(null);
  const [running, setRunning] = useState(false);
  const [permission, setPermission] = useState("not requested");
  const [startError, setStartError] = useState<string | null>(null);
  const [summary, setSummary] = useState<ProbeSummary | null>(null);
  const [appStateEvents, setAppStateEvents] = useState<readonly string[]>([]);

  const { stream, isStreaming } = useAudioStream({
    sampleRate: PROBE_REQUEST.sampleRate,
    channels: PROBE_REQUEST.channels,
    encoding: "int16",
    onBuffer: (buffer) => {
      const current = stateRef.current;
      if (current === null) return;
      stateRef.current = recordBuffer(
        current,
        {
          byteLength: buffer.data.byteLength,
          sampleRate: buffer.sampleRate,
          channels: buffer.channels,
          timestamp: buffer.timestamp,
        },
        Date.now(),
      );
    },
  });

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      const current = stateRef.current;
      if (current !== null) setSummary(summarizeProbe(current, Date.now()));
    }, SNAPSHOT_INTERVAL_MS);
    const subscription = AppState.addEventListener("change", (next) => {
      const startedAtMs = stateRef.current?.startedAtMs ?? Date.now();
      setAppStateEvents((events) => [
        ...events,
        `${next} @ ${String(Date.now() - startedAtMs)} ms`,
      ]);
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, [running]);

  const start = useCallback(() => {
    void (async () => {
      setStartError(null);
      setSummary(null);
      setAppStateEvents([]);

      const response = await requestRecordingPermissionsAsync();
      setPermission(response.status);
      if (!response.granted) {
        stateRef.current = null;
        return;
      }

      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
      });
      stateRef.current = createProbeState(Date.now());
      setRunning(true);
      try {
        await stream.start();
      } catch (error) {
        stateRef.current = null;
        setRunning(false);
        setStartError(
          error instanceof Error ? error.message : "stream.start() failed",
        );
      }
    })();
  }, [stream]);

  const stop = useCallback(() => {
    stream.stop();
    setRunning(false);
    const current = stateRef.current;
    if (current !== null) setSummary(summarizeProbe(current, Date.now()));
    void setAudioModeAsync({ allowsRecording: false });
  }, [stream]);

  return {
    running,
    report: formatProbeReport({
      platform: `${Platform.OS} ${String(Platform.Version)}`,
      request: PROBE_REQUEST,
      permission,
      isStreaming,
      startError,
      appStateEvents,
      summary,
    }),
    start,
    stop,
  };
}
