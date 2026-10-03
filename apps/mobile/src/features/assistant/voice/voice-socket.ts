import {
  parseVoiceServerMessage,
  VOICE_CLOSE_CODE,
  VOICE_FINALIZE_TIMEOUT_MS,
  VOICE_MAX_FRAME_BYTES,
  VOICE_MAX_SESSION_MS,
  VOICE_MAX_TOTAL_BYTES,
  VOICE_SAMPLE_RATE_HZ,
  VOICE_STOP_FRAME,
  type VoiceSessionLimits,
  type VoiceUtteranceEnd,
} from "@showzy/validation/assistant-voice";

import { staffAssistantChatHeaders } from "../api/assistant-chat-headers";

import type { VoiceCaptureFailure } from "./voice-capture-state";
import { sliceVoiceFrames, voiceSocketUrl } from "./voice-protocol";

export type VoiceSocketFailure = Exclude<
  VoiceCaptureFailure,
  "audio" | "format"
>;

export interface VoiceWebSocketListener {
  onText(text: string): void;
  onClose(code: number): void;
  onError(): void;
}

export interface VoiceWebSocketHandle {
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
}

export type VoiceWebSocketFactory = (
  url: string,
  headers: Record<string, string>,
  listener: VoiceWebSocketListener,
) => VoiceWebSocketHandle;

type NativeSocketConstructor = new (
  url: string,
  protocols?: string | string[],
  options?: { readonly headers: Record<string, string> },
) => WebSocket;

export function nativeVoiceWebSocket(
  url: string,
  headers: Record<string, string>,
  listener: VoiceWebSocketListener,
): VoiceWebSocketHandle {
  const Native: NativeSocketConstructor = WebSocket;
  const socket = new Native(url, undefined, { headers });
  socket.binaryType = "arraybuffer";
  socket.onmessage = (event) => {
    const data: unknown = event.data;
    if (typeof data === "string") {
      listener.onText(data);
    }
  };
  socket.onerror = () => {
    listener.onError();
  };
  socket.onclose = (event) => {
    listener.onClose(event.code);
  };
  return {
    send: (data) => {
      socket.send(data);
    },
    close: (code, reason) => {
      socket.close(code, reason);
    },
  };
}

const CLOSE_FAILURE: Readonly<Record<number, VoiceSocketFailure>> = {
  [VOICE_CLOSE_CODE.overloaded]: "busy",
  [VOICE_CLOSE_CODE.refused]: "busy",
  [VOICE_CLOSE_CODE.badFrame]: "protocol",
  [VOICE_CLOSE_CODE.recognizerFailed]: "recognizer",
};

export function voiceFailureFromCloseCode(code: number): VoiceSocketFailure {
  return CLOSE_FAILURE[code] ?? "network";
}

export interface VoiceSocketHandlers {
  readonly onReady: (limits: VoiceSessionLimits) => void;
  readonly onPartial: (text: string) => void;
  readonly onFinal: (text: string, endedBy: VoiceUtteranceEnd) => void;
  readonly onFailed: (failure: VoiceSocketFailure) => void;
}

export interface VoiceSocketRequest {
  readonly apiUrl: string;
  readonly getCookie: () => string | null;
  readonly getCompanyId: () => string | null;
  readonly handlers: VoiceSocketHandlers;
  readonly createSocket?: VoiceWebSocketFactory | undefined;
}

export interface VoiceSocket {
  send(buffer: ArrayBuffer): void;
  stop(): void;
  close(): void;
}

export function openVoiceSocket(request: VoiceSocketRequest): VoiceSocket {
  let handle: VoiceWebSocketHandle | null = null;
  let ready = false;
  let stopped = false;
  let settled = false;
  let sentBytes = 0;
  let queued: ArrayBuffer[] = [];
  let finalizeTimer: ReturnType<typeof setTimeout> | null = null;
  let limits: VoiceSessionLimits = {
    maxFrameBytes: VOICE_MAX_FRAME_BYTES,
    maxTotalBytes: VOICE_MAX_TOTAL_BYTES,
    maxSessionMs: VOICE_MAX_SESSION_MS,
  };

  const clearFinalize = (): void => {
    if (finalizeTimer !== null) {
      clearTimeout(finalizeTimer);
      finalizeTimer = null;
    }
  };

  const settle = (close: number, run: () => void): void => {
    if (settled) {
      return;
    }
    settled = true;
    queued = [];
    clearFinalize();
    handle?.close(close);
    run();
  };

  const succeed = (text: string, endedBy: VoiceUtteranceEnd): void => {
    settle(VOICE_CLOSE_CODE.done, () => {
      request.handlers.onFinal(text, endedBy);
    });
  };

  const fail = (failure: VoiceSocketFailure): void => {
    settle(VOICE_CLOSE_CODE.done, () => {
      request.handlers.onFailed(failure);
    });
  };

  const armFinalize = (): void => {
    clearFinalize();
    finalizeTimer = setTimeout(() => {
      fail("network");
    }, VOICE_FINALIZE_TIMEOUT_MS);
  };

  const control = (): void => {
    handle?.send(VOICE_STOP_FRAME);
    armFinalize();
  };

  const receive = (raw: string): void => {
    const message = parseVoiceServerMessage(raw);
    if (message === null) {
      fail("protocol");
      return;
    }
    if (message.type === "ready") {
      if (message.sampleRateHz !== VOICE_SAMPLE_RATE_HZ) {
        fail("protocol");
        return;
      }
      ready = true;
      limits = {
        maxFrameBytes: message.maxFrameBytes,
        maxTotalBytes: message.maxTotalBytes,
        maxSessionMs: message.maxSessionMs,
      };
      const pending = queued;
      queued = [];
      for (const frame of pending) {
        handle?.send(frame);
      }
      if (stopped) {
        control();
      }
      request.handlers.onReady(limits);
      return;
    }
    if (message.type === "partial") {
      request.handlers.onPartial(message.text);
      return;
    }
    succeed(message.text, message.endedBy);
  };

  const listener: VoiceWebSocketListener = {
    onText: (text) => {
      if (!settled) {
        receive(text);
      }
    },
    onClose: (code) => {
      if (settled) {
        return;
      }
      fail(voiceFailureFromCloseCode(code));
    },
    onError: () => {
      fail("network");
    },
  };

  const create = request.createSocket ?? nativeVoiceWebSocket;
  handle = create(
    voiceSocketUrl(request.apiUrl),
    staffAssistantChatHeaders({
      cookie: request.getCookie(),
      companyId: request.getCompanyId(),
    }),
    listener,
  );

  return {
    send: (buffer) => {
      if (settled || stopped) {
        return;
      }
      for (const frame of sliceVoiceFrames(buffer, limits.maxFrameBytes)) {
        if (sentBytes + frame.byteLength > limits.maxTotalBytes) {
          return;
        }
        sentBytes += frame.byteLength;
        if (ready) {
          handle.send(frame);
        } else {
          queued.push(frame);
        }
      }
    },
    stop: () => {
      if (settled || stopped) {
        return;
      }
      stopped = true;
      armFinalize();
      if (ready) {
        control();
      }
    },
    close: () => {
      settle(VOICE_CLOSE_CODE.done, () => {});
    },
  };
}
