import type { Logger } from "pino";

import {
  VOICE_SAMPLE_RATE_HZ,
  type VoiceRecognitionStream,
  type VoiceRecognizer,
} from "./assistant-voice-recognizer.js";

export const VOICE_MAX_SESSION_MS = 15_000;

export const VOICE_MAX_FRAME_BYTES = 32_000;

export const VOICE_CLOSE_CODE = {
  done: 1000,
  badFrame: 4400,
  recognizerFailed: 4500,
} as const;

export type VoiceUtteranceEnd = "client" | "limit";

export type VoiceServerMessage =
  | {
      readonly type: "ready";
      readonly sampleRateHz: number;
      readonly maxFrameBytes: number;
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
  readonly companySelector: string;
  readonly requestId: string;
}

export interface VoiceSessionOptions {
  readonly recognizer: VoiceRecognizer;
  readonly socket: VoiceSocket;
  readonly logger: Logger;
  readonly caller: VoiceSessionCaller;
  readonly maxFrameBytes?: number;
  readonly maxSessionMs?: number;
}

export interface VoiceSession {
  audio(frame: Buffer): void;
  control(frame: string): void;
  abandon(): void;
}

export function startVoiceSession(options: VoiceSessionOptions): VoiceSession {
  const maxFrameBytes = options.maxFrameBytes ?? VOICE_MAX_FRAME_BYTES;
  const maxSessionMs = options.maxSessionMs ?? VOICE_MAX_SESSION_MS;
  const { socket, logger, caller } = options;

  let endedBy: VoiceUtteranceEnd = "client";
  let listening = true;
  let closed = false;
  let timer: NodeJS.Timeout | undefined;

  const logContext = {
    request_id: caller.requestId,
    user_id: caller.userId,
    company_selector: caller.companySelector,
  };

  const send = (message: VoiceServerMessage): void => {
    if (!closed) {
      socket.send(JSON.stringify(message));
    }
  };

  const stopTimer = (): void => {
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
    stopTimer();
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
      stopTimer();
      send({ type: "final", text, endedBy });
      logger.info(
        { ...logContext, ended_by: endedBy, transcript_chars: text.length },
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
    stopTimer();
    stream.finish();
  };

  send({
    type: "ready",
    sampleRateHz: VOICE_SAMPLE_RATE_HZ,
    maxFrameBytes,
    maxSessionMs,
  });

  timer = setTimeout(() => {
    stopListening("limit");
  }, maxSessionMs);

  const reject = (reason: string): void => {
    logger.warn(
      { ...logContext, voice_reject: reason },
      "assistant voice frame rejected",
    );
    listening = false;
    stopTimer();
    stream.abort();
    close(VOICE_CLOSE_CODE.badFrame, reason);
  };

  return {
    audio(frame) {
      if (!listening) {
        return;
      }
      if (frame.byteLength > maxFrameBytes) {
        reject("frame-too-large");
        return;
      }
      if (frame.byteLength === 0 || frame.byteLength % 2 !== 0) {
        reject("not-pcm16");
        return;
      }
      stream.write(frame);
    },
    control(frame) {
      if (!listening) {
        return;
      }
      if (frame.length > maxFrameBytes) {
        reject("frame-too-large");
        return;
      }
      if (!isStopCommand(frame)) {
        reject("unknown-command");
        return;
      }
      stopListening("client");
    },
    abandon() {
      closed = true;
      listening = false;
      stopTimer();
      stream.abort();
    },
  };
}

function isStopCommand(frame: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(frame);
  } catch {
    return false;
  }
  return (
    typeof parsed === "object" &&
    parsed !== null &&
    "type" in parsed &&
    parsed.type === "stop"
  );
}
