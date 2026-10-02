import { staffAssistantChatHeaders } from "../api/assistant-chat-headers";

import type { VoiceCaptureFailure } from "./voice-capture-state";
import {
  parseVoiceServerMessage,
  sliceVoiceFrames,
  voiceSocketUrl,
  VOICE_CLOSE_CODE,
  VOICE_FINALIZE_TIMEOUT_MS,
  VOICE_MAX_TOTAL_BYTES,
  VOICE_SAMPLE_RATE_HZ,
  VOICE_STOP_FRAME,
  type VoiceUtteranceEnd,
} from "./voice-protocol";

export type VoiceSocketFailure = Exclude<VoiceCaptureFailure, "audio">;

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

export function voiceFailureFromCloseCode(
  code: number,
): VoiceSocketFailure | null {
  switch (code) {
    case VOICE_CLOSE_CODE.done:
      return null;
    case VOICE_CLOSE_CODE.overloaded:
      return "busy";
    case VOICE_CLOSE_CODE.badFrame:
      return "protocol";
    case VOICE_CLOSE_CODE.recognizerFailed:
      return "recognizer";
    default:
      return "network";
  }
}

export interface VoiceSocketHandlers {
  readonly onReady: () => void;
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

  const control = (): void => {
    handle?.send(VOICE_STOP_FRAME);
  };

  const write = (frame: ArrayBuffer): void => {
    if (ready) {
      handle?.send(frame);
      return;
    }
    queued.push(frame);
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
      const pending = queued;
      queued = [];
      for (const frame of pending) {
        handle?.send(frame);
      }
      if (stopped) {
        control();
      }
      request.handlers.onReady();
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
      const failure = voiceFailureFromCloseCode(code);
      if (failure === null) {
        succeed("", "client");
        return;
      }
      fail(failure);
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
      for (const frame of sliceVoiceFrames(buffer)) {
        if (sentBytes + frame.byteLength > VOICE_MAX_TOTAL_BYTES) {
          return;
        }
        sentBytes += frame.byteLength;
        write(frame);
      }
    },
    stop: () => {
      if (settled || stopped) {
        return;
      }
      stopped = true;
      if (ready) {
        control();
      }
      finalizeTimer = setTimeout(() => {
        fail("network");
      }, VOICE_FINALIZE_TIMEOUT_MS);
    },
    close: () => {
      settle(VOICE_CLOSE_CODE.done, () => {});
    },
  };
}
