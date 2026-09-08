/**
 * Logical-attempt idempotency keys for the staff AI mount (SHO-322).
 *
 * `idempotencyKey` identifies an attempt, not content. Core still hashes
 * validated input separately (same key + same input → replay; same key +
 * different input → conflict). `conversationId` is a namespace so IDs
 * cannot collide across conversations — it is not an access grant.
 */
export type StaffAssistantAttemptKind = "message" | "tool" | "turn" | "choice";

export function attemptKey(
  kind: StaffAssistantAttemptKind,
  conversationId: string,
  id: string,
): string {
  return `${kind}:${conversationId}:${id}`;
}

/**
 * Compose the existing tool-attempt key with a server-minted
 * `execution_id`. Do not use a model-regenerated `toolCallId` as the
 * retry key.
 */
export function executionAttemptKey(
  conversationId: string,
  executionId: string,
): string {
  return attemptKey("tool", conversationId, executionId);
}
