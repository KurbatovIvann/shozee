import { z } from "zod";

export const ASSISTANT_VOICE_PATH = "/assistant/kit/voice";

export const VOICE_SAMPLE_RATE_HZ = 16_000;

export const VOICE_CHANNELS = 1;

export const VOICE_ENCODING = "int16";

export const VOICE_BYTES_PER_SAMPLE = 2;

export const VOICE_SAMPLE_FULL_SCALE = 32_768;

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

export const voiceServerMessageSchema = z.discriminatedUnion("type", [
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

export type VoiceSessionLimits = Omit<
  Extract<VoiceServerMessage, { type: "ready" }>,
  "type" | "sampleRateHz"
>;

export function voiceFrameLevel(data: ArrayBuffer): number {
  const samples = Math.floor(data.byteLength / VOICE_BYTES_PER_SAMPLE);
  if (samples === 0) {
    return 0;
  }
  const view = new DataView(data);
  let squares = 0;
  for (let index = 0; index < samples; index += 1) {
    const sample =
      view.getInt16(index * VOICE_BYTES_PER_SAMPLE, true) /
      VOICE_SAMPLE_FULL_SCALE;
    squares += sample * sample;
  }
  return Math.sqrt(squares / samples);
}

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
