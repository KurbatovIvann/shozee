import {
  VOICE_MAX_SESSION_MS,
  type VoiceUtteranceEnd,
} from "@showzy/validation/assistant-voice";

export type VoiceCaptureStatus =
  | "idle"
  | "requesting"
  | "denied"
  | "starting"
  | "listening"
  | "recognizing"
  | "error";

export type VoiceCaptureFailure =
  "audio" | "format" | "busy" | "protocol" | "recognizer" | "network";

export interface VoiceCaptureState {
  readonly status: VoiceCaptureStatus;
  readonly partial: string;
  readonly transcript: string | null;
  readonly endedBy: VoiceUtteranceEnd | null;
  readonly failure: VoiceCaptureFailure | null;
  readonly sessionMs: number;
}

export type VoiceCaptureEvent =
  | { readonly type: "requested" }
  | { readonly type: "permissionDenied" }
  | { readonly type: "permissionGranted" }
  | { readonly type: "ready"; readonly sessionMs: number }
  | { readonly type: "partial"; readonly text: string }
  | {
      readonly type: "final";
      readonly text: string;
      readonly endedBy: VoiceUtteranceEnd;
    }
  | { readonly type: "failed"; readonly failure: VoiceCaptureFailure }
  | { readonly type: "backgrounded" }
  | { readonly type: "reset" };

export const initialVoiceCaptureState: VoiceCaptureState = {
  status: "idle",
  partial: "",
  transcript: null,
  endedBy: null,
  failure: null,
  sessionMs: VOICE_MAX_SESSION_MS,
};

const ACTIVE_STATUSES: readonly VoiceCaptureStatus[] = [
  "requesting",
  "starting",
  "listening",
  "recognizing",
];

export function voiceCaptureActive(status: VoiceCaptureStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

export function voiceCaptureReducer(
  state: VoiceCaptureState,
  event: VoiceCaptureEvent,
): VoiceCaptureState {
  switch (event.type) {
    case "requested":
      return voiceCaptureActive(state.status)
        ? state
        : { ...initialVoiceCaptureState, status: "requesting" };
    case "permissionDenied":
      return state.status === "requesting"
        ? { ...initialVoiceCaptureState, status: "denied" }
        : state;
    case "permissionGranted":
      return state.status === "requesting"
        ? { ...state, status: "starting" }
        : state;
    case "ready":
      return state.status === "starting"
        ? { ...state, status: "listening", sessionMs: event.sessionMs }
        : state;
    case "partial":
      return state.status === "listening" || state.status === "recognizing"
        ? { ...state, status: "recognizing", partial: event.text }
        : state;
    case "final":
      return voiceCaptureActive(state.status)
        ? {
            ...initialVoiceCaptureState,
            transcript: event.text,
            endedBy: event.endedBy,
          }
        : state;
    case "failed":
      return voiceCaptureActive(state.status)
        ? {
            ...initialVoiceCaptureState,
            status: "error",
            failure: event.failure,
          }
        : state;
    case "backgrounded":
      return voiceCaptureActive(state.status)
        ? initialVoiceCaptureState
        : state;
    case "reset":
      return initialVoiceCaptureState;
  }
}
