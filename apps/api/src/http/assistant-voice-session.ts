import type { Logger } from "pino";

import {
  VOICE_SAMPLE_RATE_HZ,
  type VoiceRecognitionStream,
  type VoiceRecognizer,
} from "./assistant-voice-chirp.js";

export const VOICE_STOP_FRAME = "stop";

export const VOICE_MAX_SESSION_MS = 15_000;

export const VOICE_MAX_FRAME_BYTES = 32_000;

export const VOICE_MAX_TOTAL_BYTES =
  (VOICE_MAX_SESSION_MS / 1000) * VOICE_SAMPLE_RATE_HZ * 2;

export const VOICE_FINALIZE_TIMEOUT_MS = 5_000;

export const VOICE_MAX_UNACKED_BYTES = 64_000;

export const VOICE_CLOSE_CODE = {
  done: 1000,
  badFrame: 4400,
  overloaded: 4429,
  recognizerFailed: 4500,
} as const;

export type VoiceUtteranceEnd = "client" | "limit";

export type VoiceServerMessage =
  | {
      readonly type: "ready";
      readonly sampleRateHz: number;
      readonly maxFrameBytes: number;
      readonly maxTotalBytes: number;
      readonly maxSessionMs: number;
    }
  | { readonly type: "partial"; readonly text: string }
  | {
      readonly type: "final";
      readonly text: string;
      readonly endedBy: VoiceUtteranceEnd;
    };

export interface VoiceSocket {
  send(payload: string): void;
  close(code: number, reason?: string): void;
}

export interface VoiceSessionCaller {
  readonly userId: string;
  readonly companyId: string;
  readonly requestId: string;
}

export interface VoiceSessionOptions {
  readonly recognizer: VoiceRecognizer;
  readonly socket: VoiceSocket;
  readonly logger: Logger;
  readonly caller: VoiceSessionCaller;
  readonly maxFrameBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxSessionMs?: number;
  readonly finalizeTimeoutMs?: number;
}

export interface VoiceSession {
  audio(frame: Buffer): void;
  control(frame: string): void;
  abandon(): void;
}

export function startVoiceSession(options: VoiceSessionOptions): VoiceSession {
  const maxFrameBytes = options.maxFrameBytes ?? VOICE_MAX_FRAME_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? VOICE_MAX_TOTAL_BYTES;
  const maxSessionMs = options.maxSessionMs ?? VOICE_MAX_SESSION_MS;
  const finalizeTimeoutMs =
    options.finalizeTimeoutMs ?? VOICE_FINALIZE_TIMEOUT_MS;
  const { socket, logger, caller } = options;

  let endedBy: VoiceUtteranceEnd = "client";
  let listening = true;
  let closed = false;
  let totalBytes = 0;
  let unackedBytes = 0;
  let timer: NodeJS.Timeout | undefined;

  const logContext = {
    request_id: caller.requestId,
    user_id: caller.userId,
    company_id: caller.companyId,
  };

  const send = (message: VoiceServerMessage): void => {
    if (!closed) {
      socket.send(JSON.stringify(message));
    }
  };

  const stopTimers = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const close = (code: number, reason: string): void => {
    if (closed) {
      return;
    }
    closed = true;
    listening = false;
    stopTimers();
    socket.close(code, reason);
  };

  const stream: VoiceRecognitionStream = options.recognizer.start({
    partial(text) {
      if (text !== "") {
        send({ type: "partial", text });
      }
    },
    final(text) {
      listening = false;
      stopTimers();
      send({ type: "final", text, endedBy });
      logger.info(
        {
          ...logContext,
          ended_by: endedBy,
          transcript_chars: text.length,
          audio_bytes: totalBytes,
        },
        "assistant voice utterance recognised",
      );
      close(VOICE_CLOSE_CODE.done, "final");
    },
    failed(code) {
      logger.warn(
        { ...logContext, speech_error: code },
        "assistant voice recognition failed",
      );
      close(VOICE_CLOSE_CODE.recognizerFailed, code);
    },
  });

  const stopListening = (reason: VoiceUtteranceEnd): void => {
    if (!listening) {
      return;
    }
    listening = false;
    endedBy = reason;
    stopTimers();
    timer = setTimeout(() => {
      if (closed) {
        return;
      }
      logger.warn(logContext, "assistant voice recognizer never finalised");
      stream.abort();
      close(VOICE_CLOSE_CODE.recognizerFailed, "finalize-timeout");
    }, finalizeTimeoutMs);
    stream.finish();
  };

  send({
    type: "ready",
    sampleRateHz: VOICE_SAMPLE_RATE_HZ,
    maxFrameBytes,
    maxTotalBytes,
    maxSessionMs,
  });

  timer = setTimeout(() => {
    stopListening("limit");
  }, maxSessionMs);

  const reject = (code: number, reason: string): void => {
    logger.warn(
      { ...logContext, voice_reject: reason },
      "assistant voice frame rejected",
    );
    stream.abort();
    close(code, reason);
  };

  return {
    audio(frame) {
      if (!listening) {
        return;
      }
      if (frame.byteLength > maxFrameBytes) {
        reject(VOICE_CLOSE_CODE.badFrame, "frame-too-large");
        return;
      }
      if (frame.byteLength === 0 || frame.byteLength % 2 !== 0) {
        reject(VOICE_CLOSE_CODE.badFrame, "not-pcm16");
        return;
      }
      if (totalBytes + frame.byteLength > maxTotalBytes) {
        reject(VOICE_CLOSE_CODE.badFrame, "audio-budget");
        return;
      }
      totalBytes += frame.byteLength;
      if (stream.write(frame)) {
        unackedBytes = 0;
        return;
      }
      unackedBytes += frame.byteLength;
      if (unackedBytes > VOICE_MAX_UNACKED_BYTES) {
        reject(VOICE_CLOSE_CODE.overloaded, "upstream-behind");
      }
    },
    control(frame) {
      if (!listening) {
        return;
      }
      if (frame.length > maxFrameBytes) {
        reject(VOICE_CLOSE_CODE.badFrame, "frame-too-large");
        return;
      }
      if (frame !== VOICE_STOP_FRAME) {
        reject(VOICE_CLOSE_CODE.badFrame, "unknown-command");
        return;
      }
      stopListening("client");
    },
    abandon() {
      closed = true;
      listening = false;
      stopTimers();
      stream.abort();
    },
  };
}
