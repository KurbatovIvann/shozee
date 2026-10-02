import {
  ASSISTANT_VOICE_PATH,
  VOICE_BYTES_PER_SAMPLE,
  VOICE_CHANNELS,
  VOICE_MAX_FRAME_BYTES,
  VOICE_SAMPLE_RATE_HZ,
} from "@showzy/validation/assistant-voice";

export function voiceSocketUrl(apiUrl: string): string {
  const base = apiUrl.replace(/\/+$/, "").replace(/^http/, "ws");
  return `${base}${ASSISTANT_VOICE_PATH}`;
}

export function voiceFrameBytes(buffer: {
  readonly data: ArrayBuffer;
  readonly sampleRate: number;
  readonly channels: number;
}): ArrayBuffer | null {
  const captured =
    buffer.sampleRate === VOICE_SAMPLE_RATE_HZ &&
    buffer.channels === VOICE_CHANNELS;
  const whole =
    buffer.data.byteLength > 0 &&
    buffer.data.byteLength % VOICE_BYTES_PER_SAMPLE === 0;
  return captured && whole ? buffer.data : null;
}

export function sliceVoiceFrames(
  data: ArrayBuffer,
  maxBytes: number = VOICE_MAX_FRAME_BYTES,
): readonly ArrayBuffer[] {
  if (data.byteLength <= maxBytes) {
    return [data];
  }
  const frames: ArrayBuffer[] = [];
  for (let offset = 0; offset < data.byteLength; offset += maxBytes) {
    frames.push(
      data.slice(offset, Math.min(offset + maxBytes, data.byteLength)),
    );
  }
  return frames;
}
