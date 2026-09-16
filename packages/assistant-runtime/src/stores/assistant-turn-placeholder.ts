import { createPostgresAssistantKitMessageLog } from "./assistant-kit-postgres-stores.js";
import type { AssistantKitCaller, AssistantKitStoreDeps } from "./caller.js";

export async function readTurnPlaceholderBind(
  deps: AssistantKitStoreDeps,
  caller: AssistantKitCaller,
  turn: {
    readonly conversationId: string;
    readonly placeholderMessageId: string;
  },
): Promise<string | null> {
  const latest = (
    await createPostgresAssistantKitMessageLog(deps, caller, undefined).page(
      turn.conversationId,
      { limit: 1 },
    )
  ).records[0];
  return latest?.messageId === turn.placeholderMessageId ? latest.bind : null;
}
