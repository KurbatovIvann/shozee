import { createNodeWebSocket, type NodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import type { WSEvents } from "hono/ws";
import type { Logger } from "pino";

import {
  requireCaller,
  type AssistantKitAppEnv,
  type AssistantKitAuth,
} from "./assistant-kit-http.js";
import { REQUEST_ID_HEADER, resolveRequestId } from "./request-id.js";
import type { VoiceRecognizer } from "./assistant-voice-recognizer.js";
import {
  startVoiceSession,
  VOICE_CLOSE_CODE,
  type VoiceSession,
  type VoiceSessionCaller,
} from "./assistant-voice-session.js";

export const ASSISTANT_VOICE_PATH = "/assistant/kit/voice";

export interface AssistantVoiceRuntime {
  readonly auth: AssistantKitAuth;
  readonly logger: Logger;
  readonly recognizer: VoiceRecognizer;
}

export interface AssistantVoiceApp {
  readonly app: Hono<AssistantKitAppEnv>;
  readonly injectWebSocket: NodeWebSocket["injectWebSocket"];
  close(): Promise<void>;
}

export function voiceSocketEvents(
  runtime: AssistantVoiceRuntime,
  caller: VoiceSessionCaller,
): WSEvents {
  let session: VoiceSession | undefined;
  return {
    onOpen(_event, ws) {
      session = startVoiceSession({
        recognizer: runtime.recognizer,
        logger: runtime.logger,
        caller,
        socket: {
          send: (payload) => {
            ws.send(payload);
          },
          close: (code, reason) => {
            ws.close(code, reason);
          },
        },
      });
    },
    onMessage(event: { readonly data: unknown }, ws) {
      if (session === undefined) {
        return;
      }
      const { data } = event;
      if (typeof data === "string") {
        session.control(data);
        return;
      }
      if (data instanceof ArrayBuffer) {
        session.audio(Buffer.from(data));
        return;
      }
      session.abandon();
      ws.close(VOICE_CLOSE_CODE.badFrame, "unsupported-frame");
    },
    onClose() {
      session?.abandon();
    },
    onError() {
      session?.abandon();
    },
  };
}

export function createAssistantVoiceApp(
  runtime: AssistantVoiceRuntime,
): AssistantVoiceApp {
  const app = new Hono<AssistantKitAppEnv>();
  const nodeWebSocket = createNodeWebSocket({ app });

  app.get(ASSISTANT_VOICE_PATH, async (c) => {
    const requestId = resolveRequestId(c.req.header(REQUEST_ID_HEADER));
    c.set("requestId", requestId);
    const caller = await requireCaller(c, runtime);
    if (!caller.ok) {
      return caller.response;
    }
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
      return c.body(null, 426);
    }
    return nodeWebSocket.upgradeWebSocket(
      c,
      voiceSocketEvents(runtime, {
        userId: caller.userId,
        companySelector: caller.companySelector,
        requestId,
      }),
    );
  });

  return {
    app,
    injectWebSocket: (server) => {
      nodeWebSocket.injectWebSocket(server);
    },
    close: () => runtime.recognizer.close(),
  };
}
