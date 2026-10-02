import type { PauseScope } from "@showzy/assistant-kit";
import {
  readAssistantChatWindow,
  runShoTurn,
  shoFreeBudgetHold,
  SHO_INVOCATION_CHANNEL,
  type AssistantHistoryPort,
  type AssistantKitFor,
  type AssistantSettledTurn,
  type AssistantToolContext,
  type AssistantTurnStore,
  type ShoTurnAsk,
} from "@showzy/assistant-runtime";

import {
  goneResponse,
  json,
  type AssistantKitRuntime,
} from "./assistant-kit-http.js";

interface ShoAsked {
  readonly settled: AssistantSettledTurn;
  readonly interactionId: string;
}

async function openShoPause(
  kit: AssistantKitFor,
  scope: PauseScope,
  ask: ShoTurnAsk,
): Promise<ShoAsked | null> {
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
  if (opened.kind !== "opened") {
    return null;
  }
  return {
    interactionId: opened.pause.interactionId,
    settled: {
      parts: [
        {
          kind: "interaction",
          interactionId: opened.pause.interactionId,
          revision: opened.pause.revision,
          pause: opened.pause,
        },
      ],
      history: ask.history,
    },
  };
}

export interface ShoChatTurnEnv {
  readonly runtime: AssistantKitRuntime;
  readonly caller: {
    readonly userId: string;
    readonly companySelector: string;
    readonly bind: string;
    readonly sessionId: string;
  };
  readonly kit: AssistantKitFor;
  readonly turns: AssistantTurnStore;
  readonly history: AssistantHistoryPort;
  readonly scope: PauseScope;
  readonly requestId: string;
  readonly clientIp?: string;
  readonly text: string;
  readonly commandId: string;
}

export async function shoChatTurn(
  env: ShoChatTurnEnv,
): Promise<Response | null> {
  const engineFor = env.runtime.sho;
  if (engineFor === undefined) {
    return null;
  }

  const verifiedCompanyId = await env.runtime.staffCompany({
    userId: env.caller.userId,
    companySelector: env.caller.companySelector,
    requestId: env.requestId,
    ...(env.clientIp === undefined ? {} : { clientIp: env.clientIp }),
  });

  const context: AssistantToolContext = {
    userId: env.caller.userId,
    companySelector: env.caller.companySelector,
    conversationId: env.scope.conversationId,
    commandId: env.commandId,
    requestId: env.requestId,
    ...(env.clientIp === undefined ? {} : { clientIp: env.clientIp }),
    channel: SHO_INVOCATION_CHANNEL,
  };

  const now = new Date();
  const outcome = await runShoTurn({
    text: env.text,
    commandId: env.commandId,
    now,
    history: await env.history.load(env.scope),
    tools: () => env.runtime.tools(context),
    engine: engineFor({
      verifiedCompanyId,
      userId: env.caller.userId,
      requestId: env.requestId,
      ...(env.clientIp === undefined ? {} : { clientIp: env.clientIp }),
    }),
  });
  if (outcome.kind === "fallback") {
    return null;
  }

  let asked: ShoAsked | null = null;
  let settled: AssistantSettledTurn;
  if (outcome.kind === "settled") {
    settled = { parts: outcome.parts, history: outcome.history };
  } else {
    asked = await openShoPause(env.kit, env.scope, outcome);
    if (asked === null) {
      return null;
    }
    settled = asked.settled;
  }
  const unaskWhatNoTurnOwns = async (): Promise<null> => {
    if (asked !== null) {
      await env.kit.abandon({
        ...env.scope,
        interactionId: asked.interactionId,
      });
    }
    return null;
  };

  const stored = await env.turns.accept({
    kind: "chat",
    conversationId: env.scope.conversationId,
    commandId: env.commandId,
    text: env.text,
    bind: env.caller.bind,
    sessionId: env.caller.sessionId,
    budgetHold: shoFreeBudgetHold(now),
    releaseUnusedHold: () => Promise.resolve(),
    settled,
  });
  if (stored.outcome === "wrong_owner") {
    await unaskWhatNoTurnOwns();
    return goneResponse(env.requestId);
  }
  if (stored.outcome === "busy") {
    return await unaskWhatNoTurnOwns();
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
