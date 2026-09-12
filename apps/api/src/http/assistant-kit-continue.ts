import type { Context } from "hono";
import { z } from "zod";

import { readAssistantChatWindow } from "@showzy/assistant-runtime";

import {
  canonicalCommandIds,
  enqueueAcceptedTurn,
  goneResponse,
  json,
  readJson,
  requireBudgetTicket,
  requireCaller,
  takeCommand,
  type AssistantKitAppEnv,
  type AssistantKitRuntime,
} from "./assistant-kit-http.js";

export const ASSISTANT_KIT_CONTINUE_PATH = "/assistant/kit/continue";

export const assistantKitContinueBodySchema = z.strictObject({
  commandId: z.uuid(),
  conversationId: z.uuid(),
});

export async function handleAssistantKitContinue(
  c: Context<AssistantKitAppEnv>,
  runtime: AssistantKitRuntime,
): Promise<Response> {
  const requestId = c.get("requestId");
  const caller = await requireCaller(c, runtime);
  if (!caller.ok) {
    return caller.response;
  }

  const raw = await readJson(c);
  if (!raw.ok) {
    return json(400, { error: { code: "VALIDATION" } }, requestId);
  }
  const parsed = assistantKitContinueBodySchema.safeParse(raw.body);
  if (!parsed.success) {
    return json(400, { error: { code: "VALIDATION" } }, requestId);
  }
  const body = canonicalCommandIds(parsed.data);
  const { kit, turns } = runtime.forCaller({
    userId: caller.userId,
    companySelector: caller.companySelector,
    requestId,
    clientIp: c.get("clientIp"),
  });
  const scope = { conversationId: body.conversationId, bind: caller.bind };
  const accepted = async (): Promise<Response> =>
    json(
      202,
      {
        status: "accepted",
        window: await readAssistantChatWindow(kit, turns, scope),
      },
      requestId,
    );

  const open = await kit.peek(scope);
  if (open !== null) {
    return json(
      409,
      {
        status: "interaction_open",
        window: await readAssistantChatWindow(kit, turns, scope),
      },
      requestId,
    );
  }

  const command = {
    route: "continue" as const,
    bind: caller.bind,
    conversationId: body.conversationId,
    commandId: body.commandId,
  };
  if (!(await takeCommand(runtime, command))) {
    return await accepted();
  }

  const budget = requireBudgetTicket(c);

  let result: Awaited<ReturnType<typeof turns.accept>>;
  try {
    result = await turns.accept({
      kind: "continue",
      conversationId: body.conversationId,
      commandId: body.commandId,
      bind: caller.bind,
      sessionId: caller.sessionId,
      budgetHold: budget.handOverToAccept(),
      releaseUnusedHold: () => budget.release(),
    });
  } catch (error) {
    const released = await Promise.allSettled([
      runtime.commands.release(command),
    ]);
    for (const outcome of released) {
      if (outcome.status === "rejected") {
        runtime.logger.warn(
          { request_id: requestId, err: outcome.reason },
          "assistant command could not be given back after a failed accept",
        );
      }
    }
    throw error;
  }

  if (result.outcome === "busy") {
    await runtime.commands.release(command);
    return json(
      409,
      {
        status: "turn_open",
        window: await readAssistantChatWindow(kit, turns, scope),
      },
      requestId,
    );
  }
  if (result.outcome === "wrong_owner") {
    await runtime.commands.release(command);
    return goneResponse(requestId);
  }
  if (result.outcome === "accepted") {
    budget.keep();
  }

  await enqueueAcceptedTurn(runtime, result.job, requestId);

  return await accepted();
}
