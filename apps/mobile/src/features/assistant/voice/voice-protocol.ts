import { z } from "zod";

export const ASSISTANT_KIT_VOICE_PATH = "/assistant/kit/voice";

export const VOICE_SAMPLE_RATE_HZ = 16_000;

export const VOICE_CHANNELS = 1;

export const VOICE_ENCODING = "int16";

export const VOICE_BYTES_PER_SAMPLE = 2;

export const VOICE_STOP_FRAME = "stop";

export const VOICE_MAX_SESSION_MS = 15_000;

export const VOICE_MAX_FRAME_BYTES = 32_000;

export const VOICE_MAX_TOTAL_BYTES =
  (VOICE_MAX_SESSION_MS / 1000) * VOICE_SAMPLE_RATE_HZ * VOICE_BYTES_PER_SAMPLE;

export const VOICE_FINALIZE_TIMEOUT_MS = 5_000;

export const VOICE_CLOSE_CODE = {
  done: 1000,
  badFrame: 4400,
  overloaded: 4429,
  recognizerFailed: 4500,
} as const;

export type VoiceUtteranceEnd = "client" | "limit";

const voiceServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ready"),
    sampleRateHz: z.number().int().positive(),
    maxFrameBytes: z.number().int().positive(),
    maxTotalBytes: z.number().int().positive(),
    maxSessionMs: z.number().int().positive(),
  }),
  z.object({ type: z.literal("partial"), text: z.string() }),
  z.object({
    type: z.literal("final"),
    text: z.string(),
    endedBy: z.enum(["client", "limit"]),
  }),
]);

export type VoiceServerMessage = z.infer<typeof voiceServerMessageSchema>;

export function parseVoiceServerMessage(
  raw: string,
): VoiceServerMessage | null {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = voiceServerMessageSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

export function voiceSocketUrl(apiUrl: string): string {
  const base = apiUrl.replace(/\/+$/, "").replace(/^http/, "ws");
  return `${base}${ASSISTANT_KIT_VOICE_PATH}`;
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
