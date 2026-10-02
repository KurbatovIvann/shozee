import { useCallback, useEffect, useRef, useState } from "react";

import { useVoiceCapture, type VoiceLevelListener } from "./use-voice-capture";
import type { VoiceCaptureFailure } from "./voice-capture-state";
import {
  rememberSpoken,
  voiceAnnouncementKey,
  voiceCountdownText,
  voiceCountdownVisible,
  voiceMicActive,
  voiceMicMode,
  voiceRemainingSeconds,
  voiceSpokenKey,
  type VoiceAnnouncementKey,
  type VoiceMicMode,
} from "./voice-composer";
import { announceVoice, openVoiceSettings } from "./voice-platform";
import type { VoiceWebSocketFactory } from "./voice-socket";

const VOICE_TICK_MS = 250;

export interface VoiceComposerCall {
  readonly apiUrl: string;
  readonly getCookie: () => string | null;
  readonly getCompanyId: () => string | null;
}

export interface VoiceComposerAnnouncements {
  readonly listening: string;
  readonly done: string;
}

export interface VoiceComposerRequest {
  readonly call: VoiceComposerCall | null;
  readonly send: (text: string) => void;
  readonly blocked: boolean;
  readonly announcements: VoiceComposerAnnouncements;
  readonly createSocket?: VoiceWebSocketFactory | undefined;
}

export interface VoiceComposerModel {
  readonly available: boolean;
  readonly mode: VoiceMicMode;
  readonly partial: string;
  readonly countdown: string | null;
  readonly remaining: number;
  readonly failure: VoiceCaptureFailure | null;
  readonly spoken: ReadonlySet<string>;
  readonly toggle: () => void;
  readonly retry: () => void;
  readonly dismiss: () => void;
  readonly openSettings: () => void;
  readonly onLevel: (listener: VoiceLevelListener) => () => void;
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
  const announcementsRef = useRef(request.announcements);
  announcementsRef.current = request.announcements;

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
    setSpoken((current) => rememberSpoken(current, text));
    setSpokeLast(true);
    sendRef.current(text);
  }, [transcript]);

  const counting = voiceCountdownVisible(mode);
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    if (!counting) {
      setElapsedMs(0);
      return;
    }
    const startedAt = Date.now();
    const timer = setInterval(() => {
      setElapsedMs(Date.now() - startedAt);
    }, VOICE_TICK_MS);
    return () => {
      clearInterval(timer);
    };
  }, [counting]);

  const announcement = voiceAnnouncementKey({ mode, spokeLast });
  const announcedRef = useRef<VoiceAnnouncementKey>(null);
  useEffect(() => {
    if (announcedRef.current === announcement) {
      return;
    }
    announcedRef.current = announcement;
    if (announcement === null) {
      return;
    }
    announceVoice(
      announcement === "listening"
        ? announcementsRef.current.listening
        : announcementsRef.current.done,
    );
  }, [announcement]);

  const blocked = request.blocked;
  const start = capture.start;
  const stop = capture.stop;
  const reset = capture.reset;

  const toggle = useCallback(() => {
    if (voiceMicActive(mode)) {
      stop();
      return;
    }
    if (!available || blocked) {
      return;
    }
    setSpokeLast(false);
    start();
  }, [available, blocked, mode, start, stop]);

  const retry = useCallback(() => {
    reset();
    if (!available || blocked) {
      return;
    }
    setSpokeLast(false);
    start();
  }, [available, blocked, reset, start]);

  const dismiss = useCallback(() => {
    reset();
  }, [reset]);

  const openSettings = useCallback(() => {
    openVoiceSettings();
  }, []);

  const remaining = voiceRemainingSeconds(elapsedMs);

  return {
    available,
    mode,
    partial: capture.partial,
    countdown: counting ? voiceCountdownText(remaining) : null,
    remaining,
    failure: capture.failure,
    spoken,
    toggle,
    retry,
    dismiss,
    openSettings,
    onLevel: capture.onLevel,
  };
}
