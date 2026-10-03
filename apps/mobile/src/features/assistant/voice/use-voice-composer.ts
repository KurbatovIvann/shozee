import { useCallback, useEffect, useRef, useState } from "react";

import type { AssistantKitCall } from "../api/assistant-kit-client";
import { useVoiceCapture } from "./use-voice-capture";
import type { VoiceCaptureFailure } from "./voice-capture-state";
import {
  rememberSpoken,
  voiceMicActive,
  voiceMicMode,
  voiceSpokenKey,
  type VoiceMicMode,
} from "./voice-composer";
import { openVoiceSettings } from "./voice-platform";
import {
  useVoiceAnnouncements,
  useVoiceCountdown,
  type VoiceComposerAnnouncements,
} from "./voice-session-chrome";
import type { VoiceWebSocketFactory } from "./voice-socket";

export interface VoiceComposerRequest {
  readonly call: AssistantKitCall | null;
  readonly send: (text: string) => Promise<boolean>;
  readonly blocked: boolean;
  readonly announcements: VoiceComposerAnnouncements;
  readonly createSocket?: VoiceWebSocketFactory | undefined;
}

export interface VoiceComposerModel {
  readonly available: boolean;
  readonly canPress: boolean;
  readonly mode: VoiceMicMode;
  readonly partial: string;
  readonly countdown: string | null;
  readonly remaining: number;
  readonly failure: VoiceCaptureFailure | null;
  readonly spoken: ReadonlySet<string>;
  readonly toggle: () => void;
  readonly retry: () => void;
  readonly openSettings: () => void;
}

export function useVoiceComposer(
  request: VoiceComposerRequest,
): VoiceComposerModel {
  const call = request.call;
  const callRef = useRef(call);
  callRef.current = call;
  const capture = useVoiceCapture({
    apiUrl: call?.apiUrl ?? "",
    getCookie: () => callRef.current?.getCookie() ?? null,
    getCompanyId: () => callRef.current?.getCompanyId() ?? null,
    createSocket: request.createSocket,
  });

  const mode = voiceMicMode(capture.status);
  const available = call !== null;
  const [spoken, setSpoken] = useState<ReadonlySet<string>>(() => new Set());
  const [spokeLast, setSpokeLast] = useState(false);

  const sendRef = useRef(request.send);
  sendRef.current = request.send;
  const resetRef = useRef(capture.reset);
  resetRef.current = capture.reset;

  const transcript = capture.transcript;
  useEffect(() => {
    if (transcript === null) {
      return;
    }
    resetRef.current();
    const text = voiceSpokenKey(transcript);
    if (text.length === 0) {
      setSpokeLast(false);
      return;
    }
    void sendRef.current(text).then((delivered) => {
      setSpokeLast(delivered);
      if (delivered) {
        setSpoken((current) => rememberSpoken(current, text));
      }
    });
  }, [transcript]);

  const { countdown, remaining } = useVoiceCountdown({
    mode,
    sessionMs: capture.sessionMs,
  });
  useVoiceAnnouncements({
    mode,
    spokeLast,
    announcements: request.announcements,
  });

  const blocked = request.blocked;
  const start = capture.start;
  const stop = capture.stop;
  const reset = capture.reset;
  const dictating = voiceMicActive(mode);
  const canPress = dictating ? mode !== "recognizing" : available && !blocked;

  const toggle = useCallback(() => {
    if (dictating) {
      stop();
      return;
    }
    if (!available || blocked) {
      return;
    }
    setSpokeLast(false);
    start();
  }, [available, blocked, dictating, start, stop]);

  const retry = useCallback(() => {
    reset();
    if (!available || blocked) {
      return;
    }
    setSpokeLast(false);
    start();
  }, [available, blocked, reset, start]);

  const openSettings = useCallback(() => {
    openVoiceSettings();
  }, []);

  return {
    available,
    canPress,
    mode,
    partial: capture.partial,
    countdown,
    remaining,
    failure: capture.failure,
    spoken,
    toggle,
    retry,
    openSettings,
  };
}
