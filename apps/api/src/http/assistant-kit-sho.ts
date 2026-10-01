import type { PauseScope } from "@showzy/assistant-kit";
import {
  isShoToolCall,
  readAssistantChatWindow,
  runShoTurn,
  shoFreeBudgetHold,
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

export function shoOpenedThePause(pausedToolCallId: string): boolean {
  return isShoToolCall(pausedToolCallId);
}

async function openShoPause(
  kit: AssistantKitFor,
  scope: PauseScope,
  ask: ShoTurnAsk,
): Promise<AssistantSettledTurn | null> {
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
    parts: [
      {
        kind: "interaction",
        interactionId: opened.pause.interactionId,
        revision: opened.pause.revision,
        pause: opened.pause,
      },
    ],
    history: ask.history,
  };
}

export async function shoChatTurn(env: {
  readonly runtime: AssistantKitRuntime;
  readonly caller: { readonly bind: string; readonly sessionId: string };
  readonly kit: AssistantKitFor;
  readonly turns: AssistantTurnStore;
  readonly history: AssistantHistoryPort;
  readonly scope: PauseScope;
  readonly requestId: string;
  readonly text: string;
  readonly commandId: string;
  readonly context: AssistantToolContext;
}): Promise<Response | null> {
  const engine = env.runtime.sho;
  if (engine === undefined) {
    return null;
  }
  const now = new Date();
  const outcome = await runShoTurn({
    text: env.text,
    conversationId: env.scope.conversationId,
    commandId: env.commandId,
    now,
    history: await env.history.load(env.scope),
    tools: () => env.runtime.tools(env.context),
    engine,
  });
  if (outcome.kind === "fallback") {
    return null;
  }
  const settled =
    outcome.kind === "settled"
      ? { parts: outcome.parts, history: outcome.history }
      : await openShoPause(env.kit, env.scope, outcome);
  if (settled === null) {
    return null;
  }
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
