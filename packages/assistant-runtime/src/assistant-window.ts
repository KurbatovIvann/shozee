import type { ChatWindow, PauseScope } from "@showzy/assistant-kit";

import type { AssistantKitFor } from "./runtime-types.js";
import type {
  AssistantTurnActiveView,
  AssistantTurnStore,
} from "./stores/assistant-turn-store.js";

export interface AssistantChatWindowWithTurn extends ChatWindow {
  readonly turn: AssistantTurnActiveView | null;
}

export async function readAssistantChatWindow(
  kit: Pick<AssistantKitFor, "messages">,
  turns: Pick<AssistantTurnStore, "activeTurn">,
  scope: PauseScope,
  options?: { readonly before?: string },
): Promise<AssistantChatWindowWithTurn> {
  const [window, turn] = await Promise.all([
    kit.messages.read(scope, options),
    turns.activeTurn(scope),
  ]);
  return { ...window, turn };
}
