import { randomUUID } from "node:crypto";

import { createNodeWebSocket, type NodeWebSocket } from "@hono/node-ws";
import type {
  AssistantCaller,
  AssistantStreamSlots,
} from "@showzy/assistant-runtime";
import { NotFoundError, PermissionDeniedError } from "@showzy/core/errors";
import {
  ASSISTANT_VOICE_PATH,
  VOICE_CLOSE_CODE,
} from "@showzy/validation/assistant-voice";
import { Hono, type Context } from "hono";
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
  admitVoiceSession,
  VOICE_SESSION_DENIAL_CODE,
  type VoiceSessionRateLimit,
} from "./assistant-voice-limit.js";
import {
  startVoiceSession,
  type VoiceSession,
  type VoiceSessionCaller,
} from "./assistant-voice-session.js";

export type VoiceUpgrade = (
  c: Context<AssistantKitAppEnv>,
  events: WSEvents,
) => Promise<Response>;

export type VoiceStreamSlots = Pick<
  AssistantStreamSlots,
  "acquire" | "release"
>;

export interface AssistantVoiceRuntime {
  readonly auth: AssistantKitAuth;
  readonly logger: Logger;
  readonly rateLimit: VoiceSessionRateLimit;
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

export function voiceRefusalEvents(denialCode: string): WSEvents {
  return {
    onOpen(_event, ws) {
      ws.close(VOICE_CLOSE_CODE.refused, denialCode);
    },
  };
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
      try {
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
      } catch (error) {
        runtime.logger.error(
          { err: error, request_id: caller.requestId },
          "assistant voice session failed to start",
        );
        finish();
        ws.close(VOICE_CLOSE_CODE.recognizerFailed, "start-failed");
      }
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
  upgrade?: VoiceUpgrade,
): AssistantVoiceApp {
  const app = new Hono<AssistantKitAppEnv>();
  const nodeWebSocket = createNodeWebSocket({ app });
  const trustedOrigins = new Set(runtime.trustedOrigins);
  const upgradeSocket: VoiceUpgrade =
    upgrade ??
    ((context, events) => nodeWebSocket.upgradeWebSocket(context, events));

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
      if (
        !(error instanceof PermissionDeniedError) &&
        !(error instanceof NotFoundError)
      ) {
        throw error;
      }
      runtime.logger.info(
        { err: error, request_id: requestId, user_id: caller.userId },
        "assistant voice refused a caller without staff membership",
      );
      return json(403, { error: { code: "FORBIDDEN" } }, requestId);
    }

    if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
      return c.body(null, 426);
    }

    const streamId = randomUUID();
    if (!(await runtime.slots.acquire(caller.userId, streamId))) {
      runtime.logger.info(
        {
          request_id: requestId,
          user_id: caller.userId,
          company_id: companyId,
          reason: "no_slot",
        },
        "assistant voice refused a caller before opening a recognizer",
      );
      return await upgradeSocket(
        c,
        voiceRefusalEvents(VOICE_SESSION_DENIAL_CODE.session_limit),
      );
    }
    const releaseSlot = (): void => {
      runtime.slots.release(caller.userId, streamId).catch((error: unknown) => {
        runtime.logger.error(
          { err: error, request_id: requestId, user_id: caller.userId },
          "assistant voice could not release a stream slot",
        );
      });
    };

    const admission = await admitVoiceSession({
      rateLimit: runtime.rateLimit,
      logger: runtime.logger,
      requestId,
      userId: caller.userId,
    });
    if (!admission.admitted) {
      releaseSlot();
      runtime.logger.info(
        {
          request_id: requestId,
          user_id: caller.userId,
          company_id: companyId,
          reason: admission.reason,
          retry_after_sec: admission.retryAfterSec,
        },
        "assistant voice refused a caller before opening a recognizer",
      );
      return await upgradeSocket(c, voiceRefusalEvents(admission.code));
    }

    try {
      return await upgradeSocket(
        c,
        voiceSocketEvents(
          runtime,
          { userId: caller.userId, companyId, requestId },
          releaseSlot,
        ),
      );
    } catch (error) {
      releaseSlot();
      throw error;
    }
  });

  app.onError((error, c) => {
    const requestId = c.get("requestId");
    runtime.logger.error(
      { err: error, request_id: requestId },
      "assistant voice handshake failed",
    );
    return json(500, { error: { code: "INTERNAL" } }, requestId);
  });

  return {
    app,
    injectWebSocket: (server) => {
      nodeWebSocket.injectWebSocket(server);
    },
    close: () => runtime.recognizer.close(),
  };
}
