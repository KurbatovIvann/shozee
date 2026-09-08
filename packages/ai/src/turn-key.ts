/**
 * Host begin identity stored on `assistant_messages.turn_key` (SHO-539).
 * Recovery is exact membership on these keys — not neighbor heuristics.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ASSISTANT_CHAT_TURN_KEY_PREFIX = "begin:" as const;
export const ASSISTANT_RESUME_TURN_KEY_PREFIX = "begin:resume:" as const;
export const ASSISTANT_PHASE_A_TURN_KEY_PREFIX = "begin:phase-a:" as const;
export const ASSISTANT_REPLACE_TURN_KEY_PREFIX = "begin:replace:" as const;
export const ASSISTANT_SUCCESSOR_TURN_KEY_PREFIX = "begin:successor:" as const;

export function chatTurnKey(userMessageId: string): string {
  return `${ASSISTANT_CHAT_TURN_KEY_PREFIX}${userMessageId}`;
}

export function resumeTurnKey(pendingId: string): string {
  return `${ASSISTANT_RESUME_TURN_KEY_PREFIX}${pendingId}`;
}

export function phaseATurnKey(pendingId: string): string {
  return `${ASSISTANT_PHASE_A_TURN_KEY_PREFIX}${pendingId}`;
}

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * Chat begin identity: `begin:${userMessageId}` (a UUID, no extra
 * segments). Null / unknown origin is not a chat turn.
 */
export function isChatTurnKey(turnKey: string | null | undefined): boolean {
  if (turnKey === null || turnKey === undefined) {
    return false;
  }
  if (!turnKey.startsWith(ASSISTANT_CHAT_TURN_KEY_PREFIX)) {
    return false;
  }
  return isUuid(turnKey.slice(ASSISTANT_CHAT_TURN_KEY_PREFIX.length));
}

/**
 * Phase B resume identity: `begin:resume:${pendingId}`.
 */
export function isResumeTurnKey(turnKey: string | null | undefined): boolean {
  if (turnKey === null || turnKey === undefined) {
    return false;
  }
  if (!turnKey.startsWith(ASSISTANT_RESUME_TURN_KEY_PREFIX)) {
    return false;
  }
  return isUuid(turnKey.slice(ASSISTANT_RESUME_TURN_KEY_PREFIX.length));
}
