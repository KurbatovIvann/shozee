/**
 * The `assistant-kit` routes, mounted together.
 *
 * Parallel to the live assistant on its own path prefix and its own factory:
 * nothing here is reachable from `createApp`, so the running assistant is
 * untouched while this path is proven.
 */
import { Hono } from "hono";

import {
  ASSISTANT_KIT_CHAT_PATH,
  ASSISTANT_KIT_MESSAGES_PATH,
  handleAssistantKitChat,
  handleAssistantKitMessages,
} from "./assistant-kit-chat.js";
import {
  ASSISTANT_KIT_CHOICE_PATH,
  handleAssistantKitChoice,
} from "./assistant-kit-choice.js";
import type {
  AssistantKitAppEnv,
  AssistantKitRuntime,
} from "./assistant-kit-http.js";
import { REQUEST_ID_HEADER, resolveRequestId } from "./request-id.js";

export {
  ASSISTANT_KIT_CHAT_PATH,
  ASSISTANT_KIT_CHOICE_PATH,
  ASSISTANT_KIT_MESSAGES_PATH,
};

export function createAssistantKitApp(
  runtime: AssistantKitRuntime,
): Hono<AssistantKitAppEnv> {
  const app = new Hono<AssistantKitAppEnv>();

  app.use(async (c, next) => {
    // Mounted inside the main app, the outer middleware has already resolved
    // both — including the trusted-proxy handling for the client address.
    // Re-deriving them here would be a second, weaker answer to the same
    // question. These fallbacks are for running this app on its own, in tests.
    if ((c.get("requestId") as string | undefined) === undefined) {
      c.set("requestId", resolveRequestId(c.req.header(REQUEST_ID_HEADER)));
    }
    if ((c.get("clientIp") as string | undefined) === undefined) {
      c.set("clientIp", "127.0.0.1");
    }
    await next();
  });

  app.post(ASSISTANT_KIT_CHAT_PATH, (c) => handleAssistantKitChat(c, runtime));
  app.post(ASSISTANT_KIT_CHOICE_PATH, (c) =>
    handleAssistantKitChoice(c, runtime),
  );
  app.get(ASSISTANT_KIT_MESSAGES_PATH, (c) =>
    handleAssistantKitMessages(c, runtime),
  );

  return app;
}
