import { useEffect, useRef, useState } from "react";

import {
  voiceAnnouncementKey,
  voiceRemainingSeconds,
  type VoiceAnnouncementKey,
  type VoiceMicMode,
} from "./voice-composer";
import { announceVoice } from "./voice-platform";

const VOICE_TICK_MS = 250;

export interface VoiceComposerAnnouncements {
  readonly listening: string;
  readonly done: string;
}

export interface VoiceCountdown {
  readonly countdown: string | null;
  readonly remaining: number;
}

export function useVoiceCountdown(input: {
  readonly mode: VoiceMicMode;
  readonly sessionMs: number;
}): VoiceCountdown {
  const counting = input.mode === "listening" || input.mode === "recognizing";
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

  const remaining = voiceRemainingSeconds(elapsedMs, input.sessionMs);
  return {
    countdown: counting ? `0:${String(remaining).padStart(2, "0")}` : null,
    remaining,
  };
}

export function useVoiceAnnouncements(input: {
  readonly mode: VoiceMicMode;
  readonly spokeLast: boolean;
  readonly announcements: VoiceComposerAnnouncements;
}): void {
  const announcement = voiceAnnouncementKey({
    mode: input.mode,
    spokeLast: input.spokeLast,
  });
  const announcementsRef = useRef(input.announcements);
  announcementsRef.current = input.announcements;
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
}
