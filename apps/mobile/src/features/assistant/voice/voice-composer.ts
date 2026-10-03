import type { VoiceCaptureStatus } from "./voice-capture-state";

export type VoiceMicMode =
  "idle" | "pending" | "listening" | "recognizing" | "denied" | "error";

export type VoiceAnnouncementKey = "listening" | "done" | null;

export const VOICE_SPOKEN_MEMORY = 20;

export const VOICE_RING_FULL_LEVEL = 0.2;

export const VOICE_RING_REST_SCALE = 1;

export const VOICE_RING_PEAK_SCALE = 1.6;

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

export function voiceRingScale(input: {
  readonly active: boolean;
  readonly level: number;
}): number {
  if (!input.active || !Number.isFinite(input.level)) {
    return VOICE_RING_REST_SCALE;
  }
  const reach = Math.min(1, Math.max(0, input.level) / VOICE_RING_FULL_LEVEL);
  return (
    VOICE_RING_REST_SCALE +
    reach * (VOICE_RING_PEAK_SCALE - VOICE_RING_REST_SCALE)
  );
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

export function voiceRemainingSeconds(
  elapsedMs: number,
  sessionMs: number,
): number {
  const limit = Math.ceil(sessionMs / 1000);
  return Math.max(
    0,
    Math.min(limit, Math.ceil((sessionMs - elapsedMs) / 1000)),
  );
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
  const kept = [...spoken].filter((item) => item !== key);
  kept.push(key);
  return new Set(kept.slice(-VOICE_SPOKEN_MEMORY));
}

export function voiceRowSpoken(input: {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly spoken: ReadonlySet<string>;
}): boolean {
  return input.role === "user" && input.spoken.has(voiceSpokenKey(input.text));
}
