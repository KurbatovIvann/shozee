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
  kit: { readonly messages: Pick<AssistantKitFor["messages"], "read"> },
  turns: Pick<AssistantTurnStore, "activeTurn">,
  scope: PauseScope,
  options?: { readonly before?: string },
): Promise<AssistantChatWindowWithTurn> {
  const window = await kit.messages.read(scope, options);
  const turn = await turns.activeTurn(scope);
  return { ...window, turn };
}
