import { useCallback, useEffect, useReducer, useRef } from "react";
import {
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioStream,
} from "expo-audio";
import {
  VOICE_CHANNELS,
  VOICE_ENCODING,
  VOICE_MAX_SESSION_MS,
  VOICE_SAMPLE_RATE_HZ,
} from "@showzy/validation/assistant-voice";

import {
  initialVoiceCaptureState,
  voiceCaptureReducer,
  type VoiceCaptureState,
} from "./voice-capture-state";
import { subscribeVoiceBackground } from "./voice-app-state";
import { voiceFrameBytes, voiceFrameLevel } from "./voice-protocol";
import {
  openVoiceSocket,
  type VoiceSocket,
  type VoiceWebSocketFactory,
} from "./voice-socket";

export interface UseVoiceCaptureRequest {
  readonly apiUrl: string;
  readonly getCookie: () => string | null;
  readonly getCompanyId: () => string | null;
  readonly createSocket?: VoiceWebSocketFactory | undefined;
}

export type VoiceLevelListener = (level: number) => void;

export interface VoiceCapture extends VoiceCaptureState {
  readonly start: () => void;
  readonly stop: () => void;
  readonly reset: () => void;
  readonly onLevel: (listener: VoiceLevelListener) => () => void;
}

export function useVoiceCapture(request: UseVoiceCaptureRequest): VoiceCapture {
  const [state, dispatch] = useReducer(
    voiceCaptureReducer,
    initialVoiceCaptureState,
  );
  const requestRef = useRef(request);
  requestRef.current = request;
  const socketRef = useRef<VoiceSocket | null>(null);
  const capturingRef = useRef(false);
  const sessionRef = useRef(0);
  const deadlineRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const releaseRef = useRef<() => void>(() => {});
  const stopRef = useRef<() => void>(() => {});
  const levelListenersRef = useRef(new Set<VoiceLevelListener>());

  const emitLevel = useCallback((level: number) => {
    for (const listener of levelListenersRef.current) {
      listener(level);
    }
  }, []);

  const onLevel = useCallback((listener: VoiceLevelListener) => {
    const listeners = levelListenersRef.current;
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const { stream } = useAudioStream({
    sampleRate: VOICE_SAMPLE_RATE_HZ,
    channels: VOICE_CHANNELS,
    encoding: VOICE_ENCODING,
    onBuffer: (buffer) => {
      const socket = socketRef.current;
      if (socket === null) {
        return;
      }
      const frame = voiceFrameBytes(buffer);
      if (frame === null) {
        releaseRef.current();
        dispatch({ type: "failed", failure: "format" });
        return;
      }
      socket.send(frame);
      emitLevel(voiceFrameLevel(frame));
    },
  });

  const clearDeadline = useCallback(() => {
    if (deadlineRef.current !== null) {
      clearTimeout(deadlineRef.current);
      deadlineRef.current = null;
    }
  }, []);

  const armDeadline = useCallback(
    (sessionMs: number) => {
      clearDeadline();
      deadlineRef.current = setTimeout(() => {
        stopRef.current();
      }, sessionMs);
    },
    [clearDeadline],
  );

  const silence = useCallback(() => {
    clearDeadline();
    emitLevel(0);
    stream.stop();
    setAudioModeAsync({ allowsRecording: false }).catch(() => {
      dispatch({ type: "failed", failure: "audio" });
    });
  }, [clearDeadline, emitLevel, stream]);

  const release = useCallback(() => {
    sessionRef.current += 1;
    silence();
    capturingRef.current = false;
    const socket = socketRef.current;
    socketRef.current = null;
    socket?.close();
  }, [silence]);
  releaseRef.current = release;

  const stop = useCallback(() => {
    if (!capturingRef.current) {
      return;
    }
    sessionRef.current += 1;
    const socket = socketRef.current;
    if (socket === null) {
      release();
      dispatch({ type: "reset" });
      return;
    }
    silence();
    socket.stop();
  }, [release, silence]);
  stopRef.current = stop;

  const start = useCallback(() => {
    if (capturingRef.current) {
      return;
    }
    capturingRef.current = true;
    sessionRef.current += 1;
    const session = sessionRef.current;
    const abandoned = (): boolean => sessionRef.current !== session;
    dispatch({ type: "requested" });
    void (async () => {
      const permission = await requestRecordingPermissionsAsync().catch(() => ({
        granted: false,
      }));
      if (abandoned()) {
        return;
      }
      if (!permission.granted) {
        capturingRef.current = false;
        dispatch({ type: "permissionDenied" });
        return;
      }
      dispatch({ type: "permissionGranted" });
      try {
        await setAudioModeAsync({
          allowsRecording: true,
          playsInSilentMode: true,
        });
        if (abandoned()) {
          releaseRef.current();
          return;
        }
        socketRef.current = openVoiceSocket({
          apiUrl: requestRef.current.apiUrl,
          getCookie: requestRef.current.getCookie,
          getCompanyId: requestRef.current.getCompanyId,
          createSocket: requestRef.current.createSocket,
          handlers: {
            onReady: (limits) => {
              armDeadline(limits.maxSessionMs);
              dispatch({ type: "ready" });
            },
            onPartial: (text) => {
              dispatch({ type: "partial", text });
            },
            onFinal: (text, endedBy) => {
              releaseRef.current();
              dispatch({ type: "final", text, endedBy });
            },
            onFailed: (failure) => {
              releaseRef.current();
              dispatch({ type: "failed", failure });
            },
          },
        });
        armDeadline(VOICE_MAX_SESSION_MS);
        await stream.start();
        if (abandoned()) {
          stream.stop();
        }
      } catch {
        if (abandoned()) {
          return;
        }
        releaseRef.current();
        dispatch({ type: "failed", failure: "audio" });
      }
    })();
  }, [armDeadline, stream]);

  const reset = useCallback(() => {
    releaseRef.current();
    dispatch({ type: "reset" });
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeVoiceBackground(() => {
      releaseRef.current();
      dispatch({ type: "backgrounded" });
    });
    return () => {
      unsubscribe();
      releaseRef.current();
    };
  }, []);

  return { ...state, start, stop, reset, onLevel };
}
