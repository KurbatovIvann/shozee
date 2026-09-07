/**
 * Staff-assistant HTTP invocation channel (security-operations §4).
 * Shared so chat, choice, and confirm mounts do not import each other.
 */
export const ASSISTANT_INVOCATION_CHANNEL = "ai" as const;
