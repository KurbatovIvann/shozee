import type { RateLimitStore } from "@showzy/core";
import type { Logger } from "pino";

export const VOICE_SESSION_WINDOW_SEC = 60;

export interface VoiceSessionRateLimit {
  readonly store: RateLimitStore;
  readonly sessionsPerMinutePerUser: number;
}

export type VoiceSessionAdmission =
  | { readonly admitted: true }
  | { readonly admitted: false; readonly retryAfterSec: number };

function voiceSessionLimitKey(userId: string): string {
  return `rl:assistant.voice:user:${userId}`;
}

export async function admitVoiceSession(options: {
  readonly rateLimit: VoiceSessionRateLimit;
  readonly logger: Logger;
  readonly requestId: string;
  readonly userId: string;
}): Promise<VoiceSessionAdmission> {
  if (options.rateLimit.sessionsPerMinutePerUser <= 0) {
    return { admitted: true };
  }

  let decision;
  try {
    decision = await options.rateLimit.store.consume({
      key: voiceSessionLimitKey(options.userId),
      limit: options.rateLimit.sessionsPerMinutePerUser,
      windowSec: VOICE_SESSION_WINDOW_SEC,
    });
  } catch (error) {
    options.logger.error(
      { err: error, request_id: options.requestId, user_id: options.userId },
      "assistant voice rate-limit store failed",
    );
    return { admitted: false, retryAfterSec: VOICE_SESSION_WINDOW_SEC };
  }

  return decision.allowed
    ? { admitted: true }
    : { admitted: false, retryAfterSec: decision.retryAfterSec };
}
