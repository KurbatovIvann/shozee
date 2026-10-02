import { randomUUID } from "node:crypto";

import { createNodeWebSocket, type NodeWebSocket } from "@hono/node-ws";
import type {
  AssistantCaller,
  AssistantStreamSlots,
} from "@showzy/assistant-runtime";
import { Hono } from "hono";
import type { WSEvents } from "hono/ws";
import type { Logger } from "pino";

import {
  json,
  requireCaller,
  type AssistantKitAppEnv,
  type AssistantKitAuth,
} from "./assistant-kit-http.js";
import { REQUEST_ID_HEADER, resolveRequestId } from "./request-id.js";
import type { VoiceRecognizer } from "./assistant-voice-chirp.js";
import {
  startVoiceSession,
  VOICE_CLOSE_CODE,
  type VoiceSession,
  type VoiceSessionCaller,
} from "./assistant-voice-session.js";

export const ASSISTANT_VOICE_PATH = "/assistant/kit/voice";

export type VoiceStreamSlots = Pick<
  AssistantStreamSlots,
  "acquire" | "release"
>;

export interface AssistantVoiceRuntime {
  readonly auth: AssistantKitAuth;
  readonly logger: Logger;
  readonly recognizer: VoiceRecognizer;
  readonly staffCompany: (caller: AssistantCaller) => Promise<string>;
  readonly slots: VoiceStreamSlots;
  readonly trustedOrigins: readonly string[];
}

export interface AssistantVoiceApp {
  readonly app: Hono<AssistantKitAppEnv>;
  readonly injectWebSocket: NodeWebSocket["injectWebSocket"];
  close(): Promise<void>;
}

export function voiceSocketEvents(
  runtime: AssistantVoiceRuntime,
  caller: VoiceSessionCaller,
  onDone: () => void,
): WSEvents {
  let session: VoiceSession | undefined;
  let done = false;
  const finish = (): void => {
    if (done) {
      return;
    }
    done = true;
    session?.abandon();
    onDone();
  };
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
      finish();
    },
    onError() {
      finish();
    },
  };
}

export function createAssistantVoiceApp(
  runtime: AssistantVoiceRuntime,
): AssistantVoiceApp {
  const app = new Hono<AssistantKitAppEnv>();
  const nodeWebSocket = createNodeWebSocket({ app });
  const trustedOrigins = new Set(runtime.trustedOrigins);

  app.get(ASSISTANT_VOICE_PATH, async (c) => {
    const requestId = resolveRequestId(c.req.header(REQUEST_ID_HEADER));
    c.set("requestId", requestId);

    const origin = c.req.header("origin");
    if (origin !== undefined && !trustedOrigins.has(origin)) {
      return json(403, { error: { code: "FORBIDDEN" } }, requestId);
    }

    const caller = await requireCaller(c, runtime);
    if (!caller.ok) {
      return caller.response;
    }
    const assistantCaller: AssistantCaller = {
      userId: caller.userId,
      companySelector: caller.companySelector,
      requestId,
    };

    let companyId: string;
    try {
      companyId = await runtime.staffCompany(assistantCaller);
    } catch (error) {
      runtime.logger.info(
        { err: error, request_id: requestId, user_id: caller.userId },
        "assistant voice refused a caller without staff membership",
      );
      return json(403, { error: { code: "FORBIDDEN" } }, requestId);
    }

    const streamId = randomUUID();
    if (!(await runtime.slots.acquire(caller.userId, streamId))) {
      return json(429, { error: { code: "RATE_LIMITED" } }, requestId);
    }

    return nodeWebSocket.upgradeWebSocket(
      c,
      voiceSocketEvents(
        runtime,
        { userId: caller.userId, companyId, requestId },
        () => {
          void runtime.slots.release(caller.userId, streamId);
        },
      ),
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
