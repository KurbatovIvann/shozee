import type { ChatWindow, PauseScope } from "@showzy/assistant-kit";
import type { AssistantChatInterruptedTurn } from "@showzy/validation/assistant-chat";

import type { AssistantKitFor } from "./runtime-types.js";
import type {
  AssistantTurnActiveView,
  AssistantTurnStore,
} from "./stores/assistant-turn-store.js";

export interface AssistantChatWindowWithTurn extends ChatWindow {
  readonly turn: AssistantTurnActiveView | null;
  readonly interruptedTurn: AssistantChatInterruptedTurn | null;
}

export async function readAssistantChatWindow(
  kit: { readonly messages: Pick<AssistantKitFor["messages"], "read"> },
  turns: Pick<AssistantTurnStore, "activeTurn" | "latestInterrupted">,
  scope: PauseScope,
  options?: { readonly before?: string },
): Promise<AssistantChatWindowWithTurn> {
  const window = await kit.messages.read(scope, options);
  const turn = await turns.activeTurn(scope);
  const interruptedTurn = await turns.latestInterrupted(scope);
  return { ...window, turn, interruptedTurn };
}
