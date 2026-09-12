/**
 * The `assistant-kit` routes, mounted together.
 *
 * Two of the four cost money, and those two are wrapped in the spend guard here
 * rather than inside the handlers. Putting it at the mount point means a route
 * cannot be added without deciding whether it calls the model — a new endpoint
 * that quietly spends is the failure this shape prevents.
 */
import {
  AssistantKitConversationGoneError,
  createMemoryAiBudgetStore,
} from "@showzy/assistant-runtime";
import { createInMemoryRateLimitStore } from "@showzy/core";
import { Hono } from "hono";

import {
  ASSISTANT_KIT_CHAT_PATH,
  ASSISTANT_KIT_MESSAGES_PATH,
  handleAssistantKitChat,
  handleAssistantKitMessages,
} from "./assistant-kit-chat.js";
import {
  ASSISTANT_KIT_ABANDON_PATH,
  ASSISTANT_KIT_ANSWER_PATH,
  handleAssistantKitAbandon,
  handleAssistantKitAnswer,
} from "./assistant-kit-answer.js";
import {
  ASSISTANT_KIT_EVENTS_PATH,
  handleAssistantKitEvents,
  type AssistantKitEvents,
} from "./assistant-kit-events.js";
import { goneResponse, json } from "./assistant-kit-http.js";
import {
  memoryAssistantKitBudget,
  withAssistantKitBudget,
  type AssistantKitBudget,
} from "./assistant-kit-budget.js";
import type {
  AssistantKitAppEnv,
  AssistantKitRuntime,
} from "./assistant-kit-http.js";
import { REQUEST_ID_HEADER, resolveRequestId } from "./request-id.js";

export type { AssistantKitBudget, AssistantKitEvents };

export {
  ASSISTANT_KIT_ABANDON_PATH,
  ASSISTANT_KIT_ANSWER_PATH,
  ASSISTANT_KIT_CHAT_PATH,
  ASSISTANT_KIT_EVENTS_PATH,
  ASSISTANT_KIT_MESSAGES_PATH,
};

export function createAssistantKitApp(
  runtime: AssistantKitRuntime,
  /**
   * Omitted only by tests and a single-process run: the fallback is in-process
   * stores, never no ceiling. `app.ts` always passes the real ones.
   */
  budget?: AssistantKitBudget,
  /** The event stream (SHO-562). Absent, `GET /assistant/kit/events` is not mounted. */
  events?: AssistantKitEvents,
): Hono<AssistantKitAppEnv> {
  const app = new Hono<AssistantKitAppEnv>();
  const spend =
    budget ??
    memoryAssistantKitBudget(runtime.logger, {
      rateLimitStore: createInMemoryRateLimitStore(),
      budgetStore: createMemoryAiBudgetStore(),
    });

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

  // A new job: it consumes a turn slot as well as budget.
  /**
   * A conversation that does not exist and one belonging to someone else answer
   * the same way, because the store cannot tell them apart and must not: a
   * conversation id is not a secret, and a distinction here would make it one.
   */
  app.onError((error, c) => {
    const requestId = c.get("requestId");
    if (error instanceof AssistantKitConversationGoneError) {
      return goneResponse(requestId);
    }
    // Everything else is a fault, answered in this path's own shape rather
    // than Hono's plain-text default, and logged where it can be found.
    runtime.logger.error(
      { err: error, request_id: requestId },
      "assistant-kit turn failed",
    );
    return json(500, { error: { code: "INTERNAL" } }, requestId);
  });

  app.post(ASSISTANT_KIT_CHAT_PATH, (c) =>
    withAssistantKitBudget(
      c,
      runtime,
      spend,
      { skipTurnLimit: false, turnKind: "chat" },
      () => handleAssistantKitChat(c, runtime),
    ),
  );
  // Finishing work already admitted. Budget applies; the turn bucket does not.
  app.post(ASSISTANT_KIT_ANSWER_PATH, (c) =>
    withAssistantKitBudget(
      c,
      runtime,
      spend,
      { skipTurnLimit: true, turnKind: "answer" },
      () => handleAssistantKitAnswer(c, runtime),
    ),
  );
  app.post(ASSISTANT_KIT_ABANDON_PATH, (c) =>
    handleAssistantKitAbandon(c, runtime),
  );
  app.get(ASSISTANT_KIT_MESSAGES_PATH, (c) =>
    handleAssistantKitMessages(c, runtime),
  );
  // A stream is not a turn: no spend guard, no turn slot. It has its own
  // per-person limit inside.
  if (events !== undefined) {
    app.get(ASSISTANT_KIT_EVENTS_PATH, (c) =>
      handleAssistantKitEvents(c, runtime, events),
    );
  }

  return app;
}
