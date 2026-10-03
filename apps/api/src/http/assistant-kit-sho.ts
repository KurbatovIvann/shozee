import type { PauseScope, PublicPause } from "@showzy/assistant-kit";
import {
  AssistantKitConversationGoneError,
  readAssistantChatWindow,
  runShoTurn,
  shoFreeBudgetHold,
  SHO_INVOCATION_CHANNEL,
  type AssistantHistoryPort,
  type AssistantKitCommandRef,
  type AssistantKitFor,
  type AssistantSettledTurn,
  type AssistantToolContext,
  type AssistantTurnAcceptResult,
  type AssistantTurnStore,
  type ShoTurnAsk,
} from "@showzy/assistant-runtime";

import {
  goneResponse,
  json,
  type AssistantKitRuntime,
} from "./assistant-kit-http.js";

async function openShoPause(
  kit: AssistantKitFor,
  scope: PauseScope,
  ask: ShoTurnAsk,
): Promise<PublicPause | null> {
  if (!kit.interactions.has(ask.interaction)) {
    return null;
  }
  const opened = await kit.open({
    conversationId: scope.conversationId,
    bind: scope.bind,
    kind: ask.interaction,
    prompt: ask.prompt,
    secret: ask.secret,
    continuation: ask.continuation,
  });
  return opened.kind === "opened" ? opened.pause : null;
}

export interface ShoChatTurnEnv {
  readonly runtime: AssistantKitRuntime;
  readonly caller: {
    readonly userId: string;
    readonly companySelector: string;
    readonly bind: string;
    readonly sessionId: string;
  };
  readonly verifiedCompanyId: string;
  readonly kit: AssistantKitFor;
  readonly turns: AssistantTurnStore;
  readonly history: AssistantHistoryPort;
  readonly scope: PauseScope;
  readonly command: AssistantKitCommandRef;
  readonly requestId: string;
  readonly clientIp?: string;
  readonly text: string;
}

export async function shoChatTurn(
  env: ShoChatTurnEnv,
): Promise<Response | null> {
  const engineFor = env.runtime.sho;
  if (engineFor === undefined) {
    return null;
  }

  const now = new Date();
  let asked: string | null = null;
  const complain = (error: unknown, message: string): void => {
    env.runtime.logger.warn({ request_id: env.requestId, err: error }, message);
  };
  const withdrawTheQuestionNoTurnTook = async (): Promise<void> => {
    const interactionId = asked;
    if (interactionId === null) {
      return;
    }
    asked = null;
    try {
      await env.kit.abandon({ ...env.scope, interactionId });
    } catch (error) {
      complain(
        error,
        "a Шо question could not be withdrawn after no turn took it",
      );
    }
  };
  const giveTheCommandBack = async (): Promise<void> => {
    try {
      await env.runtime.commands.release(env.command);
    } catch (error) {
      complain(error, "a Шо turn could not give its command back");
    }
  };

  let settled: AssistantSettledTurn;
  try {
    const context: AssistantToolContext = {
      userId: env.caller.userId,
      companySelector: env.caller.companySelector,
      conversationId: env.scope.conversationId,
      commandId: env.command.commandId,
      requestId: env.requestId,
      ...(env.clientIp === undefined ? {} : { clientIp: env.clientIp }),
      channel: SHO_INVOCATION_CHANNEL,
    };
    const outcome = await runShoTurn({
      text: env.text,
      commandId: env.command.commandId,
      sessionId: env.caller.sessionId,
      now,
      history: await env.history.load(env.scope),
      tools: () => env.runtime.tools(context),
      engine: engineFor({
        verifiedCompanyId: env.verifiedCompanyId,
        userId: env.caller.userId,
        requestId: env.requestId,
        ...(env.clientIp === undefined ? {} : { clientIp: env.clientIp }),
      }),
    });
    if (outcome.kind === "fallback") {
      env.runtime.logger.info(
        { request_id: env.requestId, sho_fallback: outcome.reason },
        "Шо did not close this turn and the model answers it",
      );
      return null;
    }
    if (outcome.kind === "settled") {
      settled = { parts: outcome.parts, appended: outcome.appended };
    } else {
      const pause = await openShoPause(env.kit, env.scope, outcome);
      if (pause === null) {
        return null;
      }
      asked = pause.interactionId;
      settled = {
        parts: [
          {
            kind: "interaction",
            interactionId: pause.interactionId,
            revision: pause.revision,
            pause,
          },
        ],
        appended: outcome.appended,
      };
    }
  } catch (error) {
    await withdrawTheQuestionNoTurnTook();
    if (error instanceof AssistantKitConversationGoneError) {
      throw error;
    }
    complain(error, "a Шо turn stored nothing and the model answers instead");
    return null;
  }

  let stored: AssistantTurnAcceptResult;
  try {
    stored = await env.turns.accept({
      kind: "chat",
      conversationId: env.scope.conversationId,
      commandId: env.command.commandId,
      text: env.text,
      bind: env.caller.bind,
      sessionId: env.caller.sessionId,
      budgetHold: shoFreeBudgetHold(now),
      releaseUnusedHold: () => Promise.resolve(),
      settled,
    });
  } catch (error) {
    await withdrawTheQuestionNoTurnTook();
    await giveTheCommandBack();
    throw error;
  }

  if (stored.outcome !== "accepted") {
    await withdrawTheQuestionNoTurnTook();
  }
  if (stored.outcome === "wrong_owner") {
    await giveTheCommandBack();
    return goneResponse(env.requestId);
  }
  if (stored.outcome === "busy") {
    return null;
  }

  return json(
    200,
    {
      status: "ok",
      window: await readAssistantChatWindow(env.kit, env.turns, env.scope),
    },
    env.requestId,
  );
}
