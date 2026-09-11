/**
 * The owner token a turn's placeholder was stored under (SHO-561, SHO-570).
 *
 * A turn writes under the token the accept stored rather than deriving one
 * again, so the kit's owner rule compares a value with itself. The placeholder
 * must also still be the conversation's latest message: only the latest message
 * can be written to, so a turn whose conversation has moved on has nothing to
 * write into.
 *
 * Both the worker running a turn and the reconciler ending one ask this, and
 * they must agree: two readings of "which message is this turn's" would be two
 * answers waiting to disagree.
 */
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
    await createPostgresAssistantKitMessageLog(deps, caller).page(
      turn.conversationId,
      { limit: 1 },
    )
  ).records[0];
  return latest?.messageId === turn.placeholderMessageId ? latest.bind : null;
}
