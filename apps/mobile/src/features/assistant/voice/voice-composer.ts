import { VOICE_MAX_SESSION_MS } from "@showzy/validation/assistant-voice";

import type { VoiceCaptureStatus } from "./voice-capture-state";

export type VoiceMicMode =
  "idle" | "pending" | "listening" | "recognizing" | "denied" | "error";

export type VoiceAnnouncementKey = "listening" | "done" | null;

export const VOICE_SPOKEN_MEMORY = 20;

export const VOICE_MAX_SESSION_SECONDS = Math.ceil(VOICE_MAX_SESSION_MS / 1000);

export function voiceMicMode(status: VoiceCaptureStatus): VoiceMicMode {
  switch (status) {
    case "requesting":
    case "starting":
      return "pending";
    case "listening":
      return "listening";
    case "recognizing":
      return "recognizing";
    case "denied":
      return "denied";
    case "error":
      return "error";
    case "idle":
      return "idle";
  }
}

export function voiceMicActive(mode: VoiceMicMode): boolean {
  return mode === "pending" || mode === "listening" || mode === "recognizing";
}

export function voiceMicPressable(input: {
  readonly mode: VoiceMicMode;
  readonly available: boolean;
  readonly blocked: boolean;
}): boolean {
  if (voiceMicActive(input.mode)) {
    return input.mode !== "recognizing";
  }
  return input.available && !input.blocked;
}

export function voiceComposerValue(input: {
  readonly mode: VoiceMicMode;
  readonly partial: string;
  readonly typed: string;
}): string {
  return voiceMicActive(input.mode) ? input.partial : input.typed;
}

export function voiceComposerPlaceholder(input: {
  readonly mode: VoiceMicMode;
  readonly listening: string;
  readonly recognizing: string;
  readonly idle: string;
}): string {
  if (input.mode === "recognizing") {
    return input.recognizing;
  }
  return input.mode === "pending" || input.mode === "listening"
    ? input.listening
    : input.idle;
}

export function voiceCountdownVisible(mode: VoiceMicMode): boolean {
  return mode === "listening" || mode === "recognizing";
}

export function voiceRemainingSeconds(elapsedMs: number): number {
  const left = Math.ceil((VOICE_MAX_SESSION_MS - elapsedMs) / 1000);
  return Math.max(0, Math.min(VOICE_MAX_SESSION_SECONDS, left));
}

export function voiceCountdownText(seconds: number): string {
  return `0:${String(Math.max(0, seconds)).padStart(2, "0")}`;
}

export function voiceAnnouncementKey(input: {
  readonly mode: VoiceMicMode;
  readonly spokeLast: boolean;
}): VoiceAnnouncementKey {
  if (input.mode === "listening" || input.mode === "recognizing") {
    return "listening";
  }
  return input.spokeLast ? "done" : null;
}

export function voiceSpokenKey(text: string): string {
  return text.trim();
}

export function rememberSpoken(
  spoken: ReadonlySet<string>,
  text: string,
): ReadonlySet<string> {
  const key = voiceSpokenKey(text);
  if (key.length === 0) {
    return spoken;
  }
  const next = new Set(spoken);
  next.delete(key);
  next.add(key);
  while (next.size > VOICE_SPOKEN_MEMORY) {
    const [oldest] = next;
    if (oldest === undefined) {
      break;
    }
    next.delete(oldest);
  }
  return next;
}

export function voiceRowSpoken(input: {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly spoken: ReadonlySet<string>;
}): boolean {
  return input.role === "user" && input.spoken.has(voiceSpokenKey(input.text));
}
