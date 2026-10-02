import { useCallback, useEffect, useReducer, useRef } from "react";
import {
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioStream,
} from "expo-audio";

import {
  initialVoiceCaptureState,
  voiceCaptureReducer,
  type VoiceCaptureFailure,
  type VoiceCaptureStatus,
} from "./voice-capture-state";
import {
  voiceFrameBytes,
  VOICE_CHANNELS,
  VOICE_ENCODING,
  VOICE_MAX_SESSION_MS,
  VOICE_SAMPLE_RATE_HZ,
  type VoiceUtteranceEnd,
} from "./voice-protocol";
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

export interface VoiceCapture {
  readonly status: VoiceCaptureStatus;
  readonly partial: string;
  readonly transcript: string | null;
  readonly endedBy: VoiceUtteranceEnd | null;
  readonly failure: VoiceCaptureFailure | null;
  readonly start: () => void;
  readonly stop: () => void;
  readonly reset: () => void;
}

async function microphoneGranted(): Promise<boolean> {
  try {
    const permission = await requestRecordingPermissionsAsync();
    return permission.granted;
  } catch {
    return false;
  }
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
  const deadlineRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const releaseRef = useRef<() => void>(() => {});
  const stopRef = useRef<() => void>(() => {});

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
        dispatch({ type: "failed", failure: "audio" });
        return;
      }
      socket.send(frame);
    },
  });

  const silence = useCallback(() => {
    if (deadlineRef.current !== null) {
      clearTimeout(deadlineRef.current);
      deadlineRef.current = null;
    }
    stream.stop();
    void setAudioModeAsync({ allowsRecording: false });
  }, [stream]);

  const release = useCallback(() => {
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
    silence();
    socketRef.current?.stop();
  }, [silence]);
  stopRef.current = stop;

  const start = useCallback(() => {
    if (capturingRef.current) {
      return;
    }
    capturingRef.current = true;
    dispatch({ type: "requested" });
    void (async () => {
      if (!(await microphoneGranted())) {
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
        socketRef.current = openVoiceSocket({
          apiUrl: requestRef.current.apiUrl,
          getCookie: requestRef.current.getCookie,
          getCompanyId: requestRef.current.getCompanyId,
          createSocket: requestRef.current.createSocket,
          handlers: {
            onReady: () => {
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
        deadlineRef.current = setTimeout(() => {
          stopRef.current();
        }, VOICE_MAX_SESSION_MS);
        await stream.start();
      } catch {
        releaseRef.current();
        dispatch({ type: "failed", failure: "audio" });
      }
    })();
  }, [stream]);

  const reset = useCallback(() => {
    releaseRef.current();
    dispatch({ type: "reset" });
  }, []);

  useEffect(
    () => () => {
      releaseRef.current();
    },
    [],
  );

  return {
    status: state.status,
    partial: state.partial,
    transcript: state.transcript,
    endedBy: state.endedBy,
    failure: state.failure,
    start,
    stop,
    reset,
  };
}
