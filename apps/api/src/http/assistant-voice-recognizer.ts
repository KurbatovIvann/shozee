export const VOICE_SAMPLE_RATE_HZ = 16_000;

export const VOICE_LANGUAGE_CODES: readonly string[] = ["uk-UA", "ru-RU"];

export interface VoiceRecognitionEvents {
  partial(text: string): void;
  final(text: string): void;
  failed(code: string): void;
}

export interface VoiceRecognitionStream {
  write(pcm: Buffer): void;
  finish(): void;
  abort(): void;
}

export interface VoiceRecognizer {
  start(events: VoiceRecognitionEvents): VoiceRecognitionStream;
  close(): Promise<void>;
}

export function joinTranscript(left: string, right: string): string {
  if (left === "") {
    return right;
  }
  if (right === "") {
    return left;
  }
  return `${left} ${right}`;
}
