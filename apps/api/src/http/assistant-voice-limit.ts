import type { RateLimitStore } from "@showzy/core";
import type { Logger } from "pino";

export const VOICE_SESSION_WINDOW_SEC = 60;

export type VoiceSessionDenialReason = "session_limit" | "rate_limit_store";

export const VOICE_SESSION_DENIAL_CODE: Readonly<
  Record<VoiceSessionDenialReason, string>
> = {
  session_limit: "RATE_LIMITED",
  rate_limit_store: "RATE_LIMIT_STORE",
};

export interface VoiceSessionRateLimit {
  readonly store: RateLimitStore;
  readonly sessionsPerMinutePerUser: number;
}

export interface VoiceSessionDenial {
  readonly admitted: false;
  readonly reason: VoiceSessionDenialReason;
  readonly code: string;
  readonly retryAfterSec: number;
}

export type VoiceSessionAdmission =
  { readonly admitted: true } | VoiceSessionDenial;

function voiceSessionLimitKey(userId: string): string {
  return `ai-voice:${userId}`;
}

function deny(
  reason: VoiceSessionDenialReason,
  retryAfterSec: number,
): VoiceSessionDenial {
  return {
    admitted: false,
    reason,
    code: VOICE_SESSION_DENIAL_CODE[reason],
    retryAfterSec,
  };
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
    return deny("rate_limit_store", VOICE_SESSION_WINDOW_SEC);
  }

  return decision.allowed
    ? { admitted: true }
    : deny("session_limit", decision.retryAfterSec);
}
